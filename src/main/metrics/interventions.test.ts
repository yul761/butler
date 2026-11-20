import { describe, expect, it, vi } from "vitest";
import type { ActivityKind } from "../../shared/activity";
import { IPC, INVOKE_CHANNELS } from "../../shared/ipc";
import type { MergeHold } from "../db/merge-gate-repo";
import { MetricsRepo } from "../db/metrics-repo";
import { memDb } from "../test-utils";
import { Metrics } from "./events";
import {
  COUNTED_ELSEWHERE, isManualTrigger, KEY_DEDUPE_MS, MANUAL_TRIGGERS, mergeKind, NOT_TRIGGERS, noOpResult, promptOnTerminalChain, questionToolShowing,
  recordInvoke, recordMerges, TerminalInputMeter, unclassifiedChannels, type AnsweredWhat,
} from "./interventions";

function setup() {
  const repo = new MetricsRepo(memDb());
  let now = 1000;
  const m = new Metrics({ repo, now: () => now });
  const state = {
    inFlight: false,
    permission: false,
    kind: "waiting" as ActivityKind | null,
    waitingFor: null as AnsweredWhat | null,
    known: true,
    /** AskUserQuestion / ExitPlanMode 这类工具在跑（activity.startedAt 不为 null）。 */
    toolRunning: false,
    lookups: 0,
  };
  const meter = new TerminalInputMeter({
    record: m.recordEvent,
    now: () => now,
    session: (t) => {
      state.lookups++;
      return state.known ? { id: `head-${t}`, ticketKey: "T-1" } : null;
    },
    autoInputInFlight: () => state.inFlight,
    permissionShowing: () => state.permission,
    activity: () => (state.kind ? { kind: state.kind, startedAt: state.toolRunning ? 1 : null } : null),
    waitingFor: () => state.waitingFor,
  });
  return { repo, meter, state, tick: (ms: number) => (now += ms) };
}

describe("terminal_input: prompt (UserPromptSubmit)", () => {
  it("records a prompt the user typed", () => {
    const { repo, meter } = setup();
    expect(meter.promptSubmitted("t1")).toBe(true);
    expect(repo.events(0)[0]).toMatchObject({ kind: "terminal_input", sessionId: "head-t1", ticketKey: "T-1", data: { mode: "prompt" } });
  });

  it("does not count what Butler delivers (answers, reports, tasks, /handoff)", () => {
    const { repo, meter, state } = setup();
    state.inFlight = true;
    expect(meter.promptSubmitted("t1")).toBe(false);
    expect(repo.events(0)).toHaveLength(0);
  });

  it("tags what the prompt answered: an ask_user question or a needs-you stop", () => {
    const { repo, meter, state } = setup();
    state.waitingFor = "ask_user";
    meter.promptSubmitted("t1");
    state.waitingFor = "needs_you";
    meter.promptSubmitted("t1");
    expect(repo.events(0).map((e) => e.data.answered)).toEqual(["ask_user", "needs_you"]);
  });

  it("ignores terminals that are not Butler sessions", () => {
    const { repo, meter, state } = setup();
    state.known = false;
    expect(meter.promptSubmitted("t1")).toBe(false);
    expect(repo.events(0)).toHaveLength(0);
  });

  it("never throws: a failing lookup is logged and nothing is recorded", () => {
    const repo = new MetricsRepo(memDb());
    const log = vi.fn();
    const meter = new TerminalInputMeter({
      record: new Metrics({ repo, now: () => 1 }).recordEvent, now: () => 1, log,
      session: () => {
        throw new Error("db closed");
      },
      autoInputInFlight: () => false, permissionShowing: () => true, activity: () => null, waitingFor: () => null,
    });
    expect(meter.promptSubmitted("t1")).toBe(false);
    expect(meter.keys("t1", "\r")).toBe(false);
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe("promptOnTerminalChain", () => {
  const heads: Record<string, string> = { A: "A2", A2: "A2", N: "N" };
  const headOf = (id: string) => heads[id] ?? null;

  it("is the terminal's own claude, also after /clear moved the chain on", () => {
    expect(promptOnTerminalChain(headOf, "A", "A")).toBe(true);
    expect(promptOnTerminalChain(headOf, "A2", "A")).toBe(true);
  });

  it("is not a nested claude -p started inside the terminal, nor an unknown terminal", () => {
    expect(promptOnTerminalChain(headOf, "N", "A")).toBe(false);
    expect(promptOnTerminalChain(headOf, "A", "missing")).toBe(false);
  });
});

describe("terminal_input: dialog keys (pty:write)", () => {
  it("records Enter on a permission prompt as a permission answer", () => {
    const { repo, meter, state } = setup();
    state.permission = true;
    state.kind = "approval";
    expect(meter.keys("t1", "\r")).toBe(true);
    expect(repo.events(0)[0].data).toEqual({ mode: "dialog", answered: "permission" });
  });

  it("records a digit on AskUserQuestion / ExitPlanMode as a choice", () => {
    const { repo, meter, state } = setup();
    state.kind = "approval";
    state.toolRunning = true;
    expect(meter.keys("t1", "2")).toBe(true);
    expect(repo.events(0)[0].data).toEqual({ mode: "dialog", answered: "choice" });
  });

  it("does not take a stale approval left over from an answered permission prompt for a choice", () => {
    const { repo, meter, state } = setup();
    state.kind = "approval";
    state.toolRunning = false;
    expect(meter.keys("t1", "1")).toBe(false);
    expect(repo.events(0)).toHaveLength(0);
  });

  it("does not count keys while Butler is delivering into the terminal", () => {
    const { repo, meter, state } = setup();
    state.permission = true;
    state.inFlight = true;
    expect(meter.keys("t1", "\r")).toBe(false);
    expect(repo.events(0)).toHaveLength(0);
  });

  it("does not look anything up for keys that cannot be a dialog answer or an interrupt", () => {
    const { meter, state } = setup();
    for (const k of ["a", "hello", "\x1b[A", " "]) meter.keys("t1", k);
    expect(state.lookups).toBe(0);
  });

  it("counts one dialog answer per terminal within the dedupe window", () => {
    const { repo, meter, state, tick } = setup();
    state.kind = "approval";
    state.toolRunning = true;
    expect(meter.keys("t1", "1")).toBe(true);
    expect(meter.keys("t1", "\r")).toBe(false);
    expect(meter.keys("t2", "\r")).toBe(true);
    tick(KEY_DEDUPE_MS);
    expect(meter.keys("t1", "\r")).toBe(true);
    expect(repo.events(0)).toHaveLength(3);
  });

  it("ignores ordinary typing, arrows and keys outside a dialog", () => {
    const { repo, meter, state } = setup();
    state.kind = "approval";
    state.toolRunning = true;
    expect(meter.keys("t1", "hello")).toBe(false);
    expect(meter.keys("t1", "\x1b[B")).toBe(false);
    state.kind = "waiting";
    expect(meter.keys("t1", "\r")).toBe(false);
    expect(repo.events(0)).toHaveLength(0);
  });
});

describe("terminal_input: interrupt (Esc while working)", () => {
  it("records a bare Esc while the session is busy", () => {
    const { repo, meter, state } = setup();
    state.kind = "edit";
    expect(meter.keys("t1", "\x1b")).toBe(true);
    expect(repo.events(0)[0].data).toEqual({ mode: "interrupt" });
  });

  it("does not count Esc while idle or waiting", () => {
    const { meter, state } = setup();
    state.kind = "waiting";
    expect(meter.keys("t1", "\x1b")).toBe(false);
    state.kind = null;
    expect(meter.keys("t1", "\x1b")).toBe(false);
  });

  it("dedupes repeated Esc presses", () => {
    const { repo, meter, state } = setup();
    state.kind = "thinking";
    meter.keys("t1", "\x1b");
    meter.keys("t1", "\x1b");
    expect(repo.events(0)).toHaveLength(1);
  });
});

describe("manual_trigger channels", () => {
  it("classifies every invoke channel", () => {
    expect(unclassifiedChannels()).toEqual([]);
  });

  it("puts each channel in exactly one group", () => {
    for (const c of INVOKE_CHANNELS) {
      const groups = [MANUAL_TRIGGERS.has(c), COUNTED_ELSEWHERE.has(c), NOT_TRIGGERS.has(c)].filter(Boolean);
      expect(groups, c).toHaveLength(1);
    }
  });

  it("counts control-panel operations that push work and not reads or setup", () => {
    expect(isManualTrigger(IPC.sessionsOpen)).toBe(true);
    expect(isManualTrigger(IPC.sessionsRefresh)).toBe(true);
    expect(isManualTrigger(IPC.ciResend)).toBe(true);
    expect(isManualTrigger(IPC.nowView)).toBe(false);
    expect(isManualTrigger(IPC.settingsSet)).toBe(false);
    expect(isManualTrigger(IPC.inboxAnswer)).toBe(false);
  });
});

const hold = (o: Partial<MergeHold> = {}): MergeHold => ({
  id: 1, repoPath: "/r", branch: "b", target: "main", kind: "pr", prUrl: "https://github.com/o/r/pull/5", sessionId: "s",
  ticketKey: "T-1", createdAt: 100, releasedAt: 200, outcome: "merged", ...o,
});
const pr = { id: 9, ticketKey: "T-1", url: "https://github.com/o/r/pull/5", slug: "o/r", mergedAt: 150 };

describe("manual_trigger recording (successful invokes)", () => {
  const rec = () => {
    const repo = new MetricsRepo(memDb());
    return { repo, record: new Metrics({ repo, now: () => 5 }).recordEvent };
  };

  it("records triggers with the session or ticket they act on", () => {
    const { repo, record } = rec();
    expect(recordInvoke(record, IPC.sessionsWake, ["s9"], "woken")).toBe(true);
    expect(recordInvoke(record, IPC.handoffsRun, ["T-1"])).toBe(true);
    expect(recordInvoke(record, IPC.sessionsOpen, [{ ticketKey: "T-2", repoId: 1 }])).toBe(true);
    expect(recordInvoke(record, IPC.jobsRunNightly, [])).toBe(true);
    expect(repo.events(0).map((e) => [e.sessionId, e.ticketKey, e.data.channel])).toEqual([
      ["s9", null, IPC.sessionsWake], [null, "T-1", IPC.handoffsRun], [null, "T-2", IPC.sessionsOpen], [null, null, IPC.jobsRunNightly],
    ]);
  });

  it("does not count a trigger that did nothing: a wake that failed or was not needed, a refused refresh", () => {
    const { repo, record } = rec();
    expect(recordInvoke(record, IPC.sessionsWake, ["s9"], "failed")).toBe(false);
    expect(recordInvoke(record, IPC.sessionsWake, ["s9"], "cooldown")).toBe(false);
    expect(recordInvoke(record, IPC.sessionsWake, ["s9"], "not_hibernated")).toBe(false);
    expect(recordInvoke(record, IPC.sessionsRefresh, ["s9"], { ok: false, reason: "busy" })).toBe(false);
    expect(recordInvoke(record, IPC.sessionsRefresh, ["s9"], { ok: true })).toBe(true);
    expect(recordInvoke(record, IPC.sessionsWake, ["s9"], "woken")).toBe(true);
    expect(repo.events(0)).toHaveLength(2);
    expect(noOpResult(IPC.handoffsRun, undefined)).toBe(false);
  });

  it("counts a breaker continue-and-raise on its ticket or session, but not when nothing was tripped", () => {
    const { repo, record } = rec();
    expect(recordInvoke(record, IPC.costResume, [{ subjectKind: "ticket", subjectId: "T-3" }], { ok: true, cap: 10 })).toBe(true);
    expect(recordInvoke(record, IPC.costResume, [{ subjectKind: "session", subjectId: "root-1" }], { ok: true, cap: 10 })).toBe(true);
    expect(recordInvoke(record, IPC.costResume, [{ subjectKind: "ticket", subjectId: "T-3" }], { ok: false, reason: "not_tripped" })).toBe(false);
    expect(recordInvoke(record, IPC.costSet, [{}])).toBe(false);
    expect(recordInvoke(record, IPC.backgroundAct, [{ op: "pauseKind", kind: "backtest" }])).toBe(false);
    expect(repo.events(0).map((e) => [e.sessionId, e.ticketKey])).toEqual([[null, "T-3"], ["root-1", null]]);
  });

  it("counts a turn-board send to the agent on its ticket, not a refused one or reading the board", () => {
    const { repo, record } = rec();
    const target = { ticketKey: "T-4", pr: { repo: "acme/app", number: 7 } };
    expect(recordInvoke(record, IPC.turnSendToAgent, [target], { ok: true })).toBe(true);
    expect(recordInvoke(record, IPC.turnSendToAgent, [target], { ok: false, reason: "not_sendable" })).toBe(false);
    expect(recordInvoke(record, IPC.turnBoard, [null], { items: [] })).toBe(false);
    expect(repo.events(0).map((e) => [e.ticketKey, e.data])).toEqual([["T-4", { channel: IPC.turnSendToAgent }]]);
  });

  it("counts sending or re-replying a comment, not recategorising or dismissing it", () => {
    const { repo, record } = rec();
    const view = { id: 1 };
    expect(recordInvoke(record, IPC.loopCommentsAct, [{ op: "send", id: 1 }], view)).toBe(true);
    expect(recordInvoke(record, IPC.loopCommentsAct, [{ op: "reply", id: 1 }], view)).toBe(true);
    expect(recordInvoke(record, IPC.loopCommentsAct, [{ op: "send", id: 2 }], null)).toBe(false);
    expect(recordInvoke(record, IPC.loopCommentsAct, [{ op: "categorize", id: 1, category: "fix" }], view)).toBe(false);
    expect(recordInvoke(record, IPC.loopCommentsAct, [{ op: "dismiss", id: 1 }], view)).toBe(false);
    expect(recordInvoke(record, IPC.loopPolicySet, [{}])).toBe(false);
    expect(repo.events(0)).toHaveLength(2);
  });

  it("ignores reads, setup and channels counted as needs_you_answer", () => {
    const { repo, record } = rec();
    expect(recordInvoke(record, IPC.ticketsList, [])).toBe(false);
    expect(recordInvoke(record, IPC.settingsSet, ["k", "v"])).toBe(false);
    expect(recordInvoke(record, IPC.inboxAnswer, [1, "A"])).toBe(false);
    expect(repo.events(0)).toHaveLength(0);
  });
});

describe("manual_merge / agent_merge", () => {
  it("is an agent merge when a session's gh pr merge took a hold for the PR that was released as merged", () => {
    expect(mergeKind(pr, [hold()])).toBe("agent");
    expect(mergeKind(pr, [hold({ prUrl: "https://github.com/o/r/pull/5/" })])).toBe("agent");
  });

  it("is not judged yet while the hold is still held (占位未释放先不判断)", () => {
    expect(mergeKind(pr, [hold({ outcome: null, releasedAt: null })])).toBe("pending");
    expect(mergeKind(pr, [hold({ outcome: null, releasedAt: null }), hold({ id: 2 })])).toBe("agent");
  });

  it("matches an agent's local git merge + push by head branch and ticket or repo", () => {
    const local = (o: Partial<MergeHold> = {}) => hold({ kind: "local", prUrl: null, branch: "feat/x", ...o });
    const withBranch = { ...pr, headBranch: "feat/x", repoPath: "/r" };
    expect(mergeKind(withBranch, [local()])).toBe("agent");
    expect(mergeKind(withBranch, [local({ ticketKey: null })])).toBe("agent");
    expect(mergeKind(withBranch, [local({ ticketKey: "T-9", repoPath: "/other" })])).toBe("manual");
    expect(mergeKind(withBranch, [local({ branch: "feat/y" })])).toBe("manual");
    expect(mergeKind(pr, [local()])).toBe("manual");
  });

  it("is a manual merge without a hold, with only a cancelled or expired one, or a hold taken after the merge", () => {
    expect(mergeKind(pr, [])).toBe("manual");
    expect(mergeKind(pr, [hold({ outcome: "cancelled" })])).toBe("manual");
    expect(mergeKind(pr, [hold({ outcome: "expired" })])).toBe("manual");
    expect(mergeKind(pr, [hold({ createdAt: 500 })])).toBe("manual");
    expect(mergeKind(pr, [hold({ prUrl: "https://github.com/o/r/pull/6" })])).toBe("manual");
  });

  it("records each merged PR once, at its merge time", () => {
    const repo = new MetricsRepo(memDb());
    const m = new Metrics({ repo, now: () => 999 });
    expect(recordMerges([pr, { ...pr, id: 10, url: "https://github.com/o/r/pull/7" }], [hold()], m.recordEvent)).toBe(2);
    expect(recordMerges([pr], [], m.recordEvent)).toBe(0);
    const evs = repo.events(0);
    expect(evs.map((e) => [e.kind, e.prId, e.at])).toEqual([["agent_merge", 9, 150], ["manual_merge", 10, 150]]);
  });

  it("records nothing for a PR whose hold is still held, and decides it once the hold is released", () => {
    const repo = new MetricsRepo(memDb());
    const m = new Metrics({ repo, now: () => 999 });
    expect(recordMerges([pr], [hold({ outcome: null, releasedAt: null })], m.recordEvent)).toBe(0);
    expect(recordMerges([pr], [hold()], m.recordEvent)).toBe(1);
    expect(repo.events(0).map((e) => e.kind)).toEqual(["agent_merge"]);
  });
});

describe("questionToolShowing", () => {
  it("is an approval with a running tool, not a bare approval (a permission prompt or one just answered)", () => {
    expect(questionToolShowing({ kind: "approval", startedAt: 5 })).toBe(true);
    expect(questionToolShowing({ kind: "approval", startedAt: null })).toBe(false);
    expect(questionToolShowing({ kind: "edit", startedAt: 5 })).toBe(false);
    expect(questionToolShowing(null)).toBe(false);
  });
});
