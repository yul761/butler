import type { NarrativeStatus } from "../../shared/brief";
import type { ScanHit } from "../../shared/llm";
import type { AuditFinish, AuditRepo } from "../db/audit-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TermsRepo } from "../db/terms-repo";
import { isLoopbackHost, llmConfig, type LlmConfig, type PriceRule } from "../settings/settings-values";
import { auditCutoff, checkBudget, costUsd, estimateTokens, monthStart, sentWithoutUsage, STATECORE_MAX_TOKENS } from "./budget";
import type { KeyStore } from "./key-store";
import { NARRATIVE_MAX_TOKENS, narrativeMessages, parseNarrative } from "./narrative";
import { project } from "./projection";
import { chatBody, chatCompletion, chatUrl, ProviderError, scrub, type ChatCall, type ChatMessage, type ChatResponse } from "./provider";
import { defaultRng, Pseudonymizer, restore } from "./pseudonym";
import { scanOutbound } from "./scanner";
import type { NarrativeSource, OutboundPayload, Rng, StatecoreChatModel } from "./types";
import { M } from "../strings";


/** StateCore 每次蒸馏调用的输出上限（定义在 budget.ts：启动时给遗留的 pending 记录估花费也要用）。 */
export { STATECORE_MAX_TOKENS };

/** StateCore 每次蒸馏调用的截止时间：输出上限 8192 token，按 50～60 token/秒要两三分钟（“今日重点”沿用 provider 的 60 秒）。 */
export const STATECORE_TIMEOUT_MS = 180_000;

/** StateCore 蒸馏调用在发送前被拒绝的原因（只写进日志的代码，不含任何内容）。 */
type StatecoreRefusal = "level_not_full" | "not_configured" | "confirm_on" | "quitting" | "bad_base_url" | "no_key";

/** StateCore 蒸馏调用被拒绝或失败：StateCore 把这次蒸馏记为 failed，事件留到下次。 */
export class StatecoreCallError extends Error {}

const errorText = (e: unknown): string => {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return "unknown error";
  }
};

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

const llmOff = (cfg: LlmConfig): boolean => cfg.level === "off" || !cfg.baseUrl || !cfg.model;

/** StateCore 蒸馏的条件（计划 4 R1 / P4-R5）：full 档位、配置齐全、没开发送前确认。返回不满足的那一条（null：可以发）。 */
const statecoreRefusal = (cfg: LlmConfig): StatecoreRefusal | null =>
  cfg.level !== "full" ? "level_not_full" : llmOff(cfg) ? "not_configured" : cfg.confirm ? "confirm_on" : null;

/** 一次已经写好 pending 审计行、通过了预算检查的请求（send() 的输入）。 */
interface SendRequest {
  /** 日志里的名字（narrative / statecore）。 */
  what: string;
  cfg: LlmConfig;
  apiKey: string | null;
  messages: ChatMessage[];
  maxTokens: number;
  /** 截止时间；省略时用 provider 的默认值。 */
  timeoutMs?: number;
  /** pending 时记下的请求体。 */
  body: string;
  auditId: number;
  price: PriceRule;
  signal?: AbortSignal;
  /** 检查（去掉 key 之后的）响应内容，返回要记进审计的 error；可用时返回 null。不能抛错。 */
  check: (content: string) => string | null;
}

/** send() 的结果：没收到可用的响应（审计已记 failed 或按 2xx 保守记账），或者收到了响应（recorded：花费是否记上）。 */
type SendOutcome = { sent: false; error: string } | { sent: true; content: string; recorded: boolean };

/**
 * 个人 LLM API 的唯一出口（设计文档第 7 节）。用于早间简报的“今日重点”，以及 full 档位下 StateCore 记忆的蒸馏（计划 4 R1）。
 * 串行执行：两次请求不会同时通过预算检查。narrate() 永远不抛错。
 */
export class PrivacyGateway {
  private chain: Promise<unknown> = Promise.resolve();
  /** 上一次 StateCore 调用被拒绝的原因：同一个原因连续出现只记一次日志（一次蒸馏会调用好几次模型）。 */
  private lastStatecoreRefusal: StatecoreRefusal | null = null;

  constructor(private readonly d: GatewayDeps) {}

  /** 串行队列：预算检查、发送、记账一次只有一个调用在进行（“今日重点”和 StateCore 蒸馏共用）。 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    // 链条本身永远不会失败：一次调用出了任何问题，后面的调用照常排队执行。
    this.chain = run.catch(() => undefined);
    return run;
  }

  narrate(src: NarrativeSource, signal?: AbortSignal): Promise<NarrativeResult> {
    return this.serial(() => this.run(src, signal)).catch((e: unknown): NarrativeResult => {
      // 意外错误（数据库等）里不会有 key：key 只进请求头；保险起见仍去掉 Bearer 凭证。
      this.log("narrative failed", new Error(scrub(errorText(e), null)));
      return result("failed");
    });
  }

  /**
   * StateCore 蒸馏用的模型（计划 4 R1）：只有 full 档位、配置齐全、没开“发送前确认”时才给。
   * 每次 chat() 都重新检查这些条件（蒸馏进行中改了档位也立即生效），在 gateway 里带上 key、检查预算、
   * 写审计（source = statecore）后发送。不做敏感信息扫描：full 档位下设计文档 8.5 接受发送原始事件（Ruling P4-R1）。
   * 被拒绝或失败时 reject（StatecoreCallError）。
   */
  statecoreModel(signal?: AbortSignal): StatecoreChatModel | null {
    if (statecoreRefusal(llmConfig(this.d.settings)) !== null) return null;
    return {
      chat: (messages) =>
        this.serial(() => this.statecoreCall(messages, signal)).catch((e: unknown): never => {
          // 意外错误（数据库等）也只以 StatecoreCallError 交出去，并去掉 Bearer 凭证。
          throw e instanceof StatecoreCallError ? e : new StatecoreCallError(scrub(errorText(e), null));
        }),
    };
  }

  private async statecoreCall(input: { role: "system" | "user"; content: string }[], signal?: AbortSignal): Promise<string> {
    const cfg = llmConfig(this.d.settings);
    const now = this.d.now();
    this.d.audit.prune(auditCutoff(now, cfg.retentionDays));
    const refusal = statecoreRefusal(cfg);
    if (refusal !== null) this.refuseStatecore(refusal, M().statecoreFullOnly);
    if (signal?.aborted) this.refuseStatecore("quitting", M().appQuitting);
    let url: URL;
    try {
      url = new URL(cfg.baseUrl);
    } catch {
      this.refuseStatecore("bad_base_url", M().badBaseUrl);
    }
    const apiKey = this.d.keys.get();
    // 远程服务必须有 key；保存过但解不开的 key 本机服务也不发。
    if (apiKey === null && (this.d.keys.saved() || !isLoopbackHost(url.hostname))) this.refuseStatecore("no_key", M().noApiKey);
    this.lastStatecoreRefusal = null;

    // 只取 role 和 content 两个字段，其余一概不发。
    const messages: ChatMessage[] = input.map((m) => ({ role: m.role === "system" ? "system" : "user", content: String(m.content) }));
    const body = chatBody({ model: cfg.model, messages, maxTokens: STATECORE_MAX_TOKENS });
    const base = { ts: now, provider: url.host, model: cfg.model, level: "full" as const, source: "statecore" as const };
    const budget = checkBudget({
      prices: cfg.prices, model: cfg.model, budgetUsd: cfg.budgetUsd, spentUsd: this.d.audit.costSince(monthStart(now)),
      inputText: messages.map((m) => m.content).join("\n"), maxOutputTokens: STATECORE_MAX_TOKENS,
    });
    if (!budget.ok) {
      this.d.audit.insert({ ...base, status: "budget", payloadSent: null, error: budget.message });
      throw new StatecoreCallError(budget.message);
    }

    const auditId = this.d.audit.insert({ ...base, status: "pending", payloadSent: body });
    const out = await this.send({
      what: "statecore", cfg, apiKey, messages, maxTokens: STATECORE_MAX_TOKENS, timeoutMs: STATECORE_TIMEOUT_MS, body, auditId,
      price: budget.price, signal, check: () => null,
    });
    if (!out.sent) throw new StatecoreCallError(out.error);
    // 花费没记上就不交出结果：下一次预算检查必须看得到这次的花费。
    if (!out.recorded) throw new StatecoreCallError(M().auditWriteFailed);
    return out.content;
  }

  /** 发送前拒绝一次 StateCore 调用：日志只记原因代码（不含内容和 key），同一个原因连续出现只记一次。 */
  private refuseStatecore(reason: StatecoreRefusal, message: string): never {
    if (this.lastStatecoreRefusal !== reason) {
      this.lastStatecoreRefusal = reason;
      this.log(`statecore call refused: ${reason}`);
    }
    throw new StatecoreCallError(message);
  }

  /** 个人 LLM 是否关闭（档位 off，或没配 base URL / 模型）：调用方据此跳过构建输入，narrate() 用的是同一个判断。 */
  isOff(): boolean {
    return llmOff(llmConfig(this.d.settings));
  }

  /** 日志出错（比如写日志文件失败）不能让 narrate() 抛错，也不能打断审计的收尾。 */
  private log(msg: string, err?: unknown): void {
    try {
      this.d.log?.(msg, err);
    } catch {
      // 忽略。
    }
  }

  private async run(src: NarrativeSource, signal?: AbortSignal): Promise<NarrativeResult> {
    const cfg = llmConfig(this.d.settings);
    const now = this.d.now();
    // 保留期再短也不删本月的记录：本月的花费要留给预算检查。
    this.d.audit.prune(auditCutoff(now, cfg.retentionDays));
    const level = cfg.level;
    // level === "off" 也在 llmOff 里；写出来是为了让 level 的类型收窄。
    if (level === "off" || llmOff(cfg)) return result("off");

    const url = new URL(cfg.baseUrl);
    const loopback = isLoopbackHost(url.hostname);
    const apiKey = this.d.keys.get();
    if (apiKey === null && this.d.keys.saved()) {
      // 保存过但解不开（钥匙串被重置等）：远程服务等同没配置；本机服务也不发（用户本来要带 key，不带只会被拒）。
      this.log("narrative skipped: the saved API key cannot be decrypted");
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
        terms: [...terms.filter((t) => t.category === "term").map((t) => t.term), ...(src.known.terms ?? [])],
      },
      rng,
    );
    // 截断之前的自由文本：截断可能把密钥、邮箱、主机名切成扫描器认不出的半截。
    const untruncated: string[] = [];
    const payload = project(src, level, pseudo, rng, untruncated);
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
    //    自由文本截断前、截断后两个版本都查。full 档位本来就发真实 ticket 号和原文，这两条跳过。
    const masked = level !== "full";
    const hits = uniqueHits([
      ...scanOutbound(collectStrings(payload), { ticketPattern: null, originals: [] }),
      ...scanOutbound([...freeTexts(payload), ...untruncated], {
        ticketPattern: masked ? this.d.settings.get("ticketPattern") : null,
        originals: masked ? pseudo.originals() : [],
      }),
    ]);
    if (hits.length > 0) return result("blocked", this.d.audit.insert({ ...base, status: "blocked", payloadSent: null, blockedReason: hits }));

    // app 正在退出：不确认、不发送，留一条 declined（没有请求体）。
    if (signal?.aborted) return result("failed", this.d.audit.insert({ ...base, status: "declined", error: M().appQuitting }));

    // 4. 写审计（原样的请求体），再按设置请用户确认。
    const auditId = this.d.audit.insert({ ...base, status: "pending", payloadSent: body });
    if (cfg.confirm) {
      const answer = await this.askConfirm(confirmText(chatUrl(cfg.baseUrl), cfg.model, messages), signal);
      if (answer === "error") {
        this.d.audit.finish(auditId, { status: "declined", error: M().confirmFailed });
        return result("failed", auditId);
      }
      if (answer === "no") {
        this.d.audit.finish(auditId, { status: "declined" });
        return result("off", auditId);
      }
    }
    if (signal?.aborted) {
      this.d.audit.finish(auditId, { status: "declined", error: M().appQuitting });
      return result("failed", auditId);
    }

    // 5. 发送、记账、校验、还原。
    let lines: string[] = [];
    const out = await this.send({
      what: "narrative", cfg, apiKey, messages, maxTokens: NARRATIVE_MAX_TOKENS, body, auditId, price: budget.price, signal,
      check: (content) => {
        let error: string | null = M().badResponseShape;
        try {
          const focus = parseNarrative(content);
          lines = (focus ?? []).map((f) => restore(f, pseudo.mapping).text).filter((l) => l.length > 0);
          error = focus === null ? M().badResponseShape : lines.length === 0 ? M().noUsableSentence : null;
        } catch (e) {
          this.log("narrative reply could not be processed", e);
        }
        return error;
      },
    });
    if (!out.sent || !out.recorded || lines.length === 0) return result("failed", auditId);
    return result("ok", auditId, lines.join("\n"));
  }

  /**
   * 发送一次已写好 pending 审计行的请求，并收尾这一行（run() 和 statecoreCall() 共用）。
   * key 只在这里进请求头；错误文本、响应里的 key 都去掉。
   */
  private async send(r: SendRequest): Promise<SendOutcome> {
    const { cfg, apiKey, auditId } = r;
    let res: ChatResponse;
    try {
      res = await (this.d.chat ?? chatCompletion)({
        baseUrl: cfg.baseUrl, apiKey, model: cfg.model, messages: r.messages, maxTokens: r.maxTokens, signal: r.signal,
        ...(r.timeoutMs === undefined ? {} : { timeoutMs: r.timeoutMs }),
      });
    } catch (e) {
      const message = scrub(errorText(e), apiKey);
      this.log(`${r.what} request failed: ${message}`);
      if (e instanceof ProviderError && e.kind === "bad_response" && e.status !== null && e.status >= 200 && e.status < 300) {
        // 服务商以 2xx 收下了请求，只是响应用不了：可能已经计费。没有 usage，按发出的请求体和输出上限保守记账。
        const sentBody = e.sentBody ?? r.body;
        this.record(auditId, { status: "sent", payloadSent: sentBody, ...sentWithoutUsage(r.price, sentBody, r.maxTokens), error: message });
        return { sent: false, error: message };
      }
      // 请求体真的发出去了就记下实际发出的那个（用户要能看到）；确定什么都没发出去时清空 pending 时记的请求体。
      // 不是 ProviderError（不知道发没发）时保留 pending 的请求体：宁可多给用户看。
      const sent = e instanceof ProviderError ? e.sentBody : undefined;
      // 请求体发出去之后超时、被取消或断线：服务商可能已经收下并计费，和启动时清理遗留 pending 一样按请求体和输出上限保守记账。
      // 服务商明确回了非 2xx 的不记：被拒的请求没有生成。
      const maybeBilled =
        e instanceof ProviderError && (e.kind === "timeout" || e.kind === "aborted" || e.kind === "network") && e.sentBody !== null
          ? sentWithoutUsage(r.price, e.sentBody, r.maxTokens)
          : {};
      this.d.audit.finish(auditId, { status: "failed", error: message, ...(sent === undefined ? {} : { payloadSent: sent }), ...maybeBilled });
      return { sent: false, error: message };
    }

    // 记账、校验。provider 已经去掉了 raw / content 里的 key；这里再去一次，换了 chat 实现也成立。
    // 没有 usage 时按实际发出的请求体和收到的内容保守估算。
    const content = scrub(res.content, apiKey);
    const tokensIn = res.tokensIn ?? estimateTokens(res.sentBody);
    const tokensOut = res.tokensOut ?? estimateTokens(content);
    const cost = costUsd(r.price, tokensIn, tokensOut);
    const error = r.check(content);
    const recorded = this.record(auditId, {
      status: "sent",
      payloadSent: res.sentBody,
      response: scrub(res.raw, apiKey),
      tokensIn,
      tokensOut,
      costUsd: cost,
      error,
    });
    return { sent: true, content, recorded };
  }

  /** 发送前确认，和“app 正在退出”赛跑：退出时不再等对话框。 */
  private async askConfirm(text: string, signal?: AbortSignal): Promise<"yes" | "no" | "error" | "aborted"> {
    let resolveAbort: (v: "aborted") => void = () => undefined;
    const aborted = new Promise<"aborted">((r) => (resolveAbort = r));
    const onAbort = () => resolveAbort("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const answer = Promise.resolve()
        .then(() => this.d.confirm(text))
        .then(
          (ok): "yes" | "no" => (ok ? "yes" : "no"),
          (e: unknown): "error" => {
            this.log("confirm dialog failed", e);
            return "error";
          },
        );
      return await Promise.race([answer, aborted]);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * 发出去之后的审计收尾：花费必须记上。第一次写失败就只写状态和花费再试一次；
   * 还是失败就记日志并返回 false（这次结果按 failed 处理）。
   */
  private record(auditId: number, f: AuditFinish & { status: "sent" }): boolean {
    try {
      this.d.audit.finish(auditId, f);
      return true;
    } catch (e) {
      this.log("audit update after send failed", e);
    }
    try {
      this.d.audit.finish(auditId, { status: "sent", costUsd: f.costUsd });
      return true;
    } catch (e) {
      this.log("audit update after send failed again; the cost of this call is not recorded", e);
      return false;
    }
  }
}
