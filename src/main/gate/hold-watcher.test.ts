import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/database";
import { MergeGateRepo } from "../db/merge-gate-repo";
import { M } from "../strings";
import { memDb } from "../test-utils";
import type { PrInfo } from "../tickets/gh";
import { HoldWatcher, LOCAL_HOLD_MAX_MS, type HoldWatcherDeps } from "./hold-watcher";
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
  deliver?: () => Promise<"sent" | "exited" | "timeout">;
}

function setup(o: Opts = {}) {
  const db = o.db ?? memDb();
  if (!o.db) seed(db);
  const state = { now: 0, open: o.open ?? true, waiting: o.waiting ?? true };
  const repo = new MergeGateRepo(db);
  const prInfo = vi.fn(async () => (o.pr ? o.pr() : null));
  const git = {
    isAncestor: vi.fn(async (_repo: string, a: string, b: string) => o.ancestor?.(a, b) ?? false),
    fetchQuiet: vi.fn(async () => true),
    upstreamRef: vi.fn(async (_repo: string, b: string) => `origin/${b}`),
  };
  const deliver = vi.fn(o.deliver ?? (async () => "sent" as const));
  const logs: string[] = [];
  const deps: HoldWatcherDeps = {
    repo, prInfo, git,
    isOpen: () => state.open,
    isWaiting: () => state.waiting,
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
  it("cancels an open PR without auto-merge 31 s after the hold, and tells nobody", async () => {
    const t = setup({ pr: () => pr("OPEN") });
    t.state.now = 31_000;
    await t.watcher.check();
    expect(t.prInfo).toHaveBeenCalledWith(REPO, PR_URL, 2000);
    expect(t.outcome()).toBe("cancelled");
    expect(t.deliver).not.toHaveBeenCalled();
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

  it("marks a waiter whose session has closed as notified without sending anything", async () => {
    const t = setup({ pr: () => pr("MERGED"), open: false });
    await t.watcher.check();
    expect(t.deliver).not.toHaveBeenCalled();
    expect(t.repo.pendingNotices()).toEqual([]);
  });

  it("marks the waiter as notified when its terminal exits during delivery", async () => {
    const t = setup({ pr: () => pr("MERGED"), deliver: async () => "exited" });
    await t.watcher.check();
    expect(t.repo.pendingNotices()).toEqual([]);
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

  it("cancels a closed PR and tells nobody", async () => {
    const t = setup({ pr: () => pr("CLOSED") });
    await t.watcher.check();
    expect(t.outcome()).toBe("cancelled");
    expect(t.deliver).not.toHaveBeenCalled();
  });

  it("expires a hold 2 h + 1 ms old when gh cannot answer and the branch is not in the target", async () => {
    const t = setup({ pr: () => null, ancestor: () => false });
    t.state.now = HOLD_MAX_MS + 1;
    await t.watcher.check();
    expect(t.git.fetchQuiet).toHaveBeenCalledWith(REPO, "main", 2000);
    expect(t.git.isAncestor).toHaveBeenCalledWith(REPO, "dms-1", "origin/main");
    expect(t.outcome()).toBe("expired");
    expect(t.deliver).not.toHaveBeenCalled();
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
      isOpen: () => true, isWaiting: (s) => waiting[s] ?? false, deliver, whoOf: who, now: () => 0, log: () => undefined,
    });
    // 这一轮先卡在 s-slow 上，名单里还有忙着的 s-fast。
    const round = watcher.check();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith("s-slow", expect.any(String)));
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
