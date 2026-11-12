import { describe, expect, it } from "vitest";
import { descendantCpuMs, hasLiveShell, parsePsOutput, sampleProcTree } from "./proc-tree";

describe("parsePsOutput", () => {
  it("parses the cputime formats ps prints", () => {
    const t = parsePsOutput("  12    1   0:03.50\n 13 12 1:02:03\n14 12 1-02:03:04\n");
    expect(t.get(12)).toEqual({ ppid: 1, cpuMs: 3500, args: "" });
    expect(t.get(13)).toEqual({ ppid: 12, cpuMs: (3600 + 120 + 3) * 1000, args: "" });
    expect(t.get(14)).toEqual({ ppid: 12, cpuMs: (86400 + 7200 + 180 + 4) * 1000, args: "" });
  });
  it("keeps the command line, spaces included", () => {
    const t = parsePsOutput("  20 1   0:00.10 /bin/zsh -c source x && eval 'git push'  \n");
    expect(t.get(20)).toEqual({ ppid: 1, cpuMs: 100, args: "/bin/zsh -c source x && eval 'git push'" });
  });
  it("skips malformed lines", () => {
    expect(parsePsOutput("garbage\n\n 1 0 x:y\n").size).toBe(0);
  });
});

describe("descendantCpuMs", () => {
  it("sums all descendants but not the root", () => {
    const t = parsePsOutput("10 1 5:00.00\n11 10 0:01.00\n12 11 0:02.00\n13 99 0:09.00\n");
    expect(descendantCpuMs(10, t)).toBe(3000);
    expect(descendantCpuMs(99, t)).toBe(9000);
    expect(descendantCpuMs(555, t)).toBe(0);
  });
});

/** 真实的样子（macOS）：claude 下面是 MCP server、Bash 工具的 zsh，zsh 下面是后台命令。 */
const CLAUDE_TREE = [
  "100 1 1:00.00 /Users/x/.local/bin/claude --session-id s --mcp-config /Users/x/.butler/mcp/tickets/A-1.json",
  "101 100 0:01.00 node /Users/x/.nvm/versions/node/v26.3.0/bin/statecore-mcp",
  "102 100 0:01.00 npm exec chrome-devtools-mcp@latest --autoConnect",
  "103 102 0:01.00 sh -c chrome-devtools-mcp",
  "104 100 0:01.00 /Applications/Butler.app/Contents/MacOS/Butler /Applications/Butler.app/Contents/Resources/memory-mcp/butler-sessions-mcp.cjs",
  "105 100 0:00.01 caffeinate -i -t 300",
].join("\n");
const BASH = "106 100 0:00.10 /bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'python3 -m http.server 8000' < /dev/null && pwd -P >| /tmp/claude-1-cwd";

describe("hasLiveShell", () => {
  it("finds the Bash tool's shell under claude", () => {
    expect(hasLiveShell(100, parsePsOutput(`${CLAUDE_TREE}\n${BASH}\n107 106 0:00.50 /usr/bin/python3 -m http.server 8000`), ["python3 -m http.server 8000"])).toBe(true);
  });
  it("does not count MCP servers, their child shells, or other children", () => {
    expect(hasLiveShell(100, parsePsOutput(CLAUDE_TREE), ["python3 -m http.server 8000"])).toBe(false);
    expect(hasLiveShell(100, parsePsOutput(CLAUDE_TREE), ["node server.js"])).toBe(false);
  });
  it("counts a shell whose command line mentions mcp only when it runs one of the commands", () => {
    const mcpCmd = "106 100 0:00.10 /bin/zsh -c source s.sh && eval 'pnpm dev:mcp' < /dev/null";
    expect(hasLiveShell(100, parsePsOutput(`${CLAUDE_TREE}\n${mcpCmd}`), ["pnpm dev:mcp"])).toBe(true);
    expect(hasLiveShell(100, parsePsOutput(`${CLAUDE_TREE}\n${mcpCmd}`), ["git push"])).toBe(false);
  });
  it("counts the command itself when the shell exec'd into it, and Windows shells", () => {
    expect(hasLiveShell(100, parsePsOutput(`${CLAUDE_TREE}\n108 100 0:01.00 pnpm run dev --port 3000`), ["pnpm run dev --port 3000"])).toBe(true);
    expect(hasLiveShell(100, parsePsOutput("100 1 0:01.00 claude\n109 100 0:00.10 C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command x"), ["x"])).toBe(true);
    expect(hasLiveShell(100, parsePsOutput("100 1 0:01.00 claude\n110 100 0:00.10 -bash"), [])).toBe(true);
  });
  it("only looks below the root", () => {
    expect(hasLiveShell(100, parsePsOutput(`${CLAUDE_TREE}\n200 1 0:00.10 /bin/zsh -l`), ["git push"])).toBe(false);
  });
});

describe("sampleProcTree", () => {
  it("returns nulls on win32 and when ps fails", async () => {
    expect(await sampleProcTree(1, ["x"], "win32", async () => "1 0 0:01.00")).toEqual({ cpuMs: null, liveShell: null });
    expect(await sampleProcTree(1, ["x"], "darwin", async () => { throw new Error("no ps"); })).toEqual({ cpuMs: null, liveShell: null });
  });
  it("runs ps -A once, sums children and looks for a shell only when there are commands", async () => {
    const seen: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      seen.push([cmd, ...args]);
      return "1 0 0:10.00 claude\n2 1 0:02.00 node x-mcp\n";
    };
    expect(await sampleProcTree(1, ["git push"], "darwin", run)).toEqual({ cpuMs: 2000, liveShell: false });
    expect(await sampleProcTree(1, [], "darwin", run)).toEqual({ cpuMs: 2000, liveShell: null });
    expect(seen).toEqual([["ps", "-A", "-o", "pid=,ppid=,cputime=,args="], ["ps", "-A", "-o", "pid=,ppid=,cputime=,args="]]);
  });
});
