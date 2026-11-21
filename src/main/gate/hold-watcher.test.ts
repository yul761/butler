import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/database";
import { MergeGateRepo } from "../db/merge-gate-repo";
import { fakeMailbox } from "../mailbox/fake-mailbox";
import { M } from "../strings";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { PrWatcher, type PrWatcherDeps } from "../prwatch/pr-watcher";
import { memDb } from "../test-utils";
import type { PrInfo } from "../tickets/gh";
import { HoldWatcher, LOCAL_HOLD_MAX_MS, NOTICE_KEEP_MS, type HoldWatcherDeps } from "./hold-watcher";
import { HOLD_MAX_MS } from "./merge-gate";

const REPO = "/r/app";
const PR_URL = "https://github.com/o/app/pull/12";
const pr = (state: PrInfo["state"], autoMerge = false): PrInfo => ({ number: 12, url: PR_URL, head: "dms-1", base: "main", state, autoMerge });
const who = (t: string | null, b: string) => (t ? `${t}（支付）` : b);

/** DMS-1 的 PR 占着 main（t = 0 拿到许可），DMS-2 的 session s-wait 在等它。 */
function seed(db: Db, kind: "pr" | "local" = "pr"): number {
  const repo = new MergeGateRepo(db);
  const id = repo.addHold({ repoPath: REPO, branch: "dms-1", target: "main", kind, prUrl: kind === "pr" ? PR_URL : null, sessionId: "s-hold", ticketKey: "DMS-1", createdAt: 0 });
  repo.addWaiter({ holdId: id, sessionId: "s-wait", ticketKey: "DMS-2", branch: "dms-2", createdAt: 0 });
  return id;
}

interface Opts {
  db?: Db;
  pr?: () => PrInfo | null | Promise<PrInfo | null>;
  ancestor?: (a: string, b: string) => boolean;
  /** 假信箱现在送不送得到（等待者开着、停着）。 */
  reachable?: boolean;
  cachedByUrl?: HoldWatcherDeps["cachedByUrl"];
}

function setup(o: Opts = {}) {
  const db = o.db ?? memDb();
  if (!o.db) seed(db);
  const state = { now: 0, reachable: o.reachable ?? true };
  const repo = new MergeGateRepo(db);
  const prInfo = vi.fn(async () => (o.pr ? o.pr() : null));
  const git = {
    isAncestor: vi.fn(async (_repo: string, a: string, b: string) => o.ancestor?.(a, b) ?? false),
    fetchQuiet: vi.fn(async () => true),
    upstreamRef: vi.fn(async (_repo: string, b: string) => `origin/${b}`),
  };
  /** 送到了的：[等待者, 正文]。 */
  const deliver = vi.fn<(to: string, body: string) => void>();
  const mailbox = fakeMailbox({ canDeliver: () => state.reachable, deliver, now: () => state.now });
  const logs: string[] = [];
  const deps: HoldWatcherDeps = {
    repo, prInfo, git,
    mailbox,
    cachedByUrl: o.cachedByUrl,
    whoOf: who,
    now: () => state.now,
    log: (m) => logs.push(m),
  };
  const watcher = new HoldWatcher(deps);
  const outcome = () => (db.prepare(`SELECT outcome FROM merge_holds ORDER BY id`).get() as { outcome: string | null }).outcome;
  return { db, repo, state, prInfo, git, deliver, mailbox, logs, watcher, outcome };
}

afterEach(() => vi.useRealTimers());

describe("HoldWatcher: PR holds", () => {
  it("cancels an open PR without auto-merge 31 s after the hold, and tells the waiter it can try again", async () => {
    const t = setup({ pr: () => pr("OPEN") });
    t.state.now = 31_000;
    await t.watcher.check();
    expect(t.prInfo).toHaveBeenCalledWith(REPO, PR_URL, 2000);
    expect(t.outcome()).toBe("cancelled");
    expect(t.deliver).toHaveBeenCalledTimes(1);
    expect(t.deliver).toHaveBeenCalledWith("s-wait", M().gateNotMerged("DMS-1（支付）"));
    expect(t.repo.pendingNotices()).toEqual([]);
  });

  it("leaves an open PR without auto-merge alone for the first 30 s (the merge command may still be running)", async () => {
    const t = setup({ pr: () => pr("OPEN") });
    t.state.now = 10_000;
    await t.watcher.check();
    expect(t.outcome()).toBeNull();
    expect(t.repo.activeHolds()).toHaveLength(1);
  });

  it("keeps an open PR with auto-merge on", async () => {
    const t = setup({ pr: () => pr("OPEN", true) });
    t.state.now = 60 * 60 * 1000;
    await t.watcher.check();
    expect(t.outcome()).toBeNull();
  });

  it("releases a merged PR as merged and tells the idle waiting session once", async () => {
    const t = setup({ pr: () => pr("MERGED") });
    await t.watcher.check();
    expect(t.outcome()).toBe("merged");
    expect(t.deliver).toHaveBeenCalledTimes(1);
    expect(t.deliver).toHaveBeenCalledWith("s-wait", M().gateMergedNotice("DMS-1（支付）"));
    expect(t.repo.pendingNotices()).toEqual([]);
  });

  it("queues the notice for a busy or closed waiter right away (kind merge); it arrives once, when the session can take it", async () => {
    const t = setup({ pr: () => pr("MERGED"), reachable: false });
    await t.watcher.check();
    expect(t.outcome()).toBe("merged");
    expect(t.deliver).not.toHaveBeenCalled();
    // 排进信箱就算通知过了：不再算待发。
    expect(t.repo.pendingNotices()).toEqual([]);
    const [m] = [...t.mailbox.queued.values()];
    expect(m).toMatchObject({ kind: "merge", toSession: "s-wait", body: M().gateMergedNotice("DMS-1（支付）") });
    expect(m.ref).toMatch(/^merge:\d+$/);
    // 停下来（或者重新打开）：信箱送进去，只送一次。
    t.state.reachable = true;
    t.mailbox.deliverQueued();
    await t.watcher.check();
    t.watcher.sessionIdle("s-wait");
    expect(t.deliver).toHaveBeenCalledTimes(1);
    expect(t.deliver).toHaveBeenCalledWith("s-wait", M().gateMergedNotice("DMS-1（支付）"));
  });

  it("drops a notice released more than 24 h before it could be queued (left from before an upgrade)", async () => {
    expect(NOTICE_KEEP_MS).toBe(24 * 60 * 60_000);
    const t = setup({ pr: () => pr("OPEN", true) });
    t.repo.releaseHold(t.repo.activeHolds()[0].id, "merged", 1000);
    t.state.now = 1000 + NOTICE_KEEP_MS + 1;
    await t.watcher.check();
    expect(t.repo.pendingNotices()).toEqual([]);
    expect(t.mailbox.queued.size).toBe(0);
    expect(t.deliver).not.toHaveBeenCalled();
  });

  it("cancels a closed PR and tells the waiter it can try again", async () => {
    const t = setup({ pr: () => pr("CLOSED") });
    await t.watcher.check();
    expect(t.outcome()).toBe("cancelled");
    expect(t.deliver).toHaveBeenCalledWith("s-wait", M().gateNotMerged("DMS-1（支付）"));
  });

  it("expires a hold 2 h + 1 ms old when gh cannot answer and the branch is not in the target", async () => {
    const t = setup({ pr: () => null, ancestor: () => false });
    t.state.now = HOLD_MAX_MS + 1;
    await t.watcher.check();
    expect(t.git.fetchQuiet).toHaveBeenCalledWith(REPO, "main", 2000);
    expect(t.git.isAncestor).toHaveBeenCalledWith(REPO, "dms-1", "origin/main");
    expect(t.outcome()).toBe("expired");
    expect(t.deliver).toHaveBeenCalledTimes(1);
    expect(t.deliver).toHaveBeenCalledWith("s-wait", M().gateNotMerged("DMS-1（支付）"));
  });

  it("keeps a hold younger than 2 h when gh cannot answer", async () => {
    const t = setup({ pr: () => null, ancestor: () => false });
    t.state.now = HOLD_MAX_MS;
    await t.watcher.check();
    expect(t.outcome()).toBeNull();
  });

  it("releases as merged when gh cannot answer but git shows the branch in the latest target", async () => {
    const t = setup({ pr: () => null, ancestor: (a, b) => a === "dms-1" && b === "origin/main" });
    await t.watcher.check();
    expect(t.outcome()).toBe("merged");
    expect(t.deliver).toHaveBeenCalledTimes(1);
  });
});

describe("HoldWatcher: PR state cached by the PR watcher", () => {
  type Cached = ReturnType<NonNullable<HoldWatcherDeps["cachedByUrl"]>>;
  const cached = (state: "open" | "merged" | "closed") => vi.fn<(url: string) => Cached>(() => ({ state }));

  it("releases as merged from a cached MERGED reading without asking gh", async () => {
    const cachedByUrl = cached("merged");
    const t = setup({ pr: () => pr("OPEN"), cachedByUrl });
    await t.watcher.check();
    expect(cachedByUrl).toHaveBeenCalledWith(PR_URL);
    expect(t.prInfo).not.toHaveBeenCalled();
    expect(t.outcome()).toBe("merged");
    expect(t.deliver).toHaveBeenCalledWith("s-wait", M().gateMergedNotice("DMS-1（支付）"));
  });

  it("cancels from a cached CLOSED reading without asking gh", async () => {
    const t = setup({ pr: () => pr("OPEN"), cachedByUrl: cached("closed") });
    await t.watcher.check();
    expect(t.prInfo).not.toHaveBeenCalled();
    expect(t.outcome()).toBe("cancelled");
  });

  it("trusts a cached merged state and ignores rows with read_error", async () => {
    // 真的 PrWatcher.cachedByUrl：只给 60 秒内读成功的行。
    const prDb = memDb();
    new TicketsRepo(prDb).insert({ key: "DMS-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
    const prs = new TicketPrsRepo(prDb);
    const watcher = new PrWatcher({ prs, now: () => 100_000 } as unknown as PrWatcherDeps);
    const row = prs.link({ ticketKey: "DMS-1", url: PR_URL, slug: "o/app", repoId: null, number: 12, headBranch: "dms-1", state: "open", source: "merge_gate", linkedAt: 1 }).pr;
    prs.update(row.id, { state: "merged", checkedAt: 90_000, readError: true });
    const failed = setup({ pr: () => pr("OPEN", true), cachedByUrl: (url) => watcher.cachedByUrl(url) });
    await failed.watcher.check();
    expect(failed.prInfo).toHaveBeenCalledWith(REPO, PR_URL, 2000);
    expect(failed.outcome()).toBeNull();
    prs.update(row.id, { readError: false });
    const good = setup({ pr: () => pr("OPEN", true), cachedByUrl: (url) => watcher.cachedByUrl(url) });
    await good.watcher.check();
    expect(good.prInfo).not.toHaveBeenCalled();
    expect(good.outcome()).toBe("merged");
  });

  it("asks gh for an open PR (the cache does not know about auto-merge) and when nothing is cached", async () => {
    for (const cachedByUrl of [cached("open"), vi.fn<(url: string) => Cached>(() => null)]) {
      const t = setup({ pr: () => pr("MERGED"), cachedByUrl });
      await t.watcher.check();
      expect(t.prInfo).toHaveBeenCalledTimes(1);
      expect(t.outcome()).toBe("merged");
    }
  });
});

describe("HoldWatcher: local holds", () => {
  it("releases a local hold whose branch is in the target as merged", async () => {
    const db = memDb();
    seed(db, "local");
    const t = setup({ db, ancestor: (a, b) => a === "dms-1" && b === "main" });
    await t.watcher.check();
    expect(t.prInfo).not.toHaveBeenCalled();
    expect(t.outcome()).toBe("merged");
    expect(t.deliver).toHaveBeenCalledTimes(1);
  });

  it("expires a local hold after 10 min (no post arrived: the command was rejected or interrupted)", async () => {
    expect(LOCAL_HOLD_MAX_MS).toBe(10 * 60_000);
    const db = memDb();
    seed(db, "local");
    const t = setup({ db, ancestor: () => false });
    t.state.now = LOCAL_HOLD_MAX_MS + 1;
    await t.watcher.check();
    expect(t.outcome()).toBe("expired");
    expect(t.deliver).toHaveBeenCalledWith("s-wait", M().gateNotMerged("DMS-1（支付）"));
  });

  it("keeps a local hold up to 10 min", async () => {
    const db = memDb();
    seed(db, "local");
    const t = setup({ db, ancestor: () => false });
    t.state.now = LOCAL_HOLD_MAX_MS;
    await t.watcher.check();
    expect(t.outcome()).toBeNull();
  });
});

describe("HoldWatcher: rounds", () => {
  it("picks up holds and waiters written before a restart", async () => {
    const db = memDb();
    seed(db);
    // 上一次运行的 watcher 已经不在了：新的 watcher 只看数据库。
    const t = setup({ db, pr: () => pr("MERGED") });
    await t.watcher.check();
    expect(t.outcome()).toBe("merged");
    expect(t.deliver).toHaveBeenCalledWith("s-wait", M().gateMergedNotice("DMS-1（支付）"));
  });

  it("runs one round for two overlapping check calls", async () => {
    let answer: (p: PrInfo) => void = () => undefined;
    const t = setup({ pr: () => new Promise<PrInfo>((done) => (answer = done)) });
    const a = t.watcher.check();
    const b = t.watcher.check();
    await vi.waitFor(() => expect(t.prInfo).toHaveBeenCalled());
    answer(pr("MERGED"));
    await Promise.all([a, b]);
    expect(t.prInfo).toHaveBeenCalledTimes(1);
    expect(t.deliver).toHaveBeenCalledTimes(1);
  });

  it("queues each notice once, whichever of a round and a Stop gets there first", async () => {
    const db = memDb();
    const repo = new MergeGateRepo(db);
    const id = repo.addHold({ repoPath: REPO, branch: "dms-1", target: "main", kind: "pr", prUrl: PR_URL, sessionId: "s-hold", ticketKey: "DMS-1", createdAt: 0 });
    repo.addWaiter({ holdId: id, sessionId: "s-a", ticketKey: "DMS-2", branch: "dms-2", createdAt: 0 });
    repo.addWaiter({ holdId: id, sessionId: "s-b", ticketKey: "DMS-3", branch: "dms-3", createdAt: 0 });
    const send = vi.fn(() => ({ id: "m", state: "busy" as const }));
    const watcher = new HoldWatcher({
      repo, prInfo: async () => pr("MERGED"), git: { isAncestor: async () => false, fetchQuiet: async () => true, upstreamRef: async (_r, b) => `origin/${b}` },
      mailbox: { send }, whoOf: who, now: () => 0, log: () => undefined,
    });
    await watcher.check();
    watcher.sessionIdle("s-b");
    await watcher.check();
    expect(send.mock.calls.map((c) => (c as unknown as [{ to: string }])[0].to).sort()).toEqual(["s-a", "s-b"]);
    expect(repo.pendingNotices()).toEqual([]);
  });

  it("keeps going when one hold's check throws", async () => {
    const db = memDb();
    seed(db);
    const repo = new MergeGateRepo(db);
    repo.addHold({ repoPath: REPO, branch: "dms-3", target: "main", kind: "local", prUrl: null, sessionId: null, ticketKey: "DMS-3", createdAt: 0 });
    const t = setup({ db, pr: () => Promise.reject(new Error("boom")), ancestor: (a) => a === "dms-3" });
    await t.watcher.check();
    expect(repo.activeHolds().map((h) => h.branch)).toEqual(["dms-1"]);
    expect(t.logs.some((l) => l.includes("dms-1"))).toBe(true);
  });

  it("soon() runs one round a second later, however often it is called", async () => {
    vi.useFakeTimers();
    const t = setup({ pr: () => pr("OPEN", true) });
    t.watcher.soon();
    t.watcher.soon();
    await vi.advanceTimersByTimeAsync(999);
    expect(t.prInfo).not.toHaveBeenCalled();
    t.watcher.soon();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.prInfo).toHaveBeenCalledTimes(1);
  });

  it("start() checks a second after starting, then every interval until stop()", async () => {
    vi.useFakeTimers();
    const t = setup({ pr: () => pr("OPEN", true) });
    t.watcher.start(30_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.prInfo).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(t.prInfo).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.prInfo).toHaveBeenCalledTimes(3);
    t.watcher.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.prInfo).toHaveBeenCalledTimes(3);
  });
});
