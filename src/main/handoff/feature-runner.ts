import { FeatureHandoffSchema } from "../../shared/handoff";
import type { Turn } from "../../shared/turn";
import { effectiveStatus, type FeatureHandoffOutcome, type FeatureHandoffTrigger, type HandoffOutcome, type Ticket, type WatchedPr } from "../../shared/types";
import { storedModel } from "../claude/spawn";
import { headlessArgs, READ_ONLY_TOOLS } from "../claude/headless";
import type { FeatureHandoffsRepo } from "../db/feature-handoffs-repo";
import type { FeaturesRepo } from "../db/features-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { currentLang } from "../i18n";
import { trackerTools } from "../settings/settings-values";
import { M } from "../strings";
import type { HeadlessDirs } from "../tickets/ticket-service";
import { runPool } from "../util/pool";
import type { FeatureIngestInput, FeatureIngestResult } from "./feature-ingest";
import { defaultFeatureHandoffPrompt, renderFeatureTickets, renderPreviousSummary, type FeatureTicketContext } from "./feature-templates";
import { execHeadlessJson, type HeadlessExecDeps } from "./headless-exec";
import { renderTemplate, retryPrompt } from "./prompt";
import { HANDOFF_CONCURRENCY, type HandoffRunner } from "./runner";
import { FEATURE_HANDOFF_JSON_SCHEMA, validate } from "./schema";

export interface FeatureBatchResult {
  /** 有失败或被限流跳过的 feature 时是 partial。 */
  status: "ok" | "partial";
  outcomes: FeatureHandoffOutcome[];
}

export interface FeatureRunnerDeps extends HeadlessExecDeps {
  features: FeaturesRepo;
  tickets: TicketsRepo;
  handoffs: HandoffsRepo;
  featureHandoffs: FeatureHandoffsRepo;
  settings: SettingsRepo;
  ingest: (input: FeatureIngestInput) => FeatureIngestResult;
  /** 子 ticket 的 handoff 交给 ticket 的 runner（有活动的判断、并发限制、once 都在那边）。 */
  ticketRunner: Pick<HandoffRunner, "candidates" | "runManual">;
  /** 后台 claude 在哪里跑（见 TicketService.featureHeadlessDirs）。 */
  dirs: (featureId: number) => HeadlessDirs;
  /** session 的 transcript 修改时间；没有 transcript 时为 null。 */
  transcriptMtime: (sessionId: string) => number | null;
  /** 设置 headlessProjectMcp 打开时调用：这个目录要额外挂的 --mcp-config 文件。 */
  projectMcp?: (cwd: string) => string[];
  /** Butler 实时读到的这个 ticket 的 PR（PrWatcher.statusOf，ws-b）：汇总的 prompt 用它，PR 状态变化也算新活动。 */
  livePrs?: (ticketKey: string) => WatchedPr[];
  /** 实时 PR 轮到谁（TurnService.prTurns：一次算好，按链接查），写进汇总 prompt；不给就不写。 */
  prTurns?: () => (url: string, ticketKey?: string) => Turn | null;
}

type Exec = { ok: true; value: unknown; rawText: string } | { ok: false; outcome: FeatureHandoffOutcome };

const failed = (featureId: number, reason: string, message: string): FeatureHandoffOutcome => ({ featureId, status: "failed", reason, message });

/** feature 汇总（设计文档 2026-10-28）：晚间批量、手动"立即更新"，以及总控 /handoff 之后给子 ticket 补跑。 */
export class FeatureSummaryRunner {
  private readonly inflight = new Map<number, Promise<FeatureHandoffOutcome>>();

  constructor(private readonly d: FeatureRunnerDeps) {}

  /**
   * 晚间批量的名单：有新活动的未归档 feature，规则见 hasNewActivity。
   * 不看还没跑 handoff 的 ticket：晚间 ticket 批次已经先跑过，跑成的 ticket 走 hasNewActivity 的第二条；还留在 ticket 名单里的是这一晚没跑成的，
   * 而 runNightly 不补跑子 ticket，算进来只会没有新材料地重新生成，失败多少晚就花多少晚的额度。
   * session 全被隐藏的 ticket 甚至永远留在名单里（晚间是 no_session），它的 feature 就每晚都生成一次。
   */
  candidates(): number[] {
    return this.d.features.list().map((f) => f.id).filter((id) => this.hasNewActivity(id));
  }

  /**
   * 最新有效汇总之后有没有已经捕获到的新活动：总控 session 的 transcript 晚于汇总，
   * 或者下面有 ticket 在汇总覆盖到的时间之后捕获了新的 handoff（不算 refresh 和 degraded），
   * 或者下面有 ticket 的 PR 状态（state、review、CI、draft、合并状态、reviewer）在汇总读 PR 之后变过（ws-b）。
   * progress_overview、list_features 的"过期"也用它。
   */
  hasNewActivity(id: number): boolean {
    const last = this.d.featureHandoffs.latestValid(id);
    const coordinator = Math.max(0, ...this.d.sessions.listFeatureCoordinators(id).map((s) => this.d.transcriptMtime(s.id) ?? 0));
    if (coordinator > (last?.createdAt ?? 0)) return true;
    const covered = last ? (last.coversUntil ?? last.createdAt) : 0;
    const tickets = this.d.tickets.listByFeature(id);
    if (tickets.some((t) => (this.d.handoffs.lastCapturedAt(t.key) ?? 0) > covered)) return true;
    return this.prChangedSince(tickets, last ? (last.prStatusAt ?? last.createdAt) : 0);
  }

  /** 这些 ticket 的 PR 有没有在 since 之后变过状态。 */
  private prChangedSince(tickets: Ticket[], since: number): boolean {
    const live = this.d.livePrs;
    if (!live) return false;
    return tickets.some((t) => live(t.key).some((p) => (p.detail?.statusChangedAt ?? 0) > since));
  }

  /** 这个 feature 正在生成汇总（手动、晚间或 /handoff 的退路）。 */
  isRunning(featureId: number): boolean {
    return this.inflight.has(featureId);
  }

  /** feature 之间串行；被限流后剩下的不再发起，留给早间补跑。 */
  async runNightly(): Promise<FeatureBatchResult> {
    const outcomes: FeatureHandoffOutcome[] = [];
    let rateLimited = false;
    for (const id of this.candidates()) {
      if (this.d.signal?.aborted) {
        outcomes.push(failed(id, "aborted", M().cancelled));
        continue;
      }
      if (rateLimited) {
        outcomes.push({ featureId: id, status: "skipped", reason: "rate_limited" });
        continue;
      }
      const o = await this.once(id, () => this.generate(id, "nightly"));
      if (o.status === "skipped" && o.reason === "rate_limited") rateLimited = true;
      outcomes.push(o);
    }
    const partial = outcomes.some((o) => o.status === "failed" || (o.status === "skipped" && o.reason === "rate_limited"));
    return { status: partial ? "partial" : "ok", outcomes };
  }

  /** "立即更新"：先给有活动的子 ticket 跑 handoff，再生成汇总。 */
  runManual(featureId: number): Promise<FeatureHandoffOutcome> {
    return this.once(featureId, async () => {
      await this.runChildren(featureId);
      return this.generate(featureId, "manual");
    });
  }

  /**
   * 总控里的 /handoff 没存下汇总（wrong_block / no_block，多半是用户自己开的总控、没有 Butler 的 MCP）时的退路：
   * Butler 自己 fork 跑 /handoff 的那个 session 生成汇总（trigger=command，sessionId 记成它），再走 afterCommand
   * （先子 ticket，再 coversUntil）。和 runManual、晚间批量共用 once：同一个 feature 正在跑时共用那次的结果，不重复跑。
   */
  runFromCommand(featureId: number, sessionId: string): Promise<FeatureHandoffOutcome> {
    return this.once(featureId, async () => {
      const o = await this.generate(featureId, "command", sessionId);
      // 子 ticket 出错不影响已经存下的汇总：只记日志。
      try {
        await this.afterCommand(featureId, o.status === "stored" ? o.handoffId : null);
      } catch (e) {
        this.d.log?.(`child handoffs after the fallback summary of feature ${featureId} failed`, e);
      }
      return o;
    });
  }

  /** feature 下有活动的 ticket 各跑一次手动 handoff（并发受 HANDOFF_CONCURRENCY 限制）。 */
  runChildren(featureId: number): Promise<HandoffOutcome[]> {
    const due = new Set(this.d.ticketRunner.candidates());
    const keys = this.d.tickets.listByFeature(featureId).map((t) => t.key).filter((k) => due.has(k));
    return runPool(keys, HANDOFF_CONCURRENCY, (k) => this.d.ticketRunner.runManual(k));
  }

  /**
   * 总控里的 /handoff 之后：给子 ticket 跑 handoff；存下了汇总时把它的 coversUntil 记成现在，
   * 这些子 ticket handoff 算在这份汇总里，不再触发当晚重新生成。
   */
  async afterCommand(featureId: number, handoffId: number | null): Promise<void> {
    await this.runChildren(featureId);
    if (handoffId !== null) this.d.featureHandoffs.setCoversUntil(handoffId, this.d.now());
  }

  /** 同一个 feature 同时只跑一个：手动按钮和晚间批量撞在一起时共用结果。 */
  private once(featureId: number, fn: () => Promise<FeatureHandoffOutcome>): Promise<FeatureHandoffOutcome> {
    const existing = this.inflight.get(featureId);
    if (existing) return existing;
    const p = fn()
      .catch((e: unknown) => failed(featureId, "internal", e instanceof Error ? e.message : String(e)))
      .finally(() => this.inflight.delete(featureId));
    this.inflight.set(featureId, p);
    return p;
  }

  /**
   * 要 fork 的总控 session：指定了 sessionId（总控 /handoff 的退路）就是它；
   * 否则是最近活动的、没被替换、没隐藏、有 transcript 的那个。
   */
  private resumeTarget(featureId: number, sessionId?: string): { id: string; cwd: string } | null {
    if (sessionId !== undefined) return { id: sessionId, cwd: this.d.sessions.get(sessionId)?.cwd ?? "" };
    return this.d.sessions.listFeatureCoordinators(featureId).find((s) => !s.replacedBy && !s.dismissed && this.d.transcriptMtime(s.id) !== null) ?? null;
  }

  private ticketContexts(tickets: Ticket[]): FeatureTicketContext[] {
    const turnOf = this.d.prTurns?.();
    return tickets.map((t) => ({
      key: t.key,
      title: t.title,
      status: effectiveStatus(t),
      // PR 取最新的有效 handoff（早间刷新会更新它）；完成、下一步取最新的完整 handoff（刷新会清空 done_today）。
      prs: this.d.handoffs.knownPrs(t.key),
      latest: this.d.handoffs.latestValidFull(t.key)?.payload ?? null,
      ...(this.d.livePrs && { live: this.d.livePrs(t.key) }),
      ...(turnOf && { turnOf }),
    }));
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

  private async generate(featureId: number, trigger: FeatureHandoffTrigger, sessionId?: string): Promise<FeatureHandoffOutcome> {
    const feature = this.d.features.get(featureId);
    if (!feature) return failed(featureId, "no_feature", M().featureNotFound);
    const session = this.resumeTarget(featureId, sessionId);
    // 归档时超时的汇总走到这里时 feature 可能已经归档：读和它一起归档的 ticket，否则这份最后的汇总里没有 ticket。
    const tickets = this.d.tickets.listWithFeature(feature);
    // 没有总控对话、也没有任何有效的 ticket handoff：没东西可写，不花额度。
    if (!session && !tickets.some((t) => this.d.handoffs.latestValid(t.key))) {
      return { featureId, status: "skipped", reason: "nothing_to_summarize" };
    }
    const rows = this.ticketContexts(tickets);
    // 读 PR 实时状态的时间：记进汇总，之后 PR 再变就算过期（hasNewActivity 第三条）。
    const prStatusAt = this.d.livePrs ? this.d.now() : undefined;
    const dirs = this.d.dirs(featureId);
    const cwd = session?.cwd || dirs.cwd;
    const l = currentLang();
    const prompt = renderTemplate(defaultFeatureHandoffPrompt(l), {
      feature: feature.name,
      previous: renderPreviousSummary(this.d.featureHandoffs.latestValid(featureId)?.payload ?? null, l),
      tickets: renderFeatureTickets(rows, l, prStatusAt),
    });
    // 工作区里一般没有项目级 MCP 配置：按第一个仓库找（同 HandoffRunner 对总控 session 的处理）。
    const mcpCwd = dirs.repoDirs[0] ?? dirs.cwd;
    const args = headlessArgs({
      schema: FEATURE_HANDOFF_JSON_SCHEMA, resumeSessionId: session?.id, allowedTools: [...READ_ONLY_TOOLS, ...trackerTools(this.d.settings)],
      mcpConfigs: this.mcpConfigs(mcpCwd), addDirs: dirs.addDirs.filter((d) => d !== cwd),
    });
    // fork 换模型会让 prompt 缓存整个失效：沿用被 fork 的总控自己的模型（路由不给 session 任务换模型）。
    const sessionModel = session ? storedModel(this.d.sessions.get(session.id) ?? { model: null }, this.d.routing?.registered) : null;

    let attempt = await this.exec(featureId, args, prompt, cwd, session?.id, sessionModel);
    if (!attempt.ok) return attempt.outcome;
    let checked = validate(FeatureHandoffSchema, attempt.value);
    if (!checked.ok) {
      this.d.log?.(`feature summary ${featureId}: output failed validation, retrying once: ${checked.errors}`);
      attempt = await this.exec(featureId, args, retryPrompt(prompt, checked.errors), cwd, session?.id, sessionModel);
      if (!attempt.ok) return attempt.outcome;
      checked = validate(FeatureHandoffSchema, attempt.value);
    }
    const r = this.d.ingest({ featureId, sessionId: session?.id ?? null, trigger, payload: checked.ok ? checked.value : null, rawText: attempt.rawText, prStatusAt });
    if (!r.stored) return failed(featureId, r.reason, r.reason);
    return { featureId, status: "stored", handoffId: r.handoffId, degraded: r.degraded };
  }

  private async exec(featureId: number, args: string[], prompt: string, cwd: string, resumedId?: string, sessionModel?: string | null): Promise<Exec> {
    const r = await execHeadlessJson(this.d, { task: "feature_summary", label: `feature summary ${featureId}`, args, prompt, cwd, resumedId, sessionModel });
    if (r.ok) return r;
    if (r.reason === "rate_limited") return { ok: false, outcome: { featureId, status: "skipped", reason: "rate_limited" } };
    return { ok: false, outcome: failed(featureId, r.reason, r.message) };
  }
}

/**
 * index.ts 交给 capture 的 afterFeatureCommand：总控里的 /handoff 存下了汇总时，后台给子 ticket 跑 handoff；
 * 没存下（handoffId 为 null）时记一笔，然后后台由 Butler 从那个 session 自己生成汇总（runFromCommand，里面也会跑子 ticket）。
 * capture 不等它；结束后刷新界面。同步抛错也只记日志，不能打断 captureCommandHandoff（否则已经存下的汇总收不到 notify）。
 */
export function featureCommandFollowup(
  runner: Pick<FeatureSummaryRunner, "afterCommand" | "runFromCommand">,
  o: { notify: () => void; log: (msg: string, err?: unknown) => void },
): (featureId: number, handoffId: number | null, sessionId: string) => void {
  return (featureId, handoffId, sessionId) => {
    try {
      if (handoffId !== null) {
        void runner.afterCommand(featureId, handoffId).then(o.notify, (e: unknown) => o.log(`child handoffs after /handoff in feature ${featureId} failed`, e));
        return;
      }
      o.log(`/handoff in feature ${featureId} coordinator session ${sessionId} stored no summary; fallback: generating it from that session in the background`);
      void runner.runFromCommand(featureId, sessionId).then(
        (r) => {
          if (r.status !== "stored") o.log(`fallback feature summary for feature ${featureId}: ${r.status}: ${r.status === "failed" ? r.message : r.reason}`);
          o.notify();
        },
        (e: unknown) => o.log(`fallback feature summary for feature ${featureId} failed`, e),
      );
    } catch (e) {
      o.log(`follow-up after /handoff in feature ${featureId} failed`, e);
    }
  };
}
