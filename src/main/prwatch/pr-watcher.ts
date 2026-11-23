import type { BranchOwnersRepo } from "../db/branch-owners-repo";
import type { BranchWatchRepo, BranchWatchRow } from "../db/branch-watch-repo";
import type { PrStageRepo } from "../db/pr-stage-repo";
import { PR_GONE_RETRY_MS, prGivenUp, type TicketPr, type TicketPrsRepo } from "../db/ticket-prs-repo";
import {
  GH_NOT_FOUND, latestReviewers, reviewerKind, type CiCheck, type PrComment, type PrStatus, type branchRuns, type failedLog, type prRead, type prsForBranch, type reviewAuthors,
  type ReviewAuthors, type reviewComments,
} from "../tickets/gh";
import { prUrlParts } from "../../shared/pr-url";
import type { firstCommitAt } from "../tickets/git";
import type { Ticket, TicketRepo, WatchedPr } from "../../shared/types";
import type { CiItem } from "./ci-delivery";
import { PR_STATES, type PrLinker } from "./pr-links";
import { firstCommitObservation, prObservations, scopeOf, stageKey, type ObsScope, type PrSnapshot } from "./pr-observe";
import { branchTargets, capRound, nextBranchCheckAt, nextPrCheckAt, PR_SLOW_MS, PR_WATCH_MAX, prPolls, type BranchTarget, type PrPoll } from "./pr-schedule";

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
/** 从没读成功过的 PR 读失败了：第一次等这么久再试，之后每次翻倍、最多 PR_SLOW_MS（读过的按 checkedAt 排）。 */
const UNREAD_RETRY_MS = 60_000;
/** 有归属的分支（不是 ticket 分支）最多这么久列一次 PR。 */
export const OWNED_LIST_MS = 5 * 60_000;
/** 这么久之前推的分支不再去列。 */
export const OWNED_FRESH_MS = 14 * 24 * 60 * 60_000;
/** 有归属的分支上已经合并 / 关闭的 PR：最近一次推送前这么久以内开的才算这次的（推送和开 PR 之间隔不了多久）。 */
export const OWNED_PR_SLACK_MS = 24 * 60 * 60_000;

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
  linker: Pick<PrLinker, "linkBranchPrs">;
  gh: {
    /** 读一个 PR：GH_NOT_FOUND 是 GitHub 说仓库看得见、没有这个 PR，null 是 gh 失败（包括仓库解析不到）。 */
    prStatus: typeof prRead; prsForBranch: typeof prsForBranch; branchRuns: typeof branchRuns; failedLog: typeof failedLog;
    reviewComments: typeof reviewComments; reviewAuthors: typeof reviewAuthors;
  };
  git: { firstCommitAt: typeof firstCommitAt };
  stages: Pick<PrStageRepo, "has" | "add" | "lastCi">;
  /** 哪些分支是哪个 session 推的（工作流 W）：不是 ticket 分支的也去列 PR。没有时不列。 */
  owners?: Pick<BranchOwnersRepo, "since">;
  /** Shipherd 跟踪的 PR 合并了：复盘规矩的分析排队用。抛错下一轮再来，成功后不再调用。repoPath 是 PR 所在的 ticket 仓库。 */
  onMerged(pr: TicketPr, repoPath: string | null): void;
  /** 按旧 slug 读到的 PR，GitHub 给的链接是另一个仓库名（仓库改了名、换了 owner）：交给改名处理去确认、改写。不等它。 */
  onSlugMoved?(oldSlug: string, newSlug: string): void;
  /** PR 的状态或 review 变了：把这个 ticket 所有 PR 写成一条 refresh handoff。 */
  onPrChanged(ticketKey: string): void;
  /** CI 有了新的结论。 */
  onCiSettled(item: CiItem): void;
  /** 读成功一个 PR、写完所有行以后（工作流 I 的评论闭环）：不等它，不让它拖慢这一轮。rows 是更新后的行。 */
  onPrRead?(rows: TicketPr[], pr: PrStatus, where: { cwd: string; slug: string }): Promise<void>;
  /** 新看到同事（不是 PR 作者、不是 bot）的评论或 review（ws-j 的外部通知）；第一次读到的 PR 不算（那是历史）。抛错只记日志。 */
  onHumanComment?(ticketKey: string, prNumber: number, count: number): void;
  notify(): void;
  /** 每一轮结束后（不管查没查、成没成）：主进程用它再递一遍还没递出去的 CI 结论（session 刚安静下来）。 */
  roundDone?(): void;
  now(): number;
  log(msg: string, err?: unknown): void;
}


/** 一轮里攒下的：哪些 ticket 的 PR 状态或 review 变了、页面要不要刷新。 */
interface Marks {
  prChanged: Set<string>;
  changed: boolean;
}

type Forced = (ticketKey: string, repoId: number | null) => boolean;

/** 一轮里读失败的 PR：notFound 是 GitHub 说仓库看得见、没有这个 PR，其余是 gh 失败。 */
interface Unread {
  poll: PrPoll;
  notFound: boolean;
}

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
  /** soon() / soonTicket() 要求马上查的仓库和 ticket；ticket 的值：放弃了的 PR 要不要也读。 */
  private dueRepos = new Set<number>();
  private dueTickets = new Map<string, boolean>();
  private ghActive = 0;
  private readonly ghWaiting: (() => void)[] = [];
  /** Copilot review 的行内评论拉失败的次数，键 `${url}:${reviewId}`；拉到了就删掉。只在内存里。 */
  private readonly inlineTries = new Map<string, number>();
  /** 有归属的分支上次列 PR 的时间，键 `${ticket}:${repoId}:${branch}`。只在内存里。 */
  private readonly ownedListedAt = new Map<string, number>();
  /** 从没读成功过的 PR 读失败后的退避（键 URL）：下次再试的时间、这次等了多久。读成功或行没了就删掉。只在内存里。 */
  private readonly unreadBackoff = new Map<string, { at: number; delay: number }>();

  constructor(private readonly d: PrWatcherDeps) {}

  start(tickMs = 15_000): void {
    this.stop();
    this.timer = setInterval(() => void this.check(), tickMs);
    this.timer.unref?.();
    // 启动时先查一轮：Shipherd 没开着的时候 PR 和 CI 可能都变了。
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

  /**
   * 立刻查这个 ticket 所有仓库的分支和它所有的 PR。retryGivenUp（默认 true）：放弃读了的 PR 也读一次（用户点了刷新、ticket 的 session 停下来）。
   * 总控停下来时把 epic 里每个 ticket 都查一遍，那时传 false：不然放弃了的 PR 总控每停一次就读一次，放弃等于没放弃。
   */
  soonTicket(ticketKey: string, o: { retryGivenUp?: boolean } = {}): void {
    this.dueTickets.set(ticketKey, (this.dueTickets.get(ticketKey) ?? false) || (o.retryGivenUp ?? true));
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
      checkedAt: r.checkedAt, readError: r.readError, ...(prGivenUp(r) && { gaveUp: true }),
      detail: {
        baseBranch: r.baseBranch, isDraft: r.isDraft, title: r.title, author: r.author, labels: r.labels, reviewRequests: r.reviewRequests, reviewers: r.reviewers,
        mergeable: r.mergeable, mergeState: r.mergeState, statusChangedAt: r.statusChangedAt, slug: r.slug,
      },
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
    this.dueTickets = new Map();
    const forced: Forced = (key, repoId) => keys.has(key) || (repoId !== null && repos.has(repoId));
    const retryGivenUp: Forced = (key, repoId) => keys.get(key) === true || (repoId !== null && repos.has(repoId));
    const marks: Marks = { prChanged: new Set(), changed: false };
    let tickets: Pick<Ticket, "key" | "repos">[] = [];
    await this.part("listing tickets", () => {
      tickets = this.d.tickets();
    });
    await this.part("pruning old branches", () => this.prune(tickets, marks));
    await this.part("reading PRs", () => this.pollPrs(tickets, forced, retryGivenUp, marks));
    await this.part("checking branches", () => this.checkBranches(tickets, forced, marks));
    await this.part("checking owned branches", () => this.checkOwnedBranches(tickets, forced, marks));
    await this.part("handling merged PRs", () => this.handleMerged());
    // 一个 ticket 的所有 PR 都写完了再告诉 onPrChanged，而且只告诉一次。
    for (const key of marks.prChanged) await this.part(`updating ${key} after its PR changed`, () => this.d.onPrChanged(key));
    if (marks.changed) await this.part("notify", () => this.d.notify());
    await this.part("roundDone", () => this.d.roundDone?.());
  }

  /** ticket 换了分支（C-S3）：删掉旧分支找到的、还开着的 PR 行；分支行换成新分支的、没查过的。 */
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

  private async pollPrs(tickets: Pick<Ticket, "key" | "repos">[], forced: Forced, retryGivenUp: Forced, marks: Marks): Promise<void> {
    const live = new Set(tickets.map((t) => t.key));
    const now = this.d.now();
    // 归档 ticket 里没读过的行（补链接来的）也读一次；读过以后 needingRead 不再给它。
    // 放弃了的（read_retry_at 还没到）和认定不存在的（read_gone_at，一周内）不读，除非这一轮强制、而且要重试放弃了的
    // （用户点了刷新、session 刚 push 或停下；总控停下的那种不算）：认定错了（比如换了账号、补了权限）用户刷新一下就能读回来。
    const goneUntil = now - PR_GONE_RETRY_MS;
    const rows = this.d.prs
      .needingRead(now, { includeGone: true })
      .filter(
        (r) =>
          (live.has(r.ticketKey) || r.checkedAt === 0) &&
          (retryGivenUp(r.ticketKey, r.repoId) || ((r.readRetryAt === null || r.readRetryAt <= now) && (r.readGoneAt === null || r.readGoneAt <= goneUntil))),
      );
    const urls = new Set(rows.map((r) => r.url));
    for (const u of this.unreadBackoff.keys()) if (!urls.has(u)) this.unreadBackoff.delete(u);
    const polls = prPolls(rows, {
      repoOf: (id) => this.d.repoOf(id), ghWorkDir: (r) => this.d.ghWorkDir(r), home: this.d.home, sessionOpen: (k, id) => this.d.sessionOpen(k, id),
    });
    // 总控停下来那种强制（retryGivenUp 为 false）也守着没读成功过的退避：坏链接不跟着总控每停一次读一次。
    const due = capRound(
      polls.filter((p) => {
        const backedOff = now < (this.unreadBackoff.get(p.url)?.at ?? 0);
        return p.rows.some((r) => retryGivenUp(r.ticketKey, r.repoId) || (!backedOff && (forced(r.ticketKey, r.repoId) || now >= nextPrCheckAt(r, p.sessionOpen))));
      }),
    );
    const unread: Unread[] = [];
    await Promise.all(due.map((p) => this.part(`reading ${p.url}`, () => this.poll(p, unread, marks))));
    // 这一轮读了两个以上、全都是 gh 失败：多半是 gh 离线 / 没登录 / 换了看不到这些仓库的账号 / 网络断了，不是这些 PR 的问题，不算进失败次数。
    // 仓库解析不到也算 gh 失败（私有仓库对当前账号就是这么回答的）。只有「仓库看得见、没有这个 PR」（GH_NOT_FOUND）
    // 不算：有一个这样的，gh 就是在线、看得见的；它们自己一定计数。
    const outage = due.length >= 2 && unread.length === due.length && unread.every((u) => !u.notFound);
    if (outage) this.d.log(`pr watch: all ${due.length} PR reads failed this round; not counting them (gh offline?)`);
    for (const u of unread) await this.part(`noting the failed read of ${u.poll.url}`, () => this.noteFailed(u, !outage, marks));
  }

  /**
   * C-V7：读失败不是 PR 变了。ci、state 留着上一次的，只记下读失败；从没读成功过的 checkedAt 留 0（还算第一次读），过一会儿再试。
   * 失败了 10 次（PR_READ_GIVE_UP）、持续一天：停一天（只有强制读会读它），开着的状态也不再挡着 ticket。
   */
  private noteFailed(u: Unread, count: boolean, marks: Marks): void {
    const p = u.poll;
    const now = this.d.now();
    let gone = false;
    let stopped = false;
    for (const r of p.rows) {
      const res = this.d.prs.noteReadFailure(r.id, now, { count, notFound: u.notFound });
      if (res.gone) gone = true;
      else if (res.gaveUp) stopped = true;
      if (!r.readError) marks.changed = true;
    }
    if (gone || stopped) {
      if (gone) this.d.log(`pr watch: GitHub keeps saying ${p.url} does not exist; trying it again in a week`);
      if (stopped) this.d.log(`pr watch: giving up on ${p.url} after a day of failed reads; trying again once a day`);
      marks.changed = true;
      for (const r of p.rows) marks.prChanged.add(r.ticketKey);
    }
  }

  /** 读一个 PR，写进链接它的每个 ticket 的行。读失败的放进 unread，整轮读完再记（要先知道是不是整轮都失败了）。 */
  private async poll(p: PrPoll, unread: Unread[], marks: Marks): Promise<void> {
    const got = await this.gh(() => this.d.gh.prStatus(p.cwd, p.url, PR_GH_TIMEOUT_MS));
    const now = this.d.now();
    if (got === null || got === GH_NOT_FOUND) {
      const notFound = got === GH_NOT_FOUND;
      this.d.log(`pr watch: reading ${p.url} failed${notFound ? " (not found)" : ""}`);
      unread.push({ poll: p, notFound });
      if (p.rows.some((r) => r.checkedAt === 0)) {
        const prev = this.unreadBackoff.get(p.url);
        const delay = prev ? Math.min(prev.delay * 2, PR_SLOW_MS) : UNREAD_RETRY_MS;
        this.unreadBackoff.set(p.url, { at: now + delay, delay });
      }
      return;
    }
    const pr = got;
    this.unreadBackoff.delete(p.url);
    const moved = prUrlParts(pr.url)?.slug;
    if (moved && moved !== p.slug) {
      try {
        this.d.onSlugMoved?.(p.slug, moved);
      } catch (e) {
        this.d.log(`pr watch: reporting that ${p.slug} moved to ${moved} failed`, e);
      }
    }
    // 合并了、关闭了的不再取失败日志：没人会再看，省下 gh 调用。失败的检查照记（不带日志）。
    // 行内评论和 review 作者只在开着变成合并 / 关闭的那一次还取（合并前刚交的 review 要记对）；之后的读（例如补链接来的）不取。
    const open = pr.state === "OPEN";
    const wasOpen = open || p.rows.some((r) => r.state === "open" && r.checkedAt > 0);
    const failed = pr.ci !== "failing" ? [] : open ? await this.failedWithLogs(p.cwd, pr.checks, p.slug) : pr.checks.filter((c) => c.state === "failing").map((c) => ({ ...c }));
    const inline = wasOpen ? await this.inlineComments(p, pr) : [];
    const bots = wasOpen ? await this.botsOf(p, pr) : null;
    for (const r of p.rows) this.apply(r, pr, failed, inline, bots, now, marks);
    if (this.d.onPrRead) {
      const rows = p.rows.map((r) => this.d.prs.get(r.id)).filter((r): r is TicketPr => r !== null);
      void this.d.onPrRead(rows, pr, { cwd: p.cwd, slug: p.slug }).catch((e: unknown) => this.d.log(`pr watch: after reading ${p.url}`, e));
    }
  }

  private scopeOf(r: TicketPr, branch: string | null): ObsScope {
    return { ticketKey: r.ticketKey, prId: r.id, repoId: r.repoId, scope: scopeOf(r.ticketKey, r.repoId, r.slug), branch };
  }

  /** 这一轮读到的写进一行：先记事件，再更新行。 */
  private apply(r: TicketPr, pr: PrStatus, failed: CiCheck[], inline: PrComment[], bots: ReviewAuthors | null, now: number, marks: Marks): void {
    const state = PR_STATES[pr.state];
    // GitHub 的时间，没有就用行里存的（例如合并占位释放的时间），再没有用 now；都不晚于 now。只有合并了、关闭了才有。
    const mergedAt = state === "merged" ? Math.min(pr.mergedAt ?? r.mergedAt ?? now, now) : r.mergedAt;
    const closedAt = state === "closed" ? Math.min(pr.closedAt ?? r.closedAt ?? now, now) : r.closedAt;
    const headBranch = pr.headBranch || r.headBranch;
    const next: PrSnapshot = { number: r.number, state, review: pr.review, ci: pr.ci, headSha: pr.headSha, failed, checkedAt: now };
    const first = r.checkedAt === 0;
    let added = false;
    try {
      const obs = prObservations(
        this.scopeOf(r, headBranch), r, next, { ...pr, mergedAt, closedAt }, inline, now, bots, this.d.stages.lastCi(r.id), this.firstCommitFallback(r, state, headBranch),
      );
      let human = 0;
      for (const o of obs) {
        if (!this.d.stages.add(o.event, o.dedupeKey)) continue;
        added = true;
        if ((o.event.kind === "comment" || o.event.kind === "review") && o.event.data.who === "human") human++;
      }
      if (human > 0 && !first) {
        try {
          this.d.onHumanComment?.(r.ticketKey, r.number, human);
        } catch (e) {
          this.d.log(`pr watch: notifying about comments on ${r.url}`, e);
        }
      }
    } catch (e) {
      this.d.log(`pr watch: recording the stages of ${r.url} for ${r.ticketKey} failed`, e);
    }
    const detail = prDetailOf(pr);
    // 状态最后一次变化（ws-b）：汇总新鲜度和"卡了多久"看它；第一次读到也算。标题、label 不算状态。
    const statusChanged = prStatusChanged(r, { state, review: pr.review, ci: pr.ci, headSha: pr.headSha, ...detail }, first);
    this.d.prs.update(r.id, {
      state, review: pr.review, ci: pr.ci, headSha: pr.headSha, headBranch, failed, readError: false, readFailures: 0, readFailingSince: null, readRetryAt: null,
      readNotFound: 0, readNotFoundSince: null, readGoneAt: null, checkedAt: now,
      openedAt: pr.createdAt ?? r.openedAt, mergedAt, closedAt,
      ...detail, baseBranch: detail.baseBranch ?? r.baseBranch, title: detail.title ?? r.title, author: detail.author ?? r.author,
      ...(statusChanged && { statusChangedAt: now }),
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

  /**
   * 开着的 PR 在 ticket 仓库现在的分支上时，分支检查停着（由 PR 的读取接手）：用 PR 的 commit 补记第一个 commit。
   * 已经记过（分支检查记的，或者上一次读记的）就不给。
   */
  private firstCommitFallback(r: TicketPr, state: TicketPr["state"], branch: string | null): { afterPrId: number | null } | null {
    if (state !== "open" || r.repoId === null || branch === null || this.d.repoOf(r.repoId)?.branch !== branch) return null;
    const afterPrId = this.lastEnded(r.ticketKey, r.repoId, branch)?.pr.id ?? null;
    return this.d.stages.has(stageKey.firstCommit({ scope: String(r.repoId), branch }, afterPrId)) ? null : { afterPrId };
  }

  /** 这个 ticket 这个仓库这个分支上最后结束（合并或关闭）的 PR 和结束的时间。 */
  private lastEnded(ticketKey: string, repoId: number, branch: string): { pr: TicketPr; end: number } | null {
    let last: { pr: TicketPr; end: number } | null = null;
    for (const r of this.d.prs.byTicket(ticketKey)) {
      const end = r.mergedAt ?? r.closedAt;
      if (r.repoId !== repoId || r.headBranch !== branch || end === null || (last && end <= last.end)) continue;
      last = { pr: r, end };
    }
    return last;
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
    const now = this.d.now();
    // 放弃读了的开着的 PR 也算：PR 还在，只是读不到，分支检查照样停着（不然它每轮都去列这个分支）。
    const open = this.d.prs.needingRead().filter((r) => r.state === "open");
    const due = capRound(
      targets.filter((t) => {
        const hasOpenPr = open.some((r) => r.repoId === t.repoId && r.headBranch === t.branch);
        return forced(t.ticketKey, t.repoId) || now >= nextBranchCheckAt(this.branchRowOf(t), t.sessionOpen, hasOpenPr);
      }),
    );
    await Promise.all(due.map((t) => this.part(`checking ${t.branch} in ${t.repoPath}`, () => this.checkBranch(t, marks))));
  }

  /**
   * session 推过、在上面开过 PR 的别的分支（worktree 里的子 session 最常见）：列出上面的 PR 并链接上，下一轮读它们的 CI。
   * ticket 分支本身由 checkBranches 管；OWNED_FRESH_MS 之前记下的不列；同一个分支最多 OWNED_LIST_MS 列一次（强制的除外）。
   * 已经链接上的 PR 还开着、或者在最近一次推送之后才合并 / 关闭的：这次推送的 PR 已经有了，不再列（再推一次又会列）。
   * 列出来的只链接开着的、和最近一次推送前一天以后开的：重名的老分支（`fix/ci`）上早就合并的 PR 不链接进来。
   */
  private async checkOwnedBranches(tickets: Pick<Ticket, "key" | "repos">[], forced: Forced, marks: Marks): Promise<void> {
    if (!this.d.owners) return;
    const now = this.d.now();
    const due: { ticketKey: string; repo: TicketRepo; branch: string; id: string; at: number }[] = [];
    const seen = new Set<string>();
    const linked = new Map<string, TicketPr[]>();
    for (const o of this.d.owners.since(now - OWNED_FRESH_MS)) {
      const repo = tickets.find((t) => t.key === o.ticketKey)?.repos.find((r) => r.id === o.repoId);
      if (!repo || o.branch === repo.branch) continue;
      const id = `${o.ticketKey}:${o.repoId}:${o.branch}`;
      seen.add(id);
      if (!linked.has(o.ticketKey)) linked.set(o.ticketKey, this.d.prs.byTicket(o.ticketKey));
      const done = (r: TicketPr): boolean => r.state === "open" || (r.mergedAt ?? r.closedAt ?? r.linkedAt) >= o.at;
      if (linked.get(o.ticketKey)!.some((r) => r.repoId === o.repoId && r.headBranch === o.branch && done(r))) continue;
      if (!forced(o.ticketKey, o.repoId) && now < (this.ownedListedAt.get(id) ?? 0) + OWNED_LIST_MS) continue;
      due.push({ ticketKey: o.ticketKey, repo, branch: o.branch, id, at: o.at });
    }
    for (const id of this.ownedListedAt.keys()) if (!seen.has(id)) this.ownedListedAt.delete(id);
    await Promise.all(
      due.slice(0, PR_WATCH_MAX).map((t) =>
        this.part(`listing the PRs of ${t.branch} in ${t.repo.repoPath}`, async () => {
          const list = await this.gh(() => this.d.gh.prsForBranch(this.d.ghWorkDir(t.repo), t.branch, PR_GH_TIMEOUT_MS));
          this.ownedListedAt.set(t.id, this.d.now());
          if (list === null) return this.d.log(`pr watch: listing the PRs of ${t.branch} in ${t.repo.repoPath} failed`);
          const fresh = list.filter((p) => p.state === "OPEN" || (p.createdAt !== null && p.createdAt >= t.at - OWNED_PR_SLACK_MS));
          if (this.d.linker.linkBranchPrs(t.ticketKey, { id: t.repo.id, repoPath: t.repo.repoPath, branch: t.branch }, fresh, "branch") > 0) marks.changed = true;
        }),
      ),
    );
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
    // 新链接的行 checked_at 为 0，下一轮的 PR 读取马上读它（R12）。
    if (this.d.linker.linkBranchPrs(t.ticketKey, { id: t.repoId, repoPath: t.repoPath, branch: t.branch }, list, "branch") > 0) marks.changed = true;
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
    const last = this.lastEnded(t.ticketKey, t.repoId, t.branch);
    const afterId = last?.pr.id ?? null;
    if (this.d.stages.has(stageKey.firstCommit({ scope: String(t.repoId), branch: t.branch }, afterId))) return false;
    const at = await this.d.git.firstCommitAt(t.cwd, t.branch, last?.end ?? null);
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

/** 一次读到的 PR 里 ws-b 要存的字段（reviewer 按 GitHub 的规则取每个人最新的态度）。 */
export function prDetailOf(pr: PrStatus): Pick<TicketPr, "baseBranch" | "isDraft" | "title" | "author" | "labels" | "reviewRequests" | "reviewers" | "mergeable" | "mergeState"> {
  return {
    baseBranch: pr.baseBranch, isDraft: pr.isDraft, title: pr.title, author: pr.author || null, labels: pr.labels, reviewRequests: pr.reviewRequests,
    reviewers: latestReviewers(pr.reviews, pr.author), mergeable: pr.mergeable, mergeState: pr.mergeState,
  };
}

type StatusFields = Pick<TicketPr, "state" | "review" | "ci" | "headSha" | "isDraft" | "mergeable" | "mergeState" | "reviewers" | "reviewRequests">;

/** 合并状态的"不知道"：GitHub 重新算的时候先给 UNKNOWN，升级前的行是 null。来回变不算状态变化。 */
const knownMerge = (v: string | null): string | null => (v === null || v === "unknown" ? null : v);
/** reviewer 只看人和态度，不看时间（同一个人又留了一条评论不算），也不看 bot。 */
const reviewerKey = (r: TicketPr["reviewers"]): string => r.filter((x) => !x.bot).map((x) => `${x.login}:${x.state}`).sort().join(",");
const requestKey = (r: TicketPr["reviewRequests"]): string => r.map((x) => `${x.kind}:${x.name}`).sort().join(",");

/**
 * 这一轮读到的 PR 状态和上一次比算不算"变了"（ws-b：汇总新鲜度、卡了多久）。第一次读到算。
 * 升级前就有的行（读过、但 statusChangedAt 还是 null）这一次只比老字段：新字段是第一次有值，不是变了。
 */
export function prStatusChanged(prev: StatusFields & Pick<TicketPr, "statusChangedAt">, next: StatusFields, first: boolean): boolean {
  if (first) return true;
  if (prev.state !== next.state || prev.review !== next.review || prev.ci !== next.ci || prev.headSha !== next.headSha) return true;
  if (prev.statusChangedAt === null) return false;
  const merge = (a: string | null, b: string | null) => knownMerge(a) !== null && knownMerge(b) !== null && knownMerge(a) !== knownMerge(b);
  return prev.isDraft !== next.isDraft || merge(prev.mergeable, next.mergeable) || merge(prev.mergeState, next.mergeState)
    || reviewerKey(prev.reviewers) !== reviewerKey(next.reviewers) || requestKey(prev.reviewRequests) !== requestKey(next.reviewRequests);
}
