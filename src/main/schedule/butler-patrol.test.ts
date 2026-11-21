import { describe, expect, it } from "vitest";
import type { OpenButlerSessionRequest, OpenSessionResult, Session } from "../../shared/types";
import { JOB_PATROL, JobsRepo } from "../db/jobs-repo";
import type { SendInput } from "../mailbox/mailbox";
import { memDb } from "../test-utils";
import { ButlerPatrol } from "./butler-patrol";
import { atTime, localDate } from "./calendar";

const DAY = "2026-11-12";
const at = (h: number, m = 0) => atTime(DAY, h, m);

const butler = (id: string): Session => ({
  id, ticketKey: null, cwd: "/b", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null, waitingForInput: true, replacedBy: null,
  dismissed: false, createdAt: 1, repoId: null, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, model: null, butler: true, lessonRunId: null,
});

/** 巡检 9:00；running 是正在跑的 Butler 总控。sent 是排进信箱的，typed 是 opened 交进新终端的。 */
function setup(o: { time?: string; now?: number } = {}) {
  const jobs = new JobsRepo(memDb());
  const st = {
    time: o.time ?? "09:00",
    now: o.now ?? at(9, 1),
    running: null as Session | null,
    latest: null as Session | null,
    openResult: { ok: true, termId: "t-new", alreadyOpen: false } as OpenSessionResult,
    openedResult: true,
  };
  const opened: OpenButlerSessionRequest[] = [];
  const sent: SendInput[] = [];
  const withdrawn: string[] = [];
  const typed: [string, string][] = [];
  const logs: string[] = [];
  const patrol = new ButlerPatrol({
    time: () => st.time,
    jobs,
    now: () => st.now,
    running: () => st.running,
    latest: () => st.latest,
    open: async (req) => (opened.push(req), st.openResult),
    mailbox: { send: (x) => (sent.push(x), { id: "m", state: "busy" }), withdraw: (ref) => void withdrawn.push(ref) },
    headOf: (termId) => `head-of-${termId}`,
    opened: async (sessionId, termId) => (typed.push([sessionId, termId]), st.openedResult),
    message: () => "巡检一下",
    log: (m) => logs.push(m),
  });
  return { patrol, jobs, st, opened, sent, withdrawn, typed, logs };
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

  it("opens the latest Butler 总控 when none runs: queues the patrol for it first (held), then types it in as the first message; once a day", async () => {
    const { patrol, jobs, st, opened, sent, typed } = setup();
    st.latest = butler("b-old");
    await patrol.check();
    expect(sent).toEqual([{ kind: "patrol", from: null, to: "b-old", featureId: null, body: "巡检一下", ref: `patrol:${at(9)}`, hold: true }]);
    expect(opened).toEqual([{ sessionId: "b-old" }]);
    expect(typed).toEqual([["head-of-t-new", "t-new"]]);
    expect(jobs.get(JOB_PATROL)).toMatchObject({ lastRunAt: at(9, 1), lastStatus: "ok" });
    st.now = at(15);
    await patrol.check();
    expect(opened).toHaveLength(1);
    // 第二天到点再跑。
    st.now = atTime("2026-11-13", 9, 0);
    await patrol.check();
    expect(opened).toHaveLength(2);
  });

  it("starts a new conversation when there is none to resume, and queues for the new session once it is open", async () => {
    const { patrol, opened, sent, typed } = setup();
    await patrol.check();
    expect(opened).toEqual([{}]);
    expect(sent.map((x) => [x.to, x.hold])).toEqual([["head-of-t-new", true]]);
    expect(typed).toEqual([["head-of-t-new", "t-new"]]);
  });

  it("makes up a patrol the computer slept through, later the same day, but not yesterday's", async () => {
    const { patrol, jobs, st, sent } = setup({ now: at(13, 30) });
    jobs.record(JOB_PATROL, atTime("2026-11-10", 9, 0), "ok", null);
    await patrol.check();
    expect(sent).toHaveLength(1);
    expect(localDate(jobs.get(JOB_PATROL).lastRunAt!)).toBe(DAY);
    st.now = at(23, 59);
    await patrol.check();
    expect(sent).toHaveLength(1);
  });

  it("queues it for a running Butler 总控, busy or not, and counts the day as done", async () => {
    const { patrol, jobs, st, opened, sent } = setup();
    st.running = butler("b-1");
    await patrol.check();
    await patrol.check();
    expect(sent).toEqual([{ kind: "patrol", from: null, to: "b-1", featureId: null, body: "巡检一下", ref: `patrol:${at(9)}`, hold: false }]);
    expect(opened).toEqual([]);
    expect(jobs.get(JOB_PATROL)).toMatchObject({ lastRunAt: at(9, 1), lastStatus: "ok" });
  });

  it("a first message not typed in yet stays queued; the day still counts", async () => {
    const { patrol, jobs, st, opened, logs } = setup();
    st.openedResult = false;
    await patrol.check();
    await patrol.check();
    expect(opened).toHaveLength(1);
    expect(jobs.get(JOB_PATROL).lastStatus).toBe("ok");
    expect(logs.some((l) => l.includes("stays queued"))).toBe(true);
  });

  it("does not type into a Butler 总控 that something else opened meanwhile; queues it normally instead", async () => {
    const { patrol, jobs, st, sent, typed } = setup();
    st.latest = butler("b-1");
    st.openResult = { ok: true, termId: "t-b-1", alreadyOpen: true } as OpenSessionResult;
    await patrol.check();
    expect(typed).toEqual([]);
    expect(sent.map((x) => [x.to, x.hold])).toEqual([["b-1", true], ["head-of-t-b-1", false]]);
    expect(jobs.get(JOB_PATROL).lastStatus).toBe("ok");
  });

  it("gives up for the day when the session cannot be opened, and takes the queued patrol back", async () => {
    const missing = setup();
    missing.st.latest = butler("b-old");
    missing.st.openResult = { ok: false, reason: "claude_missing" };
    await missing.patrol.check();
    expect(missing.jobs.get(JOB_PATROL)).toMatchObject({ lastStatus: "failed", lastError: "claude_missing" });
    expect(missing.withdrawn).toEqual([`patrol:${at(9)}`]);
    await missing.patrol.check();
    expect(missing.opened).toHaveLength(1);
  });

  it("runs one check at a time: two that arrive together open once", async () => {
    const { patrol, typed, opened } = setup();
    await Promise.all([patrol.check(), patrol.check()]);
    expect(opened).toHaveLength(1);
    expect(typed).toHaveLength(1);
  });

  it("treats a run recorded far in the future (clock set back) as not today's", async () => {
    const { patrol, jobs, typed } = setup();
    jobs.record(JOB_PATROL, atTime("2026-12-01", 9, 0), "ok", null);
    await patrol.check();
    expect(typed).toHaveLength(1);
  });
});
