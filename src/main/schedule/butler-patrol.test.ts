import { describe, expect, it } from "vitest";
import type { OpenButlerSessionRequest, OpenSessionResult, Session } from "../../shared/types";
import { JOB_PATROL, JobsRepo } from "../db/jobs-repo";
import type { DeliverResult } from "../sessions/pty-manager";
import type { DeliveryBlock } from "../sessions/delivery-guard";
import { memDb } from "../test-utils";
import { ButlerPatrol } from "./butler-patrol";
import { atTime, localDate } from "./calendar";

const DAY = "2026-11-12";
const at = (h: number, m = 0) => atTime(DAY, h, m);

const butler = (id: string): Session => ({
  id, ticketKey: null, cwd: "/b", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null, waitingForInput: true, replacedBy: null,
  dismissed: false, createdAt: 1, repoId: null, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, epicId: null, model: null, butler: true,
});

/** 巡检 9:00；running 是正在跑的 Butler 总控，block 是 guard 的结果。 */
function setup(o: { time?: string; now?: number } = {}) {
  const jobs = new JobsRepo(memDb());
  const st = {
    time: o.time ?? "09:00",
    now: o.now ?? at(9, 1),
    running: null as Session | null,
    latest: null as Session | null,
    block: null as DeliveryBlock | null,
    openResult: { ok: true, termId: "t-new", alreadyOpen: false } as OpenSessionResult,
    deliverResult: "sent" as DeliverResult,
    submitResult: "sent" as DeliverResult,
  };
  const opened: OpenButlerSessionRequest[] = [];
  const delivered: [string, string][] = [];
  const submitted: [string, string][] = [];
  const logs: string[] = [];
  const patrol = new ButlerPatrol({
    time: () => st.time,
    jobs,
    now: () => st.now,
    running: () => st.running,
    latest: () => st.latest,
    open: async (req) => (opened.push(req), st.openResult),
    guard: {
      check: (id) => (st.block ? { ok: false, block: st.block } : { ok: true, termId: `t-${id}`, headId: id }),
      recheckAfter: () => () => true,
    },
    deliver: async (termId, text) => (delivered.push([termId, text]), st.deliverResult),
    submit: async (termId, text) => (submitted.push([termId, text]), st.submitResult),
    message: () => "巡检一下",
    log: (m) => logs.push(m),
  });
  return { patrol, jobs, st, opened, delivered, submitted, logs };
}

describe("ButlerPatrol (BTL-190 5)", () => {
  it("does nothing while it is off or before today's time", async () => {
    const off = setup({ time: "" });
    await off.patrol.check();
    expect(off.opened).toEqual([]);
    expect(off.jobs.get(JOB_PATROL).lastRunAt).toBeNull();
    const early = setup({ now: at(8, 59) });
    await early.patrol.check();
    expect(early.opened).toEqual([]);
  });

  it("opens the latest Butler 总控 when none runs, gives it the patrol as its first message, and runs once a day", async () => {
    const { patrol, jobs, st, opened, submitted } = setup();
    st.latest = butler("b-old");
    await patrol.check();
    expect(opened).toEqual([{ sessionId: "b-old" }]);
    expect(submitted).toEqual([["t-new", "巡检一下"]]);
    expect(jobs.get(JOB_PATROL)).toMatchObject({ lastRunAt: at(9, 1), lastStatus: "ok" });
    st.now = at(15);
    await patrol.check();
    expect(opened).toHaveLength(1);
    // 第二天到点再跑。
    st.now = atTime("2026-11-13", 9, 0);
    await patrol.check();
    expect(opened).toHaveLength(2);
  });

  it("starts a new conversation when there is none to resume", async () => {
    const { patrol, opened } = setup();
    await patrol.check();
    expect(opened).toEqual([{}]);
  });

  it("makes up a patrol the computer slept through, later the same day, but not yesterday's", async () => {
    const { patrol, jobs, st, submitted } = setup({ now: at(13, 30) });
    jobs.record(JOB_PATROL, atTime("2026-11-10", 9, 0), "ok", null);
    await patrol.check();
    expect(submitted).toHaveLength(1);
    expect(localDate(jobs.get(JOB_PATROL).lastRunAt!)).toBe(DAY);
    st.now = at(23, 59);
    await patrol.check();
    expect(submitted).toHaveLength(1);
  });

  it("sends to a running Butler 总控 through the delivery guard, and waits while it is busy", async () => {
    const { patrol, jobs, st, opened, delivered } = setup();
    st.running = butler("b-1");
    st.block = "busy";
    await patrol.check();
    await patrol.check();
    expect(delivered).toEqual([]);
    expect(opened).toEqual([]);
    expect(jobs.get(JOB_PATROL).lastRunAt).toBeNull();
    st.block = null;
    st.now = at(9, 20);
    await patrol.check();
    expect(delivered).toEqual([["t-b-1", "巡检一下"]]);
    expect(jobs.get(JOB_PATROL)).toMatchObject({ lastRunAt: at(9, 20), lastStatus: "ok" });
  });

  it("tries again when the paste did not go through", async () => {
    const { patrol, jobs, st, delivered } = setup();
    st.running = butler("b-1");
    st.deliverResult = "blocked";
    await patrol.check();
    expect(jobs.get(JOB_PATROL).lastRunAt).toBeNull();
    st.deliverResult = "sent";
    await patrol.check();
    expect(delivered).toHaveLength(2);
    expect(jobs.get(JOB_PATROL).lastStatus).toBe("ok");
  });

  it("opens at most once per day: a first message that did not land goes through the guard next time", async () => {
    const { patrol, jobs, st, opened, submitted, delivered } = setup();
    st.submitResult = "timeout";
    await patrol.check();
    expect(submitted).toHaveLength(1);
    expect(jobs.get(JOB_PATROL).lastRunAt).toBeNull();
    // 开好了，还在跑：走 guard。
    st.running = butler("b-new");
    await patrol.check();
    expect(delivered).toEqual([["t-b-new", "巡检一下"]]);
    expect(opened).toHaveLength(1);
  });

  it("does not paste into a Butler 总控 that something else opened meanwhile; it goes through the guard next time", async () => {
    const { patrol, jobs, st, opened, submitted, delivered } = setup();
    st.openResult = { ok: true, termId: "t-b-1", alreadyOpen: true } as OpenSessionResult;
    await patrol.check();
    expect(opened).toHaveLength(1);
    expect(submitted).toEqual([]);
    expect(jobs.get(JOB_PATROL).lastRunAt).toBeNull();
    st.running = butler("b-1");
    st.block = "typing";
    await patrol.check();
    expect(delivered).toEqual([]);
    st.block = null;
    await patrol.check();
    expect(delivered).toEqual([["t-b-1", "巡检一下"]]);
    expect(jobs.get(JOB_PATROL).lastStatus).toBe("ok");
  });

  it("gives up for the day when the session it opened is closed before the patrol landed, or cannot be opened", async () => {
    const closed = setup();
    closed.st.submitResult = "exited";
    await closed.patrol.check();
    await closed.patrol.check();
    expect(closed.opened).toHaveLength(1);
    expect(closed.jobs.get(JOB_PATROL)).toMatchObject({ lastStatus: "failed" });

    const missing = setup();
    missing.st.openResult = { ok: false, reason: "claude_missing" };
    await missing.patrol.check();
    expect(missing.jobs.get(JOB_PATROL)).toMatchObject({ lastStatus: "failed", lastError: "claude_missing" });
    await missing.patrol.check();
    expect(missing.opened).toHaveLength(1);
  });

  it("runs one check at a time: two that arrive together open once", async () => {
    const { patrol, submitted, opened } = setup();
    await Promise.all([patrol.check(), patrol.check()]);
    expect(opened).toHaveLength(1);
    expect(submitted).toHaveLength(1);
  });

  it("treats a run recorded far in the future (clock set back) as not today's", async () => {
    const { patrol, jobs, submitted } = setup();
    jobs.record(JOB_PATROL, atTime("2026-12-01", 9, 0), "ok", null);
    await patrol.check();
    expect(submitted).toHaveLength(1);
  });
});
