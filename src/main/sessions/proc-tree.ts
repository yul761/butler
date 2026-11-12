import { execFile } from "node:child_process";

export interface ProcEntry {
  ppid: number;
  cpuMs: number;
  /** 完整命令行（ps 的 args）；没有这一列时为 ""。 */
  args: string;
}

/** 一次读进程树得到的两样东西；读不到的那项为 null。 */
export interface ProcSample {
  /** 子孙进程的累计 CPU 毫秒。 */
  cpuMs: number | null;
  /** 子孙里还有没有跑后台命令的 shell（MCP server 不算）；没问（没有后台命令）或读不到时为 null。 */
  liveShell: boolean | null;
}

/** ps 的 cputime：`0:03.50`、`1:02:03`、`1-02:03:04`；解析不了返回 null。 */
function parseCpuTime(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  const [, d, h, min, sec] = m;
  return Math.round((Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min) * 60 + Number(sec)) * 1000);
}

/** 解析 `ps -A -o pid=,ppid=,cputime=,args=` 的输出（args 可以没有），格式不对的行跳过。 */
export function parsePsOutput(out: string): Map<number, ProcEntry> {
  const table = new Map<number, ProcEntry>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*?))?\s*$/.exec(line);
    if (!m) continue;
    const cpuMs = parseCpuTime(m[3]);
    if (cpuMs === null) continue;
    table.set(Number(m[1]), { ppid: Number(m[2]), cpuMs, args: m[4] ?? "" });
  }
  return table;
}

function childrenOf(table: Map<number, ProcEntry>): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const [pid, e] of table) children.set(e.ppid, [...(children.get(e.ppid) ?? []), pid]);
  return children;
}

/** rootPid 所有后代的累计 CPU 毫秒，不含根进程：Claude 的动画会让根进程一直用 CPU。 */
export function descendantCpuMs(rootPid: number, table: Map<number, ProcEntry>): number {
  const children = childrenOf(table);
  let total = 0;
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const c of children.get(queue.shift()!) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      total += table.get(c)?.cpuMs ?? 0;
      queue.push(c);
    }
  }
  return total;
}

const SHELLS = new Set(["bash", "zsh", "sh", "dash", "fish", "ksh", "cmd", "powershell", "pwsh"]);

/** 命令行第一段的程序名：去掉路径、登录 shell 的「-」和 .exe，小写。 */
function programName(args: string): string {
  const first = args.trim().split(/\s+/)[0] ?? "";
  return (first.split(/[\\/]/).pop() ?? "").replace(/^-/, "").replace(/\.exe$/i, "").toLowerCase();
}

/** 命令开头一段（到第一个引号为止，最多 30 个字符）：shell 的命令行里转义过引号，后面的部分对不上。太短的不要。 */
function commandHead(command: string): string | null {
  const head = command.trim().split(/['"]/)[0].slice(0, 30).trim();
  return head.length >= 3 ? head : null;
}

/**
 * rootPid 的子孙里还有没有跑着后台命令的进程：shell（bash、zsh、sh、cmd、powershell…），或者命令行里就是这条命令的进程。
 * MCP server（命令行里带 mcp 的进程）和它的子孙都不算；命令行里带 mcp 的 shell 只有同时带着某条后台命令时才算（命令本身提到 mcp）。
 */
export function hasLiveShell(rootPid: number, table: Map<number, ProcEntry>, commands: string[]): boolean {
  const children = childrenOf(table);
  const heads = commands.flatMap((c) => commandHead(c) ?? []);
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const c of children.get(queue.shift()!) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      const args = table.get(c)?.args ?? "";
      const mentionsCommand = heads.some((h) => args.includes(h));
      const shell = SHELLS.has(programName(args));
      if (/mcp/i.test(args) && !(shell && mentionsCommand)) continue;
      if (shell || mentionsCommand) return true;
      queue.push(c);
    }
  }
  return false;
}

const runCommand = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/**
 * 读一次进程树：rootPid 子孙进程的累计 CPU 毫秒，有后台命令（commands 不空）时再看子孙里还有没有它们的 shell。
 * win32 或 ps 出错两项都是 null（当作不知道，后台命令照旧算在跑）。
 */
export async function sampleProcTree(
  rootPid: number,
  commands: string[],
  platform: NodeJS.Platform = process.platform,
  run: (cmd: string, args: string[]) => Promise<string> = runCommand,
): Promise<ProcSample> {
  if (platform === "win32") return { cpuMs: null, liveShell: null };
  try {
    const table = parsePsOutput(await run("ps", ["-A", "-o", "pid=,ppid=,cputime=,args="]));
    return { cpuMs: descendantCpuMs(rootPid, table), liveShell: commands.length ? hasLiveShell(rootPid, table, commands) : null };
  } catch {
    return { cpuMs: null, liveShell: null };
  }
}
