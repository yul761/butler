import { FeatureHandoffSchema } from "../../shared/handoff";
import { effectiveStatus, type FeatureHandoffOutcome, type HandoffOutcome, type Session } from "../../shared/types";
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

/** feature 汇总（设计文档 2026-10-28）：晚间批量、手动"立即更新"，以及总控 /handoff 之后给子 ticket 补跑。 */
export class FeatureSummaryRunner {
  private readonly inflight = new Map<number, Promise<FeatureHandoffOutcome>>();

  constructor(private readonly d: FeatureRunnerDeps) {}

  /**
   * 有新活动的未归档 feature：总控 session 的 transcript 晚于最新有效汇总，
   * 或者下面有 ticket 在汇总覆盖到的时间之后捕获了新的 handoff（不算 refresh 和 degraded）。
   */
  candidates(): number[] {
    return this.d.features
      .list()
      .filter((f) => {
        const last = this.d.featureHandoffs.latestValid(f.id);
        const coordinator = Math.max(0, ...this.d.sessions.listByFeature(f.id).map((s) => this.d.transcriptMtime(s.id) ?? 0));
        if (coordinator > (last?.createdAt ?? 0)) return true;
        const covered = last ? (last.coversUntil ?? last.createdAt) : 0;
        return this.d.tickets.listByFeature(f.id).some((t) => (this.d.handoffs.lastCapturedAt(t.key) ?? 0) > covered);
      })
      .map((f) => f.id);
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

  /** 要 fork 的总控 session：最近活动的、没被替换、没隐藏、有 transcript 的那个。 */
  private resumeTarget(featureId: number): Session | null {
    return this.d.sessions.listByFeature(featureId).find((s) => !s.replacedBy && !s.dismissed && this.d.transcriptMtime(s.id) !== null) ?? null;
  }

  private ticketContexts(featureId: number): FeatureTicketContext[] {
    return this.d.tickets.listByFeature(featureId).map((t) => ({
      key: t.key,
      title: t.title,
      status: effectiveStatus(t),
      // PR 取最新的有效 handoff（早间刷新会更新它）；完成、下一步取最新的完整 handoff（刷新会清空 done_today）。
      prs: this.d.handoffs.latestValid(t.key)?.payload?.prs ?? [],
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

  private async generate(featureId: number, trigger: "nightly" | "manual"): Promise<FeatureHandoffOutcome> {
    const feature = this.d.features.get(featureId);
    if (!feature) return failed(featureId, "no_feature", M().featureNotFound);
    const session = this.resumeTarget(featureId);
    // 没有总控对话、也没有任何有效的 ticket handoff：没东西可写，不花额度。
    if (!session && !this.d.tickets.listByFeature(featureId).some((t) => this.d.handoffs.latestValid(t.key))) {
      return { featureId, status: "skipped", reason: "nothing_to_summarize" };
    }
    const rows = this.ticketContexts(featureId);
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
