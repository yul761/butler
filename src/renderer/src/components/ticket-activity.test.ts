import { afterEach, describe, expect, it } from "vitest";
import type { SessionActivity } from "../../../shared/activity";
import { S, setUiLang } from "../strings";
import { activityText, formatDuration } from "./TicketActivity";

const NOW = 1_000_000_000_000;
const MIN = 60_000;
const act = (over: Partial<SessionActivity>): SessionActivity => ({
  sessionId: "s1", kind: "command", detail: null, background: false, startedAt: null, lastOutputAt: null,
  stuck: null, reason: null, action: null, lastOutput: [], ...over,
});

afterEach(() => setUiLang("zh"));

describe("formatDuration", () => {
  it("shows minutes and hours", () => {
    expect(formatDuration(18 * MIN, S)).toBe("18 分钟");
    expect(formatDuration(60 * MIN, S)).toBe("1 小时");
    expect(formatDuration(125 * MIN, S)).toBe("2 小时 5 分钟");
    expect(formatDuration(10_000, S)).toBe("刚刚");
  });

  it("works in English", () => {
    setUiLang("en");
    expect(formatDuration(18 * MIN, S)).toBe("18 min");
    expect(formatDuration(65 * MIN, S)).toBe("1 hour 5 min");
  });
});

describe("activityText", () => {
  it("names a push with its hook and the time it has run", () => {
    const t = activityText(act({ kind: "push", startedAt: NOW - 18 * MIN }), S, NOW);
    expect(t.main).toBe("跑 git push（pre-push hook）");
    expect(t.sub).toBe("18 分钟");
  });

  it("puts the file name or command in the sub line", () => {
    expect(activityText(act({ kind: "edit", detail: "form.tsx", startedAt: NOW }), S, NOW)).toEqual({ main: "写代码", sub: "form.tsx · 刚刚" });
    expect(activityText(act({ kind: "command", detail: "make build", startedAt: NOW - 3 * MIN }), S, NOW).main).toBe("运行命令");
  });

  it("marks a background command", () => {
    expect(activityText(act({ kind: "ci", background: true, startedAt: NOW - 6 * MIN }), S, NOW).main).toContain("后台");
  });

  it("says how long a stuck session has been silent", () => {
    const t = activityText(act({ kind: "push", stuck: true, startedAt: NOW - 18 * MIN, lastOutputAt: NOW - 12 * MIN }), S, NOW);
    expect(t.sub).toContain("已 12 分钟没有新输出");
  });

  it("covers waiting, approval and thinking", () => {
    expect(activityText(act({ kind: "waiting", startedAt: NOW - 3 * MIN }), S, NOW)).toEqual({ main: "等你回话", sub: "3 分钟前停下" });
    expect(activityText(act({ kind: "approval" }), S, NOW)).toEqual({ main: "等你批准", sub: null });
    expect(activityText(act({ kind: "thinking" }), S, NOW).main).toBe("思考中");
  });

  it("speaks English", () => {
    setUiLang("en");
    const t = activityText(act({ kind: "push", stuck: true, startedAt: NOW - 18 * MIN, lastOutputAt: NOW - 12 * MIN }), S, NOW);
    expect(t.main).toBe("Running git push (pre-push hook)");
    expect(t.sub).toContain("12 min");
    expect(activityText(act({ kind: "waiting" }), S, NOW).main).toBe("Waiting for your reply");
  });
});
