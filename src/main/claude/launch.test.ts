import { describe, expect, it } from "vitest";
import { childLaunch, isCmdShim, parseCmdShim, resolveLaunch, withArgs } from "./launch";
import { NATIVE_TARGET_SHIM, NPM_SHIM, OLD_NPM_SHIM, PNPM_SHIM } from "./shim-fixtures";

const NPM_DIR = "C:\\Users\\John Smith\\AppData\\Roaming\\npm";
const CLI = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;

describe("Windows claude shims (plan 1 Task 9, plan 2 Task 10)", () => {
  it("reads the script out of npm and pnpm shims", () => {
    expect(parseCmdShim(NPM_SHIM)).toBe("node_modules\\@anthropic-ai\\claude-code\\cli.js");
    expect(parseCmdShim(PNPM_SHIM)).toBe("..\\@anthropic-ai\\claude-code\\cli.js");
    expect(parseCmdShim('@echo off\r\nnode "C:\\x\\fake.cjs" %*')).toBeNull();
    expect(parseCmdShim("")).toBeNull();
  });

  it("only treats .cmd and .bat on Windows as shims", () => {
    expect(isCmdShim("C:\\npm\\claude.cmd", "win32")).toBe(true);
    expect(isCmdShim("C:\\npm\\CLAUDE.BAT", "win32")).toBe(true);
    expect(isCmdShim("C:\\bin\\claude.exe", "win32")).toBe(false);
    expect(isCmdShim("/usr/local/bin/claude.cmd", "darwin")).toBe(false);
  });

  it("resolves npm and pnpm shims to node and the script, keeping spaces (Review Focus 1)", () => {
    const files = new Map([[`${NPM_DIR}\\claude.cmd`, NPM_SHIM], [`${NPM_DIR}\\node.exe`, ""], [CLI, ""]]);
    const deps = { read: (f: string) => files.get(f) ?? "", exists: (p: string) => files.has(p) };
    const args = ["--session-id", "u1", "--mcp-config", "C:\\Users\\John Smith\\.butler\\mcp\\PROJ-1.json"];
    expect(resolveLaunch(`${NPM_DIR}\\claude.cmd`, args, "win32", deps)).toEqual({ file: `${NPM_DIR}\\node.exe`, args: [CLI, ...args], viaCmd: false });

    const pnpmDir = "D:\\pnpm\\bin";
    const pnpmCli = "D:\\pnpm\\@anthropic-ai\\claude-code\\cli.js";
    const nodeOnPath = "C:\\Program Files\\nodejs\\node.exe";
    const files2 = new Map([[`${pnpmDir}\\claude.cmd`, PNPM_SHIM], [pnpmCli, ""], [nodeOnPath, ""], [".\\node.exe", ""]]);
    const deps2 = { read: (f: string) => files2.get(f) ?? "", exists: (p: string) => files2.has(p), pathValue: ".;C:\\Program Files\\nodejs" };
    expect(resolveLaunch(`${pnpmDir}\\claude.cmd`, ["-p"], "win32", deps2)).toEqual({ file: nodeOnPath, args: [pnpmCli, "-p"], viaCmd: false });
  });

  it("falls back to cmd.exe when the shim cannot be understood", () => {
    const cases = [
      { read: () => "@echo off\r\nsomething else %*", exists: () => true },
      { read: () => NPM_SHIM, exists: () => false },
      {
        read: () => {
          throw new Error("EACCES");
        },
        exists: () => true,
      },
    ];
    for (const deps of cases) {
      expect(resolveLaunch("C:\\npm\\claude.cmd", ["x"], "win32", deps)).toEqual({ file: "cmd.exe", args: ["/c", "C:\\npm\\claude.cmd", "x"], viaCmd: true });
    }
  });

  it("leaves everything else alone, and hands unknown shims back to cross-spawn untouched", () => {
    expect(resolveLaunch("/usr/local/bin/claude", ["x"], "darwin")).toEqual({ file: "/usr/local/bin/claude", args: ["x"], viaCmd: false });
    expect(resolveLaunch("C:\\bin\\claude.exe", ["x"], "win32")).toEqual({ file: "C:\\bin\\claude.exe", args: ["x"], viaCmd: false });
    expect(childLaunch("C:\\npm\\claude.cmd", ["x"], "win32", { read: () => "junk", exists: () => true })).toEqual({ file: "C:\\npm\\claude.cmd", args: ["x"], viaCmd: true });
  });
});

describe("Windows claude shims: other formats and odd cases (P5-R6)", () => {
  const shimAt = (shim: string, extra: string[]) => {
    const files = new Map<string, string>([[`${NPM_DIR}\\claude.cmd`, shim], ...extra.map((f): [string, string] => [f, ""])]);
    return { read: (f: string) => files.get(f) ?? "", exists: (p: string) => files.has(p) };
  };
  const cmd = (claudePath: string, args: string[]) => ({ file: "cmd.exe", args: ["/c", claudePath, ...args], viaCmd: true });

  it("reads LF-only shims, upper-case variables and the older cmd-shim format", () => {
    expect(parseCmdShim(NPM_SHIM.replace(/\r\n/g, "\n"))).toBe("node_modules\\@anthropic-ai\\claude-code\\cli.js");
    expect(parseCmdShim(PNPM_SHIM.replace(/%~dp0/g, "%~DP0"))).toBe("..\\@anthropic-ai\\claude-code\\cli.js");
    expect(parseCmdShim(OLD_NPM_SHIM)).toBe("node_modules\\@anthropic-ai\\claude-code\\cli.js");
    expect(parseCmdShim('@"%~dp0\\node.exe" "%~dp0\\lib\\cli.mjs" %*')).toBe("lib\\cli.mjs");
    expect(parseCmdShim('@node "%~dp0\\lib\\cli.cjs" %*')).toBe("lib\\cli.cjs");
  });

  it("does not recognise shims for native targets, scripts behind other variables, or non-JS files", () => {
    expect(parseCmdShim(NATIVE_TARGET_SHIM)).toBeNull();
    expect(parseCmdShim('@node "%APPDATA%\\npm\\cli.js" %*')).toBeNull();
    expect(parseCmdShim('@node "%~dp0\\%CLAUDE_DIR%\\cli.js" %*')).toBeNull();
    expect(parseCmdShim('@node "%~dp0\\cli.json" %*')).toBeNull();
    expect(parseCmdShim("@node %~dp0\\cli.js %*")).toBeNull();
  });

  it("starts the older npm shim and an upper-case .BAT shim with node", () => {
    const deps = shimAt(OLD_NPM_SHIM, [`${NPM_DIR}\\node.exe`, CLI]);
    expect(resolveLaunch(`${NPM_DIR}\\claude.cmd`, ["-p"], "win32", deps)).toEqual({ file: `${NPM_DIR}\\node.exe`, args: [CLI, "-p"], viaCmd: false });
    const files = new Map([[`${NPM_DIR}\\CLAUDE.BAT`, NPM_SHIM], [`${NPM_DIR}\\node.exe`, ""], [CLI, ""]]);
    const batDeps = { read: (f: string) => files.get(f) ?? "", exists: (p: string) => files.has(p) };
    expect(resolveLaunch(`${NPM_DIR}\\CLAUDE.BAT`, ["-p"], "win32", batDeps)).toEqual({ file: `${NPM_DIR}\\node.exe`, args: [CLI, "-p"], viaCmd: false });
  });

  it("finds node only in absolute PATH directories, quoted ones included", () => {
    const deps = shimAt(NPM_SHIM, [CLI, "node.exe", "nodejs\\node.exe", "D:\\Node 20\\node.exe"]);
    expect(resolveLaunch(`${NPM_DIR}\\claude.cmd`, [], "win32", { ...deps, pathValue: '.;nodejs;"D:\\Node 20"' })).toEqual({
      file: "D:\\Node 20\\node.exe", args: [CLI], viaCmd: false,
    });
    // 只有相对目录里有 node：认不出来，回退到 cmd.exe。
    expect(resolveLaunch(`${NPM_DIR}\\claude.cmd`, [], "win32", { ...deps, pathValue: ".;nodejs" })).toEqual(cmd(`${NPM_DIR}\\claude.cmd`, []));
    expect(resolveLaunch(`${NPM_DIR}\\claude.cmd`, [], "win32", deps)).toEqual(cmd(`${NPM_DIR}\\claude.cmd`, []));
  });

  it("falls back to cmd.exe when the script is missing or the target is native", () => {
    expect(resolveLaunch(`${NPM_DIR}\\claude.cmd`, ["x"], "win32", shimAt(NPM_SHIM, [`${NPM_DIR}\\node.exe`]))).toEqual(cmd(`${NPM_DIR}\\claude.cmd`, ["x"]));
    const native = shimAt(NATIVE_TARGET_SHIM, [`${NPM_DIR}\\node.exe`, `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`]);
    expect(resolveLaunch(`${NPM_DIR}\\claude.cmd`, ["x"], "win32", native)).toEqual(cmd(`${NPM_DIR}\\claude.cmd`, ["x"]));
    expect(childLaunch(`${NPM_DIR}\\claude.cmd`, ["x"], "win32", native)).toEqual({ file: `${NPM_DIR}\\claude.cmd`, args: ["x"], viaCmd: true });
  });

  it("childLaunch starts recognised shims with node too", () => {
    const deps = shimAt(NPM_SHIM, [`${NPM_DIR}\\node.exe`, CLI]);
    expect(childLaunch(`${NPM_DIR}\\claude.cmd`, ["x"], "win32", deps)).toEqual({ file: `${NPM_DIR}\\node.exe`, args: [CLI, "x"], viaCmd: false });
  });

  it("a launch resolved once can take the arguments later (P5-PF10)", () => {
    const deps = shimAt(NPM_SHIM, [`${NPM_DIR}\\node.exe`, CLI]);
    const args = ["--mcp-config", "C:\\Users\\John Smith\\.butler\\mcp\\tickets\\PROJ-1.json"];
    for (const [claudePath, platform, d] of [
      [`${NPM_DIR}\\claude.cmd`, "win32", deps],
      [`${NPM_DIR}\\claude.cmd`, "win32", shimAt("junk", [])],
      ["C:\\bin\\claude.exe", "win32", deps],
      ["/usr/local/bin/claude", "darwin", deps],
    ] as const) {
      expect(withArgs(resolveLaunch(claudePath, [], platform, d), args)).toEqual(resolveLaunch(claudePath, args, platform, d));
    }
  });
});
