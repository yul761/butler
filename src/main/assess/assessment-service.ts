// 就绪度和风险（设计 §7.1、§9）：读 PR 行、最新预审和证据、检查、评论、闸门、策略 → 算 → 写表（内容没变不写）→ 判定变化时发事件。
// 只对 open 的 PR 算；合并、关闭以后留着最后一次的结果。
import type { AssessRepo, StoredBrief } from "../db/assess-repo";
import type { PreReviewRepo, PreReviewRow } from "../db/prereview-repo";
import type { TicketPr } from "../db/ticket-prs-repo";
import type { RecordEvent } from "../metrics/events";
import type { PrReview, PrStatus } from "../tickets/gh";
import type { CheckHitView } from "../../shared/checks";
import type { ResolvedPrPolicy } from "../../shared/pr-policy";
import { RISK_RULES_VERSION, type BriefView, type CheckSummary, type DiffFile, type EvidenceGap, type PrAssessmentView, type PreReviewView, type Readiness, type ReviewQueueItem, type Risk, type TicketAssessmentView, reviewQueueOrder } from "../../shared/prereview";
import { hasVerifiedTest } from "../prereview/evidence";
import { summarizeHits } from "../prereview/runner";
import { computeReadiness, type Lang, type ReadinessInput } from "./readiness";
import { computeRisk, type RiskInput } from "./risk";
import { inferTicketType } from "./ticket-type";

/** 读 PR 时顺带记下的、表里没有的东西（描述原文、review）。只在内存里。 */
interface Seen {
  headSha: string;
  body: string | null;
  author: string;
  reviews: PrReview[];
}

export interface AssessmentDeps {
  prs: { get(id: number): TicketPr | null; byTicket(key: string): TicketPr[]; all(): TicketPr[] };
  preReviews: Pick<PreReviewRepo, "latestFor" | "latestForPr" | "evidenceOf" | "latestWithoutPr">;
  repo: AssessRepo;
  /** 预审的证据缺口（PreReviewService.gaps）。 */
  gaps(row: PreReviewRow): EvidenceGap[];
  /** 预审给界面、总控看的样子（PreReviewService.view）。 */
  preReviewView(row: PreReviewRow): PreReviewView;
  preReviewEnabled(): boolean;
  policy(slug: string): ResolvedPrPolicy;
  /** session 的检查情况（和预审同一个来源）。 */
  checks(sessionId: string | null): { absent: string | null; hits: CheckHitView[] };
  /** 这个 PR 的开发 session（和 CI 递送同一套挑法）。 */
  sessionOf(pr: TicketPr): string | null;
  /** 评论闭环开着时：还没处理完的评论数；关着返回 null（退回看 review 状态）。 */
  openCommentItems(prId: number): number | null;
  /** 合并总控在让这个 PR 等别人。 */
  waitingOnGate(pr: TicketPr): boolean;
  /** 没有预审时的改动文件（worktree 里算，不行就走 GitHub compare）；拿不到为 null。 */
  files(pr: TicketPr): Promise<DiffFile[] | null>;
  recordEvent: RecordEvent;
  lang(): Lang;
  changed(): void;
  now(): number;
  log(msg: string, err?: unknown): void;
}

const isBot = (login: string): boolean => /\[bot\]$|^copilot/i.test(login) || login.toLowerCase().endsWith("-bot");

/** 评论闭环关着时的口径：非作者、非 bot 的人最后一次表态是 CHANGES_REQUESTED 的人数。 */
export function openChangeRequests(reviews: readonly PrReview[], author: string): number {
  const last = new Map<string, PrReview["state"]>();
  for (const r of [...reviews].sort((a, b) => a.submittedAt - b.submittedAt)) {
    if (!r.author || r.author === author || isBot(r.author)) continue;
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED") last.set(r.author, r.state);
  }
  return [...last.values()].filter((s) => s === "CHANGES_REQUESTED").length;
}

const ciOf = (pr: TicketPr | null): RiskInput["ci"] => (pr?.ci === "passing" || pr?.ci === "failing" || pr?.ci === "pending" ? pr.ci : null);

/** 预审里的复跑摘要 → 风险的输入。 */
export function rerunOf(checks: CheckSummary | null): RiskInput["rerun"] {
  const decided = (checks?.rerun ?? []).filter((r) => r.skipped === null);
  if (decided.some((r) => !r.ok)) return "failed";
  return decided.length ? "passed" : "none";
}

export class AssessmentService {
  private readonly seen = new Map<number, Seen>();
  private readonly filesCache = new Map<number, { headSha: string; files: DiffFile[] }>();
  private readonly running = new Map<number, Promise<void>>();

  constructor(private readonly d: AssessmentDeps) {}

  /** onPrRead：记下描述和 review（只在内存里），然后重算。 */
  observe(rows: readonly TicketPr[], pr: PrStatus): Promise<void> {
    for (const r of rows) this.seen.set(r.id, { headSha: pr.headSha, body: pr.body === undefined ? null : pr.body, author: pr.author, reviews: pr.reviews });
    return Promise.all(rows.map((r) => this.assess(r.id))).then(() => undefined);
  }

  /** 最近一次读到的 PR 描述原文（简报的模型输入）；没读到为 null。 */
  description(prId: number): string | null {
    return this.seen.get(prId)?.body ?? null;
  }

  /** 这个 PR 对应的最新预审（当前 sha 的优先，没有就取这个 PR 最近的一次）。 */
  latestPreReview(pr: TicketPr): PreReviewRow | null {
    if (pr.headSha && pr.headBranch) {
      const cur = this.d.preReviews.latestFor({ repoSlug: pr.slug, branch: pr.headBranch, headSha: pr.headSha });
      if (cur) return cur;
    }
    return this.d.preReviews.latestForPr(pr.id);
  }

  /** 一个 PR 的全部评估（ticket 页的 Review tab、总控的 pr_assessment）：表里存的就绪、风险，最新的预审和简报。 */
  view(pr: TicketPr): PrAssessmentView {
    const readiness = this.d.repo.readiness(pr.id);
    const risk = this.d.repo.risk(pr.id);
    const row = this.latestPreReview(pr);
    const stored = (pr.headSha && pr.headBranch ? this.d.repo.latestBriefFor({ repoSlug: pr.slug, branch: pr.headBranch, headSha: pr.headSha }) : null) ?? this.d.repo.latestBriefForPr(pr.id);
    const brief = this.briefView(stored);
    return {
      prId: pr.id, url: pr.url, number: pr.number, title: pr.title, state: pr.state, draft: pr.isDraft,
      target: pr.headSha && pr.headBranch ? { repoSlug: pr.slug, branch: pr.headBranch, headSha: pr.headSha } : null,
      readiness: readiness && { ready: readiness.ready, conditions: readiness.conditions, missing: readiness.missing, headSha: readiness.headSha, computedAt: readiness.computedAt },
      risk: risk && { level: risk.level, reasons: risk.reasons, headSha: risk.headSha, computedAt: risk.computedAt, rulesVersion: risk.rulesVersion },
      preReview: row ? this.d.preReviewView(row) : null,
      brief,
      preReviewEnabled: this.d.preReviewEnabled(),
      canPost: pr.state === "open" && brief !== null,
    };
  }

  private briefView(stored: StoredBrief | null): BriefView | null {
    return stored && {
      id: stored.id, prId: stored.prId, preReviewId: stored.preReviewId, target: stored.target, markdown: stored.markdown, summaryOk: stored.summaryOk,
      createdAt: stored.createdAt, postedAt: stored.postedAt, postedUrl: stored.postedUrl,
    };
  }

  /** ticket 页的 Review tab：每个 PR 一块；还没有 PR 的分支（栈的上层）显示最近的预审和简报。 */
  ticketView(ticketKey: string): TicketAssessmentView {
    const prs = this.d.prs.byTicket(ticketKey);
    const withPr = new Set(prs.filter((p) => p.headBranch).map((p) => `${p.slug}\0${p.headBranch}`));
    const branches = this.d.preReviews
      .latestWithoutPr(ticketKey)
      .filter((r) => !withPr.has(`${r.target.repoSlug}\0${r.target.branch}`))
      .map(
        (r): PrAssessmentView => ({
          prId: null, url: null, number: null, title: null, state: null, draft: false, target: r.target, readiness: null, risk: null,
          preReview: this.d.preReviewView(r),
          brief: this.briefView(this.d.repo.latestBriefFor(r.target) ?? this.d.repo.latestBriefForBranch(r.target.repoSlug, r.target.branch)),
          preReviewEnabled: this.d.preReviewEnabled(), canPost: false,
        }),
      );
    return { ticketKey, prs: prs.map((p) => this.view(p)), branches };
  }

  /** 「进度」页的待 review：开着、非草稿的 PR，按 未就绪 → 风险高 → 等得久 排。 */
  queue(): ReviewQueueItem[] {
    const open = this.d.prs.all().filter((p) => p.state === "open" && !p.isDraft);
    const sums = this.d.repo.summaries(open.map((p) => p.id));
    return open
      .map((p): ReviewQueueItem => {
        const s = sums.get(p.id);
        return {
          prId: p.id, ticketKey: p.ticketKey, url: p.url, number: p.number, title: p.title, repoSlug: p.slug, risk: s?.risk ?? null,
          ready: s?.ready ?? null, missing: s?.missing ?? [], openedAt: p.openedAt,
        };
      })
      .sort(reviewQueueOrder);
  }

  /** 风险的输入（简报也用：没有 PR 的分支传 pr = null）。 */
  riskInput(o: { pr: TicketPr | null; row: PreReviewRow | null; files: DiffFile[]; gaps: EvidenceGap[]; ticketKey: string | null; branch: string | null; labels: string[] }): RiskInput {
    const policy = this.d.policy(o.pr?.slug ?? o.row?.target.repoSlug ?? "");
    const sessionId = o.row?.sessionId ?? (o.pr ? this.d.sessionOf(o.pr) : null);
    const checks = this.d.checks(sessionId);
    const failing = summarizeHits(checks.hits);
    const evidence = o.row ? this.d.preReviews.evidenceOf(o.row.id) : [];
    const openRepos = o.ticketKey ? new Set(this.d.prs.byTicket(o.ticketKey).filter((p) => p.state === "open").map((p) => p.slug)) : new Set<string>();
    if (o.pr) openRepos.add(o.pr.slug);
    return {
      files: o.files,
      openRepoCount: Math.max(openRepos.size, 1),
      ci: ciOf(o.pr),
      rerun: rerunOf(o.row?.checks ?? null),
      unresolvedHits: failing.reduce((a, f) => a + f.count, 0),
      checksAbsent: checks.absent,
      mustViolations: o.row && o.row.status === "done" ? o.row.violations.filter((v) => v.severity === "must").length : 0,
      evidenceGaps: o.gaps,
      verifiedTest: hasVerifiedTest(evidence),
      ticketType: inferTicketType(o.labels, o.branch, policy.risk.types),
    };
  }

  /** 算这个 PR 的风险（不写表）。 */
  riskOf(input: RiskInput, slug: string): Risk & { stats: ReturnType<typeof computeRisk>["stats"] } {
    return computeRisk(input, this.d.policy(slug).risk);
  }

  /** 同一个 PR 同时只算一次；算的时候又来了请求，算完再算一次。 */
  assess(prId: number): Promise<void> {
    const cur = this.running.get(prId);
    if (cur) return cur.then(() => this.assess(prId));
    const p = this.doAssess(prId)
      .catch((e: unknown) => this.d.log(`assessment of PR ${prId} failed`, e))
      .finally(() => this.running.delete(prId));
    this.running.set(prId, p);
    return p;
  }

  /** 策略改了、开关改了：全部开着的 PR 重算。 */
  async assessAll(prIds: readonly number[]): Promise<void> {
    for (const id of prIds) await this.assess(id);
  }

  private async filesFor(pr: TicketPr, row: PreReviewRow | null): Promise<DiffFile[] | null> {
    if (row && row.files.length && row.target.headSha === pr.headSha) return row.files;
    const c = this.filesCache.get(pr.id);
    if (c && c.headSha === pr.headSha) return c.files;
    const files = await this.d.files(pr);
    if (files && pr.headSha) this.filesCache.set(pr.id, { headSha: pr.headSha, files });
    return files;
  }

  private async doAssess(prId: number): Promise<void> {
    const pr = this.d.prs.get(prId);
    if (!pr || pr.state !== "open") return;
    const enabled = this.d.preReviewEnabled();
    const policy = this.d.policy(pr.slug);
    const lang = this.d.lang();
    const row = this.latestPreReview(pr);
    const current = row && row.target.headSha === pr.headSha ? row : null;
    const gaps = current && (current.status === "done" || current.status === "failed") ? this.d.gaps(current) : null;
    const sessionId = row?.sessionId ?? this.d.sessionOf(pr);
    const failing = summarizeHits(this.d.checks(sessionId).hits);
    const seen = this.seen.get(pr.id);
    const items = this.d.openCommentItems(pr.id);
    const openComments = items !== null ? items : seen ? openChangeRequests(seen.reviews, seen.author) : null;

    const rIn: ReadinessInput = {
      ci: ciOf(pr),
      blockFailures: failing.filter((f) => f.severity === "block" && f.mode === "enforce").reduce((a, f) => a + f.count, 0),
      preReviewEnabled: enabled,
      preReview: row
        ? { headSha: row.target.headSha, status: row.status, verdict: row.verdict, should: row.violations.filter((v) => v.severity === "should").length }
        : null,
      headSha: pr.headSha,
      evidenceGaps: gaps,
      openComments,
      mergeable: pr.mergeable === "mergeable" ? "MERGEABLE" : pr.mergeable === "conflicting" ? "CONFLICTING" : pr.mergeable === "unknown" ? "UNKNOWN" : null,
      waitingOnGate: this.d.waitingOnGate(pr),
      description: seen ? seen.body : undefined,
    };
    const readiness: Readiness = computeReadiness(rIn, policy.readiness, lang);

    const files = await this.filesFor(pr, current);
    const now = this.d.now();
    let changed = false;
    const r1 = this.d.repo.setReadiness(pr.id, pr.headSha, readiness, now);
    changed ||= r1.changed;
    if (r1.changed && readiness.ready && r1.before !== true && pr.headSha) {
      this.d.recordEvent("pr_ready", { prId: pr.id, ticketKey: pr.ticketKey, repoSlug: pr.slug, dedupeKey: `ready:${pr.id}:${pr.headSha}`, data: { prNumber: pr.number } });
    }
    if (files) {
      const input = this.riskInput({ pr, row: current, files, gaps: gaps ?? [], ticketKey: pr.ticketKey, branch: pr.headBranch, labels: pr.labels });
      const risk = this.riskOf(input, pr.slug);
      const inputs = {
        ci: input.ci, rerun: input.rerun, unresolvedHits: input.unresolvedHits, checksAbsent: input.checksAbsent !== null, mustViolations: input.mustViolations,
        evidenceGaps: input.evidenceGaps.map((g) => g.category), verifiedTest: input.verifiedTest, ticketType: input.ticketType, openRepoCount: input.openRepoCount,
        lines: risk.stats.lines, files: risk.stats.files, generated: risk.stats.generated,
      };
      const r2 = this.d.repo.setRisk(pr.id, pr.headSha, { level: risk.level, reasons: risk.reasons }, inputs, RISK_RULES_VERSION, now);
      changed ||= r2.changed;
      if (r2.changed && risk.level === "high" && r2.before !== "high" && !pr.isDraft && pr.headSha) {
        this.d.recordEvent("pr_risk_high", { prId: pr.id, ticketKey: pr.ticketKey, repoSlug: pr.slug, dedupeKey: `risk_high:${pr.id}:${pr.headSha}`, data: { prNumber: pr.number, level: "high" } });
      }
    }
    if (changed) this.d.changed();
  }
}
