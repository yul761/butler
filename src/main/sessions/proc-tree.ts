import { execFile } from "node:child_process";

export interface ProcEntry {
  ppid: number;
  cpuMs: number;
}

/** ps 的 cputime：`0:03.50`、`1:02:03`、`1-02:03:04`；解析不了返回 null。 */
function parseCpuTime(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  const [, d, h, min, sec] = m;
  return Math.round((Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min) * 60 + Number(sec)) * 1000);
}

/** 解析 `ps -A -o pid=,ppid=,cputime=` 的输出，格式不对的行跳过。 */
export function parsePsOutput(out: string): Map<number, ProcEntry> {
  const table = new Map<number, ProcEntry>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const cpuMs = parseCpuTime(m[3]);
    if (cpuMs === null) continue;
    table.set(Number(m[1]), { ppid: Number(m[2]), cpuMs });
  }
  return table;
}

/** rootPid 所有后代的累计 CPU 毫秒，不含根进程：Claude 的动画会让根进程一直用 CPU。 */
export function descendantCpuMs(rootPid: number, table: Map<number, ProcEntry>): number {
  const children = new Map<number, number[]>();
  for (const [pid, e] of table) children.set(e.ppid, [...(children.get(e.ppid) ?? []), pid]);
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

const runCommand = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** rootPid 子孙进程的累计 CPU 毫秒；win32 或 ps 出错返回 null。 */
export async function childCpuMs(
  rootPid: number,
  platform: NodeJS.Platform = process.platform,
  run: (cmd: string, args: string[]) => Promise<string> = runCommand,
): Promise<number | null> {
  if (platform === "win32") return null;
  try {
    return descendantCpuMs(rootPid, parsePsOutput(await run("ps", ["-A", "-o", "pid=,ppid=,cputime="])));
  } catch {
    return null;
  }
}
