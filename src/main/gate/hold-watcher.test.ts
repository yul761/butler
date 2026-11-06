import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionActivity } from "../../shared/activity";
import type { Session } from "../../shared/types";
import type { Db } from "../db/database";
import { MergeGateRepo } from "../db/merge-gate-repo";
import { M } from "../strings";
import { DeliveryGuard } from "../sessions/delivery-guard";
import { memDb } from "../test-utils";
import type { PrInfo } from "../tickets/gh";
import { HoldWatcher, LOCAL_HOLD_MAX_MS, NOTICE_KEEP_MS, USER_TYPING_QUIET_MS, type HoldWatcherDeps } from "./hold-watcher";
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
  open?: boolean;
  waiting?: boolean;
  deliver?: (id: string, text: string, recheck: () => boolean) => Promise<"sent" | "exited" | "timeout" | "blocked">;
  refreshActivity?: HoldWatcherDeps["refreshActivity"];
  cachedByUrl?: HoldWatcherDeps["cachedByUrl"];
}

function setup(o: Opts = {}) {
  const db = o.db ?? memDb();
  if (!o.db) seed(db);
  const state = { now: 0, open: o.open ?? true, waiting: o.waiting ?? true, typedAt: 0, draft: false, inFlight: false, activity: "waiting" as SessionActivity["kind"] };
  const repo = new MergeGateRepo(db);
  const prInfo = vi.fn(async () => (o.pr ? o.pr() : null));
  const git = {
    isAncestor: vi.fn(async (_repo: string, a: string, b: string) => o.ancestor?.(a, b) ?? false),
    fetchQuiet: vi.fn(async () => true),
    upstreamRef: vi.fn(async (_repo: string, b: string) => `origin/${b}`),
  };
  const deliver = vi.fn(o.deliver ?? (async () => "sent" as const));
  const logs: string[] = [];
  // 真的 DeliveryGuard：终端开着 = open，停着等输入 = waiting，typedAt 是用户上次打字的时间。
  const guard = new DeliveryGuard({
    termOf: (id) => (state.open ? id : null),
    head: (id) => ({ id, waitingForInput: state.waiting }) as Session,
    activity: () => ({ kind: state.activity, background: false }) as SessionActivity,
    pty: { lastUserInputAt: () => state.typedAt, screenNeedsUser: () => false, hasDraft: () => state.draft, autoInputInFlight: () => state.inFlight },
    now: () => state.now,
  });
  const deps: HoldWatcherDeps = {
    repo, prInfo, git,
    isOpen: () => state.open,
    guard,
    refreshActivity: o.refreshActivity,
    cachedByUrl: o.cachedByUrl,
    deliver,
    whoOf: who,
    now: () => state.now,
    log: (m) => logs.push(m),
  };
  const watcher = new HoldWatcher(deps);
  const outcome = () => (db.prepare(`SELECT outcome FROM merge_holds ORDER BY id`).get() as { outcome: string | null }).outcome;
  return { db, repo, state, prInfo, git, deliver, logs, watcher, outcome };
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
    expect(t.deliver).toHaveBeenCalledWith("s-wait", M().gateNotMerged("DMS-1（支付）"), expect.any(Function));
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
    expect(t.deliver).toHaveBeenCalledWith("s-wait", M().gateMergedNotice("DMS-1（支付）"), expect.any(Function));
    expect(t.repo.pendingNotices()).toEqual([]);
  });

  it("waits for a busy session to stop, then tells it once", async () => {
    const t = setup({ pr: () => pr("MERGED"), waiting: false });
    await t.watcher.check();
    expect(t.outcome()).toBe("merged");
    expect(t.deliver).not.toHaveBeenCalled();
    expect(t.repo.pendingNotices()).toHaveLength(1);

    t.state.waiting = true;
    await t.watcher.sessionIdle("s-wait");
    expect(t.deliver).toHaveBeenCalledTimes(1);
    await t.watcher.check();
    await t.watcher.sessionIdle("s-wait");
    expect(t.deliver).toHaveBeenCalledTimes(1);
  });

  it("re-reads the activity on Stop, so a session last seen thinking is told right away", async () => {
    const refreshed: string[] = [];
    const t = setup({
      pr: () => pr("MERGED"),
      refreshActivity: async (id) => {
        refreshed.push(id);
        t.state.activity = "waiting";
      },
    });
    // 上一次活动刷新时它还在想：这一轮的检查不发。
    t.state.activity = "thinking";
    await t.watcher.check();
    expect(t.deliver).not.toHaveBeenCalled();
    // Stop 到了：先重读活动，再发。
    await t.watcher.sessionIdle("s-wait");
    expect(refreshed).toEqual(["s-wait"]);
    expect(t.deliver).toHaveBeenCalledTimes(1);
    expect(t.repo.pendingNotices()).toEqual([]);
  });

  it("still goes through the notices on Stop when re-reading the activity fails", async () => {
    const t = setup({ pr: () => pr("MERGED"), waiting: false, refreshActivity: async () => Promise.reject(new Error("disk")) });
    await t.watcher.check();
    t.state.waiting = true;
    await t.watcher.sessionIdle("s-wait");
    expect(t.logs.some((l) => l.includes("s-wait"))).toBe(true);
    expect(t.deliver).toHaveBeenCalledTimes(1);
  });

  it("keeps the notice of a waiter whose terminal is closed, and delivers it once a terminal for it is open and idle again", async () => {
    const t = setup({ pr: () => pr("MERGED"), open: false });
    t.state.now = 1000;
    await t.watcher.check();
    expect(t.deliver).not.toHaveBeenCalled();
    expect(t.repo.pendingNotices()).toHaveLength(1);
    // 用户几小时后重新打开了这个 session（Butler 可能也重启过）。
    t.state.now = 5 * 60 * 60_000;
    t.state.open = true;
    await t.watcher.check();
    expect(t.deliver).toHaveBeenCalledTimes(1);
    expect(t.deliver).toHaveBeenCalledWith("s-wait", M().gateMergedNotice("DMS-1（支付）"), expect.any(Function));
    expect(t.repo.pendingNotices()).toEqual([]);
  });

  it("drops a notice nobody could receive for more than 24 h", async () => {
    expect(NOTICE_KEEP_MS).toBe(24 * 60 * 60_000);
    const t = setup({ pr: () => pr("MERGED"), open: false });
    t.state.now = 1000;
    await t.watcher.check();
    t.state.now = 1000 + NOTICE_KEEP_MS;
    await t.watcher.check();
    expect(t.repo.pendingNotices()).toHaveLength(1);
    t.state.now = 1000 + NOTICE_KEEP_MS + 1;
    await t.watcher.check();
    expect(t.repo.pendingNotices()).toEqual([]);
    t.state.open = true;
    await t.watcher.check();
    expect(t.deliver).not.toHaveBeenCalled();
  });

  it("keeps the notice when the terminal exits during delivery", async () => {
    let res: "exited" | "sent" = "exited";
    const t = setup({ pr: () => pr("MERGED"), deliver: async () => res });
    await t.watcher.check();
    expect(t.repo.pendingNotices()).toHaveLength(1);
    res = "sent";
    await t.watcher.check();
    expect(t.deliver).toHaveBeenCalledTimes(2);
    expect(t.repo.pendingNotices()).toEqual([]);
  });

  it("does not paste into a terminal the user typed in within the last 30 s, and tries again later", async () => {
    expect(USER_TYPING_QUIET_MS).toBe(30_000);
    const t = setup({ pr: () => pr("MERGED") });
    t.state.now = 100_000;
    t.state.typedAt = 100_000 - USER_TYPING_QUIET_MS + 1;
    await t.watcher.check();
    expect(t.outcome()).toBe("merged");
    await t.watcher.sessionIdle("s-wait");
    expect(t.deliver).not.toHaveBeenCalled();
    expect(t.repo.pendingNotices()).toHaveLength(1);
    t.state.now = t.state.typedAt + USER_TYPING_QUIET_MS;
    await t.watcher.check();
    expect(t.deliver).toHaveBeenCalledTimes(1);
    expect(t.repo.pendingNotices()).toEqual([]);
  });

  it("does not paste over an unsent draft however long ago it was typed, and delivers once it is gone", async () => {
    const t = setup({ pr: () => pr("MERGED") });
    t.state.now = 10 * USER_TYPING_QUIET_MS;
    t.state.draft = true;
    await t.watcher.check();
    expect(t.outcome()).toBe("merged");
    expect(t.deliver).not.toHaveBeenCalled();
    expect(t.repo.pendingNotices()).toHaveLength(1);
    t.state.draft = false;
    await t.watcher.sessionIdle("s-wait");
    expect(t.deliver).toHaveBeenCalledTimes(1);
    expect(t.repo.pendingNotices()).toEqual([]);
  });

  it("re-checks right before the paste and keeps the notice when the user started typing meanwhile (I2)", async () => {
    let t!: ReturnType<typeof setup>;
    t = setup({
      pr: () => pr("MERGED"),
      // deliver 等输入框就绪的时候用户开始打字：粘贴前的复查不通过。
      deliver: async (_id, _text, recheck) => {
        t.state.typedAt = t.state.now + 1;
        return recheck() ? "sent" : "blocked";
      },
    });
    t.state.now = 100_000;
    await t.watcher.check();
    expect(t.deliver).toHaveBeenCalledTimes(1);
    expect(t.repo.pendingNotices()).toHaveLength(1);
    expect(t.logs.some((m) => m.includes("held back"))).toBe(true);
  });

  it("does not start a notice while another automatic input is in flight on the terminal (I2)", async () => {
    const t = setup({ pr: () => pr("MERGED") });
    t.state.inFlight = true;
    await t.watcher.check();
    expect(t.deliver).not.toHaveBeenCalled();
    t.state.inFlight = false;
    await t.watcher.check();
    expect(t.deliver).toHaveBeenCalledTimes(1);
  });

  it("tries again next round when delivery timed out", async () => {
    let res: "sent" | "timeout" = "timeout";
    const t = setup({ pr: () => pr("MERGED"), deliver: async () => res });
    await t.watcher.check();
    expect(t.repo.pendingNotices()).toHaveLength(1);
    res = "sent";
    await t.watcher.check();
    expect(t.deliver).toHaveBeenCalledTimes(2);
    expect(t.repo.pendingNotices()).toEqual([]);
  });

  it("cancels a closed PR and tells the waiter it can try again", async () => {
    const t = setup({ pr: () => pr("CLOSED") });
    await t.watcher.check();
    expect(t.outcome()).toBe("cancelled");
    expect(t.deliver).toHaveBeenCalledWith("s-wait", M().gateNotMerged("DMS-1（支付）"), expect.any(Function));
  });

  it("expires a hold 2 h + 1 ms old when gh cannot answer and the branch is not in the target", async () => {
    const t = setup({ pr: () => null, ancestor: () => false });
    t.state.now = HOLD_MAX_MS + 1;
    await t.watcher.check();
    expect(t.git.fetchQuiet).toHaveBeenCalledWith(REPO, "main", 2000);
    expect(t.git.isAncestor).toHaveBeenCalledWith(REPO, "dms-1", "origin/main");
    expect(t.outcome()).toBe("expired");
    expect(t.deliver).toHaveBeenCalledTimes(1);
    expect(t.deliver).toHaveBeenCalledWith("s-wait", M().gateNotMerged("DMS-1（支付）"), expect.any(Function));
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
  const cached = (state: "open" | "merged" | "closed", ci: "passing" | "unknown" = "passing") => vi.fn<(url: string) => Cached>(() => ({ state, ci }));

  it("releases as merged from a cached MERGED reading without asking gh", async () => {
    const cachedByUrl = cached("merged");
    const t = setup({ pr: () => pr("OPEN"), cachedByUrl });
    await t.watcher.check();
    expect(cachedByUrl).toHaveBeenCalledWith(PR_URL);
    expect(t.prInfo).not.toHaveBeenCalled();
    expect(t.outcome()).toBe("merged");
    expect(t.deliver).toHaveBeenCalledWith("s-wait", M().gateMergedNotice("DMS-1（支付）"), expect.any(Function));
  });

  it("cancels from a cached CLOSED reading without asking gh", async () => {
    const t = setup({ pr: () => pr("OPEN"), cachedByUrl: cached("closed") });
    await t.watcher.check();
    expect(t.prInfo).not.toHaveBeenCalled();
    expect(t.outcome()).toBe("cancelled");
  });

  it("asks gh when the cached reading failed (ci unknown): its state is only the last good one", async () => {
    const t = setup({ pr: () => pr("OPEN", true), cachedByUrl: cached("merged", "unknown") });
    await t.watcher.check();
    expect(t.prInfo).toHaveBeenCalledWith(REPO, PR_URL, 2000);
    expect(t.outcome()).toBeNull();
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
    expect(t.deliver).toHaveBeenCalledWith("s-wait", M().gateNotMerged("DMS-1（支付）"), expect.any(Function));
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
    expect(t.deliver).toHaveBeenCalledWith("s-wait", M().gateMergedNotice("DMS-1（支付）"), expect.any(Function));
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

  it("delivers each notice once when a Stop arrives while another notice is slow to deliver", async () => {
    const db = memDb();
    const repo = new MergeGateRepo(db);
    const id = repo.addHold({ repoPath: REPO, branch: "dms-1", target: "main", kind: "pr", prUrl: PR_URL, sessionId: "s-hold", ticketKey: "DMS-1", createdAt: 0 });
    repo.addWaiter({ holdId: id, sessionId: "s-slow", ticketKey: "DMS-2", branch: "dms-2", createdAt: 0 });
    repo.addWaiter({ holdId: id, sessionId: "s-fast", ticketKey: "DMS-3", branch: "dms-3", createdAt: 0 });
    const waiting: Record<string, boolean> = { "s-slow": true, "s-fast": false };
    let finishSlow: (r: "sent") => void = () => undefined;
    const deliver = vi.fn((sessionId: string) =>
      sessionId === "s-slow" ? new Promise<"sent">((done) => (finishSlow = done)) : Promise.resolve("sent" as const),
    );
    const watcher = new HoldWatcher({
      repo, prInfo: async () => pr("MERGED"), git: { isAncestor: async () => false, fetchQuiet: async () => true, upstreamRef: async (_r, b) => `origin/${b}` },
      isOpen: () => true,
      guard: { check: (s) => (waiting[s] ? { ok: true, termId: s, headId: s } : { ok: false, block: "busy" }), recheckAfter: () => () => true },
      deliver, whoOf: who, now: () => 0, log: () => undefined,
    });
    // 这一轮先卡在 s-slow 上，名单里还有忙着的 s-fast。
    const round = watcher.check();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith("s-slow", expect.any(String), expect.any(Function)));
    // s-fast 停下来了：Stop 把它的通知发掉。
    waiting["s-fast"] = true;
    await watcher.sessionIdle("s-fast");
    finishSlow("sent");
    await round;
    expect(deliver.mock.calls.map((c) => c[0]).sort()).toEqual(["s-fast", "s-slow"]);
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
