import type { BranchWatchRepo, BranchWatchRow } from "../db/branch-watch-repo";
import type { PrStageRepo } from "../db/pr-stage-repo";
import type { TicketPr, TicketPrsRepo } from "../db/ticket-prs-repo";
import {
  reviewerKind, type CiCheck, type PrComment, type PrStatus, type branchRuns, type failedLog, type prStatus, type prsForBranch, type reviewAuthors,
  type ReviewAuthors, type reviewComments,
} from "../tickets/gh";
import type { firstCommitAt } from "../tickets/git";
import { prUrlParts } from "../../shared/pr-url";
import type { Ticket, TicketRepo, WatchedPr } from "../../shared/types";
import type { CiItem } from "./ci-delivery";
import { firstCommitObservation, prObservations, scopeOf, stageKey, type ObsScope, type PrSnapshot } from "./pr-observe";
import { branchTargets, capRound, nextBranchCheckAt, nextPrCheckAt, prPolls, type BranchTarget, type PrPoll } from "./pr-schedule";

/** 每次 gh 调用的超时。 */
export const PR_GH_TIMEOUT_MS = 5000;
/** 失败日志取最后这么多行。 */
export const CI_LOG_LINES = 60;
/** 链接时已经合并了这么久以上的 PR（例如回填旧分支）：不再排复盘。 */
export const MERGED_RECENT_MS = 24 * 60 * 60_000;
/** 每次最多取这么多个失败 run 的日志。 */
const FAILED_LOGS_MAX = 3;
/** 同时跑的 gh 最多这么多个。 */
const GH_PARALLEL = 4;
/** 一个 Copilot review 的行内评论最多试这么多次。 */
const INLINE_TRIES_MAX = 3;
/** soon() 等这么久再查：合并多次调用。 */
const SOON_MS = 1000;
/** cachedByUrl 只认这么久之内读成功的。 */
const CACHE_FRESH_MS = 60_000;
/** 从没读成功过的 PR 读失败了：这么久之后再试（读过的按 checkedAt 排）。 */
const UNREAD_RETRY_MS = 60_000;

export interface PrWatcherDeps {
  prs: TicketPrsRepo;
  branches: BranchWatchRepo;
  /** 未归档的 ticket 和它们的仓库。 */
  tickets(): Pick<Ticket, "key" | "repos">[];
  repoOf(repoId: number): TicketRepo | null;
  /** 在哪个目录跑 gh（worktree 或仓库本身）。 */
  ghWorkDir(r: TicketRepo): string;
  /** 这个 ticket 的终端开着（repoId 为 null：这个 ticket 任何一个终端；总控算所有仓库）。 */
  sessionOpen(ticketKey: string, repoId: number | null): boolean;
  /** 不是 ticket 仓库的 PR 在这里跑 gh（gh pr view <url> 不需要在仓库里）。 */
  home: string;
  slugOf(path: string): string | null;
  gh: {
    prStatus: typeof prStatus; prsForBranch: typeof prsForBranch; branchRuns: typeof branchRuns; failedLog: typeof failedLog;
    reviewComments: typeof reviewComments; reviewAuthors: typeof reviewAuthors;
  };
  git: { firstCommitAt: typeof firstCommitAt };
  stages: Pick<PrStageRepo, "has" | "add" | "lastCi">;
  /** Butler 跟踪的 PR 合并了：复盘规矩的分析排队用。抛错下一轮再来，成功后不再调用。repoPath 是 PR 所在的 ticket 仓库。 */
  onMerged(pr: TicketPr, repoPath: string | null): void;
  /** PR 的状态或 review 变了：把这个 ticket 所有 PR 写成一条 refresh handoff。 */
  onPrChanged(ticketKey: string): void;
  /** CI 有了新的结论。 */
  onCiSettled(item: CiItem): void;
  notify(): void;
  /** 每一轮结束后（不管查没查、成没成）：主进程用它再递一遍还没递出去的 CI 结论（session 刚安静下来）。 */
  roundDone?(): void;
  now(): number;
  log(msg: string, err?: unknown): void;
}

const STATES = { OPEN: "open", MERGED: "merged", CLOSED: "closed" } as const;

/** 一轮里攒下的：哪些 ticket 的 PR 状态或 review 变了、页面要不要刷新。 */
interface Marks {
  prChanged: Set<string>;
  changed: boolean;
}

type Forced = (ticketKey: string, repoId: number | null) => boolean;

const sameChecks = (a: CiCheck[], b: CiCheck[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 按 PR 查（全部是代码，不调模型）。ticket_prs 每个 (ticket, PR) 一行，PR 按 URL 读一次、写进所有链接它的 ticket；
 * 每个 ticket 仓库的分支用 gh pr list 找 PR（同一个分支上先后的几个 PR 都链接上），没有开着的 PR 时看分支的 workflow run（branch_watch）。
 * PR 状态或 review 变了告诉 onPrChanged，CI 有了新结论告诉 onCiSettled，合并了告诉 onMerged（成功为止）。
 * 每 tick 看一遍谁到期了；一次只跑一轮；一轮里并行，但 gh 同时最多 4 个。
 */
export class PrWatcher {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private soonTimer: ReturnType<typeof setTimeout> | null = null;
  /** soon() / soonTicket() 要求马上查的仓库和 ticket。 */
  private dueRepos = new Set<number>();
  private dueTickets = new Set<string>();
  private ghActive = 0;
  private readonly ghWaiting: (() => void)[] = [];
  /** Copilot review 的行内评论拉失败的次数，键 `${url}:${reviewId}`；拉到了就删掉。只在内存里。 */
  private readonly inlineTries = new Map<string, number>();
  /** 从没读成功过的 PR 读失败后，下次再试的时间（键 URL）。只在内存里。 */
  private readonly unreadRetryAt = new Map<string, number>();

  constructor(private readonly d: PrWatcherDeps) {}

  start(tickMs = 15_000): void {
    this.stop();
    this.timer = setInterval(() => void this.check(), tickMs);
    this.timer.unref?.();
    // 启动时先查一轮：Butler 没开着的时候 PR 和 CI 可能都变了。
    void this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.soonTimer = null;
  }

  /** 立刻查这个仓库的分支和 PR（session 刚 push、Stop 时用）：1 秒内跑一轮；正有一轮在跑就等它跑完再来一轮。 */
  soon(repoId: number): void {
    this.dueRepos.add(repoId);
    this.schedule();
  }

  /** 立刻查这个 ticket 所有仓库的分支和它所有的 PR。 */
  soonTicket(ticketKey: string): void {
    this.dueTickets.add(ticketKey);
    this.schedule();
  }

  /** 一轮：查所有到期的。永不 reject；进行中再调用就合并成这一轮。 */
  check(): Promise<void> {
    this.running ??= this.round().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** 这个 ticket 的 PR 行，和还没有开着的 PR 的分支行（读过的、分支是仓库现在的分支）。 */
  statusOf(ticketKey: string): WatchedPr[] {
    const prs = this.d.prs.byTicket(ticketKey);
    const out: WatchedPr[] = prs.map((r) => ({
      ticketKey, prId: r.id, repoId: r.repoId, repoPath: r.repoId === null ? null : (this.d.repoOf(r.repoId)?.repoPath ?? null),
      branch: r.headBranch ?? "", number: r.number, url: r.url, state: r.state, review: r.review, ci: r.ci, headSha: r.headSha,
      checkedAt: r.checkedAt, readError: r.readError,
    }));
    for (const b of this.d.branches.all()) {
      if (b.ticketKey !== ticketKey || b.checkedAt === 0) continue;
      const repo = this.d.repoOf(b.repoId);
      if (!repo || repo.branch !== b.branch) continue;
      if (prs.some((r) => r.state === "open" && r.repoId === b.repoId && r.headBranch === b.branch)) continue;
      out.push({
        ticketKey, prId: null, repoId: b.repoId, repoPath: repo.repoPath, branch: b.branch, number: null, url: null, state: null, review: null,
        ci: b.ci, headSha: b.headSha, checkedAt: b.checkedAt, readError: b.readError,
      });
    }
    return out;
  }

  /** 给 HoldWatcher 用：PR url 对应的、60 秒内读成功的状态；没有为 null。 */
  cachedByUrl(url: string): Pick<TicketPr, "state"> | null {
    const now = this.d.now();
    const rows = this.d.prs.byUrl(url).filter((r) => !r.readError && r.checkedAt > 0 && now - r.checkedAt < CACHE_FRESH_MS);
    const r = rows.sort((a, b) => b.checkedAt - a.checkedAt)[0];
    return r ? { state: r.state } : null;
  }

  private schedule(): void {
    if (this.soonTimer) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      void this.check().then(() => {
        // 赶上的是已经在跑的那一轮，它没带上这些。
        if (this.dueRepos.size > 0 || this.dueTickets.size > 0) void this.check();
      });
    }, SOON_MS);
    this.soonTimer.unref?.();
  }

  /** 每一步各自兜住错误：一步失败不影响别的。 */
  private async part(what: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.d.log(`pr watch: ${what} failed`, e);
    }
  }

  private async round(): Promise<void> {
    const repos = this.dueRepos;
    const keys = this.dueTickets;
    this.dueRepos = new Set();
    this.dueTickets = new Set();
    const forced: Forced = (key, repoId) => keys.has(key) || (repoId !== null && repos.has(repoId));
    const marks: Marks = { prChanged: new Set(), changed: false };
    let tickets: Pick<Ticket, "key" | "repos">[] = [];
    await this.part("listing tickets", () => {
      tickets = this.d.tickets();
    });
    await this.part("pruning old branches", () => this.prune(tickets, marks));
    await this.part("reading PRs", () => this.pollPrs(tickets, forced, marks));
    await this.part("checking branches", () => this.checkBranches(tickets, forced, marks));
    await this.part("handling merged PRs", () => this.handleMerged());
    // 一个 ticket 的所有 PR 都写完了再告诉 onPrChanged，而且只告诉一次。
    for (const key of marks.prChanged) await this.part(`updating ${key} after its PR changed`, () => this.d.onPrChanged(key));
    if (marks.changed) await this.part("notify", () => this.d.notify());
    await this.part("roundDone", () => this.d.roundDone?.());
  }

  /** ticket 换了分支（C-S3）：删掉旧分支找到的、没合并的 PR 行；分支行换成新分支的、没查过的。 */
  private prune(tickets: Pick<Ticket, "key" | "repos">[], marks: Marks): void {
    for (const t of tickets) {
      for (const r of t.repos) {
        if (this.d.prs.pruneStale(r.id, r.branch) > 0) marks.changed = true;
        const b = this.d.branches.get(r.id);
        if (b && b.branch !== r.branch) {
          this.d.branches.upsert({ repoId: r.id, ticketKey: t.key, branch: r.branch, ci: "unknown", headSha: null, failed: [], readError: false, checkedAt: 0 });
          marks.changed = true;
        }
      }
    }
  }

  private async pollPrs(tickets: Pick<Ticket, "key" | "repos">[], forced: Forced, marks: Marks): Promise<void> {
    const live = new Set(tickets.map((t) => t.key));
    const rows = this.d.prs.needingRead().filter((r) => live.has(r.ticketKey));
    const polls = prPolls(rows, {
      repoOf: (id) => this.d.repoOf(id), ghWorkDir: (r) => this.d.ghWorkDir(r), home: this.d.home, sessionOpen: (k, id) => this.d.sessionOpen(k, id),
    });
    const now = this.d.now();
    const due = capRound(
      polls.filter((p) =>
        p.rows.some((r) => forced(r.ticketKey, r.repoId) || (now >= nextPrCheckAt(r, p.sessionOpen) && now >= (this.unreadRetryAt.get(p.url) ?? 0))),
      ),
    );
    await Promise.all(due.map((p) => this.part(`reading ${p.url}`, () => this.poll(p, marks))));
  }

  /** 读一个 PR，写进链接它的每个 ticket 的行。 */
  private async poll(p: PrPoll, marks: Marks): Promise<void> {
    const pr = await this.gh(() => this.d.gh.prStatus(p.cwd, p.url, PR_GH_TIMEOUT_MS));
    const now = this.d.now();
    if (!pr) {
      // C-V7：读失败不是 PR 变了。ci、state 留着上一次的，只记下读失败；从没读成功过的 checkedAt 留 0（还算第一次读），过一会儿再试。
      this.d.log(`pr watch: reading ${p.url} failed`);
      for (const r of p.rows) {
        this.d.prs.update(r.id, r.checkedAt === 0 ? { readError: true } : { readError: true, checkedAt: now });
        if (!r.readError) marks.changed = true;
      }
      if (p.rows.some((r) => r.checkedAt === 0)) this.unreadRetryAt.set(p.url, now + UNREAD_RETRY_MS);
      return;
    }
    this.unreadRetryAt.delete(p.url);
    const failed = pr.ci === "failing" ? await this.failedWithLogs(p.cwd, pr.checks, p.slug) : [];
    const inline = await this.inlineComments(p, pr);
    const bots = await this.botsOf(p, pr);
    for (const r of p.rows) this.apply(r, pr, failed, inline, bots, now, marks);
  }

  private scopeOf(r: TicketPr, branch: string | null): ObsScope {
    return { ticketKey: r.ticketKey, prId: r.id, repoId: r.repoId, scope: scopeOf(r.ticketKey, r.repoId, r.slug), branch };
  }

  /** 这一轮读到的写进一行：先记事件，再更新行。 */
  private apply(r: TicketPr, pr: PrStatus, failed: CiCheck[], inline: PrComment[], bots: ReviewAuthors | null, now: number, marks: Marks): void {
    const state = STATES[pr.state];
    // GitHub 的时间，没有就用行里存的（例如合并占位释放的时间），再没有用 now；都不晚于 now。只有合并了、关闭了才有。
    const mergedAt = state === "merged" ? Math.min(pr.mergedAt ?? r.mergedAt ?? now, now) : r.mergedAt;
    const closedAt = state === "closed" ? Math.min(pr.closedAt ?? r.closedAt ?? now, now) : r.closedAt;
    const headBranch = pr.headBranch || r.headBranch;
    const next: PrSnapshot = { number: r.number, state, review: pr.review, ci: pr.ci, headSha: pr.headSha, failed, checkedAt: now };
    const first = r.checkedAt === 0;
    let added = false;
    try {
      const obs = prObservations(this.scopeOf(r, headBranch), r, next, { ...pr, mergedAt, closedAt }, inline, now, bots, this.d.stages.lastCi(r.id));
      for (const o of obs) if (this.d.stages.add(o.event, o.dedupeKey)) added = true;
    } catch (e) {
      this.d.log(`pr watch: recording the stages of ${r.url} for ${r.ticketKey} failed`, e);
    }
    this.d.prs.update(r.id, {
      state, review: pr.review, ci: pr.ci, headSha: pr.headSha, headBranch, failed, readError: false, checkedAt: now,
      openedAt: pr.createdAt ?? r.openedAt, mergedAt, closedAt,
    });
    if (first || r.state !== state || r.review !== pr.review) marks.prChanged.add(r.ticketKey);
    if (first || added || r.readError || r.state !== state || r.review !== pr.review || r.ci !== pr.ci || r.headSha !== pr.headSha || !sameChecks(r.failed, failed)) {
      marks.changed = true;
    }
    if ((pr.ci === "passing" || pr.ci === "failing") && (first || r.headSha !== pr.headSha || r.ci !== pr.ci)) {
      try {
        this.d.onCiSettled({ kind: "pr", id: r.id });
      } catch (e) {
        this.d.log(`pr watch: handing over the CI result of ${r.url} for ${r.ticketKey} failed`, e);
      }
    }
  }

  /** Copilot review 的行内评论：新的（或之前没拉到、不到 3 次的）才拉。所有 review 照常马上记，行内评论晚到也会被数上。 */
  private async inlineComments(p: PrPoll, pr: PrStatus): Promise<PrComment[]> {
    const wanted = pr.reviews.filter((rv) => {
      if (rv.state === "PENDING" || reviewerKind(rv.author, pr.author) !== "copilot") return false;
      const tries = this.inlineTries.get(`${p.url}:${rv.id}`);
      return tries === undefined ? p.rows.some((r) => !this.d.stages.has(stageKey.review(this.scopeOf(r, pr.headBranch || r.headBranch), rv.id, rv.state))) : tries < INLINE_TRIES_MAX;
    });
    if (wanted.length === 0) return [];
    const got = await this.gh(() => this.d.gh.reviewComments(p.cwd, pr.number, PR_GH_TIMEOUT_MS, p.slug));
    if (got === null) this.d.log(`pr watch: fetching the inline comments of ${p.url} failed`);
    for (const rv of wanted) {
      const key = `${p.url}:${rv.id}`;
      if (got) this.inlineTries.delete(key);
      else this.inlineTries.set(key, (this.inlineTries.get(key) ?? 0) + 1);
    }
    return got ?? [];
  }

  /** 谁是 Bot：gh pr view 的作者没有类型。有新的、按名字认是人的 review 才问一次 REST；失败按名字认，不拦。 */
  private async botsOf(p: PrPoll, pr: PrStatus): Promise<ReviewAuthors | null> {
    const fresh = pr.reviews.some(
      (rv) => rv.state !== "PENDING" && reviewerKind(rv.author, pr.author) === "human" &&
        p.rows.some((r) => !this.d.stages.has(stageKey.review(this.scopeOf(r, pr.headBranch || r.headBranch), rv.id, rv.state))),
    );
    if (!fresh) return null;
    const bots = await this.gh(() => this.d.gh.reviewAuthors(p.cwd, pr.number, PR_GH_TIMEOUT_MS, p.slug));
    if (bots === null) this.d.log(`pr watch: fetching the review authors of ${p.url} failed`);
    return bots;
  }

  private async checkBranches(tickets: Pick<Ticket, "key" | "repos">[], forced: Forced, marks: Marks): Promise<void> {
    const targets = branchTargets(tickets, { ghWorkDir: (r) => this.d.ghWorkDir(r), sessionOpen: (k, id) => this.d.sessionOpen(k, id) });
    const open = this.d.prs.needingRead().filter((r) => r.state === "open");
    const now = this.d.now();
    const due = capRound(
      targets.filter((t) => {
        const hasOpenPr = open.some((r) => r.repoId === t.repoId && r.headBranch === t.branch);
        return forced(t.ticketKey, t.repoId) || now >= nextBranchCheckAt(this.branchRowOf(t), t.sessionOpen, hasOpenPr);
      }),
    );
    await Promise.all(due.map((t) => this.part(`checking ${t.branch} in ${t.repoPath}`, () => this.checkBranch(t, marks))));
  }

  /** 这个仓库的分支行；分支改过时行还是旧分支的，当作没有。 */
  private branchRowOf(t: BranchTarget): BranchWatchRow | null {
    const row = this.d.branches.get(t.repoId);
    return row && row.branch === t.branch ? row : null;
  }

  /** 找这个分支上的 PR 并链接上；没有开着的 PR 时看分支的 CI；再看下一个 PR 的第一个 commit。 */
  private async checkBranch(t: BranchTarget, marks: Marks): Promise<void> {
    const prev = this.branchRowOf(t);
    const base = { repoId: t.repoId, ticketKey: t.ticketKey, branch: t.branch };
    const kept = { ci: prev?.ci ?? ("unknown" as const), headSha: prev?.headSha ?? null, failed: prev?.failed ?? [] };
    const list = await this.gh(() => this.d.gh.prsForBranch(t.cwd, t.branch, PR_GH_TIMEOUT_MS));
    const now = this.d.now();
    if (list === null) {
      this.d.log(`pr watch: listing the PRs of ${t.branch} in ${t.repoPath} failed`);
      this.d.branches.upsert({ ...base, ...kept, readError: true, checkedAt: now });
      if (!prev?.readError) marks.changed = true;
      return;
    }
    const repoSlug = this.d.slugOf(t.repoPath);
    for (const b of list) {
      const slug = prUrlParts(b.url)?.slug ?? repoSlug;
      if (!slug) continue;
      // 新链接的行 checked_at 为 0，下一轮的 PR 读取马上读它（R12）。
      const { created } = this.d.prs.link({
        ticketKey: t.ticketKey, url: b.url, slug, repoId: t.repoId, number: b.number, headBranch: b.headRefName || t.branch, state: STATES[b.state],
        openedAt: b.createdAt, mergedAt: b.mergedAt, closedAt: b.closedAt, source: "branch", linkedAt: now,
      });
      if (created) marks.changed = true;
    }
    if (list.some((b) => b.state === "OPEN")) {
      // CI 由 PR 的读取接手。
      this.d.branches.upsert({ ...base, ...kept, readError: false, checkedAt: now });
    } else {
      // branchRuns 的 null 也可能是这个分支还没有 run：不当作读失败，留着上一次的。
      const runs = await this.gh(() => this.d.gh.branchRuns(t.cwd, t.branch, PR_GH_TIMEOUT_MS));
      const next = runs ? { ci: runs.ci, headSha: runs.headSha, failed: runs.ci === "failing" ? await this.failedWithLogs(t.cwd, runs.checks, null) : [] } : kept;
      this.d.branches.upsert({ ...base, ...next, readError: false, checkedAt: this.d.now() });
      if (!prev || prev.readError || prev.ci !== next.ci || prev.headSha !== next.headSha || !sameChecks(prev.failed, next.failed)) marks.changed = true;
      if ((next.ci === "passing" || next.ci === "failing") && (!prev || prev.headSha !== next.headSha || prev.ci !== next.ci)) {
        try {
          this.d.onCiSettled({ kind: "branch", repoId: t.repoId });
        } catch (e) {
          this.d.log(`pr watch: handing over the CI result of ${t.branch} in ${t.repoPath} failed`, e);
        }
      }
    }
    if (await this.recordFirstCommit(t)) marks.changed = true;
  }

  /**
   * 第一个 commit：这个分支上一个结束了的 PR（合并或关闭）之后提交的第一个，key 带上那个 PR 的 id；没有结束过的 PR 就是分支上的第一个。
   * 本地的一次 git 调用：每次查分支都问，直到记下来为止。
   */
  private async recordFirstCommit(t: BranchTarget): Promise<boolean> {
    let last: TicketPr | null = null;
    let lastEnd = -Infinity;
    for (const r of this.d.prs.byTicket(t.ticketKey)) {
      const end = r.mergedAt ?? r.closedAt;
      if (r.repoId !== t.repoId || r.headBranch !== t.branch || end === null || end <= lastEnd) continue;
      last = r;
      lastEnd = end;
    }
    const afterId = last?.id ?? null;
    if (this.d.stages.has(stageKey.firstCommit({ scope: String(t.repoId), branch: t.branch }, afterId))) return false;
    const at = await this.d.git.firstCommitAt(t.cwd, t.branch, last ? lastEnd : null);
    if (at === null) return false;
    const o = firstCommitObservation(t, at, afterId);
    return this.d.stages.add(o.event, o.dedupeKey);
  }

  /** C-S5：合并了的 PR 交给 onMerged，成功才记下；抛错下一轮再来。链接之前一天多就合并了的不交。 */
  private handleMerged(): void {
    const now = this.d.now();
    for (const r of this.d.prs.pendingMerged()) {
      if (r.mergedAt !== null && r.mergedAt < r.linkedAt - MERGED_RECENT_MS) {
        this.d.prs.setMergedHandled(r.id, now);
        continue;
      }
      try {
        this.d.onMerged(r, r.repoId === null ? null : (this.d.repoOf(r.repoId)?.repoPath ?? null));
        this.d.prs.setMergedHandled(r.id, now);
      } catch (e) {
        this.d.log(`pr watch: onMerged for ${r.url} of ${r.ticketKey} failed`, e);
      }
    }
  }

  /** 失败的检查；最多取 3 个 run 的日志。同一个 run 的几个 job 共用一份日志，只取一次、挂在第一个上，免得重复。 */
  private async failedWithLogs(cwd: string, checks: CiCheck[], repo: string | null): Promise<CiCheck[]> {
    const fetched = new Set<number>();
    const out: CiCheck[] = [];
    for (const c of checks) {
      if (c.state !== "failing") continue;
      if (c.runId === null || fetched.has(c.runId) || fetched.size >= FAILED_LOGS_MAX) {
        out.push({ ...c });
        continue;
      }
      const runId = c.runId;
      fetched.add(runId);
      const log = await this.gh(() => this.d.gh.failedLog(cwd, runId, CI_LOG_LINES, PR_GH_TIMEOUT_MS, repo));
      if (log === null) this.d.log(`pr watch: fetching the log of run ${runId} failed`);
      out.push(log === null ? { ...c } : { ...c, log });
    }
    return out;
  }

  /** 跑一个 gh 调用：同时最多 GH_PARALLEL 个；抛错当作失败（null），记日志。 */
  private async gh<T>(call: () => Promise<T | null>): Promise<T | null> {
    while (this.ghActive >= GH_PARALLEL) await new Promise<void>((r) => this.ghWaiting.push(r));
    this.ghActive++;
    try {
      return await call();
    } catch (e) {
      this.d.log("pr watch: gh call failed", e);
      return null;
    } finally {
      this.ghActive--;
      this.ghWaiting.shift()?.();
    }
  }
}
