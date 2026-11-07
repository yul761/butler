import { readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { GUIDE_SECTIONS, sessionGuide, writeSessionGuide } from "./session-guide";

describe("session guide", () => {
  it("包含 CI 那一段，中英各一份", () => {
    expect(sessionGuide("zh", "ticket")).toContain("不要循环查 CI");
    expect(sessionGuide("en", "coordinator")).toContain("Butler watches your PR and CI");
    expect(GUIDE_SECTIONS.length).toBeGreaterThan(0);
  });

  it("所有 session 都有子代理的模型准则，只有总控有 start_session 的", () => {
    expect(sessionGuide("zh", "ticket")).toContain('model: "opus"');
    expect(sessionGuide("zh", "coordinator")).toContain('model: "opus"');
    expect(sessionGuide("en", "ticket")).toContain('model: "opus"');
    expect(sessionGuide("zh", "coordinator")).toContain("start_session");
    expect(sessionGuide("en", "coordinator")).toContain("start_session");
    expect(sessionGuide("zh", "ticket")).not.toContain("start_session");
    expect(sessionGuide("en", "ticket")).not.toContain("start_session");
  });

  it("所有 session 都被告知上下文会被换新，并要 remember 重要决定", () => {
    for (const kind of ["ticket", "coordinator"] as const) {
      expect(sessionGuide("zh", kind)).toContain("再让你从记忆里接上");
      expect(sessionGuide("zh", kind)).toContain("remember");
      expect(sessionGuide("en", kind)).toContain("refresh a session whose context grows too long");
    }
  });

  it("写到 mcp 目录，内容没变就不重写", () => {
    const dir = tempDir("guide");
    const file = writeSessionGuide(dir, "zh", "ticket");
    expect(file).toBe(join(dir, "guide-ticket-zh.md"));
    expect(readFileSync(file, "utf8")).toBe(sessionGuide("zh", "ticket"));
    const old = new Date(2020, 0, 1);
    utimesSync(file, old, old);
    expect(writeSessionGuide(dir, "zh", "ticket")).toBe(file);
    expect(statSync(file).mtimeMs).toBe(old.getTime());
  });
});
