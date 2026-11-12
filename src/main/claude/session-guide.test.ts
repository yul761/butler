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

  it("所有 session 都知道 ask_user 和 report，只有总控被告知不要转述子 session 的问题（BTL-190 第 2+3 点）", () => {
    for (const kind of ["ticket", "coordinator"] as const) {
      expect(sessionGuide("zh", kind)).toContain("ask_user");
      expect(sessionGuide("zh", kind)).toContain("结束这一轮");
      expect(sessionGuide("zh", kind)).toContain("要我继续吗");
      expect(sessionGuide("en", kind)).toContain("report (kind done or blocked)");
    }
    expect(sessionGuide("zh", "coordinator")).toContain("不用你再转述");
    expect(sessionGuide("en", "coordinator")).toContain("do not ask them again");
    expect(sessionGuide("zh", "ticket")).not.toContain("不用你再转述");
  });

  it("epic session 知道 start_feature 怎么用，别的 session 不知道（BTL-190 第 4 点）", () => {
    for (const lang of ["zh", "en"] as const) {
      const epic = sessionGuide(lang, "epic");
      expect(epic).toContain("start_feature");
      expect(epic).toContain("4");
      expect(sessionGuide(lang, "coordinator")).not.toContain("start_feature");
      expect(sessionGuide(lang, "ticket")).not.toContain("start_feature");
    }
    expect(sessionGuide("zh", "epic")).toContain("用户同意开工");
    expect(sessionGuide("en", "epic")).toContain("user agrees to start");
  });

  it("epic session 和总控一样有子 session 汇报那一段，但没有 start_session 的模型准则", () => {
    for (const lang of ["zh", "en"] as const) {
      const epic = sessionGuide(lang, "epic");
      expect(epic).toContain(lang === "zh" ? "不用你再转述" : "do not ask them again");
      expect(epic).toContain("ask_user");
      expect(epic).toContain('model: "opus"');
      expect(epic).toContain(lang === "zh" ? "再让你从记忆里接上" : "refresh a session whose context grows too long");
      expect(epic).not.toContain("start_session");
    }
  });

  it("Butler 总控知道自己只看不建，跨 epic 协调用 send_message，epic 的汇报会送到它这里（BTL-190 第 5 点）", () => {
    const zh = sessionGuide("zh", "butler");
    expect(zh).toContain("Butler 总控");
    expect(zh).toContain("send_message");
    expect(zh).toContain("不能建");
    expect(zh).toContain("epic session");
    expect(zh).toContain("ask_user");
    expect(zh).toContain("再让你从记忆里接上");
    // 它不 push，也不开子 session。
    expect(zh).not.toContain("不要循环查 CI");
    expect(zh).not.toContain("start_session");
    expect(zh).not.toContain("start_feature");
    const en = sessionGuide("en", "butler");
    expect(en).toContain("Butler control");
    expect(en).toContain("send_message");
    expect(en).toContain("cannot create");
    expect(/[\u4e00-\u9fff]/.test(en)).toBe(false);
    for (const kind of ["ticket", "coordinator", "epic"] as const) expect(sessionGuide("zh", kind)).not.toContain("Butler 总控");
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
