import { describe, expect, it } from "vitest";
import { jobResultMessage } from "./job-view";

describe("jobResultMessage", () => {
  it("tells the user how a manual run ended", () => {
    expect(jobResultMessage({ lastRunAt: 1, lastStatus: "ok", lastError: null })).toBe("已完成。");
    expect(jobResultMessage({ lastRunAt: 1, lastStatus: "partial", lastError: null })).toContain("早间简报前会补跑");
    expect(jobResultMessage({ lastRunAt: 1, lastStatus: "failed", lastError: "找不到 claude 命令" })).toBe("运行失败：找不到 claude 命令");
  });
});
