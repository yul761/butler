import type { LimitHit } from "../../shared/availability";
import { TASKS, tierRank, type EffortLevel, type RouteEventKind, type SpendLevel, type TaskId, type Tier } from "../../shared/model-routing";
import type { ClaudeResult, HeadlessFailure, HeadlessOutcome, HeadlessRun } from "../claude/headless";
import { headlessEnv } from "../claude/spawn";
import type { SessionsRepo } from "../db/sessions-repo";
import type { Candidate, Plan } from "../routing/router";
import { M } from "../strings";
import type { UsageCounts } from "../usage/usage-parse";
import { pickStructured } from "./schema";

/** 执行层用到的路由服务部分（RoutingService 实现；测试里可以换成假的）。 */
export interface ExecRouting {
  plan: (task: TaskId, ctx: { sessionModel?: string | null; producer?: Candidate | null; minLevel?: SpendLevel }) => Plan;
  usable: (model: string) => boolean;
  /** 模型路由的注册表里有这个名字（停用的也算；记下的 session 模型要靠它认）。 */
  registered: (model: string) => boolean;
  effortFor: (task: TaskId, tier: Tier | null) => EffortLevel | null;
  flags: () => { model: boolean; effort: boolean };
  acquire: (tier: Tier | null) => Promise<() => void>;
  onLimit: (model: string, hit: LimitHit, o: { task: TaskId | null; accountLevel: boolean; tier?: Tier | null }) => string[];
  onSuccess: (model: string, startedAt: number) => void;
  onFailure: (model: string | null, text: string, apiStatus: number | null, task: TaskId | null) => LimitHit | null;
  event: (kind: RouteEventKind, e: { task?: string | null; model?: string | null; toModel?: string | null; detail?: string | null }) => void;
}

/** 这次调用实际怎么跑的（写进用量和运行记录；D 读 fallbackFrom）。 */
export interface RouteInfo {
  task: TaskId;
  requestedTier: Tier | null;
  /** 实际传给 --model 的（null 是没传，用的默认模型）。 */
  actualModel: string | null;
  /** 结果是降级来的：第一个试的模型。 */
  fallbackFrom: string | null;
  /** 实际模型的档位低于要求的档位。 */
  degraded: boolean;
  sameModelReview: boolean;
}

export interface UsageReport {
  runId: string;
  label: string;
  at: number;
  model: string | null;
  usage: UsageCounts;
  task?: TaskId;
  requestedTier?: Tier | null;
  fallbackFrom?: string | null;
  costUsd?: number | null;
  /** 归到哪个 ticket（成本熔断按 ticket 汇总，工作流 L）；不归 ticket 为 null。 */
  ticketKey?: string | null;
}

/** 成本熔断（工作流 L）对一次后台调用的回答：照常、按降档规划（路由器当作 soft）、不跑。 */
export type CostVerdict = "ok" | "downgrade" | "pause";

/** 跑一次 headless claude 要的依赖（ticket handoff 和 feature 汇总共用）。 */
export interface HeadlessExecDeps {
  run: HeadlessRun;
  /** 首次 health 探测完成后 resolve。 */
  ready: () => Promise<void>;
  claude: () => { path: string | null; pathValue: string };
  baseEnv: NodeJS.ProcessEnv;
  sessions: SessionsRepo;
  now: () => number;
  newRunId: () => string;
  timeoutMs?: number;
  /** 退出 app 时取消所有进行中的 headless 运行：被取消的运行不写入任何东西，也不算限流。 */
  signal?: AbortSignal;
  /** 每次运行（含失败的）带回用量时调用。 */
  onUsage?: (u: UsageReport) => void;
  /** 没走路由（没传 --model 或没配置路由）的调用失败里带限流 / 模型不可用时调用；job 是 jobOf(label)。抛错只记日志。 */
  onLimit?: (hit: LimitHit, job: string) => void;
  /** 没走路由的调用成功时调用；startedAt 是这次运行开始的时间（比限流记录早的成功说明不了现在）。抛错只记日志。 */
  onSuccess?: (startedAt: number, job: string) => void;
  /** 模型路由；没有时每个任务用 2.1.0 的模型，不降级。 */
  routing?: ExecRouting;
  /** 成本熔断（工作流 L）：这个 ticket 的后台调用现在能不能跑、要不要降档。没接时一律照常。 */
  costGate?: (o: { task: TaskId; ticketKey: string | null; label: string }) => CostVerdict;
  log?: (msg: string, err?: unknown) => void;
}

export type HeadlessExecResult =
  | { ok: true; value: unknown; rawText: string; result: ClaudeResult; route: RouteInfo }
  | {
      ok: false; reason: HeadlessFailure | "claude_missing" | "cost_paused"; message: string; limit: LimitHit | null; stderr: string; result: ClaudeResult | null; rawText: string | null;
      route: RouteInfo;
      /** 链走完了 / 一开始就没有能用的模型：预计什么时候能再跑（不知道为 null）。 */
      waitUntil?: number | null;
    };

export interface ExecOptions {
  task: TaskId;
  label: string;
  args: string[];
  prompt: string;
  cwd: string;
  resumedId?: string;
  /** session 任务（handoff、feature 汇总）：被 fork 的 session 的模型。 */
  sessionModel?: string | null;
  /** 评审任务：产出方的模型和档位。 */
  producer?: Candidate | null;
  /** 只用这个模型、不走路由、不回报健康（模型探测用）。 */
  forceModel?: string;
  /** 这次调用是为哪个 ticket 做的：用量记到它名下，成本熔断按它判断（工作流 L）。 */
  ticketKey?: string | null;
}

/** 去掉 label 末尾的 ticket 号或数字：“handoff BTL-1” → “handoff”，“feature summary 3” → “feature summary”。 */
export function jobOf(label: string): string {
  return label.replace(/\s+(?:[A-Za-z][A-Za-z0-9]*-\d+|\d+)$/, "");
}

/** 把 --model（和 --effort）插到 -p 后面；args 里原来的 --model / --effort 去掉。 */
export function withModel(args: string[], model: string | null, effort: EffortLevel | null): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" || args[i] === "--effort") {
      i++;
      continue;
    }
    out.push(args[i]!);
  }
  const extra = [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];
  const p = out.indexOf("-p");
  out.splice(p >= 0 ? p + 1 : 0, 0, ...extra);
  return out;
}

const NO_RETRY: ReadonlySet<HeadlessFailure> = new Set(["timeout", "spawn_failed", "aborted", "bad_output"]);
const LEARN_FROM: ReadonlySet<HeadlessFailure> = new Set(["claude_error", "exit_nonzero"]);

/** 跑一次 headless claude，取出结构化输出。限流时 reason 是 rate_limited。配置了路由时按任务挑模型、撞限降级重试。 */
export async function execHeadlessJson(d: HeadlessExecDeps, o: ExecOptions): Promise<HeadlessExecResult> {
  const def = TASKS[o.task];
  const baseRoute: RouteInfo = { task: o.task, requestedTier: def.tier === "session" ? null : def.tier, actualModel: null, fallbackFrom: null, degraded: false, sameModelReview: false };
  await d.ready();
  const { path, pathValue } = d.claude();
  if (!path) return { ok: false, reason: "claude_missing", message: M().claudeMissing, limit: null, stderr: "", result: null, rawText: null, route: baseRoute };
  const job = jobOf(o.label);
  let verdict: CostVerdict = "ok";
  if (d.costGate && !o.forceModel) {
    try {
      verdict = d.costGate({ task: o.task, ticketKey: o.ticketKey ?? null, label: o.label });
    } catch (e) {
      d.log?.(`${o.label}: cost gate threw`, e);
    }
  }
  if (verdict === "pause") {
    d.log?.(`${o.label}: not run, the cost breaker paused background work for ${o.ticketKey ?? "this ticket"}`);
    return { ok: false, reason: "cost_paused", message: M().costPausedHeadless, limit: null, stderr: "", result: null, rawText: null, route: baseRoute };
  }
  const minLevel: SpendLevel | undefined = verdict === "downgrade" ? "soft" : undefined;
  const hook = (name: string, f: () => void) => {
    try {
      f();
    } catch (e) {
      d.log?.(`${o.label}: ${name} threw`, e);
    }
  };
  const r = d.routing;

  const runOnce = async (model: string | null, tier: Tier | null, extra: Partial<UsageReport>): Promise<{ out: HeadlessOutcome; startedAt: number }> => {
    const flags = r?.flags() ?? { model: true, effort: false };
    const effort = r && model !== null ? r.effortFor(o.task, tier) : null;
    const args = withModel(o.args, flags.model ? model : null, flags.effort ? effort : null);
    const runId = d.newRunId();
    const release = r ? await r.acquire(tier) : () => undefined;
    const startedAt = d.now();
    let out: HeadlessOutcome;
    try {
      out = await d.run({
        claudePath: path, args, prompt: o.prompt, cwd: o.cwd,
        env: headlessEnv(d.baseEnv, { pathValue, runId }),
        timeoutMs: d.timeoutMs,
        signal: d.signal,
      });
    } finally {
      release();
    }
    // 失败的运行也花了 token：判断 ok 之前先记。
    const usage = out.result?.usage;
    if (usage) {
      const u: UsageReport = { runId, label: o.label, at: d.now(), model: out.result?.model ?? null, usage, ...(o.ticketKey && { ticketKey: o.ticketKey }) };
      if (r) Object.assign(u, { task: o.task, costUsd: out.result?.costUsd ?? null, ...extra });
      hook("onUsage", () => d.onUsage?.(u));
    }
    const sid = out.result?.sessionId;
    // 返回的 id 就是被恢复的真实 session 时，绝不能把它记成 headless。
    if (sid && sid !== o.resumedId) d.sessions.recordHeadless(sid, o.cwd, d.now());
    return { out, startedAt };
  };
  const failed = (out: Extract<HeadlessOutcome, { ok: false }>, route: RouteInfo, limit: LimitHit | null = out.limit, waitUntil?: number | null): HeadlessExecResult => {
    const rawText = out.result ? out.result.resultText || JSON.stringify(out.result.structured ?? null) : null;
    // 疑似限额（规则没认出、通用信号判的）也按限流交给调用方。
    const reason: HeadlessFailure = limit && out.reason !== "rate_limited" && out.reason !== "model_unavailable" ? (limit.kind === "model_unavailable" ? "model_unavailable" : "rate_limited") : out.reason;
    return { ok: false, reason, message: out.message, limit, stderr: out.stderr, result: out.result, rawText, route, ...(waitUntil !== undefined && { waitUntil }) };
  };
  const succeeded = (out: Extract<HeadlessOutcome, { ok: true }>, route: RouteInfo): HeadlessExecResult => ({
    ok: true, value: pickStructured(out.result), rawText: out.result.resultText || JSON.stringify(out.result.structured ?? null), result: out.result, route,
  });

  // ---- 模型探测：只用指定的模型，结果由调用方解读 ----
  if (o.forceModel) {
    const { out } = await runOnce(o.forceModel, null, { requestedTier: null, fallbackFrom: null });
    const route = { ...baseRoute, actualModel: o.forceModel };
    return out.ok ? succeeded(out, route) : failed(out, route);
  }

  const plan: Plan = r
    ? r.plan(o.task, { sessionModel: o.sessionModel, producer: o.producer, minLevel })
    : { mode: "legacy", model: def.legacy === "session" ? (o.sessionModel ?? null) : def.legacy, route: { ...def, overridden: false }, why: "unconfigured" };

  // ---- 不走路由：2.1.0 的做法 ----
  if (plan.mode === "legacy") {
    const model = plan.model;
    const { out, startedAt } = await runOnce(model, null, { requestedTier: null, fallbackFrom: null });
    const route = { ...baseRoute, requestedTier: null, actualModel: model };
    if (out.ok) {
      hook("onSuccess", () => d.onSuccess?.(startedAt, job));
      return succeeded(out, route);
    }
    d.log?.(`${o.label}: ${out.reason}: ${out.message.slice(0, 500)}`);
    if (out.limit) {
      const hit = out.limit;
      hook("onLimit", () => d.onLimit?.(hit, job));
    } else if (r && LEARN_FROM.has(out.reason)) {
      // 没配置路由时只记进未识别列表，不当成限额。
      hook("onFailure", () => void r.onFailure(null, out.errorText ?? out.message, out.apiStatus ?? null, o.task));
    }
    return failed(out, route, out.limit);
  }

  if (plan.mode === "wait") {
    const message = M().routing.waiting(new Date(plan.until).toLocaleString());
    hook("event", () => r!.event("wait", { task: o.task, model: plan.skipped[0]?.model ?? null, detail: message }));
    d.log?.(`${o.label}: ${message}`);
    return {
      ok: false, reason: "rate_limited", message, limit: { kind: "rate_limit", resetsAt: plan.until, message }, stderr: "", result: null, rawText: null,
      route: { ...baseRoute, requestedTier: plan.requestedTier }, waitUntil: plan.until,
    };
  }

  // ---- 走路由：按顺序试，撞限换下一个 ----
  const routing = r!;
  // 「降级」相对这次本来能用的最高档：要求的档没有模型、只能从更低一档开始时，那一档就是满分，不算降级（否则升级重跑永远等不到）。
  const preferredTier = [...plan.candidates, ...plan.skipped].find((c) => c.model === plan.preferred)?.tier ?? plan.requestedTier;
  const baseline = tierRank(preferredTier) < tierRank(plan.requestedTier) ? preferredTier : plan.requestedTier;
  const routeFor = (cand: Candidate): RouteInfo => ({
    task: o.task, requestedTier: plan.requestedTier, actualModel: cand.model, fallbackFrom: cand.model === plan.preferred ? null : plan.preferred,
    degraded: tierRank(cand.tier) < tierRank(baseline), sameModelReview: plan.sameModelReview,
  });
  let last: { out: Extract<HeadlessOutcome, { ok: false }>; limit: LimitHit; cand: Candidate } | null = null;
  for (let i = 0; i < plan.candidates.length; i++) {
    const cand = plan.candidates[i]!;
    // 前一次的账号级标记可能连带标上了后面的模型。
    if (i > 0 && !routing.usable(cand.model)) continue;
    const prev = last;
    if (prev) hook("event", () => routing.event("fallback", { task: o.task, model: prev.cand.model, toModel: cand.model, detail: prev.limit.message }));
    const route = routeFor(cand);
    const { out, startedAt } = await runOnce(cand.model, cand.tier, { requestedTier: plan.requestedTier, fallbackFrom: route.fallbackFrom });
    if (out.ok) {
      hook("onSuccess", () => routing.onSuccess(cand.model, startedAt));
      return succeeded(out, route);
    }
    d.log?.(`${o.label} [${cand.model}]: ${out.reason}: ${out.message.slice(0, 500)}`);
    if (NO_RETRY.has(out.reason)) return failed(out, route);
    let limit = out.limit;
    if (limit) {
      const hit = limit;
      hook("onLimit", () => void routing.onLimit(cand.model, hit, { task: o.task, accountLevel: out.limitAccountLevel ?? false, tier: cand.tier }));
    } else if (LEARN_FROM.has(out.reason)) {
      // 规则没认出：通用信号 / 连续失败判成疑似限额时也换下一个。
      try {
        limit = routing.onFailure(cand.model, out.errorText ?? out.message, out.apiStatus ?? null, o.task);
      } catch (e) {
        d.log?.(`${o.label}: onFailure threw`, e);
      }
    }
    if (!limit) return failed(out, route);
    last = { out, limit, cand };
    // escalate：交给用户（交互 session 用），后台调用不自己换模型。
    if (plan.route.policy === "escalate") break;
  }
  // 链走完了：不丢，告诉调用方什么时候能再跑。
  const end = last!;
  let waitUntil: number | null = null;
  try {
    const after = routing.plan(o.task, { sessionModel: o.sessionModel, producer: o.producer, minLevel });
    waitUntil = after.mode === "wait" ? after.until : null;
  } catch (e) {
    d.log?.(`${o.label}: re-planning failed`, e);
  }
  hook("event", () => routing.event("wait", { task: o.task, model: end.cand.model, detail: waitUntil ? new Date(waitUntil).toISOString() : end.limit.message }));
  return failed(end.out, routeFor(end.cand), end.limit, waitUntil);
}
