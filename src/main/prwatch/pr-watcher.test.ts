import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrWatchRepo, PrWatchRow } from "../db/pr-watch-repo";
import type { BranchRuns, CiCheck, PrStatus, branchRuns, failedLog, prStatus } from "../tickets/gh";
import { CI_LOG_LINES, PR_FAST_MS, PR_GH_TIMEOUT_MS, PR_SLOW_MS, PR_WATCH_MAX, PrWatcher, nextCheckAt, type PrTarget } from "./pr-watcher";

const target = (o: Partial<PrTarget> = {}): PrTarget => ({ ticketKey: "BTL-1", repoId: 1, repoPath: "/r", cwd: "/w", branch: "b", sessionOpen: true, ...o });
const check = (name: string, state: CiCheck["state"], runId: number | null = null): CiCheck => ({ name, state, runId });
const pr = (o: Partial<PrStatus> = {}): PrStatus => ({
  number: 7, url: "https://x/pull/7", state: "OPEN", isDraft: false, review: "pending", headSha: "a1", checks: [check("test", "pending", 9)], ci: "pending", ...o,
});
const row = (o: Partial<PrWatchRow> = {}): PrWatchRow => ({
  ticketKey: "BTL-1", repoId: 1, repoPath: "/r", branch: "b", number: 7, url: "https://x/pull/7", state: "open", review: "pending",
  ci: "pending", headSha: "a1", checkedAt: 1000, failed: [], deliveredKey: null, ...o,
});

/** 内存里的 pr_watch：和 PrWatchRepo 一样，upsert 不动 deliveredKey。 */
function fakeRepo() {
  const rows = new Map<number, PrWatchRow>();
  const repo = {
    rows,
    upsert(r: Omit<PrWatchRow, "deliveredKey">) {
      rows.set(r.repoId, { ...r, deliveredKey: rows.get(r.repoId)?.deliveredKey ?? null });
    },
    get: (id: number) => rows.get(id) ?? null,
    byTicket: (key: string) => [...rows.values()].filter((r) => r.ticketKey === key),
    all: () => [...rows.values()],
  };
  return repo as typeof repo & PrWatchRepo;
}

function setup(targets: PrTarget[] = [target()]) {
  let t = 1_000_000;
  const repo = fakeRepo();
  const gh = {
    prStatus: vi.fn<typeof prStatus>(async () => null),
    branchRuns: vi.fn<typeof branchRuns>(async () => null),
    failedLog: vi.fn<typeof failedLog>(async (_cwd, runId) => `log of ${runId}`),
  };
  const deps = {
    repo,
    targets: () => targets,
    gh,
    onPrChanged: vi.fn<(key: string) => void>(),
    onCiSettled: vi.fn<(r: PrWatchRow) => void>(),
    notify: vi.fn<() => void>(),
    now: () => t,
    log: vi.fn<(msg: string, err?: unknown) => void>(),
  };
  const w = new PrWatcher(deps);
  return { w, repo, gh, deps, advance: (ms: number) => (t += ms), now: () => t };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("nextCheckAt", () => {
  it("checks fast while checks run and the session is open, slow otherwise", () => {
    expect(nextCheckAt(null, true)).toBe(0);
    expect(nextCheckAt(null, false)).toBe(0);
    expect(nextCheckAt(row({ ci: "pending" }), true)).toBe(1000 + PR_FAST_MS);
    expect(nextCheckAt(row({ ci: "pending" }), false)).toBe(1000 + PR_SLOW_MS);
    expect(nextCheckAt(row({ ci: "passing" }), true)).toBe(1000 + PR_SLOW_MS);
    expect(nextCheckAt(row({ ci: "unknown" }), true)).toBe(1000 + PR_SLOW_MS);
    expect(nextCheckAt(row({ ci: "pending", state: null }), true)).toBe(1000 + PR_FAST_MS);
    expect(nextCheckAt(row({ state: "merged" }), true)).toBe(Infinity);
    expect(nextCheckAt(row({ state: "closed" }), false)).toBe(Infinity);
  });
});

describe("PrWatcher", () => {
  it("records the PR with lower-case state", async () => {
    const s = setup();
    s.gh.prStatus.mockResolvedValue(pr());
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledWith("/w", "b", PR_GH_TIMEOUT_MS);
    expect(s.gh.branchRuns).not.toHaveBeenCalled();
    expect(s.repo.get(1)).toMatchObject({ ticketKey: "BTL-1", repoPath: "/r", branch: "b", number: 7, url: "https://x/pull/7", state: "open", review: "pending", ci: "pending", headSha: "a1", checkedAt: s.now(), failed: [] });
  });

  it("falls back to branch runs when there is no PR", async () => {
    const s = setup();
    s.gh.branchRuns.mockResolvedValue({ headSha: "b2", checks: [check("ci", "passing", 3)], ci: "passing" } satisfies BranchRuns);
    await s.w.check();
    expect(s.gh.branchRuns).toHaveBeenCalledWith("/w", "b", PR_GH_TIMEOUT_MS);
    expect(s.repo.get(1)).toMatchObject({ number: null, url: null, state: null, review: null, ci: "passing", headSha: "b2" });
    expect(s.deps.onPrChanged).not.toHaveBeenCalled();
  });

  it("keeps old fields and marks ci unknown when gh fails", async () => {
    const s = setup();
    s.gh.prStatus.mockResolvedValueOnce(pr({ ci: "failing", checks: [check("test", "failing", 9)] }));
    await s.w.check();
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.repo.get(1)).toMatchObject({ number: 7, state: "open", review: "pending", headSha: "a1", ci: "unknown", checkedAt: s.now(), failed: [{ name: "test", log: "log of 9" }] });
    expect(s.deps.onPrChanged).toHaveBeenCalledTimes(1);
  });

  it("does not read a failed PR lookup as the PR being gone", async () => {
    const s = setup();
    s.gh.prStatus.mockResolvedValueOnce(pr());
    await s.w.check();
    s.gh.branchRuns.mockResolvedValue({ headSha: "a1", checks: [check("ci", "passing")], ci: "passing" });
    s.advance(PR_FAST_MS);
    await s.w.check();
    expect(s.gh.branchRuns).not.toHaveBeenCalled();
    expect(s.repo.get(1)).toMatchObject({ number: 7, state: "open", ci: "unknown" });
    expect(s.deps.onPrChanged).toHaveBeenCalledTimes(1);
  });

  it("treats a throwing gh call like a failed one", async () => {
    const s = setup();
    s.gh.prStatus.mockRejectedValue(new Error("boom"));
    await expect(s.w.check()).resolves.toBeUndefined();
    expect(s.repo.get(1)).toMatchObject({ ci: "unknown", state: null, number: null, headSha: null, failed: [] });
    expect(s.deps.log).toHaveBeenCalled();
  });

  it("calls onPrChanged when state or review changes", async () => {
    const s = setup();
    const step = async (p: PrStatus) => {
      s.gh.prStatus.mockResolvedValueOnce(p);
      s.advance(PR_SLOW_MS);
      await s.w.check();
    };
    await step(pr());
    expect(s.deps.onPrChanged).toHaveBeenCalledTimes(1);
    expect(s.deps.onPrChanged).toHaveBeenLastCalledWith("BTL-1");
    await step(pr({ ci: "passing", checks: [check("test", "passing", 9)] }));
    expect(s.deps.onPrChanged).toHaveBeenCalledTimes(1);
    await step(pr({ review: "approved" }));
    expect(s.deps.onPrChanged).toHaveBeenCalledTimes(2);
    await step(pr({ review: "approved", state: "MERGED" }));
    expect(s.deps.onPrChanged).toHaveBeenCalledTimes(3);
    expect(s.repo.get(1)?.state).toBe("merged");
  });

  it("calls onPrChanged once per ticket after all its repos are written", async () => {
    const s = setup([target({ repoId: 1, cwd: "/w1" }), target({ repoId: 2, cwd: "/w2" }), target({ ticketKey: "BTL-2", repoId: 3, cwd: "/w3" })]);
    const seen: number[] = [];
    s.deps.onPrChanged.mockImplementation((key) => seen.push(s.repo.byTicket(key).length));
    s.gh.prStatus.mockImplementation(async (cwd) => pr({ number: Number(cwd.slice(2)) }));
    await s.w.check();
    expect(s.deps.onPrChanged.mock.calls).toEqual([["BTL-1"], ["BTL-2"]]);
    expect(seen).toEqual([2, 1]);
  });

  it("calls onCiSettled once when checks finish", async () => {
    const s = setup();
    const step = async (p: PrStatus) => {
      s.gh.prStatus.mockResolvedValueOnce(p);
      s.advance(PR_SLOW_MS);
      await s.w.check();
    };
    await step(pr());
    expect(s.deps.onCiSettled).not.toHaveBeenCalled();
    await step(pr({ ci: "passing", checks: [check("test", "passing", 9)] }));
    expect(s.deps.onCiSettled).toHaveBeenCalledTimes(1);
    expect(s.deps.onCiSettled).toHaveBeenLastCalledWith(expect.objectContaining({ repoId: 1, ci: "passing", headSha: "a1", deliveredKey: null }));
    await step(pr({ ci: "passing", checks: [check("test", "passing", 9)] }));
    expect(s.deps.onCiSettled).toHaveBeenCalledTimes(1);
    // 新提交：先 pending 不算，结束了再算一次。
    await step(pr({ headSha: "a2" }));
    expect(s.deps.onCiSettled).toHaveBeenCalledTimes(1);
    await step(pr({ headSha: "a2", ci: "failing", checks: [check("test", "failing", 10)] }));
    expect(s.deps.onCiSettled).toHaveBeenCalledTimes(2);
    expect(s.deps.onCiSettled).toHaveBeenLastCalledWith(expect.objectContaining({ ci: "failing", headSha: "a2", failed: [{ name: "test", state: "failing", runId: 10, log: "log of 10" }] }));
  });

  it("calls onCiSettled for the first reading and for a new sha that is already finished", async () => {
    const s = setup();
    s.gh.prStatus.mockResolvedValueOnce(pr({ ci: "passing", checks: [check("test", "passing")] }));
    await s.w.check();
    expect(s.deps.onCiSettled).toHaveBeenCalledTimes(1);
    s.gh.prStatus.mockResolvedValueOnce(pr({ headSha: "a2", ci: "passing", checks: [check("test", "passing")] }));
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.deps.onCiSettled).toHaveBeenCalledTimes(2);
  });

  it("delivers again when the conclusion changes on the same sha", async () => {
    const s = setup();
    s.gh.prStatus.mockResolvedValueOnce(pr({ ci: "failing", checks: [check("test", "failing", 9)] }));
    await s.w.check();
    // re-run failed jobs：同一个 headSha 变成通过。
    s.gh.prStatus.mockResolvedValueOnce(pr({ ci: "passing", checks: [check("test", "passing", 9)] }));
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.deps.onCiSettled).toHaveBeenCalledTimes(2);
    expect(s.deps.onCiSettled.mock.calls.map(([r]) => r.ci)).toEqual(["failing", "passing"]);
    expect(s.repo.get(1)?.failed).toEqual([]);
  });

  it("fetches at most three failed logs", async () => {
    const s = setup();
    // a、b 是同一个 run 的两个 job：日志只取一次，挂在第一个上。
    const checks = [check("a", "failing", 1), check("b", "failing", 1), check("ok", "passing", 7), check("c", "failing", 2), check("d", "failing", 3), check("e", "failing", 4), check("f", "failing")];
    s.gh.prStatus.mockResolvedValueOnce(pr({ ci: "failing", checks }));
    s.gh.failedLog.mockImplementation(async (_cwd, runId) => (runId === 2 ? null : `log of ${runId}`));
    await s.w.check();
    expect(s.gh.failedLog.mock.calls).toEqual([
      ["/w", 1, CI_LOG_LINES, PR_GH_TIMEOUT_MS],
      ["/w", 2, CI_LOG_LINES, PR_GH_TIMEOUT_MS],
      ["/w", 3, CI_LOG_LINES, PR_GH_TIMEOUT_MS],
    ]);
    expect(s.repo.get(1)?.failed).toEqual([
      { name: "a", state: "failing", runId: 1, log: "log of 1" },
      { name: "b", state: "failing", runId: 1 },
      { name: "c", state: "failing", runId: 2 },
      { name: "d", state: "failing", runId: 3, log: "log of 3" },
      { name: "e", state: "failing", runId: 4 },
      { name: "f", state: "failing", runId: null },
    ]);
  });

  it("caps the number of watched branches, preferring open sessions", async () => {
    const targets = Array.from({ length: PR_WATCH_MAX + 5 }, (_, i) => target({ repoId: i + 1, cwd: `/w${i + 1}`, sessionOpen: i >= PR_WATCH_MAX }));
    const s = setup(targets);
    await s.w.check();
    const cwds = s.gh.prStatus.mock.calls.map(([cwd]) => cwd);
    expect(cwds).toHaveLength(PR_WATCH_MAX);
    for (let id = PR_WATCH_MAX + 1; id <= PR_WATCH_MAX + 5; id++) expect(cwds).toContain(`/w${id}`);
    expect(cwds).not.toContain(`/w${PR_WATCH_MAX}`);
  });

  it("runs at most four gh calls at once", async () => {
    const s = setup(Array.from({ length: 10 }, (_, i) => target({ repoId: i + 1, cwd: `/w${i + 1}` })));
    let active = 0;
    let peak = 0;
    const slow = async <T>(v: T): Promise<T> => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return v;
    };
    s.gh.prStatus.mockImplementation(() => slow(null));
    s.gh.branchRuns.mockImplementation(() => slow(null));
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(10);
    expect(s.gh.branchRuns).toHaveBeenCalledTimes(10);
    expect(peak).toBe(4);
  });

  it("only checks repos that are due", async () => {
    const s = setup([target({ repoId: 1, cwd: "/w1", sessionOpen: true }), target({ repoId: 2, cwd: "/w2", sessionOpen: false })]);
    s.gh.prStatus.mockResolvedValue(pr());
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(2);
    s.advance(PR_FAST_MS - 1);
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(2);
    s.advance(1);
    await s.w.check();
    expect(s.gh.prStatus.mock.calls.slice(2).map(([cwd]) => cwd)).toEqual(["/w1"]);
    s.advance(PR_SLOW_MS);
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(5);
  });

  it("stops checking a merged PR", async () => {
    const s = setup();
    s.gh.prStatus.mockResolvedValue(pr({ state: "MERGED" }));
    await s.w.check();
    s.advance(PR_SLOW_MS * 10);
    await s.w.check();
    expect(s.gh.prStatus).toHaveBeenCalledTimes(1);
  });

  it("notifies only when something changed", async () => {
    const s = setup();
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

  it("one round at a time", async () => {
    const s = setup();
    let release!: () => void;
    s.gh.prStatus.mockImplementation(() => new Promise((r) => (release = () => r(null))));
    const first = s.w.check();
    const second = s.w.check();
    await vi.waitFor(() => expect(s.gh.prStatus).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(s.gh.prStatus).toHaveBeenCalledTimes(1);
  });

  it("start runs a round now and then every tick; stop ends it", async () => {
    vi.useFakeTimers();
    const s = setup();
    s.gh.prStatus.mockResolvedValue(pr({ ci: "passing", checks: [check("test", "passing")] }));
    s.w.start(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.gh.prStatus).toHaveBeenCalledTimes(1);
    s.advance(PR_SLOW_MS);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.gh.prStatus).toHaveBeenCalledTimes(2);
    s.w.stop();
    s.advance(PR_SLOW_MS);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.gh.prStatus).toHaveBeenCalledTimes(2);
  });

  it("soon checks that repo within a second even when it is not due", async () => {
    vi.useFakeTimers();
    const s = setup([target({ repoId: 1, cwd: "/w1" }), target({ repoId: 2, cwd: "/w2" })]);
    s.gh.prStatus.mockResolvedValue(pr({ ci: "passing", checks: [check("test", "passing")] }));
    s.w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.gh.prStatus).toHaveBeenCalledTimes(2);
    s.w.soon(2);
    s.w.soon(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.gh.prStatus.mock.calls.slice(2).map(([cwd]) => cwd)).toEqual(["/w2"]);
    s.w.stop();
  });

  it("soon during a running round checks the repo right after it", async () => {
    vi.useFakeTimers();
    const s = setup();
    let release!: () => void;
    s.gh.prStatus.mockImplementationOnce(() => new Promise((r) => (release = () => r(pr({ ci: "passing", checks: [] })))));
    s.gh.prStatus.mockResolvedValue(pr({ ci: "passing", checks: [] }));
    s.w.start();
    await vi.advanceTimersByTimeAsync(0);
    s.w.soon(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.gh.prStatus).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.gh.prStatus).toHaveBeenCalledTimes(2);
    s.w.stop();
  });

  it("statusOf returns the ticket's rows without logs; cachedByUrl only fresh rows", async () => {
    const s = setup([target({ repoId: 1, cwd: "/w1" }), target({ ticketKey: "BTL-2", repoId: 2, cwd: "/w2" })]);
    s.gh.prStatus.mockImplementation(async (cwd) => (cwd === "/w1" ? pr({ ci: "failing", checks: [check("t", "failing", 9)] }) : pr({ number: 8, url: "https://x/pull/8" })));
    await s.w.check();
    const status = s.w.statusOf("BTL-1");
    expect(status).toEqual([{ ticketKey: "BTL-1", repoId: 1, repoPath: "/r", branch: "b", number: 7, url: "https://x/pull/7", state: "open", review: "pending", ci: "failing", headSha: "a1", checkedAt: s.now() }]);
    expect(s.w.cachedByUrl("https://x/pull/8")).toMatchObject({ repoId: 2, number: 8 });
    expect(s.w.cachedByUrl("https://x/pull/9")).toBeNull();
    s.advance(60_000);
    expect(s.w.cachedByUrl("https://x/pull/8")).not.toBeNull();
    s.advance(1);
    expect(s.w.cachedByUrl("https://x/pull/8")).toBeNull();
  });

  it("calls roundDone after every round, also when nothing was due or the round failed", async () => {
    const s = setup();
    const roundDone = vi.fn<() => void>();
    const w = new PrWatcher({ ...s.deps, roundDone });
    s.gh.prStatus.mockResolvedValue(pr({ ci: "passing", checks: [] }));
    await w.check();
    expect(roundDone).toHaveBeenCalledTimes(1);
    // 这次没有到期的仓库。
    await w.check();
    expect(roundDone).toHaveBeenCalledTimes(2);
    const broken = new PrWatcher({ ...s.deps, targets: () => { throw new Error("db closed"); }, roundDone });
    await broken.check();
    expect(roundDone).toHaveBeenCalledTimes(3);
  });

  it("a roundDone that throws only logs", async () => {
    const s = setup();
    const w = new PrWatcher({ ...s.deps, roundDone: () => { throw new Error("boom"); } });
    await expect(w.check()).resolves.toBeUndefined();
    expect(s.deps.log).toHaveBeenCalledWith("pr watch: roundDone failed", expect.any(Error));
  });

  it("stop before start does nothing, and start after it still works", async () => {
    vi.useFakeTimers();
    const s = setup();
    s.gh.prStatus.mockResolvedValue(pr({ ci: "passing", checks: [] }));
    expect(() => s.w.stop()).not.toThrow();
    s.w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.gh.prStatus).toHaveBeenCalledTimes(1);
    s.w.stop();
  });
});
