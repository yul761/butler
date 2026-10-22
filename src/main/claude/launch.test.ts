import { describe, expect, it } from "vitest";
import {
  NPM_EXE_SHIM, NPM_FLAGS_SHIM, NPM_SHIM, OLD_NPM_SHIM, PNPM_EXE_SHIM, PNPM_NODE_PATH, PNPM_NODE_PATH_SHIM, PNPM_PATH_SHIM, PNPM_PINNED_NODE,
  PNPM_PINNED_SHIM, PNPM_SHIM, PNPM_SYMLINKS_SHIM,
} from "./__fixtures__/shims";
import { childLaunch, isCmdShim, launchEnv, parseCmdShim, resolveLaunch, withArgs } from "./launch";

const NPM_DIR = "C:\\Users\\John Smith\\AppData\\Roaming\\npm";
const CLI = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
const EXE = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const PNPM_DIR = "D:\\pnpm\\bin";
const PNPM_CLI = "D:\\pnpm\\@anthropic-ai\\claude-code\\cli.js";
const PNPM_EXE = "D:\\pnpm\\@anthropic-ai\\claude-code\\bin\\claude.exe";

/** 一个假的文件系统：shim 文件的内容，加上其他存在的文件。 */
const fsWith = (shims: Record<string, string>, others: string[]) => {
  const files = new Map<string, string>([...Object.entries(shims), ...others.map((f): [string, string] => [f, ""])]);
  return { read: (f: string) => files.get(f) ?? "", exists: (p: string) => files.has(p) };
};
const cmd = (claudePath: string, args: string[]) => ({ file: "cmd.exe", args: ["/c", claudePath, ...args], viaCmd: true });

describe("Windows claude shims (plan 1 Task 9, plan 2 Task 10)", () => {
  it("reads the script out of npm and pnpm shims", () => {
    expect(parseCmdShim(NPM_SHIM)?.target).toBe("node_modules\\@anthropic-ai\\claude-code\\cli.js");
    expect(parseCmdShim(PNPM_SHIM)?.target).toBe("..\\@anthropic-ai\\claude-code\\cli.js");
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

    const nodeOnPath = "C:\\Program Files\\nodejs\\node.exe";
    const files2 = new Map([[`${PNPM_DIR}\\claude.cmd`, PNPM_SHIM], [PNPM_CLI, ""], [nodeOnPath, ""], [".\\node.exe", ""]]);
    const deps2 = { read: (f: string) => files2.get(f) ?? "", exists: (p: string) => files2.has(p), pathValue: ".;C:\\Program Files\\nodejs" };
    expect(resolveLaunch(`${PNPM_DIR}\\claude.cmd`, ["-p"], "win32", deps2)).toEqual({ file: nodeOnPath, args: [PNPM_CLI, "-p"], viaCmd: false });
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
      expect(resolveLaunch("C:\\npm\\claude.cmd", ["x"], "win32", deps)).toEqual(cmd("C:\\npm\\claude.cmd", ["x"]));
    }
  });

  it("leaves everything else alone, and hands unknown shims back to cross-spawn untouched", () => {
    expect(resolveLaunch("/usr/local/bin/claude", ["x"], "darwin")).toEqual({ file: "/usr/local/bin/claude", args: ["x"], viaCmd: false });
    expect(resolveLaunch("C:\\bin\\claude.exe", ["x"], "win32")).toEqual({ file: "C:\\bin\\claude.exe", args: ["x"], viaCmd: false });
    expect(childLaunch("C:\\npm\\claude.cmd", ["x"], "win32", { read: () => "junk", exists: () => true })).toEqual({ file: "C:\\npm\\claude.cmd", args: ["x"], viaCmd: true });
  });
});

describe("native claude.exe behind npm and pnpm shims (claude-code 2.1.307 ships bin/claude.exe)", () => {
  it("reads the exe out of the real npm and pnpm shims", () => {
    expect(parseCmdShim(NPM_EXE_SHIM)).toEqual({ kind: "exe", target: "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe", nodeArgs: [] });
    expect(parseCmdShim(PNPM_EXE_SHIM)).toEqual({ kind: "exe", target: "..\\@anthropic-ai\\claude-code\\bin\\claude.exe", nodeArgs: [] });
  });

  it("starts the exe directly with the args: no node, no cmd.exe, spaces kept", () => {
    const args = ["--session-id", "u1", "--mcp-config", "C:\\Users\\John Smith\\.butler\\mcp\\tickets\\PROJ-1.json"];
    const npm = fsWith({ [`${NPM_DIR}\\claude.cmd`]: NPM_EXE_SHIM }, [EXE]);
    expect(resolveLaunch(`${NPM_DIR}\\claude.cmd`, args, "win32", npm)).toEqual({ file: EXE, args, viaCmd: false });
    expect(childLaunch(`${NPM_DIR}\\claude.cmd`, args, "win32", npm)).toEqual({ file: EXE, args, viaCmd: false });
    const pnpm = fsWith({ [`${PNPM_DIR}\\claude.cmd`]: PNPM_EXE_SHIM }, [PNPM_EXE]);
    expect(resolveLaunch(`${PNPM_DIR}\\claude.cmd`, ["-p"], "win32", pnpm)).toEqual({ file: PNPM_EXE, args: ["-p"], viaCmd: false });
  });

  it("falls back to cmd.exe when the exe is missing", () => {
    const deps = fsWith({ [`${NPM_DIR}\\claude.cmd`]: NPM_EXE_SHIM }, [`${NPM_DIR}\\node.exe`]);
    expect(resolveLaunch(`${NPM_DIR}\\claude.cmd`, ["x"], "win32", deps)).toEqual(cmd(`${NPM_DIR}\\claude.cmd`, ["x"]));
    expect(childLaunch(`${NPM_DIR}\\claude.cmd`, ["x"], "win32", deps)).toEqual({ file: `${NPM_DIR}\\claude.cmd`, args: ["x"], viaCmd: true });
  });
});

describe("pnpm shim variants", () => {
  it("passes the shim's NODE_PATH on to the child, ahead of an existing one", () => {
    expect(parseCmdShim(PNPM_NODE_PATH_SHIM)).toEqual({ kind: "node", target: "..\\@anthropic-ai\\claude-code\\cli.js", nodeArgs: [], nodePath: PNPM_NODE_PATH });
    const deps = fsWith({ [`${PNPM_DIR}\\claude.cmd`]: PNPM_NODE_PATH_SHIM }, [`${PNPM_DIR}\\node.exe`, PNPM_CLI]);
    const l = resolveLaunch(`${PNPM_DIR}\\claude.cmd`, ["-p"], "win32", deps);
    expect(l).toEqual({ file: `${PNPM_DIR}\\node.exe`, args: [PNPM_CLI, "-p"], viaCmd: false, nodePath: PNPM_NODE_PATH });
    expect(launchEnv(l, { Path: "C:\\x" })).toEqual({ Path: "C:\\x", NODE_PATH: PNPM_NODE_PATH });
    expect(launchEnv(l, { Node_Path: "E:\\mine" })).toEqual({ Node_Path: `${PNPM_NODE_PATH};E:\\mine` });
    expect(launchEnv(withArgs(l, ["x"]), {})).toEqual({ NODE_PATH: PNPM_NODE_PATH });
    const plain = { file: "/usr/local/bin/claude", args: [], viaCmd: false };
    const env = { PATH: "/usr/bin" };
    expect(launchEnv(plain, env)).toBe(env);
  });

  it("uses the node.exe the shim pins, and only that one", () => {
    expect(parseCmdShim(PNPM_PINNED_SHIM)).toEqual({ kind: "node", target: "..\\@anthropic-ai\\claude-code\\cli.js", nodeArgs: [], node: PNPM_PINNED_NODE });
    const pinned = fsWith({ [`${PNPM_DIR}\\claude.cmd`]: PNPM_PINNED_SHIM }, [PNPM_PINNED_NODE, `${PNPM_DIR}\\node.exe`, PNPM_CLI]);
    expect(resolveLaunch(`${PNPM_DIR}\\claude.cmd`, ["-p"], "win32", pinned)).toEqual({ file: PNPM_PINNED_NODE, args: [PNPM_CLI, "-p"], viaCmd: false });
    // 固定的 node 不在了：shim 自己也会失败，不换别的 node，回退到 cmd.exe。
    const gone = fsWith({ [`${PNPM_DIR}\\claude.cmd`]: PNPM_PINNED_SHIM }, [`${PNPM_DIR}\\node.exe`, PNPM_CLI]);
    expect(resolveLaunch(`${PNPM_DIR}\\claude.cmd`, ["-p"], "win32", gone)).toEqual(cmd(`${PNPM_DIR}\\claude.cmd`, ["-p"]));
  });

  it("keeps allowlisted node flags in front of the script (npm --no-warnings, pnpm --preserve-symlinks)", () => {
    expect(parseCmdShim(NPM_FLAGS_SHIM)?.nodeArgs).toEqual(["--no-warnings"]);
    expect(parseCmdShim(PNPM_SYMLINKS_SHIM)?.nodeArgs).toEqual(["--preserve-symlinks"]);
    const deps = fsWith({ [`${NPM_DIR}\\claude.cmd`]: NPM_FLAGS_SHIM }, [`${NPM_DIR}\\node.exe`, CLI]);
    expect(resolveLaunch(`${NPM_DIR}\\claude.cmd`, ["-p"], "win32", deps)).toEqual({ file: `${NPM_DIR}\\node.exe`, args: ["--no-warnings", CLI, "-p"], viaCmd: false });
    expect(parseCmdShim(NPM_FLAGS_SHIM.replace("--no-warnings", "--preserve-symlinks-main --no-warnings"))?.nodeArgs).toEqual(["--preserve-symlinks-main", "--no-warnings"]);
  });

  it("does not recognise a shim that changes PATH", () => {
    expect(parseCmdShim(PNPM_PATH_SHIM)).toBeNull();
    expect(parseCmdShim(`@SET PATH=C:\\tools;%PATH%\r\n${PNPM_SHIM}`)).toBeNull();
  });
});

describe("Windows claude shims: other formats and odd cases (P5-R6)", () => {
  it("reads LF-only shims, upper-case variables and the older cmd-shim format", () => {
    expect(parseCmdShim(NPM_SHIM.replace(/\r\n/g, "\n"))?.target).toBe("node_modules\\@anthropic-ai\\claude-code\\cli.js");
    expect(parseCmdShim(PNPM_SHIM.replace(/%~dp0/g, "%~DP0"))?.target).toBe("..\\@anthropic-ai\\claude-code\\cli.js");
    expect(parseCmdShim(OLD_NPM_SHIM)?.target).toBe("node_modules\\@anthropic-ai\\claude-code\\cli.js");
    expect(parseCmdShim('@"%~dp0\\node.exe" "%~dp0\\lib\\cli.mjs" %*')?.target).toBe("lib\\cli.mjs");
    expect(parseCmdShim('@node "%~dp0\\lib\\cli.cjs" %*')?.target).toBe("lib\\cli.cjs");
  });

  it("does not recognise scripts behind other variables, non-JS files or unquoted paths", () => {
    expect(parseCmdShim('@node "%APPDATA%\\npm\\cli.js" %*')).toBeNull();
    expect(parseCmdShim('@node "%~dp0\\%CLAUDE_DIR%\\cli.js" %*')).toBeNull();
    expect(parseCmdShim('@node "%~dp0\\cli.json" %*')).toBeNull();
    expect(parseCmdShim('@"%~dp0\\claude.com"   %*')).toBeNull();
    expect(parseCmdShim("@node %~dp0\\cli.js %*")).toBeNull();
  });

  it("refuses targets with a drive letter or UNC prefix after %~dp0, but allows ..", () => {
    for (const bad of ["C:\\evil\\x.js", "\\\\evil\\share\\x.js", "\\evil\\x.js", "C:evil\\x.js"]) {
      expect(parseCmdShim(`@node "%~dp0\\${bad}" %*`), bad).toBeNull();
      expect(parseCmdShim(`"%dp0%\\${bad.replace(/\.js$/, ".exe")}"   %*`), bad).toBeNull();
    }
    expect(parseCmdShim('@node "%~dp0\\..\\..\\lib\\cli.js" %*')?.target).toBe("..\\..\\lib\\cli.js");
  });

  it("only reads the program line itself: not REM lines, not extra arguments, not other flags", () => {
    expect(parseCmdShim('@REM "%~dp0\\decoy.js"\r\nevil.exe %*\r\n')).toBeNull();
    expect(parseCmdShim(':: "%~dp0\\decoy.js" %*\r\n@node "%~dp0\\cli.js" %*\r\n')?.target).toBe("cli.js");
    expect(parseCmdShim('rem @node "%~dp0\\decoy.js" %*\r\n')).toBeNull();
    expect(parseCmdShim('@echo "%~dp0\\decoy.js" %*\r\n')).toBeNull();
    expect(parseCmdShim('@node "%~dp0\\cli.js" --extra %*')).toBeNull();
    expect(parseCmdShim('@node "%~dp0\\cli.js" %* & evil.exe')).toBeNull();
    expect(parseCmdShim('@node --require=evil "%~dp0\\cli.js" %*')).toBeNull();
    expect(parseCmdShim('@node --inspect "%~dp0\\cli.js" %*')).toBeNull();
    expect(parseCmdShim('@node "%~dp0\\pre.js" "%~dp0\\cli.js" %*')).toBeNull();
    expect(parseCmdShim('@bun "%~dp0\\cli.js" %*')).toBeNull();
    expect(parseCmdShim(NPM_SHIM.replace('SET "_prog=node"', 'SET "_prog=bun"'))).toBeNull();
    // IF EXIST 的两个分支不一致：不认。
    expect(parseCmdShim(PNPM_SHIM.replace("node  \"%~dp0\\..\\@anthropic-ai", "node  \"%~dp0\\..\\@other"))).toBeNull();
  });

  it("refuses NODE_PATH lines it does not understand", () => {
    expect(parseCmdShim(PNPM_NODE_PATH_SHIM.replace(`${PNPM_NODE_PATH};%NODE_PATH%`, "D:\\other;%NODE_PATH%"))).toBeNull();
    expect(parseCmdShim(PNPM_NODE_PATH_SHIM.replace(`"NODE_PATH=${PNPM_NODE_PATH}"`, '"NODE_PATH=%APPDATA%\\x"'))).toBeNull();
    expect(parseCmdShim(`@SET NODE_PATH=D:\\x\r\n${PNPM_SHIM}`)).toBeNull();
  });

  it("starts the older npm shim and an upper-case .BAT shim with node", () => {
    const deps = fsWith({ [`${NPM_DIR}\\claude.cmd`]: OLD_NPM_SHIM, [`${NPM_DIR}\\CLAUDE.BAT`]: NPM_SHIM }, [`${NPM_DIR}\\node.exe`, CLI]);
    expect(resolveLaunch(`${NPM_DIR}\\claude.cmd`, ["-p"], "win32", deps)).toEqual({ file: `${NPM_DIR}\\node.exe`, args: [CLI, "-p"], viaCmd: false });
    expect(resolveLaunch(`${NPM_DIR}\\CLAUDE.BAT`, ["-p"], "win32", deps)).toEqual({ file: `${NPM_DIR}\\node.exe`, args: [CLI, "-p"], viaCmd: false });
  });

  it("finds node on the login PATH, only in absolute directories, quoted ones included", () => {
    const deps = fsWith({ [`${NPM_DIR}\\claude.cmd`]: NPM_SHIM }, [CLI, "node.exe", "nodejs\\node.exe", "D:\\Node 20\\node.exe"]);
    expect(resolveLaunch(`${NPM_DIR}\\claude.cmd`, [], "win32", { ...deps, pathValue: '.;nodejs;"D:\\Node 20"' })).toEqual({
      file: "D:\\Node 20\\node.exe", args: [CLI], viaCmd: false,
    });
    // 只有相对目录里有 node，或者没给 PATH：回退到 cmd.exe。
    expect(resolveLaunch(`${NPM_DIR}\\claude.cmd`, [], "win32", { ...deps, pathValue: ".;nodejs" })).toEqual(cmd(`${NPM_DIR}\\claude.cmd`, []));
    expect(resolveLaunch(`${NPM_DIR}\\claude.cmd`, [], "win32", deps)).toEqual(cmd(`${NPM_DIR}\\claude.cmd`, []));
  });

  it("falls back to cmd.exe when the script is missing", () => {
    const deps = fsWith({ [`${NPM_DIR}\\claude.cmd`]: NPM_SHIM }, [`${NPM_DIR}\\node.exe`]);
    expect(resolveLaunch(`${NPM_DIR}\\claude.cmd`, ["x"], "win32", deps)).toEqual(cmd(`${NPM_DIR}\\claude.cmd`, ["x"]));
  });

  it("childLaunch starts recognised shims with node too", () => {
    const deps = fsWith({ [`${NPM_DIR}\\claude.cmd`]: NPM_SHIM }, [`${NPM_DIR}\\node.exe`, CLI]);
    expect(childLaunch(`${NPM_DIR}\\claude.cmd`, ["x"], "win32", deps)).toEqual({ file: `${NPM_DIR}\\node.exe`, args: [CLI, "x"], viaCmd: false });
  });

  it("a launch resolved once can take the arguments later (P5-PF10)", () => {
    const shims = { [`${NPM_DIR}\\claude.cmd`]: NPM_FLAGS_SHIM, [`${NPM_DIR}\\exe.cmd`]: NPM_EXE_SHIM, [`${NPM_DIR}\\junk.cmd`]: "junk" };
    const deps = fsWith(shims, [`${NPM_DIR}\\node.exe`, CLI, EXE]);
    const args = ["--mcp-config", "C:\\Users\\John Smith\\.butler\\mcp\\tickets\\PROJ-1.json"];
    for (const [claudePath, platform] of [
      [`${NPM_DIR}\\claude.cmd`, "win32"],
      [`${NPM_DIR}\\exe.cmd`, "win32"],
      [`${NPM_DIR}\\junk.cmd`, "win32"],
      ["C:\\bin\\claude.exe", "win32"],
      ["/usr/local/bin/claude", "darwin"],
    ] as const) {
      expect(withArgs(resolveLaunch(claudePath, [], platform, deps), args)).toEqual(resolveLaunch(claudePath, args, platform, deps));
    }
  });
});
