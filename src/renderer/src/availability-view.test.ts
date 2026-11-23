import { describe, expect, it } from "vitest";
import { S, STRINGS } from "./strings";
import { availabilityButtons, availabilityRows, ciReasonText, limitLine, noticeText, openCommentsNotice, resetClock } from "./availability-view";
import { pickTab } from "./page-tabs";
import { TICKET_TABS } from "./ticket-tabs";

describe("availability view", () => {
  it("resetClock same day and other day", () => {
    const now = new Date(2026, 9, 31, 9, 5).getTime();
    expect(resetClock(new Date(2026, 9, 31, 14, 30).getTime(), now)).toBe("14:30");
    expect(resetClock(new Date(2026, 10, 1, 2, 7).getTime(), now)).toBe("11/1 02:07");
  });

  it("limitLine names the kind, with the reset when known", () => {
    const now = new Date(2026, 9, 31, 9, 5).getTime();
    const at = new Date(2026, 9, 31, 14, 30).getTime();
    expect(limitLine({ kind: "usage_limit", resetsAt: at, message: "m" }, S, now)).toBe("用量已达上限，14:30 恢复");
    expect(limitLine({ kind: "overloaded", resetsAt: null, message: "m" }, S, now)).toBe("Claude 繁忙");
  });
});

describe("noticeText", () => {
  it("routing notice", () => {
    expect(noticeText({ kind: "routing", limited: ["H", "M"], fallbacks: 3 }, STRINGS.en, 0)).toEqual({ text: "Models limited: H, M · 3 fallbacks in the last hour", actions: ["routing"] });
    expect(noticeText({ kind: "routing", limited: [], fallbacks: 1 }, STRINGS.en, 0).text).toBe("1 fallback in the last hour");
  });
  const now = new Date(2026, 9, 31, 9, 5).getTime();
  const at = new Date(2026, 9, 31, 14, 30).getTime();
  const hit = { kind: "usage_limit" as const, resetsAt: at, message: "m", at: 1, source: "headless" as const, job: null, sessionId: null };

  it("texts and actions for each kind", () => {
    expect(noticeText({ kind: "claude_limited", hit, retryAt: at, lessonsPaused: true }, S, now)).toEqual({ text: "Claude 用量已达上限，14:30 恢复，复盘已暂停", actions: ["resume", "health"] });
    expect(noticeText({ kind: "claude_limited", hit, retryAt: at, lessonsPaused: false }, S, now).text).toBe("Claude 用量已达上限，14:30 恢复");
    expect(noticeText({ kind: "model_unavailable", hit: { ...hit, kind: "model_unavailable", resetsAt: null }, retryAt: null }, S, now)).toEqual({ text: "复盘用的模型不可用：模型不可用，Shipherd 会稍后重试", actions: ["retry", "health"] });
    expect(noticeText({ kind: "lessons_paused" }, S, now)).toEqual({ text: "复盘队列已手动暂停", actions: ["resume"] });
    expect(noticeText({ kind: "lessons_failing", count: 4 }, S, now)).toEqual({ text: "复盘连续 4 次分析失败", actions: ["lessons"] });
    expect(noticeText({ kind: "shared_mcp_failed", error: "exited (1)" }, S, now).text).toMatch(/共享 MCP 起不来（exited \(1\)）/);
    const target = { page: "ticket" as const, key: "A-1", sessionId: "s" };
    expect(noticeText({ kind: "session_limited", target, title: "通知中心", limit: hit }, S, now)).toEqual({ text: "通知中心：用量已达上限，14:30 恢复", actions: ["open"] });
    expect(noticeText({ kind: "session_limited", target, title: null, limit: hit }, S, now).text).toBe("用量已达上限，14:30 恢复");
  });
});

describe("availabilityRows", () => {
  const now = new Date(2026, 9, 31, 9, 5).getTime();
  const at = new Date(2026, 9, 31, 14, 30).getTime();
  const hit = { kind: "usage_limit" as const, resetsAt: at, message: "limit msg", at: new Date(2026, 9, 31, 9, 0).getTime(), source: "headless" as const, job: "lessons", sessionId: null };

  it("for ok shows only state", () => {
    const rows = availabilityRows({ state: "ok", current: null, lastHit: null, retryAt: null, lessonsPause: null }, S, now);
    expect(rows).toEqual([["状态", "正常", "ok", true]]);
  });

  it("for a usage limit shows current, retry time and paused lessons", () => {
    const rows = availabilityRows({ state: "limited", current: hit, lastHit: hit, retryAt: at, lessonsPause: { reason: "limit", since: 1, until: at } }, S, now);
    expect(rows).toEqual([
      ["状态", "受限", "warn", true],
      ["当前", "用量已达上限 · 09:00 · 后台 · lessons · limit msg", "warn", false],
      ["重试时间", "14:30", "muted", true],
      ["上次受限", "用量已达上限 · 09:00", "muted", true],
      ["复盘队列", "暂停到 14:30", "warn", true],
    ]);
  });

  it("a session hit names the source", () => {
    const rows = availabilityRows({ state: "limited", current: { ...hit, source: "session", job: null, sessionId: "s" }, lastHit: null, retryAt: null, lessonsPause: null }, S, now);
    expect(rows[1][1]).toContain("会话");
    expect(rows[1][1]).not.toContain("后台");
    expect(rows[2]).toEqual(["复盘队列", "运行中", "ok", true]);
  });

  it("a manual pause shows paused by you and no time", () => {
    const rows = availabilityRows({ state: "ok", current: null, lastHit: null, retryAt: null, lessonsPause: { reason: "manual", since: 1, until: null } }, S, now);
    expect(rows[1]).toEqual(["复盘队列", "已手动暂停", "muted", true]);
  });

  it("current row shows the hit time, tone follows state, empty message is omitted", () => {
    const rows = availabilityRows({ state: "model_unavailable", current: { ...hit, kind: "model_unavailable", resetsAt: null, message: "  " }, lastHit: null, retryAt: null, lessonsPause: null }, S, now);
    expect(rows[1]).toEqual(["当前", "模型不可用 · 09:00 · 后台 · lessons", "danger", false]);
  });

  it("a pause without an end time says just paused", () => {
    const rows = availabilityRows({ state: "limited", current: hit, lastHit: null, retryAt: null, lessonsPause: { reason: "limit", since: 1, until: null } }, S, now);
    expect(rows[rows.length - 1]).toEqual(["复盘队列", "已暂停", "warn", true]);
  });

  it("buttons follow pause and current", () => {
    expect(availabilityButtons({ state: "ok", current: null, lastHit: null, retryAt: null, lessonsPause: null })).toEqual({ resume: false, pause: true });
    expect(availabilityButtons({ state: "ok", current: null, lastHit: null, retryAt: null, lessonsPause: { reason: "manual", since: 1, until: null } })).toEqual({ resume: true, pause: false });
    expect(availabilityButtons({ state: "limited", current: hit, lastHit: hit, retryAt: at, lessonsPause: { reason: "limit", since: 1, until: at } })).toEqual({ resume: true, pause: true });
  });
});

describe("ci_undelivered notice", () => {
  it("names the PR or branch, how long it has waited and why, with resend and open", () => {
    const ci = { item: { kind: "pr" as const, id: 3 }, ticketKey: "T-1", number: 34, branch: "feat/a", reason: "owner_closed" as const, since: 0, sessionId: "s1" };
    const target = { page: "ticket" as const, key: "T-1", sessionId: "s1" };
    expect(noticeText({ kind: "ci_undelivered", ci, target, title: null }, S, 35 * 60_000)).toEqual({
      text: "CI 结果未能送达：T-1 PR #34（feat/a），已等 35 分钟（推这个分支的会话已关闭）", actions: ["resend", "open"],
    });
    expect(noticeText({ kind: "ci_undelivered", ci: { ...ci, number: null, item: { kind: "branch", repoId: 2 }, reason: "unowned" }, target, title: null }, S, 31 * 60_000).text).toBe(
      "CI 结果未能送达：T-1 分支 feat/a，已等 31 分钟（认不出是哪个会话的）",
    );
  });

  it("every reason has words; unknown ones pass through", () => {
    for (const r of ["unowned", "failed", "no_repo", "no_sha", "no_session", "owner_closed", "not_open", "not_settled"]) {
      expect(ciReasonText(r, S)).not.toContain("原因：");
    }
    // 4.0 之前的原因（guard:*）已经不会再出现，出现了也原样带过。
    expect(ciReasonText("guard:typing", S)).toBe("原因：guard:typing");
    expect(ciReasonText("toString", S)).toBe("原因：toString");
  });
});

describe("cost notice (workstream L)", () => {
  const breaker = {
    subjectKind: "session" as const, subjectId: "r", sessionId: "h", ticketKey: "T-1", title: "fix", state: "paused" as const, spent: 12, cap: 10, unit: "usd" as const,
    partial: false, pauseScope: "session" as const, fromModel: null, toModel: null, trippedAt: 1, pausedAt: 2, stoppedAt: null, takenOver: false,
  };
  const target = { page: "ticket" as const, key: "T-1", sessionId: "h" };
  it("a tripped breaker offers continue-and-raise and open; a warning only opens", () => {
    expect(noticeText({ kind: "cost", breaker, target }, STRINGS.zh, 0)).toEqual({ text: "session「fix」 花到了上限（$12.0 / $10.0），已暂停", actions: ["raise", "open"] });
    expect(noticeText({ kind: "cost", breaker: { ...breaker, state: "warned" }, target }, STRINGS.en, 0).actions).toEqual(["open"]);
    expect(noticeText({ kind: "cost", breaker, target: null }, STRINGS.en, 0).actions).toEqual(["raise"]);
  });
});

describe("comments_waiting notice", () => {
  const target = { page: "ticket" as const, key: "T-3", sessionId: null };
  it("says how many comments wait for you, or how long they have waited to be sent", () => {
    const w = { reason: "review" as const, ticketKey: "T-3", prId: 1, number: 12, count: 2, since: 0 };
    expect(noticeText({ kind: "comments_waiting", waiting: w, target, title: null }, S, 0)).toEqual({ text: S.lp.noticeReview(S.lp.noticePr("T-3", 12), 2), actions: ["comments"] });
    expect(noticeText({ kind: "comments_waiting", waiting: { ...w, reason: "undelivered" }, target, title: null }, S, 45 * 60_000).text).toBe(S.lp.noticeUndelivered(S.lp.noticePr("T-3", 12), 2, 45));
  });
  it("opening it lands the ticket page on PR details (where the comments are now), not on the terminal", () => {
    const w = { reason: "review" as const, ticketKey: "T-3", prId: 1, number: 12, count: 2, since: 0 };
    const saved = new Map<string, string>();
    const opened: unknown[] = [];
    // 就算 target 带着 session，也不能带进去：带 session 进 ticket 页会被打开请求拉到终端。
    openCommentsNotice({ kind: "comments_waiting", waiting: w, target: { ...target, sessionId: "s-1" }, title: null }, {
      saveTab: (page, tab) => saved.set(page, tab), onOpen: (t) => opened.push(t),
    });
    expect(saved.get("ticket:T-3")).toBe("pr");
    expect(pickTab(saved.get("ticket:T-3") ?? null, TICKET_TABS, "overview")).toBe("pr");
    expect(opened).toEqual([{ page: "ticket", key: "T-3", sessionId: null }]);
  });
});

describe("stack notice (workstream K)", () => {
  it("goes to the stacks, and to the ticket when there is one", () => {
    const stack = { reason: "stuck" as const, stackId: 1, stackName: "pay", branch: "b1", detail: "gate held" };
    expect(noticeText({ kind: "stack", stack, target: null }, S, 0)).toEqual({ text: S.sk.notice.stuck("pay", "gate held"), actions: ["stacks"] });
    expect(noticeText({ kind: "stack", stack, target: { page: "ticket", key: "T-1", sessionId: null } }, STRINGS.en, 0).actions).toEqual(["stacks", "open"]);
  });
});

describe("approval notice (UI redesign layer 1)", () => {
  it("asks you to confirm the permission prompt and opens the session", () => {
    expect(noticeText({ kind: "approval", target: { page: "ticket", key: "BTL-1", sessionId: "s" }, title: "登录" }, S, 0)).toEqual({ text: S.noticeApproval("登录"), actions: ["open"] });
    const startup = noticeText({ kind: "approval", target: { page: "ticket", key: "BTL-1", sessionId: "s" }, title: "登录", startup: true }, S, 0);
    expect(startup).toEqual({ text: S.noticeApproval("登录", true), actions: ["open"] });
    expect(startup.text).toContain("MCP server");
  });
});
