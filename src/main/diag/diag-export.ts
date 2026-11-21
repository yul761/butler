// 「导出诊断」（BTL-242）：一份 JSON，有版本、平台、内存、进程指标、最近一小时的 perf 窗口和 main.log 的最后几行。
// 不含任何 transcript、对话内容。
import { open } from "node:fs/promises";
import type { PerfWindow } from "./perf-stats";

/** 日志最多带这么多行、从文件末尾最多读这么多字节。 */
export const LOG_TAIL_LINES = 1000;
export const LOG_TAIL_BYTES = 512 * 1024;

export interface DiagInput {
  now: number;
  version: string;
  versions: Record<string, string | undefined>;
  platform: string;
  arch: string;
  osRelease: string;
  cpus: { model: string; count: number };
  memory: { totalMb: number; freeMb: number };
  /** app.getAppMetrics() 里每个进程的类型、CPU、内存。 */
  appMetrics: unknown;
  /** process.memoryUsage()：主进程的堆。 */
  mainMemory: Record<string, number>;
  /** 渲染进程报来的终端渲染器等。 */
  mode: string;
  current: PerfWindow;
  history: PerfWindow[];
  logTail: string[];
}

export interface DiagnosticsFile {
  kind: "butler-diagnostics";
  schema: 1;
  generatedAt: string;
  app: { version: string; versions: Record<string, string | undefined>; mode: string };
  system: { platform: string; arch: string; osRelease: string; cpus: { model: string; count: number }; memory: { totalMb: number; freeMb: number } };
  processes: unknown;
  mainMemory: Record<string, number>;
  perf: { current: PerfWindow; history: PerfWindow[] };
  logTail: string[];
}

export function buildDiagnostics(i: DiagInput): DiagnosticsFile {
  return {
    kind: "butler-diagnostics",
    schema: 1,
    generatedAt: new Date(i.now).toISOString(),
    app: { version: i.version, versions: i.versions, mode: i.mode },
    system: { platform: i.platform, arch: i.arch, osRelease: i.osRelease, cpus: i.cpus, memory: i.memory },
    processes: i.appMetrics,
    mainMemory: i.mainMemory,
    perf: { current: i.current, history: i.history },
    logTail: i.logTail.slice(-LOG_TAIL_LINES),
  };
}

/** 文件末尾的最多 maxLines 行（只读最后 maxBytes 字节；第一行可能读到半截，丢掉）。读不到返回 []。 */
export async function readLogTail(file: string, maxLines = LOG_TAIL_LINES, maxBytes = LOG_TAIL_BYTES): Promise<string[]> {
  let fh;
  try {
    fh = await open(file, "r");
  } catch {
    return [];
  }
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (start > 0) lines.shift();
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-maxLines);
  } catch {
    return [];
  } finally {
    await fh.close().catch(() => undefined);
  }
}
