import { envValue } from "../../shared/legacy-env";
// 性能诊断（BTL-242）：默认开着、开销很低的计数。每 60 秒一个窗口，滚进最近一小时的环里；
// 窗口不闲（有 long task、事件循环 p99 高、有慢操作）时往 main.log 写一行 perf:，「导出诊断」把整个环导出去。
import { performance } from "node:perf_hooks";

import type { DiagMode, EventLoopDelay, PerfWindow, Timing } from "../../shared/diag";

export type { DiagMode, EventLoopDelay, PerfWindow, Timing };

/** SHIPHERD_PERF_DIAG：0 / off 关掉；verbose 每个窗口都写一行；其余（默认）开着、闲的窗口不写。 */
export function diagMode(env: Record<string, string | undefined>): DiagMode {
  const v = (envValue(env, "PERF_DIAG") ?? "").trim().toLowerCase();
  if (v === "0" || v === "off" || v === "false") return "off";
  if (v === "verbose") return "verbose";
  return "on";
}

export interface RendererReport {
  longTasks: number;
  totalMs: number;
  maxMs: number;
  /** 终端用的是哪种渲染器（webgl / dom）；没有终端时不报。 */
  xterm?: string | null;
}

export interface PerfStatsDeps {
  now: () => number;
  log: (line: string) => void;
  mode: DiagMode;
  /** IPC handler 超过这么久记一次日志（每个窗口每个通道一次）。 */
  slowIpcMs?: number;
  /** 命名的重活超过这么久记一次日志。 */
  slowOpMs?: number;
  /** 环里留几个窗口。 */
  keep?: number;
}

/** 闲的窗口：没有 long task、事件循环 p99 不高、没有慢的 IPC 和操作。 */
const BUSY_ELD_P99_MS = 50;

const round = (n: number): number => Math.round(n * 10) / 10;

function bump(map: Record<string, Timing>, key: string, ms: number): Timing {
  const t = (map[key] ??= { n: 0, totalMs: 0, maxMs: 0 });
  t.n += 1;
  t.totalMs = round(t.totalMs + ms);
  t.maxMs = Math.max(t.maxMs, round(ms));
  return t;
}

const kb = (bytes: number): string => (bytes >= 1024 * 1024 ? `${round(bytes / 1024 / 1024)}MB` : `${Math.round(bytes / 1024)}KB`);

export class PerfStats {
  private win: PerfWindow;
  private readonly ring: PerfWindow[] = [];
  /** 这个窗口里已经记过「慢」的通道和操作。 */
  private readonly slowLogged = new Set<string>();
  private readonly slowIpcMs: number;
  private readonly slowOpMs: number;
  private readonly keep: number;

  constructor(private readonly d: PerfStatsDeps) {
    this.slowIpcMs = d.slowIpcMs ?? 20;
    this.slowOpMs = d.slowOpMs ?? 50;
    this.keep = d.keep ?? 60;
    this.win = this.fresh();
  }

  private fresh(): PerfWindow {
    return { start: this.d.now(), end: 0, eld: null, sends: {}, invokes: {}, ops: {}, renderer: { longTasks: 0, totalMs: 0, maxMs: 0, xterm: null } };
  }

  send(channel: string, bytes = 0): void {
    const s = (this.win.sends[channel] ??= { n: 0, bytes: 0 });
    s.n += 1;
    s.bytes += bytes;
  }

  invoke(channel: string, ms: number): void {
    bump(this.win.invokes, channel, ms);
    if (ms >= this.slowIpcMs) this.slow(`ipc ${channel}`, ms);
  }

  op(name: string, ms: number): void {
    bump(this.win.ops, name, ms);
    if (ms >= this.slowOpMs) this.slow(`op ${name}`, ms);
  }

  private slow(what: string, ms: number): void {
    if (this.slowLogged.has(what)) return;
    this.slowLogged.add(what);
    this.d.log(`perf-slow: ${what} ${Math.round(ms)}ms`);
  }

  renderer(r: RendererReport): void {
    if (!r || typeof r !== "object") return;
    const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
    const w = this.win.renderer;
    if (ok(r.longTasks)) w.longTasks += Math.round(r.longTasks);
    if (ok(r.totalMs)) w.totalMs = round(w.totalMs + r.totalMs);
    if (ok(r.maxMs)) w.maxMs = Math.max(w.maxMs, round(r.maxMs));
    if (typeof r.xterm === "string" && r.xterm.length <= 16) w.xterm = r.xterm;
  }

  /** 当前窗口（还没结束）的一份拷贝。 */
  current(): PerfWindow {
    return structuredClone({ ...this.win, end: this.d.now() });
  }

  history(): PerfWindow[] {
    return structuredClone(this.ring);
  }

  /** 结束当前窗口：放进环里，不闲（或 verbose）时写一行 perf:，再开一个新窗口。 */
  roll(eld: EventLoopDelay | null): PerfWindow {
    const w = this.win;
    w.end = this.d.now();
    w.eld = eld;
    this.ring.push(w);
    while (this.ring.length > this.keep) this.ring.shift();
    if (this.d.mode === "verbose" || this.busy(w)) this.d.log(this.line(w));
    this.win = this.fresh();
    this.slowLogged.clear();
    return w;
  }

  private busy(w: PerfWindow): boolean {
    if (w.renderer.longTasks > 0) return true;
    if (w.eld && w.eld.p99 >= BUSY_ELD_P99_MS) return true;
    return Object.values(w.ops).some((t) => t.maxMs >= this.slowOpMs) || Object.values(w.invokes).some((t) => t.maxMs >= this.slowIpcMs);
  }

  line(w: PerfWindow): string {
    const secs = Math.round((w.end - w.start) / 1000);
    const eld = w.eld ? `eld p50=${round(w.eld.p50)} p99=${round(w.eld.p99)} max=${round(w.eld.max)}` : "eld -";
    const sends = Object.entries(w.sends)
      .sort((a, b) => b[1].n - a[1].n)
      .map(([c, s]) => (s.bytes > 0 ? `${c}=${s.n}/${kb(s.bytes)}` : `${c}=${s.n}`))
      .join(" ");
    const invokeN = Object.values(w.invokes).reduce((a, t) => a + t.n, 0);
    const topInvokes = Object.entries(w.invokes)
      .sort((a, b) => b[1].totalMs - a[1].totalMs)
      .slice(0, 5)
      .map(([c, t]) => `${c} n=${t.n} t=${Math.round(t.totalMs)} max=${Math.round(t.maxMs)}`)
      .join(", ");
    const ops = Object.entries(w.ops)
      .sort((a, b) => b[1].totalMs - a[1].totalMs)
      .map(([c, t]) => `${c} n=${t.n} t=${Math.round(t.totalMs)} max=${Math.round(t.maxMs)}`)
      .join(", ");
    const r = w.renderer;
    return [
      `perf: ${secs}s ${eld}`,
      `send ${sends || "-"}`,
      `ipc n=${invokeN}${topInvokes ? ` top ${topInvokes}` : ""}`,
      `ops ${ops || "-"}`,
      `renderer longtask n=${r.longTasks} t=${Math.round(r.totalMs)} max=${Math.round(r.maxMs)} xterm=${r.xterm ?? "-"}`,
    ].join(" | ");
  }
}

/** 全局的那一份（index.ts 装上）：深处的模块（discovery、conv）不用一路传进去。没装时 perfOp 只是直接调用。 */
let active: PerfStats | null = null;

export function setPerfStats(s: PerfStats | null): void {
  active = s;
}

export function perfStats(): PerfStats | null {
  return active;
}

/** 计时一段同步的重活（出错也记上）。 */
export function perfOp<T>(name: string, fn: () => T): T {
  const s = active;
  if (!s) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    s.op(name, performance.now() - t0);
  }
}

/** 计时一段异步的活（从开始到结束的墙钟时间，含等待）。 */
export async function perfOpAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const s = active;
  if (!s) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    s.op(name, performance.now() - t0);
  }
}
