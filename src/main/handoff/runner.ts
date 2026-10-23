import { HandoffSchema, RefreshSchema, type Handoff } from "../../shared/handoff";
import { effectiveStatus, type HandoffOutcome, type Session, type Ticket } from "../../shared/types";
import { headlessArgs, READ_ONLY_TOOLS, type HeadlessRun } from "../claude/headless";
import { headlessEnv } from "../claude/spawn";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { trackerTools } from "../settings/settings-values";
import { runPool } from "../util/pool";
import type { IngestInput, IngestResult } from "./ingest";
import { buildPrompt, retryPrompt, type PromptContext } from "./prompt";
import { emptyHandoff, HANDOFF_JSON_SCHEMA, pickStructured, REFRESH_JSON_SCHEMA, validate } from "./schema";

export const HANDOFF_CONCURRENCY = 2;

export interface BatchResult {
  /** 有失败或被限流跳过的 ticket 时是 partial：早间简报前会再补跑一次。 */
  status: "ok" | "partial";
  outcomes: HandoffOutcome[];
}

export interface HandoffRunnerDeps {
  tickets: TicketsRepo;
  sessions: SessionsRepo;
  handoffs: HandoffsRepo;
  followups: FollowupsRepo;
  settings: SettingsRepo;
  ingest: (input: IngestInput) => IngestResult;
  /** 不 fork session 时后台 claude 在哪里跑（见 TicketService.headlessDirs）。 */
  dirs: (t: Ticket) => { cwd: string; addDirs: string[] };
  run: HeadlessRun;
  /** 首次 health 探测完成后 resolve。 */
  ready: () => Promise<void>;
  claude: () => { path: string | null; pathValue: string };
  baseEnv: NodeJS.ProcessEnv;
  /** session 的 transcript 修改时间；没有 transcript 时为 null。 */
  transcriptMtime: (sessionId: string) => number | null;
  now: () => number;
  newRunId: () => string;
  timeoutMs?: number;
  /** 设置 headlessProjectMcp 打开时调用：这个目录要额外挂的 --mcp-config 文件（计划 3 任务 5）。 */
  projectMcp?: (cwd: string) => string[];
  /** 退出 app 时取消所有进行中的 headless 运行：被取消的运行不写入任何东西，也不算限流。 */
  signal?: AbortSignal;
  log?: (msg: string, err?: unknown) => void;
}

type Exec = { ok: true; value: unknown; rawText: string } | { ok: false; outcome: HandoffOutcome };

const failed = (ticketKey: string, reason: string, message: string): HandoffOutcome => ({ ticketKey, status: "failed", reason, message });

export class HandoffRunner {
  private readonly inflight = new Map<string, Promise<HandoffOutcome>>();

  constructor(private readonly d: HandoffRunnerDeps) {}

  /** 有新活动的 ticket：关联 session 的 transcript 修改时间晚于上一次读过 session 的 handoff。 */
  candidates(): string[] {
    return this.d.tickets
      .list()
      .filter((t) => {
        const latest = Math.max(0, ...this.d.sessions.listByTicket(t.key).map((s) => this.d.transcriptMtime(s.id) ?? 0));
        return latest > (this.d.handoffs.lastCapturedAt(t.key) ?? 0);
      })
      .map((t) => t.key);
  }

  runNightly(): Promise<BatchResult> {
    return this.batch(this.candidates(), (key) => this.full(key, "nightly"));
  }

  runManual(ticketKey: string): Promise<HandoffOutcome> {
    return this.once(ticketKey, () => this.full(ticketKey, "manual"));
  }

  /** 早间快速刷新：只查 in_review / merged_pending_followup 的 PR 和 tracker 状态。 */
  refreshForBrief(): Promise<BatchResult> {
    const keys = this.d.tickets
      .list()
      .filter((t) => ["in_review", "merged_pending_followup"].includes(effectiveStatus(t)))
      .map((t) => t.key);
    return this.batch(keys, (key) => this.refresh(key));
  }

  private async batch(keys: string[], fn: (key: string) => Promise<HandoffOutcome>): Promise<BatchResult> {
    let rateLimited = false;
    const outcomes = await runPool(keys, HANDOFF_CONCURRENCY, async (key): Promise<HandoffOutcome> => {
      // 公司额度用完或被限流：剩下的不再发起（不重试轰炸），留给早间补跑。
      if (this.d.signal?.aborted) return failed(key, "aborted", "已取消");
      if (rateLimited) return { ticketKey: key, status: "skipped", reason: "rate_limited" };
      const o = await this.once(key, () => fn(key));
      if (o.status === "skipped" && o.reason === "rate_limited") rateLimited = true;
      return o;
    });
    const partial = outcomes.some((o) => o.status === "failed" || (o.status === "skipped" && o.reason === "rate_limited"));
    return { status: partial ? "partial" : "ok", outcomes };
  }

  /** 同一个 ticket 同时只跑一个：手动按钮和晚间批量撞在一起时共用结果。 */
  private once(key: string, fn: () => Promise<HandoffOutcome>): Promise<HandoffOutcome> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = fn()
      .catch((e: unknown) => failed(key, "internal", e instanceof Error ? e.message : String(e)))
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** 要 fork 的 session：最近活动的、没被替换、有 transcript 的那个。 */
  private resumeTarget(key: string): Session | null {
    return this.d.sessions.listByTicket(key).find((s) => !s.replacedBy && !s.dismissed && this.d.transcriptMtime(s.id) !== null) ?? null;
  }

  private context(t: Ticket): PromptContext {
    return {
      ticket: t,
      status: effectiveStatus(t),
      previous: this.d.handoffs.latestValid(t.key)?.payload ?? null,
      openFollowups: this.d.followups.listByTicket(t.key).filter((f) => f.status === "open" || f.status === "snoozed"),
      trackerTools: trackerTools(this.d.settings),
    };
  }

  private mcpConfigs(cwd: string): string[] {
    if (this.d.settings.get("headlessProjectMcp") !== "1" || !this.d.projectMcp) return [];
    try {
      return this.d.projectMcp(cwd);
    } catch (e) {
      this.d.log?.("project MCP config failed; running without it", e);
      return [];
    }
  }

  private allowedTools(): string[] {
    return [...READ_ONLY_TOOLS, ...trackerTools(this.d.settings)];
  }

  private async full(key: string, trigger: "nightly" | "manual"): Promise<HandoffOutcome> {
    const t = this.d.tickets.get(key);
    if (!t) return failed(key, "no_ticket", `找不到 ticket ${key}`);
    const session = this.resumeTarget(key);
    // 晚间批量只为有对话记录的 ticket 生成；手动触发时没有 session 也照样跑（只能看 git、PR 和 tracker）。
    if (!session && trigger === "nightly") return { ticketKey: key, status: "skipped", reason: "no_session" };
    const dirs = this.d.dirs(t);
    const cwd = session?.cwd || dirs.cwd;
    const prompt = buildPrompt(this.d.settings.get("handoffPrompt"), this.context(t));
    const args = headlessArgs({
      schema: HANDOFF_JSON_SCHEMA, resumeSessionId: session?.id, allowedTools: this.allowedTools(), mcpConfigs: this.mcpConfigs(cwd),
      addDirs: dirs.addDirs.filter((d) => d !== cwd),
    });

    let attempt = await this.exec(key, args, prompt, cwd, session?.id);
    if (!attempt.ok) return attempt.outcome;
    let checked = validate(HandoffSchema, attempt.value);
    if (!checked.ok) {
      this.d.log?.(`handoff ${key}: output failed validation, retrying once: ${checked.errors}`);
      attempt = await this.exec(key, args, retryPrompt(prompt, checked.errors), cwd, session?.id);
      if (!attempt.ok) return attempt.outcome;
      checked = validate(HandoffSchema, attempt.value);
    }
    const r = this.d.ingest({ ticketKey: key, sessionId: session?.id ?? null, trigger, payload: checked.ok ? checked.value : null, rawText: attempt.rawText });
    if (!r.stored) return failed(key, r.reason, r.reason);
    return { ticketKey: key, status: "stored", handoffId: r.handoffId, degraded: r.degraded };
  }

  private async refresh(key: string): Promise<HandoffOutcome> {
    const t = this.d.tickets.get(key);
    if (!t) return failed(key, "no_ticket", `找不到 ticket ${key}`);
    const ctx = this.context(t);
    const prompt = buildPrompt(this.d.settings.get("refreshPrompt"), ctx);
    const { cwd, addDirs } = this.d.dirs(t);
    const args = headlessArgs({ schema: REFRESH_JSON_SCHEMA, allowedTools: this.allowedTools(), mcpConfigs: this.mcpConfigs(cwd), addDirs });
    const attempt = await this.exec(key, args, prompt, cwd);
    if (!attempt.ok) return attempt.outcome;
    const checked = validate(RefreshSchema, attempt.value);
    // 刷新结果不完整就保留旧数据：不写入、不重试。
    if (!checked.ok) return failed(key, "invalid_output", checked.errors);
    // 存成一条完整的 handoff，简报永远只看“最新一条完整 handoff”。done_today 清空，免得“上个工作日”重复计算。
    const base: Handoff = ctx.previous ?? emptyHandoff(key);
    const payload: Handoff = {
      ...base, ticket: key, status: checked.value.status, pr: checked.value.pr, jira: checked.value.jira,
      done_today: [], followups: [], decisions: [], learnings: [],
    };
    const r = this.d.ingest({ ticketKey: key, sessionId: null, trigger: "refresh", payload, rawText: attempt.rawText });
    if (!r.stored) return failed(key, r.reason, r.reason);
    return { ticketKey: key, status: "stored", handoffId: r.handoffId, degraded: r.degraded };
  }

  private async exec(key: string, args: string[], prompt: string, cwd: string, resumedId?: string): Promise<Exec> {
    await this.d.ready();
    const { path, pathValue } = this.d.claude();
    if (!path) return { ok: false, outcome: failed(key, "claude_missing", "找不到 claude 命令") };
    const out = await this.d.run({
      claudePath: path, args, prompt, cwd,
      env: headlessEnv(this.d.baseEnv, { pathValue, runId: this.d.newRunId() }),
      timeoutMs: this.d.timeoutMs,
      signal: this.d.signal,
    });
    const sid = out.result?.sessionId;
    // 返回的 id 就是被恢复的真实 session 时，绝不能把它记成 headless。
    if (sid && sid !== resumedId) this.d.sessions.recordHeadless(sid, cwd, this.d.now());
    if (!out.ok) {
      this.d.log?.(`handoff ${key}: ${out.reason}: ${out.message}`);
      if (out.reason === "rate_limited") return { ok: false, outcome: { ticketKey: key, status: "skipped", reason: "rate_limited" } };
      return { ok: false, outcome: failed(key, out.reason, out.message) };
    }
    return { ok: true, value: pickStructured(out.result), rawText: out.result.resultText || JSON.stringify(out.result.structured ?? null) };
  }
}
