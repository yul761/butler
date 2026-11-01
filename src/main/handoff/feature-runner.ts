import { FeatureHandoffSchema } from "../../shared/handoff";
import { effectiveStatus, type FeatureHandoffOutcome, type FeatureHandoffTrigger, type HandoffOutcome, type Ticket } from "../../shared/types";
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
}

type Exec = { ok: true; value: unknown; rawText: string } | { ok: false; outcome: FeatureHandoffOutcome };

const failed = (featureId: number, reason: string, message: string): FeatureHandoffOutcome => ({ featureId, status: "failed", reason, message });

/** 归档前生成汇总最多等这么久：epic 归档时所有 feature 共用这一个上限。 */
export const ARCHIVE_SUMMARY_LIMIT_MS = 2 * 60_000;

/** feature 汇总（设计文档 2026-10-28）：晚间批量、手动"立即更新"，以及总控 /handoff 之后给子 ticket 补跑。 */
export class FeatureSummaryRunner {
  private readonly inflight = new Map<number, Promise<FeatureHandoffOutcome>>();

  constructor(private readonly d: FeatureRunnerDeps) {}

  /**
   * 有新活动的未归档 feature：总控 session 的 transcript 晚于最新有效汇总，
   * 或者下面有 ticket 在汇总覆盖到的时间之后捕获了新的 handoff（不算 refresh 和 degraded）。
   */
  candidates(): number[] {
    return this.d.features.list().map((f) => f.id).filter((id) => this.staleFeature(id));
  }

  /** 最新有效汇总之后有没有新活动（规则见 candidates）。 */
  staleFeature(id: number): boolean {
    const last = this.d.featureHandoffs.latestValid(id);
    const coordinator = Math.max(0, ...this.d.sessions.listFeatureCoordinators(id).map((s) => this.d.transcriptMtime(s.id) ?? 0));
    if (coordinator > (last?.createdAt ?? 0)) return true;
    const covered = last ? (last.coversUntil ?? last.createdAt) : 0;
    return this.d.tickets.listByFeature(id).some((t) => (this.d.handoffs.lastCapturedAt(t.key) ?? 0) > covered);
  }

  /**
   * epic session 建 feature 时（设计文档 2026-11-01“交接要新鲜”）：后台给 epic 下未归档、有新活动的 feature 各生成一份汇总。
   * 调用方不等它；失败只记日志。exceptFeatureId：刚建的 feature，不用看。
   */
  refreshEpic(epicId: number, exceptFeatureId?: number): void {
    const run = async () => this.summarizeStale(this.d.features.listByEpic(epicId).map((f) => f.id).filter((id) => id !== exceptFeatureId));
    run().catch((e: unknown) => this.d.log?.(`refreshing the summaries of epic ${epicId} failed`, e));
  }

  /**
   * 归档 epic 下的 feature 之前（设计文档 2026-11-01“交接要新鲜”）：给有新活动的生成汇总，并行，共用一个上限，永不 reject。
   * 要在归档写入之前跑完：归档之后这个 feature 不再是 candidates，有新活动也不会再生成汇总。
   * 超时后不再发起新的；已经在跑的留在后台，读和 feature 一起归档的 ticket，存下来时 epic 的视图照样读得到。
   */
  async refreshBeforeArchive(featureIds: number[]): Promise<void> {
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        this.d.log?.(`feature summaries before archive timed out, archiving anyway: ${featureIds.join(", ")}`);
        resolve();
      }, ARCHIVE_SUMMARY_LIMIT_MS);
    });
    await Promise.race([this.summarizeStale(featureIds, () => expired), limit]);
    clearTimeout(timer);
  }

  /** 这些 feature 里有新活动的各跑一次“立即更新”；出错只记日志，永不 reject。stopped 之后不再发起新的。 */
  private async summarizeStale(featureIds: number[], stopped: () => boolean = () => false): Promise<void> {
    await runPool(featureIds, HANDOFF_CONCURRENCY, async (id) => {
      if (stopped()) return;
      try {
        if (!this.staleFeature(id)) return;
        const o = await this.runManual(id);
        if (o.status !== "stored") this.d.log?.(`feature summary ${id}: ${o.status}: ${o.status === "failed" ? o.message : o.reason}`);
      } catch (e) {
        this.d.log?.(`feature summary ${id} failed`, e);
      }
    });
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
    return tickets.map((t) => ({
      key: t.key,
      title: t.title,
      status: effectiveStatus(t),
      // PR 取最新的有效 handoff（早间刷新会更新它）；完成、下一步取最新的完整 handoff（刷新会清空 done_today）。
      prs: this.d.handoffs.knownPrs(t.key),
      latest: this.d.handoffs.latestValidFull(t.key)?.payload ?? null,
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
    const dirs = this.d.dirs(featureId);
    const cwd = session?.cwd || dirs.cwd;
    const l = currentLang();
    const prompt = renderTemplate(defaultFeatureHandoffPrompt(l), {
      feature: feature.name,
      previous: renderPreviousSummary(this.d.featureHandoffs.latestValid(featureId)?.payload ?? null, l),
      tickets: renderFeatureTickets(rows, l),
    });
    // 工作区里一般没有项目级 MCP 配置：按第一个仓库找（同 HandoffRunner 对总控 session 的处理）。
    const mcpCwd = dirs.repoDirs[0] ?? dirs.cwd;
    const args = headlessArgs({
      schema: FEATURE_HANDOFF_JSON_SCHEMA, resumeSessionId: session?.id, allowedTools: [...READ_ONLY_TOOLS, ...trackerTools(this.d.settings)],
      mcpConfigs: this.mcpConfigs(mcpCwd), addDirs: dirs.addDirs.filter((d) => d !== cwd),
    });

    let attempt = await this.exec(featureId, args, prompt, cwd, session?.id);
    if (!attempt.ok) return attempt.outcome;
    let checked = validate(FeatureHandoffSchema, attempt.value);
    if (!checked.ok) {
      this.d.log?.(`feature summary ${featureId}: output failed validation, retrying once: ${checked.errors}`);
      attempt = await this.exec(featureId, args, retryPrompt(prompt, checked.errors), cwd, session?.id);
      if (!attempt.ok) return attempt.outcome;
      checked = validate(FeatureHandoffSchema, attempt.value);
    }
    const r = this.d.ingest({ featureId, sessionId: session?.id ?? null, trigger, payload: checked.ok ? checked.value : null, rawText: attempt.rawText });
    if (!r.stored) return failed(featureId, r.reason, r.reason);
    return { featureId, status: "stored", handoffId: r.handoffId, degraded: r.degraded };
  }

  private async exec(featureId: number, args: string[], prompt: string, cwd: string, resumedId?: string): Promise<Exec> {
    const r = await execHeadlessJson(this.d, { label: `feature summary ${featureId}`, args, prompt, cwd, resumedId });
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
