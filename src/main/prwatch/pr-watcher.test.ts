import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchWatchRepo } from "../db/branch-watch-repo";
import { PrStageRepo, type StageEvent } from "../db/pr-stage-repo";
import { PR_NOT_FOUND_GIVE_UP, PR_NOT_FOUND_MIN_MS, PR_READ_GIVE_UP, PR_READ_RETRY_MS, TicketPrsRepo, type NewPrLink } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { memDb } from "../test-utils";
import { GH_NOT_FOUND, type BranchPr, type BranchRuns, type CiCheck, type PrBatchItem, type PrComment, type PrStatus } from "../tickets/gh";
import type * as Gh from "../tickets/gh";
import type * as Git from "../tickets/git";
import { BranchOwnersRepo } from "../db/branch-owners-repo";
import { fakeMailbox } from "../mailbox/fake-mailbox";
import { CiDelivery, pickRecipient } from "./ci-delivery";
import { PrLinker } from "./pr-links";
import { derivePrStages } from "./pr-stages";
import { PR_FAST_MS, PR_SLOW_MS, PR_WATCH_MAX } from "./pr-schedule";
import {
  CI_LOG_LINES, CI_LOG_RETRY_MAX_MS, CI_LOG_RETRY_MS, CI_LOG_TRIES_MAX, MERGED_RECENT_MS, PR_BATCH_FULL_MAX, PR_BATCH_TIMEOUT_MS, PR_FULL_REFRESH_LOW_MS, PR_FULL_REFRESH_MS,
  PR_GH_TIMEOUT_MS, PR_RATE_LOW,
  prStatusChanged, PrWatcher, type PrWatcherDeps,
} from "./pr-watcher";

const url = (n: number, repo = "app") => `https://github.com/o/${repo}/pull/${n}`;
const check = (name: string, state: CiCheck["state"], runId: number | null = null): CiCheck => ({ name, state, runId });
const pr = (o: Partial<PrStatus> = {}): PrStatus => ({
  number: 7, url: url(7), state: "OPEN", isDraft: false, review: "pending", headSha: "a1", headBranch: "b", checks: [check("test", "pending", 9)], ci: "pending",
  author: "me", reviews: [], comments: [], firstCommitAt: null, createdAt: null, mergedAt: null, closedAt: null, baseBranch: null, title: null, labels: [], reviewRequests: [], mergeable: null, mergeState: null, ...o,
});
const logOk = (log: string): Gh.FailedLogResult => ({ log, error: null, permanent: false, missing: false });
const logFailed = (error: string, permanent = false, missing = false): Gh.FailedLogResult => ({ log: null, error, permanent, missing });
const listed = (n: number, o: Partial<BranchPr> = {}): BranchPr => ({ number: n, url: url(n), state: "OPEN", headRefName: "b", createdAt: 10, mergedAt: null, closedAt: null, ...o });

type Opts = { sessionOpen?: PrWatcherDeps["sessionOpen"] };

function setup(o: Opts = {}) {
  let t = 1_000_000_000;
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const addTicket = (key: string) => tickets.insert({ key, title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const addRepo = (ticketKey: string, name: string, branch = "b") =>
    tickets.addRepo({ ticketKey, repoPath: `/r/${name}`, workMode: "branch", worktreePath: null, branch, createdAt: 1 });
  addTicket("BTL-1");
  const repoId = addRepo("BTL-1", "app");
  const prs = new TicketPrsRepo(db);
  const branches = new BranchWatchRepo(db);
  const stages = new PrStageRepo(db);
  const owners = new BranchOwnersRepo(db);
  const gh = {
    prStatus: vi.fn<typeof Gh.prRead>(async () => null),
    prsForBranch: vi.fn<typeof Gh.prsForBranch>(async () => []),
    branchRuns: vi.fn<typeof Gh.branchRuns>(async () => null),
    failedLogDetail: vi.fn<typeof Gh.failedLogDetail>(async (_cwd, runId) => ({ log: `log of ${runId}`, error: null, permanent: false, missing: false })),
    reviewComments: vi.fn<typeof Gh.reviewComments>(async () => []),
    reviewAuthors: vi.fn<typeof Gh.reviewAuthors>(async () => ({ botReviewIds: new Set(), botLogins: new Set() })),
  };
  const git = { firstCommitAt: vi.fn<typeof Git.firstCommitAt>(async () => null) };
  const slugOf = (p: string) => `o/${p.split("/").pop()}`;
  const linker = new PrLinker({ prs, tickets, slugOf, now: () => t });
  const deps = {
    prs, branches, tickets: () => tickets.list(), repoOf: (id: number) => tickets.getRepo(id),
    ghWorkDir: (r: { repoPath: string }) => `/w${r.repoPath}`,
    sessionOpen: vi.fn<PrWatcherDeps["sessionOpen"]>(o.sessionOpen ?? (() => true)),
    home: "/home", slugOf, linker, gh, git, stages, owners,
    onMerged: vi.fn<PrWatcherDeps["onMerged"]>(), onPrChanged: vi.fn<(key: string) => void>(), onCiSettled: vi.fn<PrWatcherDeps["onCiSettled"]>(),
    notify: vi.fn<() => void>(), roundDone: vi.fn<() => void>(), now: () => t, log: vi.fn<(msg: string, err?: unknown) => void>(),
  } satisfies PrWatcherDeps;
  const w = new PrWatcher(deps);
  /** 一个链接上、还没读过的 PR 行。 */
  const link = (o: Partial<NewPrLink> = {}) =>
    prs.link({ ticketKey: "BTL-1", url: url(7), slug: "o/app", repoId, number: 7, headBranch: "b", state: "open", source: "branch", linkedAt: t, ...o }).pr;
  const events = (kind?: StageEvent["kind"]) => stages.forTicket("BTL-1").filter((e) => !kind || e.kind === kind);
  return { db, tickets, addTicket, addRepo, repoId, prs, branches, stages, owners, gh, git, deps, w, link, events, advance: (ms: number) => (t += ms), now: () => t };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PrWatcher: reading PRs", () => {
  it("reports new comments and reviews from colleagues, but not history on the first read, bots or the author (ws-j)", async () => {
    const s = setup();
    const onHumanComment = vi.fn();
    const w = new PrWatcher({ ...s.deps, onHumanComment });
    s.link();
    const c = (id: string, author: string) => ({ id, author, body: "x", createdAt: 6, url: null, path: null, line: null, reviewId: null });
    s.gh.prStatus.mockResolvedValue(pr({ comments: [c("C1", "alice")] }));
    await w.check();
    expect(onHumanComment).not.toHaveBeenCalled();
    s.advance(PR_SLOW_MS);
    s.gh.prStatus.mockResolvedValue(pr({
      comments: [c("C1", "alice"), c("C2", "bob"), c("C3", "me"), c("C4", "ci-bot[bot]")],
      reviews: [{ id: "R1", author: "carol", state: "COMMENTED" as const, body: "", submittedAt: 9 }],
    }));
    await w.check();
    expect(onHumanComment).toHaveBeenCalledTimes(1);
    expect(onHumanComment).toHaveBeenCalledWith("BTL-1", 7, 2);
    s.advance(PR_SLOW_MS);
    await w.check();
    expect(onHumanComment).toHaveBeenCalledTimes(1);
  });

  it("reads a linked PR by its URL and stores it with lower-case state", async () => {
    const s = setup();
    const row = s.link();
    s.gh.prStatus.mockResolvedValue(pr({ createdAt: 5 }));
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledWith("/w/r/app", url(7), PR_GH_TIMEOUT_MS);
    expect(s.prs.get(row.id)).toMatchObject({ state: "open", review: "pending", ci: "pending", headSha: "a1", readError: false, checkedAt: s.now(), openedAt: 5, failed: [] });
    expect(s.events().map((e) => [e.kind, e.prId])).toEqual([["pr_opened", row.id], ["ci", row.id]]);
    expect(s.deps.onPrChanged).toHaveBeenCalledWith("BTL-1");
  });

  it("stores base, draft, title, labels, reviewers and merge state; statusChangedAt moves only when the status does", async () => {
    const s = setup();
    const row = s.link();
    const reviews = [{ id: "R1", author: "alice", state: "CHANGES_REQUESTED" as const, body: "", submittedAt: 5 }];
    s.gh.prStatus.mockResolvedValue(pr({
      baseBranch: "main", title: "[ui] page", labels: ["frontend"], reviewRequests: [{ kind: "user", name: "bob" }], mergeable: "mergeable", mergeState: "blocked", isDraft: true, reviews,
    }));
    await s.w.check();
    const first = s.now();
    expect(s.prs.get(row.id)).toMatchObject({
      baseBranch: "main", isDraft: true, title: "[ui] page", author: "me", labels: ["frontend"], reviewRequests: [{ kind: "user", name: "bob" }],
      reviewers: [{ login: "alice", state: "changes_requested", at: 5, bot: false }], mergeable: "mergeable", mergeState: "blocked", statusChangedAt: first,
    });
    expect(s.w.statusOf("BTL-1")[0].detail).toMatchObject({ baseBranch: "main", isDraft: true, slug: "o/app", statusChangedAt: first });
    // 只改了标题和 label：不算状态变化。
    s.advance(PR_SLOW_MS);
    s.gh.prStatus.mockResolvedValue(pr({
      baseBranch: "main", title: "[ui] page v2", labels: ["frontend", "x"], reviewRequests: [{ kind: "user", name: "bob" }], mergeable: "mergeable", mergeState: "blocked", isDraft: true, reviews,
    }));
    await s.w.check();
    expect(s.prs.get(row.id)).toMatchObject({ title: "[ui] page v2", labels: ["frontend", "x"], statusChangedAt: first });
    // 不再是 draft：算。
    s.advance(PR_SLOW_MS);
    s.gh.prStatus.mockResolvedValue(pr({ baseBranch: "main", title: "[ui] page v2", reviewRequests: [{ kind: "user", name: "bob" }], mergeable: "mergeable", mergeState: "blocked", reviews }));
    await s.w.check();
    expect(s.prs.get(row.id)?.statusChangedAt).toBe(s.now());
    // 新来一个 review：算；读不到 base / 标题时留着上一次的。
    s.advance(PR_SLOW_MS);
    s.gh.prStatus.mockResolvedValue(pr({ reviewRequests: [{ kind: "user", name: "bob" }], mergeable: "mergeable", mergeState: "blocked", reviews: [...reviews, { id: "R2", author: "bob", state: "APPROVED", body: "", submittedAt: 9 }] }));
    await s.w.check();
    expect(s.prs.get(row.id)).toMatchObject({ statusChangedAt: s.now(), baseBranch: "main", title: "[ui] page v2" });
  });

  it("keeps the previous ci and flags read_error when prStatus fails; cachedByUrl then returns null", async () => {
    const s = setup();
    const row = s.link();
    s.gh.prStatus.mockResolvedValue(pr({ ci: "passing", checks: [check("test", "passing")] }));
    await s.w.check();
    expect(s.w.cachedByUrl(url(7))).toEqual({ state: "open" });
    const ciEvents = s.events("ci").length;
    s.advance(PR_SLOW_MS);
    s.gh.prStatus.mockResolvedValue(null);
    await s.w.check();
    expect(s.prs.get(row.id)).toMatchObject({ ci: "passing", state: "open", readError: true, checkedAt: s.now() });
    expect(s.deps.log).toHaveBeenCalledWith(`pr watch: reading ${url(7)} failed`);
    expect(s.w.cachedByUrl(url(7))).toBeNull();
    expect(s.w.statusOf("BTL-1")[0]).toMatchObject({ readError: true, ci: "passing" });
    expect(s.events("ci")).toHaveLength(ciEvents);
    // 再读成功：同一个结论不再记一次 CI，也不再交一次。
    s.advance(PR_SLOW_MS);
    s.gh.prStatus.mockResolvedValue(pr({ ci: "passing", checks: [check("test", "passing")] }));
    await s.w.check();
    expect(s.prs.get(row.id)?.readError).toBe(false);
    expect(s.events("ci")).toHaveLength(ciEvents);
    expect(s.deps.onCiSettled).toHaveBeenCalledTimes(1);
  });

  it("a never-read row that fails to read stays unread and is retried a minute later, not every tick", async () => {
    const s = setup();
    const row = s.link({ state: "merged" });
    await s.w.check();
    expect(s.prs.get(row.id)).toMatchObject({ readError: true, checkedAt: 0 });
    s.advance(15_000);
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(1);
    s.advance(60_000);
    s.gh.prStatus.mockResolvedValue(pr({ state: "MERGED", mergedAt: s.now() - 5 }));
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(2);
    // 第一次读成功：已合并的也记 merged 事件。
    expect(s.events("merged")).toHaveLength(1);
  });

  it("backs off a never-read PR that keeps failing: 60s, doubling, capped at PR_SLOW_MS; a success resets it", async () => {
    const s = setup();
    s.link();
    const calls = () => s.gh.prStatus.mock.calls.length;
    await s.w.check();
    expect(calls()).toBe(1);
    // 每次失败之后等的时间：60、120、240，然后封顶 300。
    for (const [wait, total] of [[60_000, 2], [120_000, 3], [240_000, 4], [PR_SLOW_MS, 5], [PR_SLOW_MS, 6]] as const) {
      s.advance(wait - 1);
      await s.w.check();
      expect(calls()).toBe(total - 1);
      s.advance(1);
      await s.w.check();
      expect(calls()).toBe(total);
    }
    // 读成功一次：退避清零。另一个 ticket 新链接的同一个 PR 马上读，再失败从 60 秒开始。
    s.advance(PR_SLOW_MS);
    s.gh.prStatus.mockResolvedValueOnce(pr());
    await s.w.check();
    expect(calls()).toBe(7);
    s.addTicket("BTL-2");
    s.prs.link({ ticketKey: "BTL-2", url: url(7), slug: "o/app", repoId: null, number: 7, headBranch: "b", state: "open", source: "handoff", linkedAt: s.now() });
    await s.w.check();
    expect(calls()).toBe(8);
    s.advance(60_000);
    await s.w.check();
    expect(calls()).toBe(9);
  });

  it("does not give up on a PR after 10 quick failures inside an hour (a short gh outage)", async () => {
    const s = setup();
    const row = s.link();
    s.gh.prStatus.mockResolvedValue(pr());
    await s.w.check();
    s.gh.prStatus.mockResolvedValue(null);
    for (let i = 0; i < PR_READ_GIVE_UP + 2; i++) {
      s.advance(PR_SLOW_MS);
      await s.w.check();
    }
    expect(s.gh.prStatus).toHaveBeenCalledTimes(PR_READ_GIVE_UP + 3);
    expect(s.prs.get(row.id)).toMatchObject({ readFailures: PR_READ_GIVE_UP + 2, readRetryAt: null, readError: true });
    expect(s.deps.log).not.toHaveBeenCalledWith(expect.stringContaining("giving up"));
  });

  it("gives up on a PR whose reads keep failing for 24 h: no reads for a day, then one a day; a success resets it", async () => {
    const s = setup();
    const row = s.link();
    s.gh.prStatus.mockResolvedValue(pr());
    await s.w.check();
    s.gh.prStatus.mockResolvedValue(null);
    for (let i = 0; i < PR_READ_GIVE_UP; i++) {
      s.advance(PR_SLOW_MS);
      await s.w.check();
    }
    const firstFail = s.now() - (PR_READ_GIVE_UP - 1) * PR_SLOW_MS;
    expect(s.prs.get(row.id)).toMatchObject({ readRetryAt: null, readFailingSince: firstFail });
    s.advance(PR_READ_RETRY_MS);
    await s.w.check();
    expect(s.prs.get(row.id)).toMatchObject({ readFailures: PR_READ_GIVE_UP + 1, readRetryAt: s.now() + PR_READ_RETRY_MS });
    expect(s.deps.log).toHaveBeenCalledWith(expect.stringContaining(`giving up on ${url(7)}`));
    expect(s.deps.onPrChanged).toHaveBeenLastCalledWith("BTL-1");
    // 放弃了：一天之内不再读。
    const before = s.gh.prStatus.mock.calls.length;
    for (let i = 0; i < 5; i++) {
      s.advance(PR_SLOW_MS);
      await s.w.check();
    }
    expect(s.gh.prStatus.mock.calls.length).toBe(before);
    // 一天后再试一次；读成功：都清掉。
    s.advance(PR_READ_RETRY_MS);
    s.gh.prStatus.mockResolvedValue(pr());
    await s.w.check();
    expect(s.gh.prStatus.mock.calls.length).toBe(before + 1);
    expect(s.prs.get(row.id)).toMatchObject({ readFailures: 0, readRetryAt: null, readFailingSince: null, readError: false });
  });

  it("a round where every one of 2+ PR reads fails is an outage: read_error is flagged but nothing is counted", async () => {
    const s = setup();
    const a = s.link();
    const b = s.link({ url: url(8), number: 8 });
    s.gh.prStatus.mockImplementation(async (_cwd, u) => pr({ number: u === url(7) ? 7 : 8, url: u }));
    await s.w.check();
    s.gh.prStatus.mockResolvedValue(null);
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(4);
    for (const r of [a, b]) expect(s.prs.get(r.id)).toMatchObject({ readError: true, readFailures: 0, readFailingSince: null, checkedAt: s.now() });
    // 只有一个失败：照常数。
    s.gh.prStatus.mockImplementation(async (_cwd, u) => (u === url(7) ? pr() : null));
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.prs.get(a.id)).toMatchObject({ readError: false, readFailures: 0 });
    expect(s.prs.get(b.id)).toMatchObject({ readError: true, readFailures: 1, readFailingSince: s.now() });
  });

  it("a forced refresh reads a given-up PR", async () => {
    vi.useFakeTimers();
    const s = setup();
    const row = s.link();
    s.gh.prStatus.mockResolvedValue(pr());
    await s.w.check();
    s.prs.update(row.id, { readFailures: PR_READ_GIVE_UP + 1, readFailingSince: 1, readRetryAt: s.now() + PR_READ_RETRY_MS, readError: true });
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(1);
    s.w.soonTicket("BTL-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.gh.prStatus).toHaveBeenCalledTimes(2);
    expect(s.prs.get(row.id)).toMatchObject({ readFailures: 0, readRetryAt: null, readError: false });
  });

  it("a PR GitHub says does not exist is counted even when every read fails, and is never read again after a few tries (BTL-261)", async () => {
    vi.useFakeTimers();
    const s = setup();
    // 两个从没读成功过的坏链接（像 handoff 里写错的仓库）：整轮都失败，但 GitHub 回答了「不存在」，不是离线。
    const a = s.link({ url: url(25, "gone"), slug: "o/gone", number: 25, repoId: null, source: "handoff" });
    const b = s.link({ url: url(26, "gone"), slug: "o/gone", number: 26, repoId: null, source: "handoff" });
    s.gh.prStatus.mockResolvedValue("not_found");
    await s.w.check();
    for (const r of [a, b]) expect(s.prs.get(r.id)).toMatchObject({ readFailures: 1, readNotFound: 1, readFailingSince: s.now(), readGoneAt: null });
    expect(s.deps.log).not.toHaveBeenCalledWith(expect.stringContaining("gh offline"));
    // 再失败两次、过了 PR_NOT_FOUND_MIN_MS：认定不存在。
    for (let i = 1; i < PR_NOT_FOUND_GIVE_UP; i++) {
      s.advance(PR_NOT_FOUND_MIN_MS);
      await s.w.check();
    }
    for (const r of [a, b]) expect(s.prs.get(r.id)).toMatchObject({ readNotFound: PR_NOT_FOUND_GIVE_UP, readGoneAt: s.now() });
    expect(s.deps.log).toHaveBeenCalledWith(expect.stringContaining(`${url(25, "gone")} does not exist`));
    expect(s.w.statusOf("BTL-1").find((p) => p.url === url(25, "gone"))).toMatchObject({ gaveUp: true });
    // 之后定时的不读它，总控停下来扫 epic 也不读。
    const calls = s.gh.prStatus.mock.calls.length;
    s.advance(PR_READ_RETRY_MS * 2);
    await s.w.check();
    s.w.soonTicket("BTL-1", { retryGivenUp: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.gh.prStatus.mock.calls.length).toBe(calls);
    // 用户点了刷新：照读。读到了（比如认定错了），全部清掉，又照常跟踪。
    s.gh.prStatus.mockImplementation(async (_cwd, u) => pr({ number: u === url(25, "gone") ? 25 : 26, url: u }));
    s.w.soonTicket("BTL-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.gh.prStatus.mock.calls.length).toBe(calls + 2);
    for (const r of [a, b]) expect(s.prs.get(r.id)).toMatchObject({ readGoneAt: null, readNotFound: 0, readFailures: 0, readError: false });
    expect(s.w.statusOf("BTL-1").find((p) => p.url === url(25, "gone"))?.gaveUp).toBeUndefined();
  });

  it("a round where every read fails because the repo cannot be resolved (gh switched to an account that cannot see it) is an outage: nothing counted, nothing gone", async () => {
    const s = setup();
    const a = s.link();
    const b = s.link({ url: url(8), number: 8 });
    s.gh.prStatus.mockImplementation(async (_cwd, u) => pr({ number: u === url(7) ? 7 : 8, url: u }));
    await s.w.check();
    // prRead 把「Could not resolve to a Repository」当 gh 失败（null）。
    s.gh.prStatus.mockResolvedValue(null);
    for (let i = 0; i < PR_READ_GIVE_UP + 2; i++) {
      s.advance(PR_SLOW_MS);
      await s.w.check();
    }
    for (const r of [a, b]) expect(s.prs.get(r.id)).toMatchObject({ readFailures: 0, readNotFound: 0, readGoneAt: null, readRetryAt: null, state: "open" });
    expect(s.deps.log).toHaveBeenCalledWith(expect.stringContaining("gh offline"));
  });

  it("one not-found among failed reads still makes it no outage; a gh failure does not reset the not-found count", async () => {
    const s = setup();
    const a = s.link();
    const b = s.link({ url: url(8), number: 8 });
    s.gh.prStatus.mockImplementation(async (_cwd, u) => pr({ number: u === url(7) ? 7 : 8, url: u }));
    await s.w.check();
    s.gh.prStatus.mockImplementation(async (_cwd, u) => (u === url(7) ? "not_found" : null));
    s.advance(PR_SLOW_MS);
    await s.w.check();
    // 有一个 GitHub 回答了：gh 在线，另一个也照常计数。
    expect(s.prs.get(a.id)).toMatchObject({ readFailures: 1, readNotFound: 1 });
    expect(s.prs.get(b.id)).toMatchObject({ readFailures: 1, readNotFound: 0 });
    s.gh.prStatus.mockResolvedValue(null);
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.prs.get(a.id)).toMatchObject({ readNotFound: 1 });
    // 读成功清零。
    s.gh.prStatus.mockImplementation(async (_cwd, u) => pr({ number: u === url(7) ? 7 : 8, url: u }));
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.prs.get(a.id)).toMatchObject({ readFailures: 0, readNotFound: 0, readGoneAt: null, readFailingSince: null });
  });

  it("a coordinator sweep (retryGivenUp: false) neither reads a given-up PR nor skips the backoff of a never-read one (BTL-261)", async () => {
    vi.useFakeTimers();
    const s = setup();
    const row = s.link();
    s.gh.prStatus.mockResolvedValue(pr());
    await s.w.check();
    s.prs.update(row.id, { readFailures: PR_READ_GIVE_UP + 1, readFailingSince: 1, readRetryAt: s.now() + PR_READ_RETRY_MS, readError: true });
    // 一条从没读成功过、正在退避的行。
    const fresh = s.link({ url: url(9), number: 9 });
    s.gh.prStatus.mockImplementation(async (_cwd, u) => (u === url(9) ? null : pr()));
    await s.w.check();
    const calls = s.gh.prStatus.mock.calls.length;
    for (let i = 0; i < 5; i++) {
      s.advance(1000);
      s.w.soonTicket("BTL-1", { retryGivenUp: false });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(s.gh.prStatus.mock.calls.length).toBe(calls);
    expect(s.prs.get(fresh.id)?.checkedAt).toBe(0);
    // 用户点了刷新（默认 retryGivenUp）：两个都读。
    s.w.soonTicket("BTL-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.gh.prStatus.mock.calls.length).toBe(calls + 2);
  });

  it("reports a PR whose URL from GitHub names another repo (the repo was renamed)", async () => {
    const s = setup();
    const onSlugMoved = vi.fn<(from: string, to: string) => void>();
    const w = new PrWatcher({ ...s.deps, onSlugMoved });
    s.link();
    s.gh.prStatus.mockResolvedValue(pr({ url: url(7, "app2") }));
    await w.check();
    expect(onSlugMoved).toHaveBeenCalledWith("o/app", "o/app2");
    onSlugMoved.mockClear();
    s.advance(PR_SLOW_MS);
    s.gh.prStatus.mockResolvedValue(pr());
    await w.check();
    expect(onSlugMoved).not.toHaveBeenCalled();
  });

  it("forgets the backoff of a PR whose rows are gone, so a later link reads it at once", async () => {
    const s = setup();
    s.link();
    await s.w.check();
    s.advance(60_000);
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(2);
    // 换分支：旧分支没合并的行删掉了；这一轮也不再查它。
    s.tickets.updateRepo({ id: s.repoId, workMode: "branch", worktreePath: null, branch: "c" });
    s.advance(15_000);
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(2);
    // 同一个 PR 又链接到新分支上（例如 PR 改了 head）：不用等 120 秒。
    s.link({ headBranch: "c" });
    s.advance(15_000);
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(3);
  });

  it("polls a URL shared by two tickets once and updates both rows", async () => {
    const s = setup();
    s.addTicket("BTL-2");
    const a = s.link();
    // BTL-2 没有这个仓库：repoId 为 null。
    const b = s.link({ ticketKey: "BTL-2", repoId: null, headBranch: null, source: "handoff" });
    s.gh.prStatus.mockResolvedValue(pr({ ci: "passing", checks: [check("test", "passing")], reviews: [{ id: "R1", author: "alice", state: "APPROVED", body: "", submittedAt: 5 }] }));
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(1);
    expect(s.gh.reviewAuthors).toHaveBeenCalledTimes(1);
    for (const r of [a, b]) expect(s.prs.get(r.id)).toMatchObject({ ci: "passing", checkedAt: s.now(), headBranch: "b" });
    // 事件不跨 ticket 去重：各记各的。
    const kinds = (key: string) => s.stages.forTicket(key).map((e) => `${e.kind}:${e.prId}`).sort();
    expect(kinds("BTL-1")).toEqual([`ci:${a.id}`, `pr_opened:${a.id}`, `review:${a.id}`]);
    expect(kinds("BTL-2")).toEqual([`ci:${b.id}`, `pr_opened:${b.id}`, `review:${b.id}`]);
    // 每个 ticket 各自交 CI。
    expect(s.deps.onCiSettled.mock.calls).toEqual([[{ kind: "pr", id: a.id }], [{ kind: "pr", id: b.id }]]);
    expect(s.deps.onPrChanged.mock.calls.map(([k]) => k).sort()).toEqual(["BTL-1", "BTL-2"]);
  });

  it("reads a PR outside the ticket's repos from home, passing its slug to the review calls", async () => {
    const s = setup();
    s.link({ url: url(3, "docs"), slug: "o/docs", repoId: null, number: 3, headBranch: null, source: "handoff" });
    s.gh.prStatus.mockResolvedValue(pr({ number: 3, url: url(3, "docs"), ci: "failing", checks: [check("t", "failing", 4)], reviews: [{ id: "R1", author: "alice", state: "APPROVED", body: "", submittedAt: 5 }] }));
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledWith("/home", url(3, "docs"), PR_GH_TIMEOUT_MS);
    expect(s.gh.failedLogDetail).toHaveBeenCalledWith("/home", 4, CI_LOG_LINES, PR_GH_TIMEOUT_MS, "o/docs");
    expect(s.gh.reviewAuthors).toHaveBeenCalledWith("/home", 3, PR_GH_TIMEOUT_MS, "o/docs");
    expect(s.events("pr_opened")[0].data).toEqual({ number: 3 });
    expect(s.stages.has("BTL-1@o/docs:opened:b:3")).toBe(true);
  });

  it("stores mergedAt from GitHub, never later than now, falling back to the stored time; an open PR keeps no mergedAt", async () => {
    const s = setup();
    const row = s.link();
    s.gh.prStatus.mockResolvedValue(pr());
    await s.w.check();
    expect(s.prs.get(row.id)?.mergedAt).toBeNull();
    s.prs.update(row.id, { mergedAt: s.now() - 100 });
    s.advance(PR_FAST_MS);
    s.gh.prStatus.mockResolvedValue(pr({ state: "MERGED" }));
    await s.w.check();
    expect(s.prs.get(row.id)?.mergedAt).toBe(s.now() - PR_FAST_MS - 100);
    expect(s.events("merged")[0].at).toBe(s.now() - PR_FAST_MS - 100);
  });

  it("only reads PRs that are due, fast while checks run and the session is open; stops reading merged PRs", async () => {
    const s = setup({ sessionOpen: (_k, id) => id === 1 });
    const other = s.addRepo("BTL-1", "api");
    s.link();
    s.link({ url: url(8, "api"), slug: "o/api", repoId: other, number: 8 });
    s.gh.prStatus.mockImplementation(async (_cwd, ref) => pr({ number: ref.endsWith("8") ? 8 : 7 }));
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(2);
    s.advance(PR_FAST_MS - 1);
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(2);
    s.advance(1);
    await s.w.check();
    expect(s.gh.prStatus.mock.calls.slice(2).map(([, ref]) => ref)).toEqual([url(7)]);
    s.gh.prStatus.mockImplementation(async (_cwd, ref) => pr({ number: ref.endsWith("8") ? 8 : 7, state: "MERGED" }));
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(5);
    s.advance(PR_SLOW_MS * 10);
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(5);
  });

  it("the coordinator's open session makes every repo of the ticket fast-polled", async () => {
    // 总控开着：hasOpenTerminal 对这个 ticket 的每个仓库（和 repoId 为 null 的 PR）都是 true。
    const s = setup({ sessionOpen: (k) => k === "BTL-1" });
    const other = s.addRepo("BTL-1", "api");
    s.link();
    s.link({ url: url(8, "api"), slug: "o/api", repoId: other, number: 8 });
    s.link({ url: url(3, "docs"), slug: "o/docs", repoId: null, number: 3, headBranch: null, source: "handoff" });
    s.gh.prStatus.mockImplementation(async (_cwd, ref) => pr({ number: Number(ref.split("/").pop()) }));
    await s.w.check();
    s.advance(PR_FAST_MS);
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(6);
    expect(s.deps.sessionOpen).toHaveBeenCalledWith("BTL-1", s.repoId);
    expect(s.deps.sessionOpen).toHaveBeenCalledWith("BTL-1", other);
    expect(s.deps.sessionOpen).toHaveBeenCalledWith("BTL-1", null);
  });

  it("fetches at most three failed logs, one per run", async () => {
    const s = setup();
    const row = s.link();
    const checks = [check("a", "failing", 1), check("b", "failing", 1), check("ok", "passing", 7), check("c", "failing", 2), check("d", "failing", 3), check("e", "failing", 4), check("f", "failing")];
    s.gh.prStatus.mockResolvedValueOnce(pr({ ci: "failing", checks }));
    s.gh.failedLogDetail.mockImplementation(async (_cwd, runId) => (runId === 2 ? logFailed("HTTP 502") : logOk(`log of ${runId}`)));
    await s.w.check();
    expect(s.gh.failedLogDetail.mock.calls.map((c) => c[1])).toEqual([1, 2, 3]);
    expect(s.prs.get(row.id)?.failed).toEqual([
      { name: "a", state: "failing", runId: 1, log: "log of 1" }, { name: "b", state: "failing", runId: 1 }, { name: "c", state: "failing", runId: 2 },
      { name: "d", state: "failing", runId: 3, log: "log of 3" }, { name: "e", state: "failing", runId: 4 }, { name: "f", state: "failing", runId: null },
    ]);
  });

  it("a run whose log fetch failed is not fetched again on a forced read, then backs off up to a limit, logging the reason once", async () => {
    vi.useFakeTimers();
    const s = setup();
    const row = s.link();
    s.gh.prStatus.mockResolvedValue(pr({ ci: "failing", checks: [check("t", "failing", 5)] }));
    s.gh.failedLogDetail.mockResolvedValue(logFailed("HTTP 502: Bad Gateway"));
    await s.w.check();
    expect(s.gh.failedLogDetail).toHaveBeenCalledTimes(1);
    expect(s.deps.log).toHaveBeenCalledWith("pr watch: fetching the log of run 5 failed: HTTP 502: Bad Gateway; trying again in 5 min");
    // 用户点了刷新：PR 照读，日志不再取。
    s.w.soonTicket("BTL-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.gh.prStatus).toHaveBeenCalledTimes(2);
    expect(s.gh.failedLogDetail).toHaveBeenCalledTimes(1);
    // 退避 5、10、20、40、60 分钟：到点之前（强制读也）不取，到点取一次；第 6 次失败以后不再取。
    const forced = async () => {
      s.w.soonTicket("BTL-1");
      await vi.advanceTimersByTimeAsync(1000);
    };
    let delay = CI_LOG_RETRY_MS;
    for (let tries = 1; tries < CI_LOG_TRIES_MAX; tries++) {
      s.advance(delay - 1000);
      await forced();
      expect(s.gh.failedLogDetail).toHaveBeenCalledTimes(tries);
      s.advance(1000);
      await forced();
      expect(s.gh.failedLogDetail).toHaveBeenCalledTimes(tries + 1);
      delay = Math.min(delay * 2, CI_LOG_RETRY_MAX_MS);
    }
    for (let i = 0; i < 5; i++) {
      s.advance(CI_LOG_RETRY_MAX_MS);
      await forced();
    }
    expect(s.gh.failedLogDetail).toHaveBeenCalledTimes(CI_LOG_TRIES_MAX);
    // 同一种失败只记第一次和放弃的那一次。
    const lines = s.deps.log.mock.calls.map(([m]) => m).filter((m) => m.includes("fetching the log of run 5"));
    expect(lines).toEqual([
      "pr watch: fetching the log of run 5 failed: HTTP 502: Bad Gateway; trying again in 5 min",
      `pr watch: fetching the log of run 5 failed: HTTP 502: Bad Gateway; giving up after ${CI_LOG_TRIES_MAX} tries`,
    ]);
    expect(s.prs.get(row.id)?.failed).toEqual([check("t", "failing", 5)]);
  });

  it("a different failure of the same run is logged again", async () => {
    const s = setup();
    s.link();
    s.gh.prStatus.mockResolvedValue(pr({ ci: "failing", checks: [check("t", "failing", 5)] }));
    s.gh.failedLogDetail.mockResolvedValueOnce(logFailed("timed out after 5s")).mockResolvedValueOnce(logFailed("HTTP 502: Bad Gateway"));
    await s.w.check();
    s.advance(CI_LOG_RETRY_MS);
    await s.w.check();
    expect(s.deps.log.mock.calls.map(([m]) => m).filter((m) => m.includes("fetching the log"))).toEqual([
      "pr watch: fetching the log of run 5 failed: timed out after 5s; trying again in 5 min",
      "pr watch: fetching the log of run 5 failed: HTTP 502: Bad Gateway; trying again in 10 min",
    ]);
  });

  it("a permanent error (log expired, no access) is not fetched again; other runs still are, and it takes none of the three slots", async () => {
    const s = setup();
    const row = s.link();
    s.gh.prStatus.mockResolvedValue(pr({ ci: "failing", checks: [check("old", "failing", 5)] }));
    s.gh.failedLogDetail.mockImplementation(async (_cwd, runId) => (runId === 5 ? logFailed("HTTP 410: Gone", true) : logOk(`log of ${runId}`)));
    await s.w.check();
    expect(s.deps.log).toHaveBeenCalledWith("pr watch: fetching the log of run 5 failed: HTTP 410: Gone; not trying it again");
    for (let i = 0; i < 10; i++) {
      s.advance(CI_LOG_RETRY_MAX_MS);
      await s.w.check();
    }
    expect(s.gh.failedLogDetail).toHaveBeenCalledTimes(1);
    const checks = [check("old", "failing", 5), check("a", "failing", 6), check("b", "failing", 7), check("c", "failing", 8)];
    s.gh.prStatus.mockResolvedValue(pr({ ci: "failing", checks }));
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.gh.failedLogDetail.mock.calls.map((c) => c[1])).toEqual([5, 6, 7, 8]);
    expect(s.prs.get(row.id)?.failed).toEqual([
      check("old", "failing", 5), { ...check("a", "failing", 6), log: "log of 6" }, { ...check("b", "failing", 7), log: "log of 7" }, { ...check("c", "failing", 8), log: "log of 8" },
    ]);
    expect(s.deps.log.mock.calls.filter(([m]) => m.includes("fetching the log"))).toHaveLength(1);
  });

  it("a 404 is tried once more (the log archive of a run that just finished can 404); a second 404 in a row stops it (BTL-267 review)", async () => {
    const s = setup();
    s.link();
    s.gh.prStatus.mockResolvedValue(pr({ ci: "failing", checks: [check("t", "failing", 5)] }));
    s.gh.failedLogDetail.mockResolvedValue(logFailed("HTTP 404: Not Found", false, true));
    await s.w.check();
    expect(s.deps.log).toHaveBeenLastCalledWith("pr watch: fetching the log of run 5 failed: HTTP 404: Not Found; trying again in 5 min");
    s.advance(CI_LOG_RETRY_MS);
    await s.w.check();
    expect(s.deps.log).toHaveBeenLastCalledWith("pr watch: fetching the log of run 5 failed: HTTP 404: Not Found; not trying it again");
    for (let i = 0; i < 5; i++) {
      s.advance(CI_LOG_RETRY_MAX_MS);
      await s.w.check();
    }
    expect(s.gh.failedLogDetail).toHaveBeenCalledTimes(2);
    // 404 之间夹着别的临时错误：不算连着两次。
    const t = setup();
    t.link();
    t.gh.prStatus.mockResolvedValue(pr({ ci: "failing", checks: [check("t", "failing", 5)] }));
    t.gh.failedLogDetail.mockResolvedValueOnce(logFailed("HTTP 404: Not Found", false, true)).mockResolvedValueOnce(logFailed("HTTP 502: Bad Gateway")).mockResolvedValueOnce(logFailed("HTTP 404: Not Found", false, true)).mockResolvedValueOnce(logOk("got it"));
    for (let i = 0; i < 4; i++) {
      await t.w.check();
      t.advance(CI_LOG_RETRY_MAX_MS);
    }
    expect(t.gh.failedLogDetail).toHaveBeenCalledTimes(4);
  });

  it("the first failing read hands the log over as before; a log fetched after a failure is used, and a rerun of the run fetches it again", async () => {
    const s = setup();
    const row = s.link();
    s.gh.prStatus.mockResolvedValue(pr({ ci: "failing", checks: [check("t", "failing", 5)] }));
    await s.w.check();
    expect(s.prs.get(row.id)?.failed).toEqual([{ ...check("t", "failing", 5), log: "log of 5" }]);
    expect(s.deps.onCiSettled).toHaveBeenCalledTimes(1);
    // 取成功的照旧每次读都取（日志可能被重跑换掉）。
    s.advance(PR_SLOW_MS);
    s.gh.failedLogDetail.mockResolvedValueOnce(logFailed("HTTP 502: Bad Gateway"));
    await s.w.check();
    s.advance(CI_LOG_RETRY_MS);
    await s.w.check();
    expect(s.gh.failedLogDetail).toHaveBeenCalledTimes(3);
    expect(s.prs.get(row.id)?.failed).toEqual([{ ...check("t", "failing", 5), log: "log of 5" }]);
    // 永久失败以后重跑了这个 run（同一个 run id 又在跑）：跑完再取。
    s.advance(PR_SLOW_MS);
    s.gh.failedLogDetail.mockResolvedValueOnce(logFailed("HTTP 403: Resource not accessible by integration", true));
    await s.w.check();
    s.advance(PR_SLOW_MS);
    s.gh.prStatus.mockResolvedValue(pr({ ci: "pending", checks: [check("t", "pending", 5)] }));
    await s.w.check();
    expect(s.gh.failedLogDetail).toHaveBeenCalledTimes(4);
    s.advance(PR_SLOW_MS);
    s.gh.prStatus.mockResolvedValue(pr({ ci: "failing", checks: [check("t", "failing", 5)] }));
    s.gh.failedLogDetail.mockResolvedValueOnce(logOk("rerun log"));
    await s.w.check();
    expect(s.gh.failedLogDetail).toHaveBeenCalledTimes(5);
    expect(s.prs.get(row.id)?.failed).toEqual([{ ...check("t", "failing", 5), log: "rerun log" }]);
  });

  it("does not fetch the log of a run that still has jobs running", async () => {
    const s = setup();
    const row = s.link();
    s.gh.prStatus.mockResolvedValue(pr({ ci: "failing", checks: [check("lint", "failing", 5), check("test", "pending", 5), check("other", "failing", 6)] }));
    await s.w.check();
    expect(s.gh.failedLogDetail.mock.calls.map((c) => c[1])).toEqual([6]);
    expect(s.prs.get(row.id)?.failed).toEqual([check("lint", "failing", 5), { ...check("other", "failing", 6), log: "log of 6" }]);
    s.advance(PR_SLOW_MS);
    s.gh.prStatus.mockResolvedValue(pr({ ci: "failing", checks: [check("lint", "failing", 5), check("test", "failing", 5)] }));
    await s.w.check();
    expect(s.gh.failedLogDetail.mock.calls.map((c) => c[1])).toEqual([6, 5]);
    expect(s.prs.get(row.id)?.failed).toEqual([{ ...check("lint", "failing", 5), log: "log of 5" }, check("test", "failing", 5)]);
  });

  it("caps the PRs read in one round, preferring open sessions", async () => {
    const s = setup({ sessionOpen: (k) => k === "OPEN" });
    s.addTicket("OPEN");
    for (let i = 1; i <= PR_WATCH_MAX + 5; i++) s.link({ ticketKey: i > PR_WATCH_MAX ? "OPEN" : "BTL-1", url: url(i), number: i, repoId: null });
    await s.w.check();
    const refs = s.gh.prStatus.mock.calls.map(([, ref]) => ref);
    expect(refs).toHaveLength(PR_WATCH_MAX);
    for (let i = PR_WATCH_MAX + 1; i <= PR_WATCH_MAX + 5; i++) expect(refs).toContain(url(i));
    expect(refs).not.toContain(url(PR_WATCH_MAX));
  });

  it("runs at most four gh calls at once", async () => {
    const s = setup();
    for (let i = 1; i <= 10; i++) s.link({ url: url(i), number: i, repoId: null });
    let active = 0;
    let peak = 0;
    s.gh.prStatus.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return null;
    });
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(10);
    expect(peak).toBe(4);
  });

  it("reads an unread PR row of an archived ticket once, and never again", async () => {
    const s = setup();
    const row = s.link();
    s.tickets.archive("BTL-1", 5);
    s.gh.prStatus.mockResolvedValue(pr({ createdAt: 5 }));
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(1);
    expect(s.gh.prStatus).toHaveBeenCalledWith("/w/r/app", url(7), PR_GH_TIMEOUT_MS);
    expect(s.prs.get(row.id)?.checkedAt).toBe(s.now());
    expect(s.events("pr_opened")).toHaveLength(1);
    s.advance(PR_FAST_MS);
    await s.w.check();
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(1);
  });

  it("notifies only when something changed", async () => {
    const s = setup();
    s.link();
    s.gh.prStatus.mockResolvedValue(pr());
    await s.w.check();
    expect(s.deps.notify).toHaveBeenCalledTimes(1);
    s.advance(PR_FAST_MS);
    await s.w.check();
    expect(s.deps.notify).toHaveBeenCalledTimes(1);
    s.gh.prStatus.mockResolvedValue(pr({ ci: "passing", checks: [check("test", "passing", 9)] }));
    s.advance(PR_FAST_MS);
    await s.w.check();
    expect(s.deps.notify).toHaveBeenCalledTimes(2);
  });

  it("calls onCiSettled once per conclusion: the first reading, a new sha, a changed result", async () => {
    const s = setup();
    const row = s.link();
    const at = async (o: Partial<PrStatus>) => {
      s.gh.prStatus.mockResolvedValue(pr(o));
      s.advance(PR_SLOW_MS);
      await s.w.check();
      return s.deps.onCiSettled.mock.calls.length;
    };
    expect(await at({ ci: "pending" })).toBe(0);
    expect(await at({ ci: "passing" })).toBe(1);
    expect(await at({ ci: "passing" })).toBe(1);
    expect(await at({ ci: "failing", checks: [] })).toBe(2);
    expect(await at({ ci: "failing", headSha: "b2", checks: [] })).toBe(3);
    expect(s.deps.onCiSettled).toHaveBeenLastCalledWith({ kind: "pr", id: row.id });
  });
});

describe("PrWatcher: branches", () => {
  it("finds sequential PRs on one branch and links both", async () => {
    const s = setup();
    const mergedAt = s.now() - 3_600_000;
    s.gh.prsForBranch.mockResolvedValue([listed(7), listed(5, { state: "MERGED", createdAt: 1, mergedAt })]);
    await s.w.check();
    expect(s.gh.prsForBranch).toHaveBeenCalledWith("/w/r/app", "b", PR_GH_TIMEOUT_MS);
    const rows = s.prs.byTicket("BTL-1");
    expect(rows.map((r) => [r.number, r.state, r.source, r.slug, r.repoId, r.headBranch, r.checkedAt])).toEqual([
      [7, "open", "branch", "o/app", s.repoId, "b", 0],
      [5, "merged", "branch", "o/app", s.repoId, "b", 0],
    ]);
    expect(rows.find((r) => r.number === 5)?.mergedAt).toBe(mergedAt);
    // 同一轮不读：下一轮马上读（checked_at 为 0）。
    expect(s.gh.prStatus).not.toHaveBeenCalled();
    s.gh.prStatus.mockImplementation(async (_cwd, ref) => (ref === url(5) ? pr({ number: 5, state: "MERGED", mergedAt }) : pr()));
    s.advance(15_000);
    await s.w.check();
    expect(s.gh.prStatus.mock.calls.map(([, ref]) => ref).sort()).toEqual([url(5), url(7)]);
    // 一个小时前合并的 #5 交给 onMerged（一天以内）。
    expect(s.deps.onMerged).toHaveBeenCalledTimes(1);
    expect(s.deps.onMerged).toHaveBeenCalledWith(expect.objectContaining({ number: 5 }), "/r/app");
  });

  it("a newly linked PR is not marked handled before it is read", async () => {
    const s = setup();
    s.gh.prsForBranch.mockResolvedValue([listed(5, { state: "MERGED", mergedAt: s.now() - 10 })]);
    await s.w.check();
    expect(s.prs.byTicket("BTL-1")[0].mergedHandledAt).toBeNull();
    expect(s.deps.onMerged).not.toHaveBeenCalled();
  });

  it("a throwing onMerged is retried next round and recorded once it succeeds", async () => {
    const s = setup();
    const row = s.link();
    s.gh.prStatus.mockResolvedValue(pr({ state: "MERGED", mergedAt: s.now() - 5 }));
    s.deps.onMerged.mockImplementationOnce(() => { throw new Error("lessons db busy"); });
    await s.w.check();
    expect(s.deps.onMerged).toHaveBeenCalledTimes(1);
    expect(s.prs.get(row.id)?.mergedHandledAt).toBeNull();
    expect(s.deps.log).toHaveBeenCalledWith(`pr watch: onMerged for ${url(7)} of BTL-1 failed`, expect.any(Error));
    s.advance(15_000);
    await s.w.check();
    expect(s.deps.onMerged).toHaveBeenCalledTimes(2);
    expect(s.prs.get(row.id)?.mergedHandledAt).toBe(s.now());
    s.advance(15_000);
    await s.w.check();
    expect(s.deps.onMerged).toHaveBeenCalledTimes(2);
  });

  it("a merge older than linked_at - 24h is marked handled without onMerged", async () => {
    const s = setup();
    const row = s.link({ state: "merged" });
    s.gh.prStatus.mockResolvedValue(pr({ state: "MERGED", mergedAt: s.now() - MERGED_RECENT_MS - 1 }));
    await s.w.check();
    expect(s.deps.onMerged).not.toHaveBeenCalled();
    expect(s.prs.get(row.id)?.mergedHandledAt).toBe(s.now());
  });

  it("after a branch change the old branch's open row is pruned and CI for it is not delivered", async () => {
    const s = setup();
    const row = s.link();
    s.gh.prStatus.mockResolvedValue(pr({ ci: "passing", checks: [] }));
    await s.w.check();
    s.branches.upsert({ repoId: s.repoId, ticketKey: "BTL-1", branch: "b", ci: "failing", headSha: "z", failed: [], readError: false, checkedAt: s.now() });
    // 还没递出去的结论：换分支之后不再递给新分支的 session。
    const deliver = vi.fn<(to: string, body: string) => void>();
    const ci = new CiDelivery({
      prs: s.prs, branches: s.branches, currentBranch: (id) => s.tickets.getRepo(id)?.branch ?? null,
      mailbox: fakeMailbox({ canDeliver: () => true, deliver, now: s.now }),
      recipient: (_k, id, branch) => pickRecipient({ owner: null, ownerOpen: false, open: [{ id: "h", gitBranch: null, coordinator: false }], ticketBranch: s.tickets.getRepo(id)?.branch ?? null, branch }),
      now: s.now, log: () => {},
    });
    s.tickets.updateRepo({ id: s.repoId, workMode: "branch", worktreePath: null, branch: "c" });
    await ci.flush();
    expect(deliver).not.toHaveBeenCalled();
    s.advance(PR_SLOW_MS);
    s.gh.prStatus.mockClear();
    await s.w.check();
    expect(s.prs.get(row.id)).toBeNull();
    expect(s.gh.prStatus).not.toHaveBeenCalled();
    expect(s.gh.prsForBranch).toHaveBeenLastCalledWith("/w/r/app", "c", PR_GH_TIMEOUT_MS);
    expect(s.branches.get(s.repoId)).toMatchObject({ branch: "c", ci: "unknown", headSha: null, deliveredKey: null });
    await ci.flush();
    expect(deliver).not.toHaveBeenCalled();
    expect(s.w.statusOf("BTL-1")).toEqual([expect.objectContaining({ prId: null, branch: "c", ci: "unknown" })]);
  });

  it("keeps a merged row of the old branch after a branch change", async () => {
    const s = setup();
    const row = s.link({ state: "merged" });
    s.gh.prStatus.mockResolvedValue(pr({ state: "MERGED", mergedAt: s.now() }));
    await s.w.check();
    s.tickets.updateRepo({ id: s.repoId, workMode: "branch", worktreePath: null, branch: "c" });
    await s.w.check();
    expect(s.prs.get(row.id)?.state).toBe("merged");
  });

  it("no PR open: branchRuns feeds branch_watch; first_commit after the last merge gets the :after: key", async () => {
    const s = setup();
    const merged = s.link({ number: 5, url: url(5), state: "merged" });
    s.gh.prStatus.mockResolvedValue(pr({ number: 5, state: "MERGED", mergedAt: s.now() - 1000 }));
    s.gh.prsForBranch.mockResolvedValue([listed(5, { state: "MERGED", mergedAt: s.now() - 1000 })]);
    s.gh.branchRuns.mockResolvedValue({ headSha: "s2", checks: [check("ci", "passing", 3)], ci: "passing" } satisfies BranchRuns);
    s.git.firstCommitAt.mockResolvedValue(s.now() - 10);
    await s.w.check();
    expect(s.gh.branchRuns).toHaveBeenCalledWith("/w/r/app", "b", PR_GH_TIMEOUT_MS);
    expect(s.branches.get(s.repoId)).toMatchObject({ branch: "b", ci: "passing", headSha: "s2", readError: false, checkedAt: s.now() });
    expect(s.deps.onCiSettled).toHaveBeenCalledWith({ kind: "branch", repoId: s.repoId });
    expect(s.git.firstCommitAt).toHaveBeenCalledWith("/w/r/app", "b", s.now() - 1000);
    expect(s.stages.has(`${s.repoId}:first_commit:b:after:${merged.id}`)).toBe(true);
    expect(s.events("first_commit")[0]).toMatchObject({ at: s.now() - 10, prId: null, repoId: s.repoId });
    expect(s.w.statusOf("BTL-1").map((p) => [p.prId, p.number, p.ci])).toEqual([[merged.id, 5, "pending"], [null, null, "passing"]]);
    // 记下了就不再问 git。
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.git.firstCommitAt).toHaveBeenCalledTimes(1);
  });

  it("an open PR linked before any branch check gets first_commit from its PR read, keyed after the last ended PR; the branch check does not add another", async () => {
    const s = setup();
    const merged = s.link({ number: 5, url: url(5), state: "merged", mergedAt: s.now() - 2000 });
    s.prs.update(merged.id, { checkedAt: s.now() - 1 });
    s.prs.setMergedHandled(merged.id, s.now() - 1);
    const open = s.link();
    s.prs.update(open.id, { checkedAt: s.now() - PR_SLOW_MS });
    s.branches.upsert({ repoId: s.repoId, ticketKey: "BTL-1", branch: "b", ci: "unknown", headSha: null, failed: [], readError: false, checkedAt: s.now() });
    s.gh.prStatus.mockImplementation(async (_cwd, u) => (u === url(7) ? pr({ firstCommitAt: s.now() - 500 }) : null));
    await s.w.check();
    expect(s.gh.prsForBranch).not.toHaveBeenCalled();
    expect(s.events("first_commit")).toEqual([expect.objectContaining({ at: s.now() - 500, prId: null, repoId: s.repoId, branch: "b" })]);
    expect(s.stages.has(`${s.repoId}:first_commit:b:after:${merged.id}`)).toBe(true);
    // 强制查一次分支：key 一样，不再问 git、不再记。
    s.git.firstCommitAt.mockResolvedValue(s.now() - 900);
    s.w.soon(s.repoId);
    await s.w.check();
    expect(s.gh.prsForBranch).toHaveBeenCalled();
    expect(s.git.firstCommitAt).not.toHaveBeenCalled();
    expect(s.events("first_commit")).toHaveLength(1);
  });

  it("the branch check stays the primary source: a PR read does not add first_commit once the branch check recorded it", async () => {
    const s = setup();
    s.git.firstCommitAt.mockResolvedValue(42);
    s.gh.prsForBranch.mockResolvedValue([listed(7)]);
    await s.w.check();
    s.gh.prStatus.mockResolvedValue(pr({ firstCommitAt: 77 }));
    s.advance(15_000);
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalled();
    expect(s.events("first_commit").map((e) => e.at)).toEqual([42]);
  });

  it("without any ended PR the first commit has the plain key", async () => {
    const s = setup();
    s.git.firstCommitAt.mockResolvedValue(42);
    await s.w.check();
    expect(s.git.firstCommitAt).toHaveBeenCalledWith("/w/r/app", "b", null);
    expect(s.stages.has(`${s.repoId}:first_commit:b`)).toBe(true);
  });

  it("does not check a branch that has an open PR; the PR read takes over its CI", async () => {
    const s = setup();
    s.gh.prsForBranch.mockResolvedValue([listed(7)]);
    await s.w.check();
    expect(s.gh.branchRuns).not.toHaveBeenCalled();
    s.gh.prStatus.mockResolvedValue(pr());
    s.advance(PR_SLOW_MS * 3);
    await s.w.check();
    expect(s.gh.prsForBranch).toHaveBeenCalledTimes(1);
    expect(s.w.statusOf("BTL-1").map((p) => p.number)).toEqual([7]);
  });

  it("checks an idle branch every half hour and an open session's branch every five minutes", async () => {
    const s = setup({ sessionOpen: () => false });
    await s.w.check();
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.gh.prsForBranch).toHaveBeenCalledTimes(1);
    s.advance(30 * 60_000 - PR_SLOW_MS);
    await s.w.check();
    expect(s.gh.prsForBranch).toHaveBeenCalledTimes(2);
  });

  it("flags read_error on the branch row when prsForBranch fails, keeping its CI", async () => {
    const s = setup();
    s.gh.branchRuns.mockResolvedValue({ headSha: "s1", checks: [], ci: "passing" });
    await s.w.check();
    s.gh.prsForBranch.mockResolvedValue(null);
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.branches.get(s.repoId)).toMatchObject({ ci: "passing", headSha: "s1", readError: true });
    expect(s.deps.log).toHaveBeenCalledWith("pr watch: listing the PRs of b in /r/app failed");
    expect(s.w.statusOf("BTL-1")).toEqual([expect.objectContaining({ prId: null, readError: true, ci: "passing" })]);
  });

  it("a branch read that recovers while the branch has an open PR notifies (the stack tick no longer refreshes every minute, BTL-275)", async () => {
    vi.useFakeTimers();
    const s = setup();
    s.link();
    s.gh.prStatus.mockResolvedValue(pr());
    await s.w.check();
    // 分支检查上次列 PR 失败了；之后一次强制检查（分支有开着的 PR 时只有强制的才查）列成功
    s.branches.upsert({ repoId: s.repoId, ticketKey: "BTL-1", branch: "b", ci: "unknown", headSha: null, failed: [], readError: true, checkedAt: s.now() });
    s.gh.prsForBranch.mockResolvedValue([listed(7)]);
    s.deps.notify.mockClear();
    s.w.soonTicket("BTL-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.gh.prsForBranch).toHaveBeenCalled();
    expect(s.branches.get(s.repoId)).toMatchObject({ readError: false });
    expect(s.deps.notify).toHaveBeenCalledTimes(1);
    // 再强制查一次还是好的：没变，不通知
    s.deps.notify.mockClear();
    s.w.soonTicket("BTL-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.deps.notify).not.toHaveBeenCalled();
  });

  it("an open PR Shipherd gave up reading still counts as the branch's open PR: the branch check stays paused", async () => {
    const s = setup();
    const row = s.link();
    s.prs.update(row.id, { checkedAt: s.now(), readFailures: PR_READ_GIVE_UP + 1, readFailingSince: 1, readRetryAt: s.now() + PR_READ_RETRY_MS, readError: true });
    await s.w.check();
    expect(s.gh.prStatus).not.toHaveBeenCalled();
    expect(s.gh.prsForBranch).not.toHaveBeenCalled();
  });

  it("soonTicket forces branch checks for all repos of the ticket", async () => {
    vi.useFakeTimers();
    const s = setup();
    s.addRepo("BTL-1", "api", "b2");
    s.addTicket("BTL-2");
    s.addRepo("BTL-2", "web");
    s.w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.gh.prsForBranch).toHaveBeenCalledTimes(3);
    s.w.soonTicket("BTL-1");
    s.w.soonTicket("BTL-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.gh.prsForBranch.mock.calls.slice(3).map(([cwd]) => cwd).sort()).toEqual(["/w/r/api", "/w/r/app"]);
    s.w.stop();
  });

  it("soon forces one repo's branch check and PR reads", async () => {
    vi.useFakeTimers();
    const s = setup();
    const other = s.addRepo("BTL-1", "api", "b2");
    s.link({ url: url(8, "api"), slug: "o/api", repoId: other, number: 8, headBranch: "b2" });
    s.gh.prStatus.mockResolvedValue(pr({ number: 8, headBranch: "b2" }));
    s.w.start();
    await vi.advanceTimersByTimeAsync(0);
    s.gh.prStatus.mockClear();
    s.gh.prsForBranch.mockClear();
    s.w.soon(other);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.gh.prStatus.mock.calls.map(([, ref]) => ref)).toEqual([url(8, "api")]);
    expect(s.gh.prsForBranch.mock.calls.map(([cwd]) => cwd)).toEqual(["/w/r/api"]);
    s.w.stop();
  });

  it("soon during a running round checks again right after it", async () => {
    vi.useFakeTimers();
    const s = setup();
    let release!: () => void;
    s.gh.prsForBranch.mockImplementationOnce(() => new Promise((r) => (release = () => r([]))));
    s.w.start();
    await vi.advanceTimersByTimeAsync(0);
    s.w.soon(s.repoId);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.gh.prsForBranch).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.gh.prsForBranch).toHaveBeenCalledTimes(2);
    s.w.stop();
  });
});

describe("PrWatcher: rounds", () => {
  it("one round at a time", async () => {
    const s = setup();
    let release!: () => void;
    s.gh.prsForBranch.mockImplementation(() => new Promise((r) => (release = () => r([]))));
    const first = s.w.check();
    const second = s.w.check();
    await vi.waitFor(() => expect(s.gh.prsForBranch).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(s.gh.prsForBranch).toHaveBeenCalledTimes(1);
  });

  it("start runs a round now and then every tick; stop ends it", async () => {
    vi.useFakeTimers();
    const s = setup();
    s.w.start(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.gh.prsForBranch).toHaveBeenCalledTimes(1);
    s.advance(PR_SLOW_MS);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.gh.prsForBranch).toHaveBeenCalledTimes(2);
    s.w.stop();
    s.advance(PR_SLOW_MS);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.gh.prsForBranch).toHaveBeenCalledTimes(2);
  });

  it("stop before start does nothing, and start after it still works", async () => {
    vi.useFakeTimers();
    const s = setup();
    expect(() => s.w.stop()).not.toThrow();
    s.w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.gh.prsForBranch).toHaveBeenCalledTimes(1);
    s.w.stop();
  });

  it("calls roundDone after every round, also when nothing was due or listing tickets failed", async () => {
    const s = setup();
    await s.w.check();
    await s.w.check();
    expect(s.deps.roundDone).toHaveBeenCalledTimes(2);
    const broken = new PrWatcher({ ...s.deps, tickets: () => { throw new Error("db closed"); } });
    await broken.check();
    expect(s.deps.roundDone).toHaveBeenCalledTimes(3);
    expect(s.deps.log).toHaveBeenCalledWith("pr watch: listing tickets failed", expect.any(Error));
  });

  it("a failing step does not stop the others; a throwing roundDone only logs", async () => {
    const s = setup();
    const row = s.link({ state: "merged" });
    s.gh.prStatus.mockResolvedValue(pr({ state: "MERGED", mergedAt: s.now() }));
    s.gh.prsForBranch.mockRejectedValue(new Error("boom"));
    const w = new PrWatcher({ ...s.deps, roundDone: () => { throw new Error("boom"); } });
    await expect(w.check()).resolves.toBeUndefined();
    expect(s.prs.get(row.id)?.mergedHandledAt).toBe(s.now());
    expect(s.deps.log).toHaveBeenCalledWith("pr watch: roundDone failed", expect.any(Error));
  });

  it("calls onPrChanged once per ticket after all its PRs are written", async () => {
    const s = setup();
    s.link();
    s.link({ url: url(8), number: 8 });
    s.gh.prStatus.mockImplementation(async (_cwd, ref) => pr({ number: ref.endsWith("8") ? 8 : 7 }));
    s.deps.onPrChanged.mockImplementation(() => expect(s.prs.byTicket("BTL-1").every((r) => r.checkedAt > 0)).toBe(true));
    await s.w.check();
    expect(s.deps.onPrChanged).toHaveBeenCalledTimes(1);
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.deps.onPrChanged).toHaveBeenCalledTimes(1);
    s.gh.prStatus.mockImplementation(async (_cwd, ref) => pr({ number: ref.endsWith("8") ? 8 : 7, review: "approved" }));
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.deps.onPrChanged).toHaveBeenCalledTimes(2);
  });

  it("statusOf lists the ticket's PR rows with their repo path; branch rows only when no PR is open on that branch", async () => {
    const s = setup();
    s.gh.branchRuns.mockResolvedValue({ headSha: "s1", checks: [], ci: "pending" });
    await s.w.check();
    expect(s.w.statusOf("BTL-1")).toEqual([
      { ticketKey: "BTL-1", prId: null, repoId: s.repoId, repoPath: "/r/app", branch: "b", number: null, url: null, state: null, review: null, ci: "pending", headSha: "s1", checkedAt: s.now(), readError: false },
    ]);
    const row = s.link();
    s.gh.prStatus.mockResolvedValue(pr());
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.w.statusOf("BTL-1")).toEqual([
      { ticketKey: "BTL-1", prId: row.id, repoId: s.repoId, repoPath: "/r/app", branch: "b", number: 7, url: url(7), state: "open", review: "pending", ci: "pending", headSha: "a1", checkedAt: s.now(), readError: false,
        detail: {
          baseBranch: null, isDraft: false, title: null, author: "me", labels: [], reviewRequests: [], reviewers: [], mergeable: null, mergeState: null,
          statusChangedAt: s.now(), slug: "o/app",
        },
      },
    ]);
    expect(s.w.statusOf("BTL-2")).toEqual([]);
  });

  it("cachedByUrl only returns rows read successfully within the last minute", async () => {
    const s = setup();
    s.link();
    s.gh.prStatus.mockResolvedValue(pr({ state: "MERGED" }));
    expect(s.w.cachedByUrl(url(7))).toBeNull();
    await s.w.check();
    expect(s.w.cachedByUrl("https://github.com/O/App/pull/7/")).toEqual({ state: "merged" });
    expect(s.w.cachedByUrl(url(9))).toBeNull();
    s.advance(59_999);
    expect(s.w.cachedByUrl(url(7))).not.toBeNull();
    s.advance(1);
    expect(s.w.cachedByUrl(url(7))).toBeNull();
  });
});

describe("PrWatcher: stages", () => {
  const review = { id: "PRR_kwHuman1", author: "alice", state: "COMMENTED" as const, body: "", submittedAt: 5 };
  const copilot = { id: "PRR_kwCopilot1", author: "copilot-pull-request-reviewer", state: "COMMENTED" as const, body: "", submittedAt: 6 };
  const derived = (events: StageEvent[]) =>
    derivePrStages({
      ticketKey: "BTL-1", featureId: null, repoId: 1, repoName: "r", branch: "b", ticketCreatedAt: 0, events, upperDesign: [], reports: [],
      pr: { number: 7, url: "u", state: "open", ci: "none", review: null, mergedAt: null, closedAt: null, checkedAt: 0 }, skillTrackingSince: 0,
    });
  const repeat = async (s: ReturnType<typeof setup>) => {
    const before = s.events().length;
    s.advance(PR_FAST_MS);
    await s.w.check();
    return s.events().length - before;
  };

  it("records every review at once and fetches inline comments only for a new Copilot review; a repeat round neither fetches nor notifies", async () => {
    const s = setup();
    s.link();
    s.gh.prStatus.mockResolvedValue(pr({ reviews: [review, copilot] }));
    await s.w.check();
    expect(s.gh.reviewComments).toHaveBeenCalledTimes(1);
    expect(s.gh.reviewComments).toHaveBeenCalledWith("/w/r/app", 7, PR_GH_TIMEOUT_MS, "o/app");
    expect(s.events("review").map((e) => e.data.id)).toEqual(["PRR_kwHuman1", "PRR_kwCopilot1"]);
    expect(s.deps.notify).toHaveBeenCalledTimes(1);
    expect(await repeat(s)).toBe(0);
    expect(s.gh.reviewComments).toHaveBeenCalledTimes(1);
    expect(s.deps.notify).toHaveBeenCalledTimes(1);
  });

  it("a suffix-less app login that REST says is a Bot does not count as peer review; repeat polls make no extra call", async () => {
    const s = setup();
    s.link();
    const app = { id: "PRR_kwApp1", author: "someapp", state: "APPROVED" as const, body: "", submittedAt: 5 };
    s.gh.reviewAuthors.mockResolvedValue({ botReviewIds: new Set(["PRR_kwApp1"]), botLogins: new Set(["someapp"]) });
    s.gh.prStatus.mockResolvedValue(pr({ reviews: [app], comments: [{ id: "C1", author: "someapp", body: "x", createdAt: 6, url: null, path: null, line: null, reviewId: null }] }));
    await s.w.check();
    expect(s.gh.reviewAuthors).toHaveBeenCalledTimes(1);
    expect(s.events().filter((e) => e.kind === "review" || e.kind === "comment").map((e) => e.data.who)).toEqual(["bot", "bot"]);
    expect(derived(s.events()).stages.find((c) => c.id === "peer_review")?.state).not.toBe("done");
    await repeat(s);
    expect(s.gh.reviewAuthors).toHaveBeenCalledTimes(1);
  });

  it("a review later dismissed is recorded again (one extra REST call), and repeat polls then record nothing", async () => {
    const s = setup();
    s.link();
    const approved = { ...review, state: "APPROVED" as const };
    s.gh.prStatus.mockResolvedValue(pr({ reviews: [approved] }));
    await s.w.check();
    s.gh.prStatus.mockResolvedValue(pr({ reviews: [{ ...approved, state: "DISMISSED" }] }));
    await repeat(s);
    expect(s.events("review").map((e) => e.data.state)).toEqual(["APPROVED", "DISMISSED"]);
    expect(s.gh.reviewAuthors).toHaveBeenCalledTimes(2);
    expect(await repeat(s)).toBe(0);
    expect(s.gh.reviewAuthors).toHaveBeenCalledTimes(2);
  });

  it("falls back to the name list when the REST reviews call fails, and logs it", async () => {
    const s = setup();
    s.link();
    s.gh.reviewAuthors.mockResolvedValue(null);
    s.gh.prStatus.mockResolvedValue(pr({ reviews: [{ ...review, id: "PRR_kwX", author: "coderabbitai", state: "APPROVED" }, { ...review, id: "PRR_kwY", author: "unknownapp", state: "APPROVED" }] }));
    await s.w.check();
    expect(s.events("review").map((e) => e.data.who)).toEqual(["bot", "human"]);
    expect(s.deps.log).toHaveBeenCalledWith(`pr watch: fetching the review authors of ${url(7)} failed`);
  });

  it("a Copilot-only review does not trigger the REST reviews call; a human one never calls reviewComments", async () => {
    const s = setup();
    s.link();
    s.gh.prStatus.mockResolvedValue(pr({ reviews: [copilot] }));
    await s.w.check();
    expect(s.gh.reviewAuthors).not.toHaveBeenCalled();
    const h = setup();
    h.link();
    h.gh.prStatus.mockResolvedValue(pr({ reviews: [review, { ...copilot, state: "PENDING" }] }));
    await h.w.check();
    expect(h.gh.reviewComments).not.toHaveBeenCalled();
  });

  it("records a Copilot review even when its inline comments cannot be fetched, retries later and stops after 3 attempts", async () => {
    const s = setup();
    s.link();
    s.gh.prStatus.mockResolvedValue(pr({ reviews: [copilot] }));
    s.gh.reviewComments.mockResolvedValue(null);
    await s.w.check();
    expect(s.stages.has(`${s.repoId}:review:b:PRR_kwCopilot1:COMMENTED`)).toBe(true);
    for (let i = 0; i < 4; i++) await repeat(s);
    expect(s.gh.reviewComments).toHaveBeenCalledTimes(3);
  });

  it("counts the Copilot inline comments through derivePrStages, even when they arrive in a later round", async () => {
    const s = setup();
    s.link();
    s.gh.prStatus.mockResolvedValue(pr({ reviews: [copilot] }));
    s.gh.reviewComments.mockResolvedValueOnce(null);
    await s.w.check();
    const inline = (id: string): PrComment => ({ id, author: "Copilot", body: "b", createdAt: 7, url: null, path: "a.ts", line: 1, reviewId: "PRR_kwCopilot1" });
    s.gh.reviewComments.mockResolvedValueOnce([inline("101"), inline("102")]);
    await repeat(s);
    expect(derived([...s.events()].sort((a, b) => a.at - b.at)).timeline.find((e) => e.kind === "copilot_review")?.detail).toBe("2");
  });

  it("dedupes against events recorded before the migration (same repo-scoped keys)", async () => {
    const s = setup();
    s.stages.add({ ticketKey: "BTL-1", repoId: s.repoId, prId: null, branch: "b", featureId: null, sessionId: null, kind: "pr_opened", at: 1, data: { number: 7 } }, `${s.repoId}:opened:b:7`);
    s.link();
    s.gh.prStatus.mockResolvedValue(pr());
    await s.w.check();
    expect(s.events("pr_opened")).toHaveLength(1);
  });

  it("a merged or closed read fetches no failed logs, inline comments or review authors", async () => {
    for (const state of ["MERGED", "CLOSED"] as const) {
      const s = setup();
      s.link();
      s.gh.prStatus.mockResolvedValue(
        pr({ state, mergedAt: state === "MERGED" ? s.now() - 5 : null, closedAt: state === "CLOSED" ? s.now() - 5 : null, ci: "failing", checks: [check("test", "failing", 4)], reviews: [review, copilot] }),
      );
      await s.w.check();
      expect(s.prs.get(1)).toMatchObject({ state: state.toLowerCase(), ci: "failing", failed: [check("test", "failing", 4)] });
      expect(s.gh.failedLogDetail).not.toHaveBeenCalled();
      expect(s.gh.reviewComments).not.toHaveBeenCalled();
      expect(s.gh.reviewAuthors).not.toHaveBeenCalled();
      // review 照常记。
      expect(s.events("review").map((e) => e.data.id)).toEqual(["PRR_kwHuman1", "PRR_kwCopilot1"]);
    }
  });

  it("the open-to-merged read still fetches inline comments and review authors (reviews may land with the merge), but no failed logs", async () => {
    const s = setup();
    s.link();
    s.gh.prStatus.mockResolvedValue(pr());
    await s.w.check();
    s.advance(PR_SLOW_MS);
    s.gh.prStatus.mockResolvedValue(pr({ state: "MERGED", mergedAt: s.now() - 5, ci: "failing", checks: [check("test", "failing", 4)], reviews: [review, copilot] }));
    await s.w.check();
    expect(s.prs.get(1)).toMatchObject({ state: "merged", failed: [check("test", "failing", 4)] });
    expect(s.gh.failedLogDetail).not.toHaveBeenCalled();
    expect(s.gh.reviewComments).toHaveBeenCalledTimes(1);
    expect(s.gh.reviewAuthors).toHaveBeenCalledTimes(1);
  });

  it("records merged once when the PR goes from open to merged, at GitHub's time", async () => {
    const s = setup();
    s.link();
    s.gh.prStatus.mockResolvedValue(pr());
    await s.w.check();
    s.gh.prStatus.mockResolvedValue(pr({ state: "MERGED", mergedAt: s.now() + 10 }));
    await repeat(s);
    expect(s.events("merged").map((e) => e.at)).toEqual([s.now() - PR_FAST_MS + 10]);
    expect(s.deps.onMerged).toHaveBeenCalledTimes(1);
  });
});


describe("PrWatcher: branches a session pushed (workstream W)", () => {
  it("lists PRs on an owned branch that is not the ticket branch, links them, and reads them next round", async () => {
    const s = setup();
    s.owners.record({ ticketKey: "BTL-1", repoId: s.repoId, branch: "feat/wt", sessionId: "s1", dir: "/wt/a", at: s.now() });
    s.gh.prsForBranch.mockImplementation(async (_cwd, branch) => (branch === "feat/wt" ? [listed(34, { headRefName: "feat/wt" })] : []));
    await s.w.check();
    expect(s.gh.prsForBranch).toHaveBeenCalledWith("/w/r/app", "feat/wt", PR_GH_TIMEOUT_MS);
    const row = s.prs.byTicket("BTL-1").find((p) => p.number === 34);
    expect(row).toMatchObject({ headBranch: "feat/wt", repoId: s.repoId, source: "branch", state: "open" });
    // 下一轮不被 pruneStale 删掉，照常读。
    s.gh.prStatus.mockResolvedValue(pr({ number: 34, url: url(34), headBranch: "feat/wt" }));
    s.advance(15_000);
    await s.w.check();
    expect(s.prs.get(row!.id)).toMatchObject({ checkedAt: s.now(), ci: "pending" });
  });

  it("does not list an owned branch again while it has an open PR, nor more than every 5 minutes, nor after 14 days", async () => {
    const s = setup();
    s.owners.record({ ticketKey: "BTL-1", repoId: s.repoId, branch: "feat/x", sessionId: "s1", dir: "/wt/x", at: s.now() });
    // ticket 分支本身不在这里列（checkBranches 列它）。
    s.owners.record({ ticketKey: "BTL-1", repoId: s.repoId, branch: "b", sessionId: "s1", dir: "/r/app", at: s.now() });
    const owned = () => s.gh.prsForBranch.mock.calls.filter((c) => c[1] === "feat/x").length;
    await s.w.check();
    expect(owned()).toBe(1);
    s.advance(60_000);
    await s.w.check();
    expect(owned()).toBe(1);
    s.advance(5 * 60_000);
    await s.w.check();
    expect(owned()).toBe(2);
    // push 之后 soon(repoId)：马上再列。
    s.w.soon(s.repoId);
    await s.w.check();
    expect(owned()).toBe(3);
    s.link({ url: url(9), number: 9, headBranch: "feat/x" });
    s.advance(10 * 60_000);
    await s.w.check();
    expect(owned()).toBe(3);
    s.prs.update(s.prs.byTicket("BTL-1").find((p) => p.number === 9)!.id, { state: "merged" });
    s.advance(14 * 24 * 3600_000);
    await s.w.check();
    expect(owned()).toBe(3);
  });

  it("stops listing once the PR of the latest push is merged; a reused branch name does not pull in old merged PRs", async () => {
    const s = setup();
    const at = s.now();
    s.owners.record({ ticketKey: "BTL-1", repoId: s.repoId, branch: "fix/ci", sessionId: "s1", dir: "/wt/x", at });
    // 同名分支上一年前合并的 PR：不链接。
    s.gh.prsForBranch.mockImplementation(async (_cwd, branch) => (branch === "fix/ci" ? [listed(3, { headRefName: "fix/ci", state: "MERGED", createdAt: at - 365 * 24 * 3600_000, mergedAt: at - 364 * 24 * 3600_000 })] : []));
    await s.w.check();
    expect(s.prs.byTicket("BTL-1").find((p) => p.number === 3)).toBeUndefined();
    // 这次推送的 PR 在推送之后合并了：不再列。
    s.link({ url: url(9), number: 9, headBranch: "fix/ci" });
    s.prs.update(s.prs.byTicket("BTL-1").find((p) => p.number === 9)!.id, { state: "merged", mergedAt: at + 1000 });
    const owned = () => s.gh.prsForBranch.mock.calls.filter((c) => c[1] === "fix/ci").length;
    const before = owned();
    s.advance(10 * 60_000);
    await s.w.check();
    expect(owned()).toBe(before);
    // 合并以后又推了一次：又列。
    s.owners.record({ ticketKey: "BTL-1", repoId: s.repoId, branch: "fix/ci", sessionId: "s1", dir: "/wt/x", at: s.now() });
    s.advance(10 * 60_000);
    await s.w.check();
    expect(owned()).toBe(before + 1);
  });
});

describe("prStatusChanged", () => {
  type Prev = Parameters<typeof prStatusChanged>[0];
  const base: Prev = {
    state: "open", review: "pending", ci: "passing", headSha: "a", isDraft: false, mergeable: "mergeable", mergeState: "clean",
    reviewers: [{ login: "alice", state: "commented", at: 1, bot: false }], reviewRequests: [{ kind: "user", name: "bob" }], statusChangedAt: 10,
  };
  it("counts real changes and the first read", () => {
    expect(prStatusChanged(base, base, true)).toBe(true);
    expect(prStatusChanged(base, base, false)).toBe(false);
    expect(prStatusChanged(base, { ...base, ci: "failing" }, false)).toBe(true);
    expect(prStatusChanged(base, { ...base, isDraft: true }, false)).toBe(true);
    expect(prStatusChanged(base, { ...base, mergeable: "conflicting" }, false)).toBe(true);
    expect(prStatusChanged(base, { ...base, reviewers: [{ login: "alice", state: "approved", at: 2, bot: false }] }, false)).toBe(true);
    expect(prStatusChanged(base, { ...base, reviewRequests: [] }, false)).toBe(true);
  });
  it("ignores GitHub recomputing mergeability, review timestamps, bots and request order", () => {
    expect(prStatusChanged(base, { ...base, mergeable: "unknown", mergeState: "unknown" }, false)).toBe(false);
    expect(prStatusChanged({ ...base, mergeable: "unknown", mergeState: "unknown" }, base, false)).toBe(false);
    expect(prStatusChanged(base, { ...base, reviewers: [{ login: "alice", state: "commented", at: 99, bot: false }, { login: "ci-bot", state: "commented", at: 3, bot: true }] }, false)).toBe(false);
    const two = { ...base, reviewRequests: [{ kind: "user" as const, name: "bob" }, { kind: "team" as const, name: "core" }] };
    expect(prStatusChanged(two, { ...two, reviewRequests: [...two.reviewRequests].reverse() }, false)).toBe(false);
  });
  it("treats a row from before the upgrade as a baseline: only the old fields count", () => {
    const legacy: Prev = { ...base, mergeable: null, mergeState: null, reviewers: [], reviewRequests: [], statusChangedAt: null };
    expect(prStatusChanged(legacy, base, false)).toBe(false);
    expect(prStatusChanged(legacy, { ...base, ci: "failing" }, false)).toBe(true);
  });
});

describe("PrWatcher.onPrRead (workstream I)", () => {
  it("hands each read PR with its updated rows to the comment loop without waiting for it", async () => {
    const s = setup();
    const row = s.link();
    let release!: () => void;
    const onPrRead = vi.fn<NonNullable<PrWatcherDeps["onPrRead"]>>(() => new Promise<void>((r) => (release = r)));
    const w = new PrWatcher({ ...s.deps, onPrRead });
    s.gh.prStatus.mockResolvedValue(pr({ ci: "passing", headSha: "zz9" }));
    await w.check();
    expect(onPrRead).toHaveBeenCalledTimes(1);
    const [rows, status, where] = onPrRead.mock.calls[0];
    expect(rows.map((r) => [r.id, r.headSha])).toEqual([[row.id, "zz9"]]);
    expect(status.headSha).toBe("zz9");
    expect(where).toEqual({ cwd: "/w/r/app", slug: "o/app" });
    release();
  });
});

describe("PrWatcher.statusOfMany (BTL-275)", () => {
  it("is statusOf() for several tickets from one PR read and one branch read", () => {
    const s = setup();
    s.addTicket("BTL-2");
    const r2 = s.addRepo("BTL-2", "api", "x");
    s.addTicket("BTL-3");
    s.link();
    s.link({ url: url(8), number: 8, state: "merged" });
    // BTL-1 的分支上有开着的 PR：分支行不另出；BTL-2 只有分支行；没读过的分支行不出。
    s.branches.upsert({ repoId: s.repoId, ticketKey: "BTL-1", branch: "b", ci: "passing", headSha: "h1", failed: [], readError: false, checkedAt: 5 });
    s.branches.upsert({ repoId: r2, ticketKey: "BTL-2", branch: "x", ci: "failing", headSha: "h2", failed: [], readError: false, checkedAt: 5 });
    const byTicket = vi.spyOn(s.prs, "byTicket");
    const branchesByTicket = vi.spyOn(s.branches, "byTicket");
    const many = s.w.statusOfMany(["BTL-1", "BTL-2", "BTL-3", "BTL-1"]);
    expect([byTicket.mock.calls.length, branchesByTicket.mock.calls.length]).toEqual([0, 0]);
    byTicket.mockRestore();
    branchesByTicket.mockRestore();
    for (const key of ["BTL-1", "BTL-2", "BTL-3"]) expect(many.get(key)).toEqual(s.w.statusOf(key));
    expect(many.get("BTL-1")!.map((p) => p.number).sort()).toEqual([7, 8]);
    expect(many.get("BTL-2")).toEqual([expect.objectContaining({ prId: null, branch: "x", ci: "failing" })]);
    expect(many.get("BTL-3")).toEqual([]);
  });
});

/**
 * 批量读的假 gh（BTL-276）：GitHub 上的 PR 是 remote 里的（按号），"nf" 是 GitHub 说没有，null 是这个 PR 出错。
 * 指纹按 head、CI、状态、review、评论数、检查算（和真的便宜字段一样，变了就不同）。fail 为 true 时整个调用失败，failFull 只让全读失败；
 * wide 里的号列表太长、全读读不全（pr 为 null）。
 */
function batchGh(remote: Map<number, PrStatus | "nf" | null>, o: { fail?: () => boolean; failFull?: () => boolean; wide?: Set<number>; rate?: () => number } = {}) {
  return vi.fn<typeof Gh.prBatch>(async (_cwd, _slug, numbers, mode) => {
    if (o.fail?.() || (mode === "full" && o.failFull?.())) return null;
    const prs = new Map<number, PrBatchItem>();
    for (const n of numbers) {
      const v = remote.get(n);
      if (v === "nf") prs.set(n, GH_NOT_FOUND);
      else if (!v) prs.set(n, null);
      else prs.set(n, { sig: JSON.stringify([v.url, v.headSha, v.ci, v.state, v.review, v.comments.length, v.checks]), pr: mode === "full" && !o.wide?.has(n) ? v : null });
    }
    return { prs, rate: o.rate ? { cost: 1, remaining: o.rate(), resetAt: 5 } : null };
  });
}

describe("PrWatcher: batch-reading PRs with GraphQL (BTL-276)", () => {
  function batched(remote: Map<number, PrStatus | "nf" | null>, o: Parameters<typeof batchGh>[1] = {}, more: Partial<PrWatcherDeps> = {}) {
    const s = setup();
    const prBatch = batchGh(remote, o);
    const w = new PrWatcher({ ...s.deps, gh: { ...s.gh, prBatch }, ...more });
    const modes = () => prBatch.mock.calls.map((c) => `${c[3]}:${c[2].join(",")}`);
    return { ...s, w, prBatch, modes };
  }

  it("reads every due PR of a repo in one GraphQL call, not one gh pr view each (nothing cached yet: no cheap call first)", async () => {
    const remote = new Map<number, PrStatus | "nf" | null>([[7, pr()], [8, pr({ number: 8, url: url(8), ci: "passing", checks: [check("test", "passing", 3)] })]]);
    const s = batched(remote);
    const a = s.link();
    const b = s.link({ url: url(8), number: 8 });
    await s.w.check();
    expect(s.modes()).toEqual(["full:7,8"]);
    expect(s.prBatch).toHaveBeenCalledWith("/w/r/app", "o/app", [7, 8], "full", PR_BATCH_TIMEOUT_MS);
    expect(s.gh.prStatus).not.toHaveBeenCalled();
    expect(s.prs.get(a.id)).toMatchObject({ state: "open", ci: "pending", headSha: "a1", checkedAt: s.now() });
    expect(s.prs.get(b.id)).toMatchObject({ ci: "passing" });
    expect(s.deps.onPrChanged).toHaveBeenCalledWith("BTL-1");
  });

  it("does not read a PR in full again while its cheap fields stay the same, and reads it at once when they change", async () => {
    const remote = new Map<number, PrStatus | "nf" | null>([[7, pr()]]);
    const s = batched(remote);
    const row = s.link();
    await s.w.check();
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.modes()).toEqual(["full:7", "cheap:7"]);
    expect(s.prs.get(row.id)).toMatchObject({ checkedAt: s.now(), readError: false });
    remote.set(7, pr({ headSha: "b2" }));
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.modes().slice(2)).toEqual(["cheap:7", "full:7"]);
    expect(s.prs.get(row.id)).toMatchObject({ headSha: "b2" });
  });

  it("forwards a new comment, which changes the cheap fields, the same as before", async () => {
    const onHumanComment = vi.fn();
    const remote = new Map<number, PrStatus | "nf" | null>([[7, pr()]]);
    const s = batched(remote, {}, { onHumanComment });
    s.link();
    await s.w.check();
    remote.set(7, pr({ comments: [{ id: "C1", author: "alice", body: "x", createdAt: 6, url: null, path: null, line: null, reviewId: null }] }));
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(onHumanComment).toHaveBeenCalledWith("BTL-1", 7, 1);
  });

  it("keeps the failed logs it already has while the CI stays the same, and fetches them again once it changes", async () => {
    const failing = (sha: string) => pr({ headSha: sha, ci: "failing", checks: [check("a", "failing", 1), check("b", "failing", 2)] });
    const remote = new Map<number, PrStatus | "nf" | null>([[7, failing("a1")]]);
    const s = batched(remote);
    const row = s.link();
    await s.w.check();
    expect(s.gh.failedLogDetail).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 3; i++) {
      s.advance(PR_SLOW_MS);
      await s.w.check();
    }
    expect(s.gh.failedLogDetail).toHaveBeenCalledTimes(2);
    expect(s.prs.get(row.id)?.failed.map((c) => c.log)).toEqual(["log of 1", "log of 2"]);
    remote.set(7, failing("b2"));
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.gh.failedLogDetail).toHaveBeenCalledTimes(4);
  });

  it("still fetches a log it could not get last time, without fetching the ones it has", async () => {
    const remote = new Map<number, PrStatus | "nf" | null>([[7, pr({ ci: "failing", checks: [check("a", "failing", 1), check("b", "failing", 2)] })]]);
    const s = batched(remote);
    s.gh.failedLogDetail.mockImplementation(async (_c, runId) => (runId === 2 ? logFailed("HTTP 502") : logOk(`log of ${runId}`)));
    s.link();
    await s.w.check();
    s.gh.failedLogDetail.mockClear();
    s.advance(CI_LOG_RETRY_MS);
    await s.w.check();
    expect(s.gh.failedLogDetail.mock.calls.map((c) => c[1])).toEqual([2]);
  });

  it("reads every PR in full again after PR_FULL_REFRESH_MS, and only after PR_FULL_REFRESH_LOW_MS while GraphQL points are low", async () => {
    const remote = new Map<number, PrStatus | "nf" | null>([[7, pr()]]);
    let points = 5000;
    const s = batched(remote, { rate: () => points });
    s.link();
    await s.w.check();
    s.advance(PR_FULL_REFRESH_MS);
    await s.w.check();
    expect(s.modes()).toEqual(["full:7", "cheap:7", "full:7"]);
    points = PR_RATE_LOW - 1;
    s.advance(PR_FULL_REFRESH_MS);
    await s.w.check();
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.modes().slice(3)).toEqual(["cheap:7", "cheap:7"]);
    s.advance(PR_FULL_REFRESH_LOW_MS - PR_FULL_REFRESH_MS - PR_SLOW_MS);
    await s.w.check();
    expect(s.modes().slice(5)).toEqual(["cheap:7", "full:7"]);
    expect(s.deps.log.mock.calls.filter((c) => String(c[0]).includes("GraphQL points are low"))).toHaveLength(1);
  });

  it("reads in full when the user refreshes, even if nothing changed", async () => {
    vi.useFakeTimers();
    const remote = new Map<number, PrStatus | "nf" | null>([[7, pr()]]);
    const s = batched(remote);
    s.link();
    await s.w.check();
    s.w.soonTicket("BTL-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.modes()).toEqual(["full:7", "cheap:7", "full:7"]);
  });

  it("falls back to gh pr view for every PR when the batch call fails, and for one PR when only it fails", async () => {
    let fail = true;
    const remote = new Map<number, PrStatus | "nf" | null>([[7, pr()], [8, null]]);
    const s = batched(remote, { fail: () => fail });
    s.link();
    s.link({ url: url(8), number: 8 });
    s.gh.prStatus.mockImplementation(async (_cwd, u) => pr({ number: u === url(7) ? 7 : 8, url: u }));
    await s.w.check();
    expect(s.gh.prStatus.mock.calls.map((c) => c[1]).sort()).toEqual([url(7), url(8)]);
    expect(s.deps.log).toHaveBeenCalledWith(expect.stringContaining("reading them one by one"));
    fail = false;
    s.gh.prStatus.mockClear();
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.gh.prStatus.mock.calls.map((c) => c[1])).toEqual([url(8)]);
  });

  it("counts a PR GitHub says does not exist as not found, so a round of them is no outage", async () => {
    const remote = new Map<number, PrStatus | "nf" | null>([[25, "nf"], [26, "nf"]]);
    const s = batched(remote);
    const a = s.link({ url: url(25, "gone"), slug: "o/gone", number: 25, repoId: null, source: "handoff" });
    const b = s.link({ url: url(26, "gone"), slug: "o/gone", number: 26, repoId: null, source: "handoff" });
    await s.w.check();
    expect(s.gh.prStatus).not.toHaveBeenCalled();
    for (const r of [a, b]) expect(s.prs.get(r.id)).toMatchObject({ readFailures: 1, readNotFound: 1 });
    expect(s.deps.log).not.toHaveBeenCalledWith(expect.stringContaining("gh offline"));
  });

  it("counts one PR GitHub says does not exist inside a batch that read the others (BTL-261 rules), and leaves it out of the batch once it is gone", async () => {
    vi.useFakeTimers();
    const remote = new Map<number, PrStatus | "nf" | null>([[7, pr()], [25, "nf"]]);
    const s = batched(remote);
    const ok = s.link();
    const bad = s.link({ url: url(25), number: 25 });
    await s.w.check();
    // 部分 data 加一条 NOT_FOUND：好的照常读，坏的单独计一次「不存在」，整批不算失败、也不算离线，也没退回 gh pr view。
    expect(s.gh.prStatus).not.toHaveBeenCalled();
    expect(s.prs.get(ok.id)).toMatchObject({ readError: false, readFailures: 0, headSha: "a1" });
    expect(s.prs.get(bad.id)).toMatchObject({ readFailures: 1, readNotFound: 1, readNotFoundSince: s.now(), readGoneAt: null });
    expect(s.deps.log).not.toHaveBeenCalledWith(expect.stringContaining("gh offline"));
    expect(s.deps.log).not.toHaveBeenCalledWith(expect.stringContaining("reading them one by one"));
    for (let i = 1; i < PR_NOT_FOUND_GIVE_UP; i++) {
      s.advance(PR_NOT_FOUND_MIN_MS);
      await s.w.check();
    }
    expect(s.prs.get(bad.id)).toMatchObject({ readNotFound: PR_NOT_FOUND_GIVE_UP, readGoneAt: s.now() });
    expect(s.prs.get(ok.id)).toMatchObject({ readError: false, readNotFound: 0, readGoneAt: null });
    // gone 了：之后的批量查询里没有它；总控扫 epic（不强制）也不查。
    s.prBatch.mockClear();
    s.advance(PR_SLOW_MS);
    await s.w.check();
    s.w.soonTicket("BTL-1", { retryGivenUp: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.prBatch.mock.calls.length).toBeGreaterThan(0);
    for (const c of s.prBatch.mock.calls) expect(c[2]).not.toContain(25);
  });

  it("keeps the PR gh pr view read when the full batch read failed, so a later round never serves the older cached read", async () => {
    let failFull = false;
    const failing = (sha: string, id: number) => pr({ headSha: sha, ci: "failing", checks: [check("a", "failing", id)] });
    const remote = new Map<number, PrStatus | "nf" | null>([[7, failing("a1", 1)]]);
    const s = batched(remote, { failFull: () => failFull });
    s.gh.prStatus.mockImplementation(async () => remote.get(7) as PrStatus);
    const row = s.link();
    await s.w.check();
    // CI 重跑、换了 run：便宜字段变了，全读失败，退回 gh pr view 读到新的。
    failFull = true;
    remote.set(7, failing("a1", 2));
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(1);
    expect(s.prs.get(row.id)?.failed.map((c) => c.runId)).toEqual([2]);
    // 之后没变：用的是 gh pr view 读到的那份（不是第一轮的旧缓存），也不再全读、不再 gh pr view、不再取日志。
    failFull = false;
    s.gh.failedLogDetail.mockClear();
    s.prBatch.mockClear();
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.modes()).toEqual(["cheap:7"]);
    expect(s.gh.prStatus).toHaveBeenCalledTimes(1);
    expect(s.gh.failedLogDetail).not.toHaveBeenCalled();
    expect(s.prs.get(row.id)?.failed.map((c) => [c.runId, c.log])).toEqual([[2, "log of 2"]]);
  });

  it("drops the cache when even the cheap read failed, and reads in full next time", async () => {
    let fail = false;
    const remote = new Map<number, PrStatus | "nf" | null>([[7, pr()]]);
    const s = batched(remote, { fail: () => fail });
    s.gh.prStatus.mockImplementation(async () => remote.get(7) as PrStatus);
    s.link();
    await s.w.check();
    fail = true;
    s.advance(PR_SLOW_MS);
    await s.w.check();
    fail = false;
    s.prBatch.mockClear();
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.modes()).toEqual(["full:7"]);
  });

  it("reads a PR whose lists are too long for one batch with gh pr view, without a wasted full read, and only when it changed", async () => {
    const remote = new Map<number, PrStatus | "nf" | null>([[7, pr()]]);
    const s = batched(remote, { wide: new Set([7]) });
    s.gh.prStatus.mockImplementation(async () => remote.get(7) as PrStatus);
    const row = s.link();
    await s.w.check();
    expect(s.modes()).toEqual(["full:7"]);
    expect(s.gh.prStatus).toHaveBeenCalledTimes(1);
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.modes()).toEqual(["full:7", "cheap:7"]);
    expect(s.gh.prStatus).toHaveBeenCalledTimes(1);
    remote.set(7, pr({ headSha: "b2" }));
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.modes()).toEqual(["full:7", "cheap:7", "cheap:7"]);
    expect(s.gh.prStatus).toHaveBeenCalledTimes(2);
    expect(s.prs.get(row.id)).toMatchObject({ headSha: "b2" });
  });

  it("treats a round where the batch and every fallback read fail as an outage, counting nothing", async () => {
    const remote = new Map<number, PrStatus | "nf" | null>([[7, pr()], [8, pr({ number: 8, url: url(8) })]]);
    let fail = false;
    const s = batched(remote, { fail: () => fail });
    const a = s.link();
    const b = s.link({ url: url(8), number: 8 });
    await s.w.check();
    fail = true;
    s.advance(PR_SLOW_MS);
    await s.w.check();
    for (const r of [a, b]) expect(s.prs.get(r.id)).toMatchObject({ readError: true, readFailures: 0 });
    expect(s.deps.log).toHaveBeenCalledWith(expect.stringContaining("gh offline"));
  });

  it("reports a renamed repo when the batch read gives the PR's new URL (BTL-261)", async () => {
    const onSlugMoved = vi.fn<(from: string, to: string) => void>();
    const remote = new Map<number, PrStatus | "nf" | null>([[7, pr({ url: url(7, "app2") })]]);
    const s = batched(remote, {}, { onSlugMoved });
    s.link();
    await s.w.check();
    expect(onSlugMoved).toHaveBeenCalledWith("o/app", "o/app2");
  });

  it("reports a renamed repo when only the URL changed since the last full read, through the cheap read (BTL-261)", async () => {
    const onSlugMoved = vi.fn<(from: string, to: string) => void>();
    const remote = new Map<number, PrStatus | "nf" | null>([[7, pr()]]);
    const s = batched(remote, {}, { onSlugMoved });
    s.link();
    await s.w.check();
    expect(onSlugMoved).not.toHaveBeenCalled();
    remote.set(7, pr({ url: url(7, "app2") }));
    s.prBatch.mockClear();
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.modes()).toEqual(["cheap:7", "full:7"]);
    expect(onSlugMoved).toHaveBeenCalledWith("o/app", "o/app2");
  });

  it("reads a PR whose number GraphQL cannot take on its own with gh pr view, not in the batch", async () => {
    const big = 2 ** 31;
    const remote = new Map<number, PrStatus | "nf" | null>([[7, pr()]]);
    const s = batched(remote);
    s.link();
    s.link({ url: url(big), number: big });
    await s.w.check();
    expect(s.modes()).toEqual(["full:7"]);
    expect(s.gh.prStatus).toHaveBeenCalledWith("/w/r/app", url(big), expect.any(Number));
  });

  it("asks one batch per repo, and reads at most PR_BATCH_FULL_MAX PRs in full per call", async () => {
    const remote = new Map<number, PrStatus | "nf" | null>();
    const s = batched(remote);
    for (let n = 1; n <= PR_BATCH_FULL_MAX + 2; n++) {
      remote.set(n, pr({ number: n, url: url(n) }));
      s.link({ url: url(n), number: n });
    }
    remote.set(99, pr({ number: 99, url: url(99, "web") }));
    s.link({ url: url(99, "web"), slug: "o/web", number: 99, repoId: null, source: "handoff" });
    await s.w.check();
    const calls = () => s.prBatch.mock.calls.map((c) => [c[1], c[3], c[2].length]);
    expect(calls().filter((c) => c[0] === "o/app").map((c) => c[2])).toEqual([PR_BATCH_FULL_MAX, 2]);
    expect(calls().filter((c) => c[0] === "o/web")).toEqual([["o/web", "full", 1]]);
    s.prBatch.mockClear();
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(calls().sort()).toEqual([["o/app", "cheap", PR_BATCH_FULL_MAX + 2], ["o/web", "cheap", 1]]);
  });

  it("starts far fewer gh processes than one gh pr view per PR (the numbers in the PR description)", async () => {
    // 一个仓库 6 个开着的 PR，session 开着：4 个 CI 在跑（每分钟查），2 个 CI 挂了（各 2 个失败的 run，5 分钟查一次）；
    // 其中一个在跑的 PR 每 10 分钟多一条评论。跑 30 分钟，每分钟一轮。
    const run = async (useBatch: boolean) => {
      const remote = new Map<number, PrStatus | "nf" | null>();
      for (let n = 1; n <= 6; n++) {
        remote.set(n, n <= 4 ? pr({ number: n, url: url(n) }) : pr({ number: n, url: url(n), ci: "failing", checks: [check("a", "failing", n * 10), check("b", "failing", n * 10 + 1)] }));
      }
      const s = useBatch ? batched(remote) : (() => { const x = setup(); return { ...x, prBatch: null }; })();
      s.gh.prStatus.mockImplementation(async (_cwd, u) => remote.get(Number(u.split("/").pop())) as PrStatus);
      for (let n = 1; n <= 6; n++) s.link({ url: url(n), number: n });
      for (let m = 0; m < 30; m++) {
        if (m > 0 && m % 10 === 0) {
          const p = remote.get(1) as PrStatus;
          remote.set(1, { ...p, comments: [...p.comments, { id: `C${m}`, author: "alice", body: "x", createdAt: m, url: null, path: null, line: null, reviewId: null }] });
        }
        await s.w.check();
        s.advance(PR_FAST_MS);
      }
      return s.gh.prStatus.mock.calls.length + (s.prBatch?.mock.calls.length ?? 0) + s.gh.failedLogDetail.mock.calls.length;
    };
    const before = await run(false);
    const after = await run(true);
    // 改前：在跑的 4 个每分钟一次（120）+ 挂了的 2 个每 5 分钟一次（12）+ 每次 2 个日志（24）= 156，约 5.2 个/分钟
    // 改后：第一轮一次全读，之后每分钟一次便宜的（29）+ 第 10 和 20 分钟的评论各一次全读（2）+ 日志只取一次（4）= 36，约 1.2 个/分钟
    expect({ before, after }).toEqual({ before: 156, after: 36 });
  });
});
