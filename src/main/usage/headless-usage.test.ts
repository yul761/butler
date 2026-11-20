import { describe, expect, it } from "vitest";
import { headlessUsageRow } from "./headless-usage";

const usage = { input: 10, cacheWrite5m: 1, cacheWrite1h: 2, cacheRead: 100, output: 5 };

describe("headlessUsageRow", () => {
  it("没有 task 时也写 costUsd（分叉讨论不走路由）", () => {
    const row = headlessUsageRow({ runId: "r1", label: "fork discussion", at: 5, model: "claude-opus-5-5", usage, costUsd: 0.25, ticketKey: "BTL-1" });
    expect(row).toEqual({
      messageId: "headless:r1", sessionId: null, agentId: null, source: "headless", job: "fork discussion", at: 5, model: "claude-opus-5-5", ...usage,
      ticketKey: "BTL-1", context: 113, costUsd: 0.25,
    });
    expect(row.task).toBeUndefined();
  });

  it("没有 task、costUsd 是 null 时写 null", () => {
    expect(headlessUsageRow({ runId: "r1", label: "fork discussion", at: 5, model: null, usage, costUsd: null }).costUsd).toBeNull();
  });

  it("有 task 的路径结果不变", () => {
    expect(headlessUsageRow({ runId: "r2", label: "handoff BTL-7", at: 9, model: "m", usage, task: "handoff", requestedTier: "high", fallbackFrom: "x", costUsd: 0.1 })).toEqual({
      messageId: "headless:r2", sessionId: null, agentId: null, source: "headless", job: "handoff", at: 9, model: "m", ...usage, ticketKey: null, context: 113,
      task: "handoff", requestedTier: "high", fallbackFrom: "x", costUsd: 0.1,
    });
    // 有 task 但没给金额、档位：照旧补 null。
    expect(headlessUsageRow({ runId: "r3", label: "handoff BTL-7", at: 9, model: "m", usage, task: "handoff" })).toMatchObject({ task: "handoff", requestedTier: null, fallbackFrom: null, costUsd: null });
  });

  it("没有 task 也没有 costUsd：跟原来一样不带这几项", () => {
    const row = headlessUsageRow({ runId: "r4", label: "stuck check", at: 1, model: null, usage });
    expect("task" in row || "costUsd" in row || "requestedTier" in row).toBe(false);
  });
});
