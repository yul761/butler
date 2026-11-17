import { describe, expect, it } from "vitest";
import { S } from "./strings";
import { limitLine, noticeText, resetClock } from "./availability-view";

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
