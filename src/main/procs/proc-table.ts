import { execFile } from "node:child_process";
import { PROC_CLASSES, type ProcClass, type TopProc, type TreeSummary } from "../../shared/mem-usage";

export type { ProcClass, TopProc, TreeSummary };

/**
 * 整张进程表（WS-M 设计 §1）：内存采样（A）、优先级（E）、孤儿清理（F）和 watcher 明细（I）共用。
 * macOS / Linux 用 ps，Windows 用一次 PowerShell 的 Win32_Process。start 只当作身份用（pid 会被复用），不解析成时间。
 */
export interface ProcInfo {
  pid: number;
  ppid: number;
  /** 常驻内存（ps 的 rss）；Windows 是工作集（任务管理器显示的那个）。KB。 */
  rssKb: number;
  /** 启动时间的原文：ps 的 lstart，Windows 的 CreationDate（FILETIME）。同一个 pid 换了进程，这个就变了。 */
  start: string;
  /** 完整命令行；Windows 读不到命令行时是进程名。 */
  args: string;
  /** 进程组（ps 的 pgid）；Windows 上没有。claude 的 Bash 工具用 `&` / nohup 起的进程被收养走以后还留在原来那个 shell 的组里，孤儿清理靠它认。 */
  pgid?: number;
  /** 累计 CPU 毫秒（ps 的 cputime）；Windows 上没有。活动探测看子孙进程有没有在用 CPU（BTL-275：和内存采样共用这一张表）。 */
  cpuMs?: number;
}

export type ProcTable = Map<number, ProcInfo>;


export interface TreeProc extends ProcInfo {
  cls: ProcClass;
}

/**
 * `ps -A -o pid=,ppid=,pgid=,rss=,cputime=,lstart=,args=`：lstart 是 C 区域设置下的 5 段（Mon Nov 17 09:00:00 2026）。
 * 只有三个数字（没有 pgid 这一栏）、没有 cputime 这一栏的输出也能读。
 */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)\s+)?(\d+)\s+(?:((?:\d+-)?(?:\d+:)?\d+:\d+(?:\.\d+)?)\s+)?(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s?(.*)$/;

/** ps 的 cputime：`0:03.50`、`1:02:03`、`1-02:03:04`；解析不了返回 null。 */
export function parseCpuTime(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  const [, d, h, min, sec] = m;
  return Math.round((Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min) * 60 + Number(sec)) * 1000);
}

export function parsePsTable(out: string): ProcTable {
  const t: ProcTable = new Map();
  for (const line of out.split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const info: ProcInfo = { pid, ppid: Number(m[2]), rssKb: Number(m[4]), start: m[6].replace(/\s+/g, " "), args: m[7].trim() };
    if (m[3] !== undefined) info.pgid = Number(m[3]);
    const cpu = m[5] === undefined ? null : parseCpuTime(m[5]);
    if (cpu !== null) info.cpuMs = cpu;
    t.set(pid, info);
  }
  return t;
}

/** WIN_SCRIPT 的输出：pid、ppid、工作集 KB、CreationDate 的 FILETIME、进程名、命令行，用 tab 隔开（命令行里的 tab 留着）。 */
export function parseWinTable(out: string): ProcTable {
  const t: ProcTable = new Map();
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length < 6 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) continue;
    const pid = Number(parts[0]);
    const cmd = parts.slice(5).join("\t").trim();
    t.set(pid, { pid, ppid: Number(parts[1]), rssKb: Number(parts[2]) || 0, start: parts[3], args: cmd || parts[4] });
  }
  return t;
}

/** 一次 PowerShell 读完整张表；UTF-8 输出（命令行里可能有中文路径）。 */
const WIN_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,CreationDate,Name,CommandLine | ForEach-Object { $s = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }; \"$($_.ProcessId)`t$($_.ParentProcessId)`t$([int64]($_.WorkingSetSize / 1024))`t$s`t$($_.Name)`t$($_.CommandLine)\" }",
].join("; ");

/**
 * Windows PowerShell 的完整路径。不靠 PATH 找：PATH 被删减过（e2e 的沙盒就只有 System32）时按名字调会 ENOENT，
 * 内存采样就一次都采不到，也不报错。系统目录读不到时才退回按名字找。
 */
export function powershellExe(env: Record<string, string | undefined> = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
  return root ? `${root.replace(/[\\/]+$/, "")}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : "powershell.exe";
}

export type RunCommand = (cmd: string, args: string[]) => Promise<string>;

export const runCommand: RunCommand = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: "C", LANG: "C" } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });

/** execFile 的错误说成一句话：退出码或者被杀（超时）、错误信息（里面带着 stderr）。 */
function describeRunError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const x = e as Error & { code?: unknown; killed?: boolean; signal?: unknown };
  const how = x.killed ? `killed (${String(x.signal ?? "timeout")})` : typeof x.code === "number" ? `exit code ${x.code}` : x.code ? String(x.code) : "";
  const msg = x.message.trim().slice(0, 600);
  return how ? `${how}: ${msg}` : msg;
}

/**
 * 读整张进程表；命令失败、或者输出里一行进程都读不出来，返回 null（这一次采样跳过），原因交给 fail。
 * 一张空表不会是真的（至少有我们自己），当成失败。
 */
export async function readProcTable(platform: NodeJS.Platform = process.platform, run: RunCommand = runCommand, fail: (reason: string) => void = () => {}): Promise<ProcTable | null> {
  const win = platform === "win32";
  const cmd = win ? powershellExe() : "ps";
  const args = win ? ["-NoProfile", "-NonInteractive", "-Command", WIN_SCRIPT] : ["-A", "-o", "pid=,ppid=,pgid=,rss=,cputime=,lstart=,args="];
  let out: string;
  try {
    out = await run(cmd, args);
  } catch (e) {
    fail(`${cmd} failed: ${describeRunError(e)}`);
    return null;
  }
  const table = win ? parseWinTable(out) : parsePsTable(out);
  if (table.size === 0) {
    fail(`no process rows in ${out.length} characters of output: ${out.trim().slice(0, 300)}`);
    return null;
  }
  return table;
}

/** readProcTable 加上日志：同一个原因只记一次（每分钟采一次，坏着的话不刷屏），恢复了记一条。 */
export function procTableReader(platform: NodeJS.Platform, log: (msg: string) => void, run: RunCommand = runCommand): () => Promise<ProcTable | null> {
  let last: string | null = null;
  return async () => {
    let reason: string | null = null;
    const t = await readProcTable(platform, run, (r) => void (reason = r));
    if (reason !== null) {
      if (reason !== last) log(`process table: ${reason}`);
      last = reason;
    } else if (t && last !== null) {
      log(`process table: readable again (${t.size} processes)`);
      last = null;
    }
    return t;
  };
}

/**
 * 一张最多 ttlMs 旧的进程表，给只看个大概的读者共用（BTL-275）：内存采样每分钟一次，活动探测每个在跑后台命令的 session 各一次，
 * 原来各起各的 ps。正在读的那次大家等同一个结果；读失败（null）不留，下一个读者重读。
 * 孤儿清理、休眠要杀进程，要现读的表，不用这个。
 */
export function sharedProcTable(read: () => Promise<ProcTable | null>, o: { ttlMs: number; now: () => number }): () => Promise<ProcTable | null> {
  let kept: { at: number; table: ProcTable } | null = null;
  let inFlight: Promise<ProcTable | null> | null = null;
  return () => {
    const at = o.now();
    if (kept && at - kept.at < o.ttlMs) return Promise.resolve(kept.table);
    inFlight ??= read()
      .then((table) => {
        kept = table ? { at, table } : null;
        return table;
      })
      .finally(() => (inFlight = null));
    return inFlight;
  };
}

/**
 * 两个启动时间谁早：负数 a 早，正数 b 早，0 同时（ps 只精确到秒）；读不出来（FILETIME 是 0、格式不认识）返回 null。
 * Windows 的 FILETIME 超过 2^53，用 BigInt 比。
 */
export function compareStart(a: string, b: string): number | null {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    if (a === "0" || b === "0") return null;
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? null : Math.sign(x - y);
}

/**
 * 每个 pid 的子进程。
 * Windows 不会给进程换父进程：父进程早就退出、pid 又被别的进程用上时，老进程的 ParentProcessId 指向那个新进程
 * （explorer.exe 指着早就退出的 userinit.exe 的 pid）。比父进程还早启动的不算它的子进程，否则这棵树会把不相干的进程算进来，
 * 孤儿清理会去结束它们。
 */
export function childrenIndex(t: ProcTable): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const p of t.values()) {
    const parent = t.get(p.ppid);
    if (parent && parent.pid !== p.pid && (compareStart(p.start, parent.start) ?? 0) < 0) continue;
    const list = out.get(p.ppid);
    if (list) list.push(p.pid);
    else out.set(p.ppid, [p.pid]);
  }
  return out;
}

/** root 和它所有的后代（根在最前，广度优先）；root 不在表里返回空。parent 链成环也不会死循环。 */
export function treeOf(root: number, t: ProcTable, children: Map<number, number[]> = childrenIndex(t)): ProcInfo[] {
  const first = t.get(root);
  if (!first) return [];
  const out: ProcInfo[] = [first];
  const seen = new Set<number>([root]);
  for (let i = 0; i < out.length; i++) {
    for (const c of children.get(out[i].pid) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      const p = t.get(c);
      if (p) out.push(p);
    }
  }
  return out;
}

/** 去掉引号的第一段（Windows 带空格的路径整段加引号）。 */
function firstToken(args: string): { exe: string; rest: string } {
  const a = args.trim();
  if (a.startsWith('"')) {
    const end = a.indexOf('"', 1);
    if (end > 0) return { exe: a.slice(1, end), rest: a.slice(end + 1).trim() };
  }
  // Windows 上没加引号、路径里有空格的（C:\Program Files\Git\bin\bash.exe -c …）：到 .exe 为止。
  const win = /^([A-Za-z]:\\[^"]*?\.exe)(\s|$)/i.exec(a);
  if (win) return { exe: win[1], rest: a.slice(win[1].length).trim() };
  const sp = a.search(/\s/);
  return sp < 0 ? { exe: a, rest: "" } : { exe: a.slice(0, sp), rest: a.slice(sp + 1).trim() };
}

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const exeName = (args: string): string => baseName(firstToken(args).exe).replace(/^-/, "").replace(/\.exe$/i, "").toLowerCase();

/** 解释器：显示名用它跑的脚本。 */
// butler：改名前（BTL-260）的可执行文件名，升级时还没退出的旧进程。TODO(5.0) 删。
const RUNNERS = new Set(["node", "shipherd", "butler", "electron", "python", "python3", "bun", "deno", "npx", "ruby"]);
/** 脚本名是这些的，用上一级目录名（node …/chrome-devtools-mcp/index.js → chrome-devtools-mcp）。 */
const GENERIC_SCRIPTS = /^(index|main|cli|server|bin|start)\.[cm]?[jt]s$/i;

/** 给人看的短名字：.app 的名字、解释器跑的脚本名，或者可执行文件名。 */
export function shortName(args: string): string {
  const app = /\/([^/]+)\.app\/Contents\/MacOS\//.exec(args);
  if (app) return app[1];
  const { exe, rest } = firstToken(args);
  const name = baseName(exe).replace(/\.exe$/i, "");
  if (RUNNERS.has(name.toLowerCase())) {
    const script = rest.split(/\s+/).find((x) => /[\\/]/.test(x) || /\.[cm]?[jt]s$|\.py$/.test(x));
    if (script) {
      const clean = script.replace(/^"|"$/g, "");
      const b = baseName(clean);
      if (GENERIC_SCRIPTS.test(b)) {
        const dirs = clean.split(/[\\/]/).filter(Boolean);
        return dirs.at(-2) ?? b;
      }
      return b.replace(/\.[cm]?[jt]s$|\.py$/, "");
    }
  }
  return name;
}

const SHELLS = new Set(["bash", "zsh", "sh", "dash", "fish", "ksh", "cmd", "powershell", "pwsh", "conhost", "openconsole"]);
/** Shipherd 自己的 MCP（打包好的脚本名）。butler-sessions-mcp 是改名前（BTL-260）的名字，升级前起的还可能在跑（TODO(5.0) 删）。 */
const SHIPHERD_MCP = /(statecore-mcp|(?:shipherd|butler)-sessions-mcp|mcp-hub)\.cjs\b/;
/** 常驻的 watcher（设计 §1 第 5 条）。vitest 不带 run 才算（vitest run 跑完就退）。 */
const WATCHER = [
  /(^|\s)--watch(All)?(\s|=|$)/,
  /(^|\s)-w(\s|$)/,
  /\bnodemon\b/,
  /\btsserver(\.js)?\b/,
  /\bchokidar\b/,
  /[\\/]vitest[\\/]vitest\.mjs(?![^]*\s(run|bench)\b)/,
  /(^|\s|[\\/])vitest(\.cmd)?(\s+(watch|dev))?$/,
  /(^|\s)watch(\s|$)/,
];
/** 开发服务器（设计 §1 第 6 条）。 */
const DEV_SERVER = [
  /[\\/]vite([\\/]bin[\\/]vite\.js)?(\s|$)/,
  /[\\/]\.bin[\\/]vite(\s|$)/,
  /\bnext(\.js)?\s+dev\b/,
  /[\\/]next(\s+dev)/,
  /\bwebpack(-cli)?\s+serve\b/,
  /\bwebpack-dev-server\b/,
  /\breact-scripts(\.js)?\s+start\b/,
  /\bnuxt\s+dev\b/,
  /\bastro\s+dev\b/,
  /\brails\s+s(erver)?\b/,
  /\bmanage\.py\s+runserver\b/,
  /\buvicorn\b/,
  /\bflask\s+run\b/,
  /\b(npm|pnpm|yarn)(\.cmd)?\s+(run\s+)?(dev|start|serve)\b/,
];

/** claude 本身：原生可执行文件，或者 npm 装的 node …/@anthropic-ai/claude-code/cli.js。 */
export const isClaude = (args: string): boolean => exeName(args) === "claude" || /@anthropic-ai[\\/]claude-code[\\/]cli\.[cm]?js/.test(args);

function deepClass(args: string): ProcClass {
  if (SHELLS.has(exeName(args))) return "shell";
  if (WATCHER.some((r) => r.test(args))) return "watcher";
  if (DEV_SERVER.some((r) => r.test(args))) return "dev_server";
  if (isClaude(args)) return "claude";
  return "other";
}

/** claude 的直接子进程：Claude Code 把 MCP server 直接起成自己的子进程（proc-tree 也按这条认）。 */
function directClass(args: string): ProcClass {
  if (SHIPHERD_MCP.test(args)) return "mcp_shipherd";
  const deep = deepClass(args);
  if (deep !== "other" && deep !== "claude") return deep;
  // Grep 工具起的 rg、临时的 git 不是 MCP。
  if (["rg", "git", "ripgrep"].includes(exeName(args))) return "other";
  return "mcp_other";
}

/** root（claude）的整棵树加上类别：MCP 的子孙跟着它算 MCP（比如 MCP 起的浏览器）。 */
export function classifyTree(root: number, t: ProcTable, children: Map<number, number[]> = childrenIndex(t)): TreeProc[] {
  const tree = treeOf(root, t, children);
  const cls = new Map<number, ProcClass>();
  const out: TreeProc[] = [];
  for (const p of tree) {
    let c: ProcClass;
    const parent = cls.get(p.ppid);
    if (p.pid === root) c = "claude";
    else if (parent === "mcp_shipherd" || parent === "mcp_other") c = parent;
    // Windows 上经 cmd.exe 起的 claude：根是 cmd，真正的 claude 是它的子进程，MCP 挂在那下面。
    else if (parent === "claude" && isClaude(p.args)) c = "claude";
    else if (parent === "claude") c = directClass(p.args);
    else c = deepClass(p.args);
    cls.set(p.pid, c);
    out.push({ ...p, cls: c });
  }
  return out;
}

export const emptyByClass = (): Record<ProcClass, number> => Object.fromEntries(PROC_CLASSES.map((c) => [c, 0])) as Record<ProcClass, number>;

/** 按类别加起来，留下最大的 topN 个进程。 */
export function summarize(procs: TreeProc[], topN = 8): TreeSummary {
  const byClass = emptyByClass();
  let totalKb = 0;
  for (const p of procs) {
    byClass[p.cls] += p.rssKb;
    totalKb += p.rssKb;
  }
  const top = [...procs]
    .sort((a, b) => b.rssKb - a.rssKb)
    .slice(0, topN)
    .map((p) => ({ pid: p.pid, cls: p.cls, rssKb: p.rssKb, name: shortName(p.args) }));
  return { totalKb, count: procs.length, byClass, top };
}

/** Shipherd 主进程下面、不在任何 session 树里的进程算哪一份（设计 §2）：共享 MCP、无头 claude、Windows 的终端宿主，别的算 utility。 */
export function shipherdPartOf(args: string): "hub" | "headless" | "terminals" | "utility" {
  if (/\bmcp-hub\.cjs\b/.test(args)) return "hub";
  if (isClaude(args)) return "headless";
  const exe = exeName(args);
  if (exe === "conhost" || exe === "openconsole" || exe === "winpty-agent") return "terminals";
  return "utility";
}
