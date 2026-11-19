// 自动接活（工作流 N，设计补充 docs/superpowers/specs/2026-11-17-ws-n-intake-design.md）：
// 拉来源 → 规则分类（判不了的交给 intake_classify）→ 决定（澄清 / 拿不准 / 搁着 / 拆栈 / 排队）→ 后台队列里按并行、花费、内存、同路径冲突开工。
// 只在要人决定时提醒（intake.decision 度量事件 → J 的通知；「现在」页的 intake 提醒）。所有依赖都注入，单测用假的。
import { createHash } from "node:crypto";
import {
  INTAKE_DECISION_STATES, INTAKE_RULES_VERSION,
  type IncomingTicket, type IntakeActResult, type IntakeAction, type IntakeClassification, type IntakeClassifyEdit, type IntakeDim, type IntakeEffect,
  type IntakeItemView, type IntakeNoticeInfo, type IntakePolicy, type IntakeRecentEntry, type IntakeSourceKind, type IntakeState, type IntakeView, type IntakeWaitReason,
} from "../../shared/intake";
import type { ExternalActionKind } from "../../shared/external";
import type { Tier } from "../../shared/model-routing";
import type { ResolvedPrPolicy } from "../../shared/pr-policy";
import type { BgJobContext, BgJobResult } from "../background/queue";
import type { IntakeRecord, IntakeRepo, IntakePatch } from "../db/intake-repo";
import { emptyClassification } from "../db/intake-repo";
import type { RecordEvent } from "../metrics/events";
import type { ModelClassification } from "./model";
import type { IntakePolicyService } from "./policy";
import { classifyByRules, clarifyQuestions, riskAtMost, sizeAtMost } from "./rules";
import { mapRepo, type IntakeSource, type RepoRule } from "./sources";
import { predictConflicts, type RunningWork } from "./conflicts";
import { pickTier } from "./tier";

/** 开 session 失败最多重试几次。 */
export const INTAKE_OPEN_ATTEMPTS = 3;
/** 「现在」页的「自动接活」记录看多久。 */
export const INTAKE_RECENT_MS = 24 * 3600_000;

export type IntakeExternalKind = Extract<ExternalActionKind, "intake_tracker_comment" | "intake_tracker_status">;

export interface IntakeDeps {
  repo: IntakeRepo;
  policies: Pick<IntakePolicyService, "forSlug" | "anyEnabled">;
  sourceKind: () => IntakeSourceKind;
  source: () => IntakeSource | null;
  repoMap: () => RepoRule[];
  slugOf: (repoPath: string) => Promise<string | null>;
  riskPolicy: (slug: string | null) => ResolvedPrPolicy["risk"];
  validKey: (key: string) => boolean;
  /** Butler 里已经有这个 ticket（含归档的）。 */
  ticketExists: (key: string) => boolean;
  classifyModel: (t: IncomingTicket, decided: { size: IntakeClassification["size"]; risk: IntakeClassification["risk"] }, cwd: string) => Promise<ModelClassification | null>;
  lang: () => "zh" | "en";
  /** G 的预审开着（自动开工的前提：开出来的 session 要过预审和证据）。 */
  preReviewOn: () => boolean;
  /** 调度器的闸门（手动暂停、额度）：关着时不拉。 */
  gateOpen: () => boolean;
  enqueue: (key: string) => void;
  /** L 的成本熔断：这个 ticket 的后台活能不能跑。 */
  costAllows: (key: string) => boolean;
  /** 这个 ticket 开着的终端数（休眠的也算）。 */
  openTerminals: (ticketKey: string) => number;
  /** 这个仓库里在跑的 ticket（没归档、有开着的终端或合并闸门的 hold）和它们改过的文件。 */
  activeInRepo: (repoPath: string) => Promise<RunningWork[]>;
  sessionModel: (tier: Tier) => { ok: true; model: string | null } | { ok: false; error: string };
  createTicket: (i: { key: string; title: string; repoPath: string; startPoint: string | null }) => Promise<{ ok: true; repoId: number; branch: string } | { ok: false; exists: boolean; message: string }>;
  /** 已有的 ticket（澄清 session 建的、或者上次建好但没开成）的仓库。 */
  ticketRepo: (ticketKey: string) => { repoId: number; branch: string } | null;
  openSession: (ticketKey: string, repoId: number, model: string | null) => Promise<{ ok: true; termId: string } | { ok: false; message: string }>;
  submit: (termId: string, text: string) => void;
  stack: {
    canStackOn: (repoPath: string, parentBranch: string) => { ok: true } | { ok: false; message: string };
    stackOn: (p: { repoPath: string; parentBranch: string; branch: string }) => Promise<{ ok: true } | { ok: false; message: string }>;
  };
  hasPr: (ticketKey: string) => boolean;
  /** 开工后 PR 的风险和就绪：只读 G 的表。 */
  prOf: (ticketKey: string) => IntakeItemView["pr"];
  external: {
    allowed: (kind: IntakeExternalKind, scope: { repoSlug: string | null; ticketKey: string | null }) => boolean;
    record: (kind: IntakeExternalKind, d: { scope: { repoSlug: string | null; ticketKey: string | null }; target: string | null; summary: string; outcome: "done" | "failed" | "skipped"; error?: string | null }) => void;
  };
  /** 交给开着的 Butler 总控 session；没开着返回 false。 */
  toCoordinator: (text: string) => Promise<boolean>;
  recordEvent: RecordEvent;
  metricEvents: (since: number, kinds: readonly string[]) => { kind: string; ticketKey: string | null; data: Record<string, unknown> | null }[];
  knownRepos: () => { path: string; slug: string | null }[];
  now: () => number;
  log?: (msg: string, err?: unknown) => void;
  onChange?: () => void;
}

const hashOf = (t: IncomingTicket): string => createHash("sha1").update(JSON.stringify(t)).digest("hex");
const samePath = (a: string, b: string): boolean => {
  const n = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" || process.platform === "darwin" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** 这些状态的项不再跟来源同步（已经开工、拆了、跳过、已存在）。 */
const SETTLED: readonly IntakeState[] = ["started", "split", "skipped", "exists"];
/** 这些状态的项还在等开工（后台队列里有它的任务）。 */
const PENDING: readonly IntakeState[] = ["queued", "waiting"];

export class IntakeService {
  private polling = false;
  private lastPollAt: number | null = null;
  private lastPollError: string | null = null;

  constructor(private readonly d: IntakeDeps) {}

  /** 来源配了、至少一层开了。都没有时什么都不做（和以前一样）。 */
  active(): boolean {
    return this.d.sourceKind() !== "none" && this.d.policies.anyEnabled();
  }

  // ------------------------------------------------------------ 拉取

  /** 拉一次来源（定时器和「现在拉一次」）。manual：用户点的，闸门关着也拉。 */
  async poll(o: { manual?: boolean } = {}): Promise<{ ok: true; seen: number } | { ok: false; message: string }> {
    if (!this.active()) return { ok: false, message: "inactive" };
    if (this.polling) return { ok: false, message: "busy" };
    if (!o.manual && !this.d.gateOpen()) return { ok: false, message: "gated" };
    const src = this.d.source();
    if (!src) return { ok: false, message: "no source" };
    this.polling = true;
    this.d.onChange?.();
    try {
      const r = await src.fetch();
      this.lastPollAt = this.d.now();
      if (!r.ok) {
        this.lastPollError = r.message;
        return { ok: false, message: r.message };
      }
      this.lastPollError = null;
      for (const t of r.tickets) {
        try {
          await this.ingest(t, src.kind);
        } catch (e) {
          this.d.log?.(`intake: ingesting ${t.key} failed`, e);
        }
      }
      return { ok: true, seen: r.tickets.length };
    } finally {
      this.polling = false;
      this.d.onChange?.();
    }
  }

  /** 来源里的一个 ticket：新的就分类、决定；内容变了且还没开工就重新分类（用户改过的维度留着）。 */
  async ingest(raw: IncomingTicket, source: IntakeSourceKind, parent?: { key: string; layer: number }): Promise<void> {
    const t = { ...raw, key: raw.key.trim().toUpperCase() };
    if (!this.d.validKey(t.key)) return;
    const hash = hashOf(t);
    const ex = this.d.repo.get(t.key);
    if (ex && SETTLED.includes(ex.state)) return;
    if (ex && ex.contentHash === hash && ex.state !== "needs_repo") return;
    const now = this.d.now();
    const repoPath = mapRepo(t, this.d.repoMap()) ?? (parent ? (this.d.repo.get(parent.key)?.repoPath ?? null) : null);
    const slug = repoPath ? await this.d.slugOf(repoPath).catch(() => null) : null;
    const policy = this.d.policies.forSlug(slug);
    // 映射到没开的仓库：不记（总开关关着就和以前一样）。映射不到：有任何一层开着才记下来问你。
    if (repoPath && !policy.enabled && !ex) return;
    const base: IntakeRecord = ex ?? {
      key: t.key, source, title: t.title, url: t.url, contentHash: hash, payload: t, repoPath, repoSlug: slug, state: "held", waitReason: null, detail: null,
      classification: emptyClassification(), userDims: [], tier: null, model: null, allowParallel: false, forceStart: false, parentKey: parent?.key ?? null,
      layer: parent?.layer ?? null, ticketKey: null, attempts: 0, alertedAt: null, firstSeenAt: now, updatedAt: now, startedAt: null,
    };
    if (!ex) {
      if (this.d.ticketExists(t.key)) {
        this.d.repo.insert({ ...base, state: "exists", detail: null });
        return;
      }
      this.d.repo.insert(base);
    }
    const rec: IntakeRecord = { ...base, title: t.title, url: t.url, contentHash: hash, payload: t, repoPath, repoSlug: slug, attempts: 0 };
    this.d.repo.update(t.key, { title: t.title, url: t.url, contentHash: hash, payload: t, repoPath, repoSlug: slug, attempts: 0, updatedAt: now });
    if (!repoPath) {
      this.setState(rec, "needs_repo", null, null);
      return;
    }
    await this.classify(rec, policy);
    await this.decide(t.key);
  }

  // ------------------------------------------------------------ 分类

  private async classify(rec: IntakeRecord, policy: IntakePolicy): Promise<void> {
    const t = rec.payload;
    const r = classifyByRules(t, this.d.riskPolicy(rec.repoSlug));
    const prev = rec.classification;
    const user = new Set(rec.userDims);
    const c: IntakeClassification = {
      size: r.size, risk: r.risk, clarify: r.clarify, missing: r.missing, questions: clarifyQuestions(r.missing, this.d.lang()),
      expectedPaths: r.expectedPaths, reasons: r.reasons, source: "rules", rulesVersion: INTAKE_RULES_VERSION, confidence: null, model: null,
    };
    // 用户改过的维度以用户为准。
    if (user.has("size")) c.size = prev.size;
    if (user.has("risk")) c.risk = prev.risk;
    if (user.has("clarify")) c.clarify = prev.clarify;
    const undecided = (["size", "risk"] as const).filter((dim) => c[dim] === null);
    // 要先澄清的不调模型（反正不会开工；补完信息再分）。
    if (undecided.length > 0 && !c.clarify && rec.repoPath) {
      const m = await this.d.classifyModel(t, { size: c.size, risk: c.risk }, rec.repoPath).catch(() => null);
      if (m) {
        c.size = m.size;
        c.risk = m.risk;
        c.confidence = m.confidence;
        c.model = m.model;
        c.source = undecided.length === 2 ? "model" : "mixed";
        c.expectedPaths = [...new Set([...c.expectedPaths, ...m.expectedPaths])].slice(0, 50);
        for (const why of m.reasons) c.reasons.push({ dim: undecided.length === 2 ? "size" : undecided[0]!, rule: "model", detail: why });
      } else {
        c.reasons.push({ dim: undecided[0]!, rule: "model_failed", detail: "" });
      }
    }
    if (c.confidence !== null && c.confidence < policy.uncertainBelow) c.reasons.push({ dim: "size", rule: "low_confidence", detail: c.confidence.toFixed(2) });
    this.d.repo.update(rec.key, { classification: c, updatedAt: this.d.now() });
    this.d.recordEvent("intake.classified", { ticketKey: rec.key, repoSlug: rec.repoSlug, data: { via: c.source }, dedupeKey: `intake.classified:${rec.key}:${rec.contentHash}` });
  }

  /** 拿不准：大小或风险没判出来，或模型的把握低于阈值（用户把两个都改过了就不算）。 */
  private uncertain(r: IntakeRecord, p: IntakePolicy): boolean {
    const c = r.classification;
    if (c.size === null || c.risk === null) return true;
    const userBoth = r.userDims.includes("size") && r.userDims.includes("risk");
    return !userBoth && c.confidence !== null && c.confidence < p.uncertainBelow;
  }

  // ------------------------------------------------------------ 决定

  /** 按设计 §5 的顺序决定这一项去哪：澄清、拿不准、搁着、拆栈、排队。 */
  async decide(key: string): Promise<void> {
    const r = this.d.repo.get(key);
    if (!r || SETTLED.includes(r.state) || r.state === "needs_repo") return;
    const p = this.d.policies.forSlug(r.repoSlug);
    const c = r.classification;
    if (c.clarify) {
      const entering = r.state !== "needs_clarification";
      this.setState(r, "needs_clarification", null, c.missing.join(", "));
      if (entering) await this.askClarification(this.d.repo.get(key)!, p);
      return;
    }
    if (this.uncertain(r, p)) return this.setState(r, "needs_decision", null, null);
    const size = c.size!;
    const risk = c.risk!;
    const tier = pickTier(size, risk, p);
    this.d.repo.update(key, { tier });
    if (!r.forceStart) {
      const hold: IntakeWaitReason | null =
        !p.enabled || !p.autoStart ? "auto_off" : !sizeAtMost(size, p.maxSize) ? "too_large" : !riskAtMost(risk, p.maxRisk) ? "too_risky" : !this.d.preReviewOn() ? "prereview_off" : null;
      if (hold) return this.setState(r, "held", hold, null);
    }
    if (size === "large" && r.parentKey === null && p.stackSubtasks && r.payload.subtasks.length >= 2) return this.split(r);
    if (!PENDING.includes(r.state)) {
      this.setState(r, "queued", null, null);
      this.d.recordEvent("intake.queued", { ticketKey: key, repoSlug: r.repoSlug, dedupeKey: `intake.queued:${key}:${this.d.now()}` });
    }
    this.d.enqueue(key);
  }

  /** 大 ticket 按来源里的子任务拆成 K 的栈：一层一个子任务，第 k 层等第 k-1 层。 */
  private async split(r: IntakeRecord): Promise<void> {
    this.setState(r, "split", null, r.payload.subtasks.map((s) => s.key).join(", "));
    this.d.recordEvent("intake.split", { ticketKey: r.key, repoSlug: r.repoSlug, data: { layers: r.payload.subtasks.length }, dedupeKey: `intake.split:${r.key}` });
    let layer = 0;
    for (const s of r.payload.subtasks) {
      layer++;
      const child: IncomingTicket = {
        ...r.payload, key: s.key, title: s.title, subtasks: [], storyPoints: null, url: null, repo: r.repoPath,
        description: `${s.title}\n\n(${r.key} ${r.payload.title}, ${layer}/${r.payload.subtasks.length})\n\n${r.payload.description}`,
      };
      try {
        await this.ingest(child, r.source, { key: r.key, layer });
      } catch (e) {
        this.d.log?.(`intake: subtask ${s.key} of ${r.key} failed`, e);
      }
    }
  }

  // ------------------------------------------------------------ 澄清

  private clarifyText(r: IntakeRecord, mode: "session" | "coordinator"): string {
    const en = this.d.lang() === "en";
    const qs = r.classification.questions.map((q) => `- ${q}`).join("\n");
    const ref = r.url ? `${r.key} (${r.url})` : r.key;
    return en
      ? `Ticket ${ref} "${r.title}" is missing information before work can start. Using the issue tracker tools, post these questions as one comment on the ticket${mode === "session" ? ", then stop and do not start coding" : ""}:\n${qs}`
      : `ticket ${ref}「${r.title}」开工前还缺信息。用 tracker 工具在这个 ticket 上发一条评论问下面这些${mode === "session" ? "，发完就停，不要开始写代码" : ""}：\n${qs}`;
  }

  /** 缺信息时（设计 §6.1）：只提醒（默认）、开个小 session 回 tracker 提问、交给 Butler 总控去问。后两种要 intake_tracker_comment 开着。 */
  private async askClarification(r: IntakeRecord, p: IntakePolicy): Promise<void> {
    const scope = { repoSlug: r.repoSlug, ticketKey: r.key };
    let mode: "notify" | "session" | "coordinator" = p.clarifyMode;
    if (mode !== "notify" && !this.d.external.allowed("intake_tracker_comment", scope)) {
      this.d.external.record("intake_tracker_comment", { scope, target: r.url, summary: `ask ${r.key} for ${r.classification.missing.join(", ")}`, outcome: "skipped" });
      mode = "notify";
    }
    if (mode === "coordinator") {
      const sent = await this.d.toCoordinator(this.clarifyText(r, "coordinator")).catch(() => false);
      if (sent) this.d.external.record("intake_tracker_comment", { scope, target: r.url, summary: `asked the coordinator to comment on ${r.key}`, outcome: "done" });
      else mode = "notify";
    } else if (mode === "session") {
      const ok = await this.openFor(r, "low_tier", this.clarifyText(r, "session"), p.tierSmall).catch((e: unknown) => ({ ok: false as const, message: String(e) }));
      this.d.external.record("intake_tracker_comment", {
        scope, target: r.url, summary: `opened a session to comment on ${r.key}`, outcome: ok.ok ? "done" : "failed", error: ok.ok ? null : ok.message,
      });
      if (!ok.ok) mode = "notify";
    }
    this.d.recordEvent("intake.clarify", { ticketKey: r.key, repoSlug: r.repoSlug, data: { mode }, dedupeKey: `intake.clarify:${r.key}:${r.contentHash}` });
  }

  // ------------------------------------------------------------ 开工（后台队列）

  /** 后台队列 intake 的处理函数：按花费、栈、并行、冲突、内存依次判断，都过了就开工。 */
  async handle(ctx: BgJobContext): Promise<BgJobResult> {
    const key = (ctx.payload as { key?: unknown } | null)?.key;
    if (typeof key !== "string") return { done: true };
    const r = this.d.repo.get(key);
    if (!r || !PENDING.includes(r.state)) return { done: true };
    const p = this.d.policies.forSlug(r.repoSlug);
    if (!p.enabled && !r.forceStart) {
      this.setState(r, "held", "auto_off", null);
      return { done: true };
    }
    const wait = (reason: IntakeWaitReason, detail: string | null = null): BgJobResult => {
      this.setState(r, "waiting", reason, detail);
      return { defer: true, reason };
    };
    if (!this.d.costAllows(key)) return wait("cost");

    // 栈的上层：等下面那层开了 PR，或者它开的 session 都结束了。
    let startPoint: string | null = null;
    let parentBranch: string | null = null;
    if (r.parentKey && r.layer !== null && r.layer > 1) {
      const below = this.d.repo.children(r.parentKey).find((c) => c.layer === r.layer! - 1);
      if (!below || below.state !== "started" || !below.ticketKey) return wait("stack", below?.key ?? null);
      if (!this.d.hasPr(below.ticketKey) && this.d.openTerminals(below.ticketKey) > 0) return wait("stack", below.key);
      const br = this.d.ticketRepo(below.ticketKey);
      if (!br || !r.repoPath) return wait("stack", below.key);
      const can = this.d.stack.canStackOn(r.repoPath, br.branch);
      if (!can.ok) return wait("stack", can.message);
      startPoint = br.branch;
      parentBranch = br.branch;
    }

    // 并行上限：只算由接活自动开的、session 还开着的。
    if (!r.forceStart) {
      const running = this.runningAuto();
      if (running.length >= p.maxParallel) return wait("parallel", String(running.length));
    }

    // 同仓库同路径：串行（默认），或者照样并行只记一笔。
    if (r.repoPath && !r.allowParallel) {
      const active = await this.d.activeInRepo(r.repoPath).catch(() => [] as RunningWork[]);
      // 同一个大 ticket 拆出来的层本来就叠在一起（下一层从上一层的分支开），不算冲突。
      const sibling = (k: string) => r.parentKey !== null && this.d.repo.get(k)?.parentKey === r.parentKey;
      const withExpected = active.filter((a) => a.key !== key && !sibling(a.key)).map((a) => ({ key: a.key, paths: [...a.paths, ...(this.d.repo.get(a.key)?.classification.expectedPaths ?? [])] }));
      const hits = predictConflicts(r.classification.expectedPaths, withExpected);
      if (hits.length > 0) {
        const detail = hits.map((h) => `${h.key}: ${h.paths.join(", ")}`).join("; ").slice(0, 400);
        if (p.conflictAction === "serialize") return wait("conflict", detail);
        this.d.repo.update(key, { detail });
      }
    }

    const room = await ctx.admitSession(`intake ${key}`);
    if (!room.ok) return wait("memory", room.reason);
    const res = await this.openFor(r, r.forceStart ? "manual" : "auto", this.taskText(r, p), r.tier ?? pickTier(r.classification.size ?? "medium", r.classification.risk ?? "medium", p), { startPoint, parentBranch });
    if (res.ok) {
      room.opened();
      return { done: true };
    }
    if (res.retry && r.attempts + 1 < INTAKE_OPEN_ATTEMPTS) {
      this.d.repo.update(key, { attempts: r.attempts + 1 });
      return wait("retry", res.message);
    }
    this.setState(this.d.repo.get(key) ?? r, res.exists ? "exists" : "failed", null, res.message);
    return { done: true };
  }

  /** 由接活自动开的、session 还开着的项。 */
  private runningAuto(): IntakeRecord[] {
    return this.d.repo.byState(["started"]).filter((x) => !x.forceStart && x.ticketKey !== null && this.d.openTerminals(x.ticketKey) > 0);
  }

  private taskText(r: IntakeRecord, p: IntakePolicy): string {
    const en = this.d.lang() === "en";
    const t = r.payload;
    const scope = { repoSlug: r.repoSlug, ticketKey: r.key };
    const status = this.d.external.allowed("intake_tracker_status", scope);
    this.d.external.record("intake_tracker_status", { scope, target: r.url, summary: `mark ${r.key} in progress`, outcome: status ? "done" : "skipped" });
    void p;
    const lines = [
      en ? `Work on ticket ${t.key}: ${t.title}` : `做 ticket ${t.key}：${t.title}`,
      t.url ? t.url : null,
      "",
      t.description,
      status ? "" : null,
      status ? (en ? "First, use the issue tracker tools to move this ticket to In Progress." : "先用 tracker 工具把这个 ticket 的状态改成进行中。") : null,
    ];
    return lines.filter((l) => l !== null).join("\n");
  }

  /** 建 ticket（已有就用已有的）、选模型、开 session、交任务。 */
  private async openFor(
    r: IntakeRecord, mode: "auto" | "manual" | "low_tier", text: string, tier: Tier, o: { startPoint?: string | null; parentBranch?: string | null } = {},
  ): Promise<{ ok: true } | { ok: false; message: string; retry: boolean; exists: boolean }> {
    if (!r.repoPath) return { ok: false, message: "no repo", retry: false, exists: false };
    const m = this.d.sessionModel(tier);
    if (!m.ok) return { ok: false, message: m.error, retry: false, exists: false };
    let repo = r.ticketKey ? this.d.ticketRepo(r.ticketKey) : null;
    if (!repo) {
      if (this.d.ticketExists(r.key)) return { ok: false, message: "exists", retry: false, exists: true };
      const c = await this.d.createTicket({ key: r.key, title: r.title, repoPath: r.repoPath, startPoint: o.startPoint ?? null });
      if (!c.ok) return { ok: false, message: c.message, retry: false, exists: c.exists };
      repo = { repoId: c.repoId, branch: c.branch };
      this.d.repo.update(r.key, { ticketKey: r.key });
      if (o.parentBranch) {
        const s = await this.d.stack.stackOn({ repoPath: r.repoPath, parentBranch: o.parentBranch, branch: c.branch }).catch((e: unknown) => ({ ok: false as const, message: String(e) }));
        if (!s.ok) this.d.log?.(`intake: stacking ${r.key} on ${o.parentBranch} failed: ${s.message}`);
      }
    }
    const opened = await this.d.openSession(r.key, repo.repoId, m.model).catch((e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }));
    if (!opened.ok) return { ok: false, message: opened.message, retry: true, exists: false };
    this.d.submit(opened.termId, text);
    if (mode === "low_tier") return { ok: true };
    const now = this.d.now();
    const cur = this.d.repo.get(r.key) ?? r;
    this.setState(cur, "started", null, cur.detail, { startedAt: now, ticketKey: r.key, model: m.model, tier });
    this.d.recordEvent("intake.started", { ticketKey: r.key, repoSlug: r.repoSlug, data: { mode, tier }, dedupeKey: `intake.started:${r.key}` });
    return { ok: true };
  }

  /** session 结束了（名额可能空出来、栈的下一层可能能开了）：延后着的马上再试。 */
  sessionEnded(wake: () => void): void {
    if (this.d.repo.byState(["waiting"]).length > 0) wake();
  }

  // ------------------------------------------------------------ 状态和提醒

  private setState(r: IntakeRecord, state: IntakeState, reason: IntakeWaitReason | null, detail: string | null, extra: IntakePatch = {}): void {
    const now = this.d.now();
    const changed = r.state !== state || r.waitReason !== reason;
    const alertable = INTAKE_DECISION_STATES.includes(state) || (state === "waiting" && reason === "conflict");
    let alertedAt = changed ? null : r.alertedAt;
    if (alertable && alertedAt === null) {
      alertedAt = now;
      this.d.recordEvent("intake.decision", {
        ticketKey: r.key, repoSlug: r.repoSlug, data: { state, ...(reason && { reason }) }, dedupeKey: `intake.decision:${r.key}:${state}:${reason ?? ""}:${now}`,
      });
    }
    const patch: IntakePatch = { state, waitReason: reason, detail, alertedAt, updatedAt: changed ? now : r.updatedAt, ...extra };
    this.d.repo.update(r.key, patch);
    Object.assign(r, patch);
    if (changed) this.d.onChange?.();
  }

  // ------------------------------------------------------------ 用户操作

  async act(a: IntakeAction): Promise<IntakeActResult> {
    const r = this.d.repo.get(a.key);
    if (!r) return { ok: false, message: "not_found" };
    switch (a.op) {
      case "start": {
        if (r.state === "started" || r.state === "split") return { ok: false, message: "already" };
        if (r.state === "needs_repo" || !r.repoPath) return { ok: false, message: "no_repo" };
        if (r.classification.size === null || r.classification.risk === null) return { ok: false, message: "unclassified" };
        this.d.repo.update(r.key, { forceStart: true, attempts: 0 });
        this.setState(r, "queued", "manual", null);
        this.d.enqueue(r.key);
        return { ok: true };
      }
      case "skip":
        this.setState(r, "skipped", null, null);
        return { ok: true };
      case "allowParallel":
        this.d.repo.update(r.key, { allowParallel: true });
        if (PENDING.includes(r.state)) this.d.enqueue(r.key);
        return { ok: true };
      case "retry":
        if (r.state !== "failed") return { ok: false, message: "not_failed" };
        this.d.repo.update(r.key, { attempts: 0, contentHash: "" });
        this.setState(r, "held", null, null);
        await this.decide(r.key);
        return { ok: true };
      case "clarified":
        // 信息补上了：下次拉取按新内容重新分类（现在就拉一次）。
        this.d.repo.update(r.key, { contentHash: "" });
        void this.poll({ manual: true });
        return { ok: true };
      case "setRepo": {
        const slug = await this.d.slugOf(a.repoPath).catch(() => null);
        this.d.repo.update(r.key, { repoPath: a.repoPath, repoSlug: slug, payload: { ...r.payload, repo: a.repoPath }, contentHash: "" });
        const rec = this.d.repo.get(r.key)!;
        this.setState(rec, "held", null, null);
        await this.classify(rec, this.d.policies.forSlug(slug));
        await this.decide(r.key);
        return { ok: true };
      }
    }
  }

  /** 用户改分类：每一维的改动记进 intake_overrides（带规则版本，校准用），然后重新决定。 */
  async editClassification(e: IntakeClassifyEdit): Promise<IntakeActResult> {
    const r = this.d.repo.get(e.key);
    if (!r) return { ok: false, message: "not_found" };
    if (r.state === "started" || r.state === "split") return { ok: false, message: "already" };
    const c = { ...r.classification };
    const dims = new Set<IntakeDim>(r.userDims);
    const now = this.d.now();
    const change = (dim: IntakeDim, from: string | null, to: string) => {
      if (from === to) return;
      this.d.repo.addOverride({ itemKey: r.key, dim, from, to, rulesVersion: c.rulesVersion, classSource: c.source, at: now });
      this.d.recordEvent("intake.overridden", { ticketKey: r.key, repoSlug: r.repoSlug, data: { via: dim, from, to }, dedupeKey: `intake.overridden:${r.key}:${dim}:${now}` });
      dims.add(dim);
    };
    if (e.size) {
      change("size", c.size, e.size);
      c.size = e.size;
    }
    if (e.risk) {
      change("risk", c.risk, e.risk);
      c.risk = e.risk;
    }
    if (e.clarify !== undefined) {
      change("clarify", String(c.clarify), String(e.clarify));
      c.clarify = e.clarify;
    }
    c.reasons = [...c.reasons.filter((x) => !(x.rule === "user" && dims.has(x.dim as IntakeDim))), ...[...dims].map((dim) => ({ dim, rule: "user", detail: String(c[dim]) }))];
    this.d.repo.update(r.key, { classification: c, userDims: [...dims], updatedAt: now });
    if (r.state !== "needs_repo") await this.decide(r.key);
    this.d.onChange?.();
    return { ok: true };
  }

  // ------------------------------------------------------------ 视图

  private toView(r: IntakeRecord): IntakeItemView {
    return {
      key: r.key, title: r.title, url: r.url, source: r.source, repoPath: r.repoPath, repoSlug: r.repoSlug, state: r.state, waitReason: r.waitReason, detail: r.detail,
      classification: r.classification, userDims: r.userDims, tier: r.tier, model: r.model, allowParallel: r.allowParallel, parentKey: r.parentKey, layer: r.layer,
      ticketKey: r.ticketKey, pr: r.ticketKey ? this.d.prOf(r.ticketKey) : null, firstSeenAt: r.firstSeenAt, updatedAt: r.updatedAt, startedAt: r.startedAt,
    };
  }

  view(): IntakeView {
    const items = this.d.repo.list(300).filter((r) => r.state !== "exists").map((r) => this.toView(r));
    return {
      active: this.active(), source: this.d.sourceKind(), preReviewOn: this.d.preReviewOn(), lastPollAt: this.lastPollAt, lastPollError: this.lastPollError,
      polling: this.polling, running: this.runningAuto().length, items, repos: this.d.knownRepos(),
    };
  }

  /** 「现在」页的提醒：要你决定的项（每项一条）。 */
  notices(): IntakeNoticeInfo[] {
    if (!this.active() && this.d.repo.byState(["needs_repo", "needs_clarification", "needs_decision", "failed", "waiting"]).length === 0) return [];
    return this.d.repo
      .byState(["needs_repo", "needs_clarification", "needs_decision", "failed", "waiting"])
      .filter((r) => r.state !== "waiting" || r.waitReason === "conflict")
      .map((r) => ({ key: r.key, title: r.title, state: r.state, reason: r.waitReason, detail: r.detail, url: r.url }));
  }

  /** 「现在」页的「自动接活」记录：最近 24 小时自动做了什么（不用你管的那些）。 */
  recent(): IntakeRecentEntry[] {
    const since = this.d.now() - INTAKE_RECENT_MS;
    const what: Partial<Record<IntakeState, IntakeRecentEntry["what"]>> = { started: "started", queued: "queued", waiting: "waiting", held: "held", split: "split" };
    return this.d.repo
      .list(200)
      .filter((r) => r.updatedAt >= since && what[r.state] && !(r.state === "waiting" && r.waitReason === "conflict"))
      .map((r) => ({ at: r.updatedAt, key: r.key, what: what[r.state]!, detail: r.waitReason ?? r.tier ?? null }))
      .slice(0, 30);
  }

  /** 「效果」页的卡片：分类了多少、自动开了多少、用户改分类的比例（校准规则用）。 */
  effect(days: number): IntakeEffect {
    const since = this.d.now() - days * 86_400_000;
    const ev = this.d.metricEvents(since, ["intake.classified", "intake.started", "intake.clarify", "intake.decision"]);
    const keys = (kind: string, f: (d: Record<string, unknown> | null) => boolean = () => true) =>
      new Set(ev.filter((e) => e.kind === kind && e.ticketKey && f(e.data)).map((e) => e.ticketKey!)).size;
    const classified = keys("intake.classified");
    const ov = this.d.repo.overrides(since);
    const overriddenItems = new Set(ov.map((o) => o.itemKey)).size;
    return {
      days, classified,
      autoStarted: keys("intake.started", (d) => d?.mode === "auto"),
      manualStarted: keys("intake.started", (d) => d?.mode === "manual"),
      clarify: keys("intake.clarify"),
      decisions: ev.filter((e) => e.kind === "intake.decision").length,
      overriddenItems,
      overrideRate: classified > 0 ? Math.min(1, overriddenItems / classified) : null,
      byDim: (["size", "risk", "clarify"] as const).map((dim) => ({ dim, n: ov.filter((o) => o.dim === dim).length })),
    };
  }

  /** 设置页「已知仓库」用：映射里写了的路径。 */
  static mappedPaths(rules: readonly RepoRule[]): string[] {
    const out: string[] = [];
    for (const r of rules) if (!out.some((p) => samePath(p, r.path))) out.push(r.path);
    return out;
  }
}
