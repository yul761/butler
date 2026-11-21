// 性能诊断的装配（BTL-242）：PerfStats、事件循环延迟直方图、每 60 秒滚一个窗口、渲染进程的报告、快照和导出。
import { monitorEventLoopDelay } from "node:perf_hooks";

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;
import { buildDiagnostics, readLogTail, type DiagnosticsFile } from "./diag-export";
import type { DiagSnapshot } from "../../shared/diag";
import { PerfStats, setPerfStats, type DiagMode, type EventLoopDelay, type RendererReport } from "./perf-stats";

export type { DiagSnapshot };

export const WINDOW_MS = 60_000;

export interface DiagServiceDeps {
  mode: DiagMode;
  now: () => number;
  log: (line: string) => void;
  logFile: string;
  /** 导出时要的其他信息（版本、进程指标……）。 */
  info: () => Omit<Parameters<typeof buildDiagnostics>[0], "now" | "mode" | "current" | "history" | "logTail">;
  /** 弹保存对话框，返回选的路径（取消为 null）。 */
  pickSavePath: (defaultName: string) => Promise<string | null>;
  writeFile: (path: string, text: string) => Promise<void>;
  /** 每类进程累计用过的 CPU 秒数（app.getAppMetrics 的 cumulativeCPUUsage 按 type 加起来）。 */
  cpuTimes?: () => Record<string, number>;
}

/** 直方图量的是定时器实际的间隔，里面包含采样间隔本身：减掉它，剩下的才是事件循环被占住的时间。 */
const WINDOW_RESOLUTION_MS = 20;
const MEASURE_RESOLUTION_MS = 10;

const ms = (ns: number, minus: number): number => (Number.isFinite(ns) ? Math.max(0, Math.round(ns / 1e5 - minus * 10) / 10) : 0);

export class DiagService {
  readonly stats: PerfStats | null;
  private hist: IntervalHistogram | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 一段测量（snapshot(true) 重新开始）：自己的直方图和推送计数，跟 60 秒的窗口无关。 */
  private measureHist: IntervalHistogram | null = null;
  private measureStart: number | null = null;
  private measureSends: Record<string, { n: number; bytes: number }> = {};
  private measureInvokes = { n: 0, totalMs: 0 };
  private measureCpu: Record<string, number> = {};

  constructor(private readonly d: DiagServiceDeps) {
    this.stats = d.mode === "off" ? null : new PerfStats({ now: d.now, log: d.log, mode: d.mode });
  }

  start(): void {
    if (!this.stats || this.timer) return;
    setPerfStats(this.stats);
    try {
      this.hist = monitorEventLoopDelay({ resolution: WINDOW_RESOLUTION_MS });
      this.hist.enable();
    } catch (e) {
      this.d.log(`perf: event loop delay monitor unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.timer = setInterval(() => this.roll(), WINDOW_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.hist?.disable();
    this.hist = null;
    this.measureHist?.disable();
    this.measureHist = null;
    setPerfStats(null);
  }

  private eld(h: IntervalHistogram | null = this.hist, resolution = WINDOW_RESOLUTION_MS): EventLoopDelay | null {
    if (!h || h.count === 0) return null;
    return { p50: ms(h.percentile(50), resolution), p99: ms(h.percentile(99), resolution), max: ms(h.max, resolution) };
  }

  /** register.ts 的 handle 包装里调：invoke 的同步时间（也算进当前测量段）。 */
  invoke(channel: string, ms: number): void {
    this.stats?.invoke(channel, ms);
    this.measureInvokes.n += 1;
    this.measureInvokes.totalMs += ms;
  }

  roll(): void {
    if (!this.stats) return;
    this.stats.roll(this.eld());
    this.hist?.reset();
  }

  send(channel: string, args: readonly unknown[]): void {
    if (!this.stats) return;
    const data = args[1];
    const bytes = typeof data === "string" && channel === "pty:data" ? data.length : 0;
    this.stats.send(channel, bytes);
    const m = (this.measureSends[channel] ??= { n: 0, bytes: 0 });
    m.n += 1;
    m.bytes += bytes;
  }

  private cpuSince(): Record<string, number> {
    const now = this.d.cpuTimes?.() ?? {};
    const out: Record<string, number> = {};
    for (const [type, sec] of Object.entries(now)) out[type] = Math.round((sec - (this.measureCpu[type] ?? 0)) * 100) / 100;
    return out;
  }

  report(r: unknown): void {
    this.stats?.renderer(r as RendererReport);
  }

  /** resetMeasure：读完以后重新开始一段测量。 */
  snapshot(resetMeasure = false): DiagSnapshot | null {
    if (!this.stats) return null;
    const now = this.d.now();
    const snap: DiagSnapshot = {
      mode: this.d.mode, current: this.stats.current(), history: this.stats.history(), eld: this.eld(),
      measure: {
        sinceMs: this.measureStart === null ? 0 : now - this.measureStart,
        eld: this.eld(this.measureHist, MEASURE_RESOLUTION_MS),
        sends: structuredClone(this.measureSends),
        invokes: { n: this.measureInvokes.n, totalMs: Math.round(this.measureInvokes.totalMs) },
        cpuSec: this.cpuSince(),
      },
    };
    if (resetMeasure) {
      this.measureStart = now;
      this.measureSends = {};
      this.measureInvokes = { n: 0, totalMs: 0 };
      this.measureCpu = this.d.cpuTimes?.() ?? {};
      if (!this.measureHist) {
        try {
          this.measureHist = monitorEventLoopDelay({ resolution: MEASURE_RESOLUTION_MS });
          this.measureHist.enable();
        } catch {
          this.measureHist = null;
        }
      } else this.measureHist.reset();
    }
    return snap;
  }

  async build(): Promise<DiagnosticsFile> {
    const now = this.d.now();
    return buildDiagnostics({
      ...this.d.info(),
      now, mode: this.d.mode,
      current: this.stats?.current() ?? { start: now, end: now, eld: null, sends: {}, invokes: {}, ops: {}, renderer: { longTasks: 0, totalMs: 0, maxMs: 0, xterm: null } },
      history: this.stats?.history() ?? [],
      logTail: await readLogTail(this.d.logFile),
    });
  }

  /** 导出：选了路径就写进去，返回路径；取消返回 null。 */
  async export(): Promise<string | null> {
    const stamp = new Date(this.d.now()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const path = await this.d.pickSavePath(`butler-diagnostics-${stamp}.json`);
    if (!path) return null;
    await this.d.writeFile(path, `${JSON.stringify(await this.build(), null, 2)}\n`);
    this.d.log(`perf: diagnostics exported to ${path}`);
    return path;
  }
}
