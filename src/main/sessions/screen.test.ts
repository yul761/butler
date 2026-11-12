import { describe, expect, it } from "vitest";
import { dialogOnScreen, inputBoxText, pasteInInputBox, permissionOnScreen, squash, TermScreen } from "./screen";

const RULE = "─".repeat(120);

describe("TermScreen", () => {
  it("shows the current screen, with cursor jumps between words rendered as spaces", async () => {
    const s = new TermScreen(80, 6);
    s.write("\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\r\n\x1b[2G❯\x1b[4GNo,\x1b[8Gexit");
    await s.flush();
    expect(s.lines().slice(0, 2)).toEqual([" Quick safety check: Is this", " ❯ No, exit"]);
    // 清屏重画以后旧的文字就不在了（输出流的末尾里还在）。
    s.write("\x1b[2J\x1b[H> ready");
    await s.flush();
    expect(s.lines()[0]).toBe("> ready");
    expect(s.lines().slice(1).every((l) => l === "")).toBe(true);
    s.dispose();
    expect(s.lines()).toEqual([]);
  });

  it("follows resizes", async () => {
    const s = new TermScreen(20, 4);
    s.resize(40, 8);
    await s.flush();
    expect(s.lines()).toHaveLength(8);
    s.dispose();
  });
});

describe("dialogOnScreen / permissionOnScreen", () => {
  it("finds the 2.1.322 trust dialog and the older one, regardless of spacing", () => {
    expect(dialogOnScreen([" Quick safety check: Is this a project you created or one you trust?", " ❯ No, exit", "   Yes, I trust this folder", " Enter to confirm · Esc to cancel"])).toBe(true);
    expect(dialogOnScreen(["Quicksafetycheck:", "❯no,exit"])).toBe(true);
    expect(dialogOnScreen([" Do you trust the files in this folder?", " ❯ 1. Yes, proceed"])).toBe(true);
    expect(dialogOnScreen(["New MCP server found in .mcp.json: slowprobe"])).toBe(true);
    expect(dialogOnScreen([RULE, '❯ Try "fix lint errors"', RULE])).toBe(false);
  });

  it("ignores the markers in the conversation while the input box is drawn", () => {
    const talk = ["⏺ 信任对话框的默认项是 No, exit，Enter to confirm。", "  Do you want to proceed? Would you like to proceed?", ""];
    expect(dialogOnScreen([...talk, RULE, "❯ ", RULE, "  ⏵⏵ auto mode on"])).toBe(false);
    expect(permissionOnScreen([...talk, RULE, "❯ ", RULE, "  ⏵⏵ auto mode on"])).toBe(false);
    // 对话框顶替了输入框：只看最后一条线以下，上面对话里的字不算。
    expect(permissionOnScreen(["⏺ Do you want to proceed?", RULE, " Bash command", " echo hi"])).toBe(false);
    expect(permissionOnScreen(["⏺ 早先的话", RULE, " Bash command", " Do you want to proceed?", " ❯ 1. Yes"])).toBe(true);
  });

  it("finds permission prompts only", () => {
    expect(permissionOnScreen(["Bash command", "Do you want to proceed?", " ❯ 1. Yes"])).toBe(true);
    expect(permissionOnScreen(["Do  you want to make this edit to a.ts?"])).toBe(true);
    expect(permissionOnScreen(["Would you like to proceed?"])).toBe(true);
    expect(permissionOnScreen(["Do you want to create foo.ts?"])).toBe(true);
    expect(permissionOnScreen(["building..."])).toBe(false);
    expect(permissionOnScreen([" Do you trust the files in this folder?"])).toBe(false);
  });
});

describe("inputBoxText / pasteInInputBox", () => {
  it("reads what is between the last two rules", () => {
    expect(inputBoxText(["❯ 早先的消息", RULE, "❯ [Pasted text #1 +5 lines]", RULE, "  paste again to expand"])).toBe("[Pasted text #1 +5 lines]");
    expect(inputBoxText(["❯ 早先的消息", RULE, "❯ ", RULE])).toBe("");
    expect(inputBoxText([RULE, " ❯ No, exit"])).toBeNull();
    // 两条线之间不是「❯」开头、或者第二条线下面还有一大段：不是输入框。
    expect(inputBoxText([RULE, "| a | b |", RULE])).toBeNull();
    expect(inputBoxText([RULE, "❯ x", RULE, "1", "2", "3", "4", "5"])).toBeNull();
  });

  it("tells whether this paste is still sitting in the box", () => {
    expect(pasteInInputBox([RULE, "❯ [Pasted text #1 +5 lines]", RULE], "任意")).toBe(true);
    expect(pasteInInputBox([RULE, "❯ 修一下 lint", "  然后 push", RULE], "修一下 lint\n然后 push")).toBe(true);
    // 提交以后：任务出现在上面的对话里，输入框空了。
    expect(pasteInInputBox(["❯ 修一下 lint", "  然后 push", RULE, "❯ ", RULE], "修一下 lint\n然后 push")).toBe(false);
    expect(pasteInInputBox([RULE, '❯ Try "fix lint errors"', RULE], "修一下 lint")).toBe(false);
    expect(pasteInInputBox([" ❯ No, exit"], "修一下 lint")).toBe(false);
  });

  it("squash lowercases and drops all whitespace", () => {
    expect(squash(" Yes,  I\ttrust\nthis ")).toBe("yes,itrustthis");
  });
});
