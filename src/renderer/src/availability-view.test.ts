import { describe, expect, it } from "vitest";
import { S, STRINGS } from "./strings";
import { availabilityButtons, availabilityRows, ciReasonText, limitLine, noticeText, resetClock } from "./availability-view";

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
    expect(noticeText({ kind: "model_unavailable", hit: { ...hit, kind: "model_unavailable", resetsAt: null }, retryAt: null }, S, now)).toEqual({ text: "复盘用的模型不可用：模型不可用，Butler 会稍后重试", actions: ["retry", "health"] });
    expect(noticeText({ kind: "lessons_paused" }, S, now)).toEqual({ text: "复盘队列已手动暂停", actions: ["resume"] });
    expect(noticeText({ kind: "lessons_failing", count: 4 }, S, now)).toEqual({ text: "复盘连续 4 次分析失败", actions: ["lessons"] });
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
    const ci = { item: { kind: "pr" as const, id: 3 }, ticketKey: "T-1", number: 34, branch: "feat/a", reason: "guard:typing" as const, since: 0, sessionId: "s1" };
    const target = { page: "ticket" as const, key: "T-1", sessionId: "s1" };
    expect(noticeText({ kind: "ci_undelivered", ci, target, title: null }, S, 35 * 60_000)).toEqual({
      text: "CI 结果未能送达：T-1 PR #34（feat/a），已等 35 分钟（你正在终端里输入）", actions: ["resend", "open"],
    });
    expect(noticeText({ kind: "ci_undelivered", ci: { ...ci, number: null, item: { kind: "branch", repoId: 2 }, reason: "unowned" }, target, title: null }, S, 31 * 60_000).text).toBe(
      "CI 结果未能送达：T-1 分支 feat/a，已等 31 分钟（认不出是哪个会话的）",
    );
  });

  it("every reason has words; unknown ones pass through", () => {
    for (const r of ["unowned", "busy_delivering", "failed", "no_repo", "no_sha", "no_session", "owner_closed", "guard:busy", "guard:typing", "guard:draft", "guard:screen", "guard:needs_you", "guard:closed", "deliver:timeout", "deliver:blocked", "deliver:exited"]) {
      expect(ciReasonText(r, S)).not.toContain("原因：");
    }
    expect(ciReasonText("guard:new_thing", S)).toBe("原因：guard:new_thing");
    expect(ciReasonText("toString", S)).toBe("原因：toString");
  });
});
