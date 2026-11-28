import { describe, expect, it } from "vitest";
import type { NowNotice } from "./types";
import type { SessionActivity } from "./activity";
import { mostUrgent, noticeNeedsYou, prChangesRequested, prTurn, REPORT_STOP_SLACK_MS, sessionTurn, slowestOf, type SessionTurnInput, ticketTurn, TURN_PRIORITY, type PrTurnInput, type Turn } from "./turn";

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

describe("slowestOf", () => {
  it("slowestOf picks the oldest active member, null below two", () => {
    expect(slowestOf([{ name: "A", owner: "agent", progressAt: 5 }, { name: "B", owner: "you", progressAt: 3 }, { name: "C", owner: "done", progressAt: 1 }])).toBe("B");
    expect(slowestOf([{ name: "A", owner: "agent", progressAt: 5 }, { name: "C", owner: "idle", progressAt: 1 }])).toBeNull();
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
    expect(noticeNeedsYou({ kind: "approval", target: { page: "shipherd", sessionId: null }, title: null })).toBe(true);
    const stack = (reason: string) => ({ kind: "stack", stack: { reason }, target: null }) as unknown as NowNotice;
    expect(noticeNeedsYou(stack("conflict"))).toBe(true);
    expect(noticeNeedsYou(stack("behind"))).toBe(false);
    // BTL-278：自动 rebase 要改写正在 review 的 PR，等你点「马上 rebase」
    expect(noticeNeedsYou(stack("confirm"))).toBe(true);
    // 冲突标记没推出去、认不出推到哪个 remote：都要你动手；被下面那层拦住的只是跟着那条（BTL-278）
    expect(noticeNeedsYou(stack("markers"))).toBe(true);
    expect(noticeNeedsYou(stack("no_push_remote"))).toBe(true);
    // 有层的 ticket 关掉了：整个栈停着，要你把它移出栈（BTL-278 复核）
    expect(noticeNeedsYou(stack("ticket_closed"))).toBe(true);
    expect(noticeNeedsYou(stack("held_below"))).toBe(false);
    const intake = (state: string) => ({ kind: "intake", item: { state } }) as unknown as NowNotice;
    expect(noticeNeedsYou(intake("needs_decision"))).toBe(true);
    expect(noticeNeedsYou(intake("queued"))).toBe(false);
    // 总控已代答（BTL-269 A2）：只是告诉你一声，可以改，但不算等你。
    expect(noticeNeedsYou({ kind: "behalf_answered", askId: 1, question: "q", answer: "a", by: "c", at: 0, target: { page: "shipherd", sessionId: null }, title: null })).toBe(false);
  });
});

const T = 1_000_000;
const pr = (o: Partial<PrTurnInput> = {}): PrTurnInput => ({
  state: "open", isDraft: false, ci: "passing", review: null, reviewers: [], reviewRequests: [], mergeable: "mergeable", mergeState: "blocked",
  mergeQueued: false, risk: null, pusher: { sessionId: "s", working: false, stoppedAt: T - 10 }, ciDeliveredAt: null, commentsDeliveredAt: null,
  ciUndelivered: false, canResendCi: true, canSendComments: false, stackBelow: null, ...o,
});

describe("prTurn", () => {
  it("merged → done, closed → null", () => {
    expect(prTurn(pr({ state: "merged" }))).toEqual({ owner: "done", kind: "merged" });
    expect(prTurn(pr({ state: "closed" }))).toBeNull();
  });
  it("ci failing with a working session → agent fixing_ci", () => {
    expect(prTurn(pr({ ci: "failing", pusher: { sessionId: "s", working: true, stoppedAt: null } }))).toEqual({ owner: "agent", kind: "fixing_ci", sessionId: "s" });
  });
  it("delivered and not stopped since → agent", () => {
    expect(prTurn(pr({ ci: "failing", ciDeliveredAt: T, pusher: { sessionId: "s", working: false, stoppedAt: T - 5 } }))?.owner).toBe("agent");
  });
  it("delivered then stopped → unattended", () => {
    expect(prTurn(pr({ ci: "failing", ciDeliveredAt: T, pusher: { sessionId: "s", working: false, stoppedAt: T + 5 } }))).toEqual({
      owner: "you", kind: "unattended", why: "ci_failing", canSend: true, sessionId: "s",
    });
  });
  it("no recipient → unattended, cannot send", () => {
    expect(prTurn(pr({ ci: "failing", pusher: null, canResendCi: false }))).toEqual({ owner: "you", kind: "unattended", why: "ci_failing", canSend: false, sessionId: null });
  });
  it("undelivered for 30 min → ci_undelivered", () => {
    expect(prTurn(pr({ ci: "failing", ciUndelivered: true }))).toMatchObject({ kind: "unattended", why: "ci_undelivered", canSend: true });
  });
  it("undelivered for 30 min stays yours even while the pusher is busy with something else", () => {
    expect(prTurn(pr({ ci: "failing", ciUndelivered: true, pusher: { sessionId: "s", working: true, stoppedAt: null } }))).toEqual({
      owner: "you", kind: "unattended", why: "ci_undelivered", canSend: true, sessionId: "s",
    });
  });
  it("changes requested: comments decide delivery and sendability", () => {
    const human = { login: "amy", state: "changes_requested" as const, at: 1, bot: false };
    expect(prTurn(pr({ reviewers: [human], canSendComments: false }))).toMatchObject({ why: "changes_requested", canSend: false });
    expect(prTurn(pr({ reviewers: [human], commentsDeliveredAt: T }))).toEqual({ owner: "agent", kind: "addressing_review", sessionId: "s" });
  });
  it("a failing CI on a draft is still a CI turn, undelivered included", () => {
    expect(prTurn(pr({ isDraft: true, ci: "failing" }))).toMatchObject({ owner: "you", why: "ci_failing", canSend: true });
    expect(prTurn(pr({ isDraft: true, ci: "failing", ciUndelivered: true }))).toMatchObject({ owner: "you", why: "ci_undelivered" });
    expect(prTurn(pr({ isDraft: true, ci: "failing", pusher: { sessionId: "s", working: true, stoppedAt: null } }))).toEqual({ owner: "agent", kind: "fixing_ci", sessionId: "s" });
  });
  it("an upper stack layer kept as a draft waits on the layer below; its failing CI still counts", () => {
    expect(prTurn(pr({ isDraft: true, stackBelow: "feature/E2E-1" }))).toEqual({ owner: "external", kind: "stack_below", names: ["feature/E2E-1"] });
    expect(prTurn(pr({ isDraft: true, stackBelow: "feature/E2E-1", ci: "failing" }))).toMatchObject({ owner: "you", why: "ci_failing" });
    // 不是 draft（已经改成 ready）时照常判
    expect(prTurn(pr({ stackBelow: "feature/E2E-1", reviewRequests: [{ kind: "user", name: "amy" }] }))).toMatchObject({ owner: "external", kind: "awaiting_review" });
  });
  it("draft / conflicts / behind map to their whys; conflicts with a working agent → rebasing", () => {
    expect(prTurn(pr({ isDraft: true }))).toMatchObject({ why: "draft", canSend: false });
    expect(prTurn(pr({ mergeable: "conflicting" }))).toMatchObject({ why: "conflicts" });
    expect(prTurn(pr({ mergeState: "behind" }))).toMatchObject({ why: "behind" });
    expect(prTurn(pr({ mergeState: "dirty", pusher: { sessionId: "s", working: true, stoppedAt: null } }))).toEqual({ owner: "agent", kind: "rebasing", sessionId: "s" });
  });
  it("after ready for review: ci pending, merge queue, awaiting review are external", () => {
    expect(prTurn(pr({ ci: "pending" }))).toEqual({ owner: "external", kind: "ci_running", names: [] });
    expect(prTurn(pr({ mergeQueued: true }))).toEqual({ owner: "external", kind: "merge_queue", names: [] });
    expect(prTurn(pr({ reviewRequests: [{ kind: "user", name: "bob" }] }))).toEqual({ owner: "external", kind: "awaiting_review", names: ["bob"] });
  });
  it("approved, or review not required and clean → merge with risk", () => {
    const ok = { login: "amy", state: "approved" as const, at: 1, bot: false };
    expect(prTurn(pr({ reviewers: [ok], review: "approved", mergeState: "clean", risk: "low" }))).toEqual({ owner: "you", kind: "merge", risk: "low" });
    expect(prTurn(pr({ review: null, mergeState: "clean" }))).toEqual({ owner: "you", kind: "merge", risk: null });
    expect(prTurn(pr({ reviewers: [ok], review: "approved", mergeState: "blocked" }))?.kind).not.toBe("merge");
  });
  it("nobody asked to review → no_reviewer", () => {
    expect(prTurn(pr({ review: "pending" }))).toMatchObject({ owner: "you", kind: "unattended", why: "no_reviewer", canSend: false });
  });
});

const N = 5_000_000;
const act = (o: Partial<SessionActivity> = {}) => ({ kind: "waiting", stuck: null, reason: null, startedAt: null, lastOutputAt: null, ...o }) as SessionTurnInput["activity"];
const ses = (o: Partial<SessionTurnInput> = {}): SessionTurnInput => ({
  sessionId: "s", target: { page: "ticket", key: "BTL-1", sessionId: "s" }, title: "登录", activity: act(), ask: null, needsYou: null,
  lastReport: null, refreshing: false, stoppedAt: N - 100, now: N, ...o,
});

describe("sessionTurn", () => {
  it("ask_user → answer with the inbox id, since = asked at", () => {
    expect(sessionTurn(ses({ ask: { id: 7, question: "用哪个库？", options: ["a", "b"], at: N - 50 } }))).toEqual({
      turn: { owner: "you", kind: "answer", question: "用哪个库？", options: ["a", "b"], askId: 7, sessionId: "s" }, since: N - 50,
    });
  });
  it("permission prompt → shipherd approval notice", () => {
    expect(sessionTurn(ses({ activity: act({ kind: "approval" }) })).turn).toEqual({
      owner: "you", kind: "shipherd", notice: { kind: "approval", target: { page: "ticket", key: "BTL-1", sessionId: "s" }, title: "登录" },
    });
  });
  it("a startup prompt (trust folder, new MCP server) → the approval notice marked startup (BTL-262 review)", () => {
    expect(sessionTurn(ses({ activity: act({ kind: "approval", prompt: "startup" }) })).turn).toEqual({
      owner: "you", kind: "shipherd", notice: { kind: "approval", target: { page: "ticket", key: "BTL-1", sessionId: "s" }, title: "登录", startup: true },
    });
  });
  it("only the four sources are stuck", () => {
    expect(sessionTurn(ses({ needsYou: { reason: "缺 API key", category: "missing_info" } })).turn).toMatchObject({ kind: "stuck", source: "needs_you", detail: "缺 API key" });
    expect(sessionTurn(ses({ activity: act({ kind: "command", stuck: true, reason: "20 分钟没输出" }) })).turn).toMatchObject({ kind: "stuck", source: "silent" });
    // 裁判的建议动作跟着走（卡片上原因下面一行）；其他来源没有。
    expect(sessionTurn(ses({ activity: act({ kind: "command", stuck: true, reason: "在等锁", action: "结束进程再重跑" }) })).turn).toMatchObject({ kind: "stuck", source: "silent", detail: "在等锁", action: "结束进程再重跑" });
    expect(sessionTurn(ses({ activity: act({ kind: "command", stuck: true, reason: "在等锁" }) })).turn).toMatchObject({ kind: "stuck", source: "silent", action: null });
    expect(sessionTurn(ses({ lastReport: { kind: "blocked", text: "测试环境挂了", at: N - 200 }, stoppedAt: N - 150 })).turn).toMatchObject({ kind: "stuck", source: "blocked_report" });
    // 不是卡住：普通提问、发完 blocked 又干了很久才停
    expect(sessionTurn(ses({ needsYou: { reason: "要不要拆 PR？", category: "question" } })).turn).toMatchObject({ kind: "answer", askId: null, options: [] });
    expect(sessionTurn(ses({ lastReport: { kind: "blocked", text: "x", at: N - REPORT_STOP_SLACK_MS - 200 }, stoppedAt: N - 100 })).turn).toMatchObject({ kind: "unattended", why: "agent_stopped" });
  });
  it("working or refreshing → agent working; stopped → unattended agent_stopped", () => {
    expect(sessionTurn(ses({ activity: act({ kind: "edit", startedAt: N - 9 }) }))).toEqual({ turn: { owner: "agent", kind: "working", sessionId: "s" }, since: N - 9 });
    expect(sessionTurn(ses({ refreshing: true })).turn).toEqual({ owner: "agent", kind: "working", sessionId: "s" });
    expect(sessionTurn(ses({ activity: null }))).toEqual({ turn: { owner: "you", kind: "unattended", why: "agent_stopped", canSend: false, sessionId: "s" }, since: N - 100 });
  });
});

describe("prChangesRequested", () => {
  const r = (login: string, state: "approved" | "changes_requested", bot = false) => ({ login, state, at: 1, bot });
  it("a human asking for changes counts, even after someone else approved", () => {
    expect(prChangesRequested({ review: null, reviewers: [r("a", "changes_requested"), r("b", "approved")] })).toBe(true);
  });
  it("review changes_requested with nobody approving counts; with a human approval it does not", () => {
    expect(prChangesRequested({ review: "changes_requested", reviewers: [] })).toBe(true);
    expect(prChangesRequested({ review: "changes_requested", reviewers: [r("b", "approved")] })).toBe(false);
  });
  it("bots and Copilot are not people asking for changes", () => {
    expect(prChangesRequested({ review: null, reviewers: [r("copilot", "changes_requested", true)] })).toBe(false);
  });
});
