import { describe, expect, it } from "vitest";
import type { NowNotice } from "./types";
import { mostUrgent, noticeNeedsYou, ticketTurn, TURN_PRIORITY, type Turn } from "./turn";

const merge: Turn = { owner: "you", kind: "merge", risk: null };
const ask: Turn = { owner: "you", kind: "answer", question: "q", options: [], askId: 1, sessionId: "s" };
const ci: Turn = { owner: "external", kind: "ci_running", names: [] };
const fixing: Turn = { owner: "agent", kind: "fixing_ci", sessionId: "s" };
const merged: Turn = { owner: "done", kind: "merged" };
const stopped: Turn = { owner: "you", kind: "unattended", why: "agent_stopped", canSend: false, sessionId: "s" };

describe("ticketTurn", () => {
  it("returns idle with no input", () => {
    expect(ticketTurn([], null)).toEqual({ turn: { owner: "idle", kind: "not_started" }, others: 0 });
  });
  it("picks the most urgent PR and counts the other unmerged PRs", () => {
    expect(ticketTurn([ci, fixing, merged], null)).toEqual({ turn: fixing, others: 1 });
  });
  it("an answer outranks a mergeable PR (same owner, earlier kind)", () => {
    expect(ticketTurn([merge, ci], ask)).toEqual({ turn: ask, others: 2 });
  });
  it("ignores a stopped session while PRs exist, but uses it without PRs", () => {
    expect(ticketTurn([ci], stopped).turn).toBe(ci);
    expect(ticketTurn([], stopped).turn).toBe(stopped);
  });
  it("all PRs merged → done; caller-passed done without PRs → done", () => {
    expect(ticketTurn([merged, merged], null)).toEqual({ turn: merged, others: 0 });
    expect(ticketTurn([], merged).turn).toBe(merged);
  });
  it("keeps the index order of TURN_PRIORITY", () => {
    expect(TURN_PRIORITY).toEqual({ you: 0, agent: 1, external: 2, idle: 3, done: 4 });
  });
});

describe("mostUrgent", () => {
  it("is stable on ties and null on empty", () => {
    const a = { turn: ci, since: 1 }, b = { turn: { ...ci }, since: 2 };
    expect(mostUrgent([a, b])).toBe(a);
    expect(mostUrgent([])).toBeNull();
  });
});

describe("noticeNeedsYou", () => {
  const breaker = (state: "warned" | "downgraded" | "paused") => ({ kind: "cost", breaker: { state }, target: null }) as unknown as NowNotice;
  it("action notices count, info notices do not", () => {
    expect(noticeNeedsYou(breaker("paused"))).toBe(true);
    expect(noticeNeedsYou(breaker("warned"))).toBe(false);
    expect(noticeNeedsYou({ kind: "lessons_paused" })).toBe(false);
    expect(noticeNeedsYou({ kind: "check_promoted", eventId: 1, batchId: null, names: [], at: 0 })).toBe(false);
    expect(noticeNeedsYou({ kind: "approval", target: { page: "butler", sessionId: null }, title: null })).toBe(true);
    const stack = (reason: string) => ({ kind: "stack", stack: { reason }, target: null }) as unknown as NowNotice;
    expect(noticeNeedsYou(stack("conflict"))).toBe(true);
    expect(noticeNeedsYou(stack("behind"))).toBe(false);
    const intake = (state: string) => ({ kind: "intake", item: { state } }) as unknown as NowNotice;
    expect(noticeNeedsYou(intake("needs_decision"))).toBe(true);
    expect(noticeNeedsYou(intake("queued"))).toBe(false);
  });
});
