import { describe, expect, it } from "vitest";
import { clipboardAction, type KeyLike } from "./terminal-keys";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ type: "keydown", key: k, code: `Key${k.toUpperCase()}`, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });

describe("clipboardAction", () => {
  it("pastes on Ctrl+V and Ctrl+Shift+V on Windows and Linux", () => {
    for (const p of ["win32", "linux"]) {
      expect(clipboardAction(key("v", { ctrlKey: true }), p, false)).toBe("paste");
      expect(clipboardAction(key("V", { ctrlKey: true, shiftKey: true }), p, false)).toBe("paste");
    }
  });

  it("copies on Ctrl+C only when there is a selection, otherwise Ctrl+C still interrupts", () => {
    expect(clipboardAction(key("c", { ctrlKey: true }), "win32", true)).toBe("copy");
    expect(clipboardAction(key("C", { ctrlKey: true, shiftKey: true }), "win32", true)).toBe("copy");
    expect(clipboardAction(key("c", { ctrlKey: true }), "win32", false)).toBeNull();
    // Ctrl+Shift+C 没有选区：吞掉，不当成 ^C 中断 claude。
    expect(clipboardAction(key("C", { ctrlKey: true, shiftKey: true }), "win32", false)).toBe("swallow");
  });

  it("goes by the physical key on non-Latin layouts", () => {
    expect(clipboardAction({ ...key("v", { ctrlKey: true }), key: "м" }, "win32", false)).toBe("paste");
    expect(clipboardAction({ ...key("c", { ctrlKey: true }), key: "с" }, "win32", true)).toBe("copy");
  });

  it("leaves macOS to the native Cmd+C / Cmd+V and ignores other keys", () => {
    expect(clipboardAction(key("v", { metaKey: true }), "darwin", false)).toBeNull();
    expect(clipboardAction(key("v", { ctrlKey: true }), "darwin", false)).toBeNull();
    expect(clipboardAction(key("v"), "win32", false)).toBeNull();
    expect(clipboardAction(key("v", { ctrlKey: true, altKey: true }), "win32", false)).toBeNull();
    expect(clipboardAction(key("x", { ctrlKey: true }), "win32", true)).toBeNull();
  });
});
