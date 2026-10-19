import { describe, expect, it } from "vitest";
import { execText, shellPlan } from "./exec";

describe("shellPlan", () => {
  it("quotes a win32 .cmd and passes constant args through the shell", () => {
    const p = shellPlan("C:\\npm\\claude.cmd", ["--version"], "win32");
    expect(p.viaShell).toBe(true);
    expect(p.command).toBe('"C:\\npm\\claude.cmd"');
    expect(p.unsafeArg).toBeNull();
  });

  it("flags a win32 .cmd argument that is not a safe shell token", () => {
    const p = shellPlan("C:\\npm\\claude.cmd", ["-p", "hello world & del x"], "win32");
    expect(p.viaShell).toBe(true);
    expect(p.unsafeArg).toBe("hello world & del x");
  });

  it("does not use the shell for a win32 .exe", () => {
    const p = shellPlan("C:\\tools\\claude.exe", ["-p", "hello world & del x"], "win32");
    expect(p.viaShell).toBe(false);
    expect(p.command).toBe("C:\\tools\\claude.exe");
    expect(p.unsafeArg).toBeNull();
  });

  it("never uses the shell on darwin", () => {
    const p = shellPlan("/opt/bin/claude.cmd", ["-p", "hello world & del x"], "darwin");
    expect(p.viaShell).toBe(false);
    expect(p.command).toBe("/opt/bin/claude.cmd");
    expect(p.unsafeArg).toBeNull();
  });
});

describe("execText", () => {
  it("runs a real process and returns stdout when args are not shell-checked", async () => {
    expect(await execText(process.execPath, ["-e", "process.stdout.write('ok')"])).toBe("ok");
  });
});
