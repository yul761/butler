import { describe, expect, it } from "vitest";
import { classifyTree, compareStart, parsePsTable, parseWinTable, powershellExe, procTableReader, readProcTable, summarize, treeOf, type ProcTable } from "./proc-table";

const PS = [
  "  100     1  50000 Mon Nov 17 09:00:00 2026 /Applications/Butler.app/Contents/MacOS/Butler",
  "  200   100 400000 Mon Nov 17 09:01:00 2026 /usr/local/bin/claude --resume abc",
  "  201   200  80000 Mon Nov 17 09:01:01 2026 /Applications/Butler.app/Contents/MacOS/Butler /x/memory-mcp/statecore-mcp.cjs --data /d",
  "  202   200  60000 Mon Nov 17 09:01:01 2026 /Applications/Butler.app/Contents/MacOS/Butler /x/memory-mcp/butler-sessions-mcp.cjs",
  "  203   200 330000 Mon Nov 17 09:01:02 2026 node /u/.npm/_npx/chrome-devtools-mcp/index.js",
  "  204   203 200000 Mon Nov 17 09:01:03 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless",
  "  205   200   3000 Mon Nov 17 09:02:00 2026 /bin/zsh -c pnpm dev",
  "  206   205  90000 Mon Nov 17 09:02:01 2026 node /repo/node_modules/.bin/vite",
  "  207   200   3000 Mon Nov 17 09:02:00 2026 /bin/bash -c npx tsc -w",
  "  208   207 120000 Mon Nov 17 09:02:01 2026 node /repo/node_modules/typescript/bin/tsc -w",
  "  209   205   5000 Mon Nov 17 09:03:00 2026 git status",
  "  300     1   1000 Mon Nov 17 08:00:00 2026 /usr/sbin/unrelated",
  "garbage line",
].join("\n");

describe("parsePsTable", () => {
  it("reads pid, ppid, rss, the start time and the full command line", () => {
    const t = parsePsTable(PS);
    expect(t.size).toBe(13 - 1);
    expect(t.get(204)).toEqual({ pid: 204, ppid: 203, rssKb: 200000, start: "Mon Nov 17 09:01:03 2026", args: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless" });
  });
});

describe("parsePsTable with a pgid column", () => {
  it("reads the process group when ps prints four numbers", () => {
    const t = parsePsTable("  112     1   111  90000 Mon Nov 17 09:01:02 2026 node /r/vite\n  113   110  9000 Mon Nov 17 09:01:03 2026 x");
    expect(t.get(112)).toEqual({ pid: 112, ppid: 1, pgid: 111, rssKb: 90000, start: "Mon Nov 17 09:01:02 2026", args: "node /r/vite" });
    expect(t.get(113)?.pgid).toBeUndefined();
    expect(t.get(113)?.rssKb).toBe(9000);
  });
});

describe("childrenIndex on Windows", () => {
  it("does not count a process as the child of a newer process that reused its dead parent's pid", () => {
    const t = parseWinTable(
      [
        // explorer.exe 的父进程 userinit.exe 早就退出了；它的 pid 600 被一个 session 里的 node 用上了。
        "700\t600\t200000\t133000000000000000\texplorer.exe\tC:\\Windows\\explorer.exe",
        "701\t700\t50000\t133000000000000100\tapp.exe\tC:\\app.exe",
        "500\t400\t300000\t133900000000000000\tclaude.exe\tclaude.exe",
        "600\t500\t80000\t133900000000000100\tnode.exe\tnode mcp.js",
      ].join("\r\n"),
    );
    expect(treeOf(500, t).map((p) => p.pid)).toEqual([500, 600]);
    expect(compareStart("133900000000000100", "133900000000000099")).toBe(1);
    expect(compareStart("0", "133900000000000099")).toBeNull();
    expect(compareStart("Mon Nov 17 09:01:02 2026", "Mon Nov 17 09:01:03 2026")).toBe(-1);
  });
});

describe("parseWinTable", () => {
  it("reads the tab-separated PowerShell output, falling back to the name when there is no command line", () => {
    const out = [
      "4\t0\t100\t0\tSystem\t",
      "5000\t4000\t300000\t133000000000000000\tclaude.exe\t\"C:\\Users\\me\\.local\\bin\\claude.exe\" --resume abc",
      "5001\t5000\t80000\t133000000000000001\tButler.exe\t\"C:\\Program Files\\Butler\\Butler.exe\" C:\\x\\statecore-mcp.cjs\tand\ta tab",
      "",
    ].join("\r\n");
    const t = parseWinTable(out);
    expect(t.get(4)?.args).toBe("System");
    expect(t.get(5000)).toEqual({ pid: 5000, ppid: 4000, rssKb: 300000, start: "133000000000000000", args: "\"C:\\Users\\me\\.local\\bin\\claude.exe\" --resume abc" });
    expect(t.get(5001)?.args).toBe("\"C:\\Program Files\\Butler\\Butler.exe\" C:\\x\\statecore-mcp.cjs\tand\ta tab");
  });
});

describe("treeOf and classifyTree", () => {
  const t = parsePsTable(PS);

  it("walks the whole tree from the root, root first, and ignores other processes", () => {
    expect(treeOf(200, t).map((p) => p.pid).sort()).toEqual([200, 201, 202, 203, 204, 205, 206, 207, 208, 209]);
    expect(treeOf(200, t)[0].pid).toBe(200);
    expect(treeOf(999, t)).toEqual([]);
  });

  it("survives a cycle in the parent links", () => {
    const cyc: ProcTable = new Map([
      [1, { pid: 1, ppid: 2, rssKb: 1, start: "a", args: "a" }],
      [2, { pid: 2, ppid: 1, rssKb: 1, start: "b", args: "b" }],
    ]);
    expect(treeOf(1, cyc).map((p) => p.pid)).toEqual([1, 2]);
  });

  it("classes claude, Butler's MCP, other MCP with its children, shells, dev servers, watchers and the rest", () => {
    const cls = Object.fromEntries(classifyTree(200, t).map((p) => [p.pid, p.cls]));
    expect(cls).toEqual({
      200: "claude", 201: "mcp_butler", 202: "mcp_butler", 203: "mcp_other", 204: "mcp_other",
      205: "shell", 206: "dev_server", 207: "shell", 208: "watcher", 209: "other",
    });
  });

  it("classes Windows command lines the same way", () => {
    const w: ProcTable = new Map([
      [10, { pid: 10, ppid: 1, rssKb: 1, start: "1", args: "\"C:\\Users\\me\\.local\\bin\\claude.exe\" --resume x" }],
      [11, { pid: 11, ppid: 10, rssKb: 1, start: "1", args: "\"C:\\Program Files\\Butler\\Butler.exe\" C:\\Program Files\\Butler\\resources\\memory-mcp\\butler-sessions-mcp.cjs" }],
      [12, { pid: 12, ppid: 10, rssKb: 1, start: "1", args: "C:\\Program Files\\Git\\bin\\bash.exe -c \"npm run dev\"" }],
      [13, { pid: 13, ppid: 12, rssKb: 1, start: "1", args: "node.exe C:\\repo\\node_modules\\next\\dist\\bin\\next dev" }],
      [14, { pid: 14, ppid: 10, rssKb: 1, start: "1", args: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile" }],
      [15, { pid: 15, ppid: 12, rssKb: 1, start: "1", args: "node.exe C:\\repo\\node_modules\\vitest\\vitest.mjs" }],
    ]);
    const cls = Object.fromEntries(classifyTree(10, w).map((p) => [p.pid, p.cls]));
    expect(cls).toEqual({ 10: "claude", 11: "mcp_butler", 12: "shell", 13: "dev_server", 14: "shell", 15: "watcher" });
  });

  it("treats claude started through cmd.exe as claude, with its MCP under it", () => {
    const w: ProcTable = new Map([
      [10, { pid: 10, ppid: 1, rssKb: 1, start: "1", args: "C:\\Windows\\system32\\cmd.exe /d /s /c claude.cmd" }],
      [11, { pid: 11, ppid: 10, rssKb: 1, start: "1", args: "\"C:\\nodejs\\node.exe\" C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" }],
      [12, { pid: 12, ppid: 10, rssKb: 1, start: "1", args: "C:\\x\\claude.exe --resume y" }],
      [13, { pid: 13, ppid: 12, rssKb: 1, start: "1", args: "node C:\\u\\playwright-mcp\\cli.js" }],
    ]);
    const cls = Object.fromEntries(classifyTree(10, w).map((p) => [p.pid, p.cls]));
    expect(cls).toEqual({ 10: "claude", 11: "claude", 12: "claude", 13: "mcp_other" });
  });

  it("does not count vitest run or a one-off tsc as a watcher", () => {
    const w: ProcTable = new Map([
      [10, { pid: 10, ppid: 1, rssKb: 1, start: "1", args: "claude" }],
      [12, { pid: 12, ppid: 10, rssKb: 1, start: "1", args: "bash -c x" }],
      [13, { pid: 13, ppid: 12, rssKb: 1, start: "1", args: "node /r/node_modules/vitest/vitest.mjs run" }],
      [14, { pid: 14, ppid: 12, rssKb: 1, start: "1", args: "node /r/node_modules/typescript/bin/tsc --noEmit" }],
    ]);
    const cls = Object.fromEntries(classifyTree(10, w).map((p) => [p.pid, p.cls]));
    expect(cls[13]).toBe("other");
    expect(cls[14]).toBe("other");
  });
});

describe("summarize", () => {
  it("adds up per class and keeps the largest processes with a short name", () => {
    const s = summarize(classifyTree(200, parsePsTable(PS)), 3);
    expect(s.totalKb).toBe(400000 + 80000 + 60000 + 330000 + 200000 + 3000 + 90000 + 3000 + 120000 + 5000);
    expect(s.count).toBe(10);
    expect(s.byClass).toEqual({ claude: 400000, mcp_butler: 140000, mcp_other: 530000, shell: 6000, watcher: 120000, dev_server: 90000, other: 5000 });
    expect(s.top.map((p) => [p.pid, p.cls, p.name])).toEqual([
      [200, "claude", "claude"],
      [203, "mcp_other", "chrome-devtools-mcp"],
      [204, "mcp_other", "Google Chrome"],
    ]);
  });
});

describe("readProcTable", () => {
  it("runs ps in the C locale on macOS", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const t = await readProcTable("darwin", async (cmd, args) => {
      calls.push({ cmd, args });
      return PS;
    });
    expect(calls[0].cmd).toBe("ps");
    expect(calls[0].args).toEqual(["-A", "-o", "pid=,ppid=,pgid=,rss=,lstart=,args="]);
    expect(t?.size).toBe(12);
  });

  it("runs one PowerShell call on Windows", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    await readProcTable("win32", async (cmd, args) => {
      calls.push({ cmd, args });
      return "1\t0\t10\t0\tx\t";
    });
    expect(calls[0].cmd).toBe(powershellExe());
    expect(calls[0].args.slice(0, 2)).toEqual(["-NoProfile", "-NonInteractive"]);
    expect(calls[0].args.join(" ")).toContain("Win32_Process");
  });

  it("finds PowerShell under SystemRoot, not on PATH (a trimmed PATH must not hide it)", () => {
    expect(powershellExe({ SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    // 环境变量在 Windows 上不分大小写，Node 的 process.env 也是；传进来的普通对象按 windir 兜底。
    expect(powershellExe({ windir: "C:\\Windows" })).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellExe({})).toBe("powershell.exe");
  });

  it("returns null when the command fails", async () => {
    expect(await readProcTable("darwin", async () => Promise.reject(new Error("no ps")))).toBeNull();
  });

  it("says why a read failed: the exit code, a timeout and stderr, or output with no rows in it", async () => {
    const reasons: string[] = [];
    const fail = (r: string) => void reasons.push(r);
    const exit = Object.assign(new Error("Command failed: powershell.exe -NoProfile …\nGet-CimInstance : Access denied"), { code: 1, killed: false, signal: null });
    expect(await readProcTable("win32", async () => Promise.reject(exit), fail)).toBeNull();
    const timeout = Object.assign(new Error("Command failed"), { code: null, killed: true, signal: "SIGTERM" });
    expect(await readProcTable("win32", async () => Promise.reject(timeout), fail)).toBeNull();
    expect(await readProcTable("win32", async () => "Get-CimInstance : not recognized\r\n", fail)).toBeNull();
    expect(reasons[0]).toMatch(/powershell\.exe.*exit code 1.*Access denied/s);
    expect(reasons[1]).toMatch(/killed \(SIGTERM\)/);
    expect(reasons[2]).toMatch(/no process rows in 34 characters of output: Get-CimInstance : not recognized/);
  });

  it("logs a failure once until it changes, and logs when the table can be read again", async () => {
    const logs: string[] = [];
    let out: string | Error = new Error("boom");
    const read = procTableReader("darwin", (m) => void logs.push(m), async () => (out instanceof Error ? Promise.reject(out) : out));
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^process table: ps failed: boom/);
    out = PS;
    expect((await read())?.size).toBe(12);
    expect(await read()).not.toBeNull();
    expect(logs).toEqual([logs[0], "process table: readable again (12 processes)"]);
    out = new Error("boom");
    await read();
    expect(logs).toHaveLength(3);
  });

  it("reads this machine's real table (it has at least this process)", async () => {
    const t = await readProcTable(process.platform);
    expect(t?.get(process.pid)).toBeDefined();
  }, 20_000);
});
