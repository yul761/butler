import type { NarrativeStatus } from "../../shared/brief";
import type { ScanHit } from "../../shared/llm";
import type { AuditRepo } from "../db/audit-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TermsRepo } from "../db/terms-repo";
import { isLoopbackHost, llmConfig } from "../settings/settings-values";
import { checkBudget, costUsd, estimateTokens, monthStart } from "./budget";
import type { KeyStore } from "./key-store";
import { NARRATIVE_MAX_TOKENS, narrativeMessages, parseNarrative } from "./narrative";
import { project } from "./projection";
import { chatBody, chatCompletion, chatUrl, ProviderError, scrub, type ChatCall, type ChatMessage, type ChatResponse } from "./provider";
import { defaultRng, Pseudonymizer, restore } from "./pseudonym";
import { scanOutbound } from "./scanner";
import type { NarrativeSource, OutboundPayload, Rng } from "./types";

const DAY_MS = 86_400_000;

export interface GatewayDeps {
  settings: SettingsRepo;
  audit: AuditRepo;
  terms: TermsRepo;
  /** 没保存 key 时 gateway 不会访问系统钥匙串（get 只在数据库里有密文时才解密）。 */
  keys: Pick<KeyStore, "get" | "saved">;
  /** 默认是真正的 chatCompletion；测试也用它（连本地假服务器）。 */
  chat?: ChatCall;
  now: () => number;
  rng?: Rng;
  /** 发送前确认：展示完整的出站内容，返回是否同意。 */
  confirm: (outbound: string) => Promise<boolean>;
  log?: (msg: string, err?: unknown) => void;
}

export interface NarrativeResult {
  status: NarrativeStatus;
  narrative: string | null;
  /** 这次调用写的审计行；没有写（off）时为 null。 */
  auditId: number | null;
}

const result = (status: NarrativeStatus, auditId: number | null = null, narrative: string | null = null): NarrativeResult => ({ status, narrative, auditId });

/** 出站 JSON 里的所有字符串值（扫描用）。 */
export function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectStrings(x, out);
  return out;
}

/** 出站 JSON 里的自由文本（next_steps、blockers、followup 描述）；metadata 档位没有。 */
export function freeTexts(p: OutboundPayload): string[] {
  return p.tickets.flatMap((t) => [...(t.next_steps ?? []), ...(t.blockers ?? []), ...t.followups.map((f) => f.description ?? "")]).filter(Boolean);
}

const uniqueHits = (hits: ScanHit[]): ScanHit[] => hits.filter((h, i) => hits.findIndex((x) => x.rule === h.rule) === i);

/** 发送前确认对话框里的内容：请求地址、模型和每条消息的原文（用户消息排版成多行 JSON）。 */
export function confirmText(url: string, model: string, messages: ChatMessage[]): string {
  const parts = messages.map((m) => {
    let content = m.content;
    if (m.role === "user") {
      try {
        content = JSON.stringify(JSON.parse(m.content), null, 2);
      } catch {
        // 不是 JSON 就原样展示。
      }
    }
    return `[${m.role}]\n${content}`;
  });
  return [`POST ${url}`, `model: ${model}`, ...parts].join("\n\n");
}

/**
 * 个人 LLM API 的唯一出口（设计文档第 7 节）。只用于早间简报的“今日重点”。
 * 串行执行：两次请求不会同时通过预算检查。narrate() 永远不抛错。
 */
export class PrivacyGateway {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: GatewayDeps) {}

  narrate(src: NarrativeSource, signal?: AbortSignal): Promise<NarrativeResult> {
    const run = this.chain.then(() => this.run(src, signal)).catch((e: unknown): NarrativeResult => {
      // 意外错误（数据库等）里不会有 key：key 只在 run() 里、只进请求头；保险起见仍去掉 Bearer 凭证。
      this.d.log?.("narrative failed", new Error(scrub(e instanceof Error ? e.message : String(e), null)));
      return result("failed");
    });
    this.chain = run;
    return run;
  }

  private async run(src: NarrativeSource, signal?: AbortSignal): Promise<NarrativeResult> {
    const cfg = llmConfig(this.d.settings);
    const now = this.d.now();
    this.d.audit.prune(now - cfg.retentionDays * DAY_MS);
    const level = cfg.level;
    if (level === "off" || !cfg.baseUrl || !cfg.model) return result("off");
    if (signal?.aborted) return result("failed");

    const url = new URL(cfg.baseUrl);
    const loopback = isLoopbackHost(url.hostname);
    const apiKey = this.d.keys.get();
    if (apiKey === null && this.d.keys.saved()) {
      // 保存过但解不开（钥匙串被重置等）：远程服务等同没配置；本机服务也不发（用户本来要带 key，不带只会被拒）。
      this.d.log?.("narrative skipped: the saved API key cannot be decrypted");
      return result(loopback ? "failed" : "off");
    }
    // 远程服务没有 key：当作没有配置。本机服务（Ollama 等）可以不要 key。
    if (apiKey === null && !loopback) return result("off");

    // 1. 字段投影 + 假名化（字典每次请求重新随机生成，只在内存里）。
    const rng = this.d.rng ?? defaultRng;
    const terms = this.d.terms.list();
    const pseudo = new Pseudonymizer(
      {
        ...src.known,
        people: terms.filter((t) => t.category === "person").map((t) => t.term),
        terms: terms.filter((t) => t.category === "term").map((t) => t.term),
      },
      rng,
    );
    const payload = project(src, level, pseudo, rng);
    const messages = narrativeMessages(payload);
    const body = chatBody({ model: cfg.model, messages, maxTokens: NARRATIVE_MAX_TOKENS });
    const inputText = messages.map((m) => m.content).join("\n");
    const base = { ts: now, provider: url.host, model: cfg.model, level };

    // 2. 预算：超出“视为 off”（设计文档 7.6），什么都不发。
    const budget = checkBudget({
      prices: cfg.prices, model: cfg.model, budgetUsd: cfg.budgetUsd,
      spentUsd: this.d.audit.costSince(monthStart(now)), inputText, maxOutputTokens: NARRATIVE_MAX_TOKENS,
    });
    if (!budget.ok) return result("budget", this.d.audit.insert({ ...base, status: "budget", payloadSent: null, error: budget.message }));

    // 3. 敏感信息扫描：命中就整次拒发；被拦下的内容不落盘。
    //    所有字符串查“形状”规则（密钥、URL、域名、IP、邮箱、路径）；ticket 号和字典原值只在自由文本里查：
    //    枚举和日期里不会有它们，而仓库恰好叫 config、active 这类名字时，查枚举会误拦每一次请求。
    //    full 档位本来就发真实 ticket 号和原文，这两条跳过。
    const masked = level !== "full";
    const hits = uniqueHits([
      ...scanOutbound(collectStrings(payload), { ticketPattern: null, originals: [] }),
      ...scanOutbound(freeTexts(payload), {
        ticketPattern: masked ? this.d.settings.get("ticketPattern") : null,
        originals: masked ? pseudo.originals() : [],
      }),
    ]);
    if (hits.length > 0) return result("blocked", this.d.audit.insert({ ...base, status: "blocked", payloadSent: null, blockedReason: hits }));

    // 4. 写审计（原样的请求体），再按设置请用户确认。
    const auditId = this.d.audit.insert({ ...base, status: "pending", payloadSent: body });
    if (cfg.confirm) {
      let ok: boolean;
      try {
        ok = await this.d.confirm(confirmText(chatUrl(cfg.baseUrl), cfg.model, messages));
      } catch (e) {
        this.d.log?.("confirm dialog failed", e);
        this.d.audit.finish(auditId, { status: "declined", error: "发送前确认出错" });
        return result("failed", auditId);
      }
      if (!ok) {
        this.d.audit.finish(auditId, { status: "declined" });
        return result("off", auditId);
      }
    }
    if (signal?.aborted) {
      this.d.audit.finish(auditId, { status: "declined", error: "app 正在退出" });
      return result("failed", auditId);
    }

    // 5. 发送。
    let res: ChatResponse;
    try {
      res = await (this.d.chat ?? chatCompletion)({ baseUrl: cfg.baseUrl, apiKey, model: cfg.model, messages, maxTokens: NARRATIVE_MAX_TOKENS, signal });
    } catch (e) {
      const message = scrub(e instanceof Error ? e.message : String(e), apiKey);
      // 请求体真的发出去了就记下实际发出的那个（用户要能看到）；确定什么都没发出去时清空 pending 时记的请求体。
      // 不是 ProviderError（不知道发没发）时保留 pending 的请求体：宁可多给用户看。
      const sent = e instanceof ProviderError ? e.sentBody : undefined;
      this.d.audit.finish(auditId, { status: "failed", error: message, ...(sent === undefined ? {} : { payloadSent: sent }) });
      this.d.log?.(`narrative request failed: ${message}`);
      return result("failed", auditId);
    }

    // 6. 记账、校验、还原。provider 已经去掉了 raw / content 里的 key；这里再去一次，换了 chat 实现也成立。
    const content = scrub(res.content, apiKey);
    const tokensIn = res.tokensIn ?? estimateTokens(inputText);
    const tokensOut = res.tokensOut ?? estimateTokens(content);
    const focus = parseNarrative(content);
    const lines = (focus ?? []).map((f) => restore(f, pseudo.mapping).text).filter((l) => l.length > 0);
    this.d.audit.finish(auditId, {
      status: "sent",
      payloadSent: res.sentBody,
      response: scrub(res.raw, apiKey),
      tokensIn,
      tokensOut,
      costUsd: costUsd(budget.price, tokensIn, tokensOut),
      error: focus === null ? "响应不符合格式" : lines.length === 0 ? "响应里没有可用的句子" : null,
    });
    if (lines.length === 0) return result("failed", auditId);
    return result("ok", auditId, lines.join("\n"));
  }
}
