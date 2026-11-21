import { BUTLER_PARTS, type ButlerPart, type MemoryHistoryPoint, type MemorySnapshot, type SessionMemory } from "../../shared/mem-usage";
import type { MemorySampleRow } from "../db/memory-samples-repo";
import { butlerPartOf, childrenIndex, classifyTree, summarize, treeOf, type ProcTable, type TreeProc, type TreeSummary } from "./proc-table";
import type { SystemMemory } from "./system-memory";
import { perfOpAsync } from "../diag/perf-stats";

/** 采样间隔（设计 §2）。 */
export const SAMPLE_INTERVAL_MS = 60_000;
/** Windows 上每次采样是一次 PowerShell（Get-CimInstance Win32_Process），又慢又占 CPU：两分钟一次（BTL-242）。 */
export const WIN_SAMPLE_INTERVAL_MS = 120_000;

export function sampleIntervalMs(platform: NodeJS.Platform): number {
  return platform === "win32" ? WIN_SAMPLE_INTERVAL_MS : SAMPLE_INTERVAL_MS;
}
/** 每几次采样写一次历史（5 分钟一个点）。 */
export const HISTORY_EVERY = 5;
/** 历史留多久。 */
export const HISTORY_KEEP_MS = 14 * 24 * 3600_000;
/** 开了或关了一个终端以后多久补采一次（给 claude 起子进程的时间）。 */
export const SOON_MS = 3_000;
/** 两次补采之间至少隔这么久（BTL-242）：一下子开好几个终端时，Windows 上每次补采都要起一个 PowerShell。 */
export const SOON_GAP_MS = 20_000;
/** 每几次采样清一次过期历史（大约一小时）。 */
const PRUNE_EVERY = 60;

/** 一个开着的终端：termId、它现在的 head 和终端里那个进程的 pid。 */
export interface MonitorTerm {
  termId: string;
  head: string;
  pid: number;
}

/** Electron 的 app.getAppMetrics() 里需要的部分；kb 是工作集。 */
export interface AppMetric {
  pid: number;
  type: string;
  kb: number;
}

export interface TermSample extends MonitorTerm {
  tree: TreeProc[];
  summary: TreeSummary;
}

/** 一次采样：给 E（优先级）、F（孤儿）、G（内存换新）以及 PR 2 的休眠和内存压力用。 */
export interface MonitorSample {
  at: number;
  table: ProcTable;
  children: Map<number, number[]>;
  terms: TermSample[];
  system: SystemMemory | null;
  snapshot: MemorySnapshot;
}

export type SampleHook = (s: MonitorSample) => void | Promise<void>;

export interface MemoryMonitorDeps {
  terms(): MonitorTerm[];
  appMetrics(): AppMetric[];
  mainPid: number;
  readTable(): Promise<ProcTable | null>;
  readSystem(): Promise<SystemMemory | null>;
  /** 有任何一项要采样（A、E、F、G 和以后的 B、C）：都关着就不读进程表。 */
  enabled(): boolean;
  /** 「内存监控」开着：记 sessions.mem_kb、写历史、「现在」页显示。 */
  recordOn(): boolean;
  sessions: { setMemory(id: string, kb: number, at: number): void };
  samples: { insertMany(rows: MemorySampleRow[]): void; prune(before: number): number; since(since: number): MemorySampleRow[] };
  now(): number;
  log(msg: string, err?: unknown): void;
  /**
   * 「现在」页上的读数变了（记下一次采样，或者监控关掉、卡片要收起）。主进程接到后发 stateChanged：
   * 「现在」页只在 stateChanged 时重取，不通知的话比最后一个 hook 事件晚到的采样要等下一次事件才显示。
   */
  changed(): void;
  /** 两次补采之间的最小间隔，默认 SOON_GAP_MS。 */
  soonGapMs?: number;
}

/** Electron 的进程类型对应到哪一份。 */
function partOfMetric(type: string): ButlerPart {
  if (type === "Browser") return "main";
  if (type === "Tab") return "renderer";
  if (type === "GPU") return "gpu";
  return "utility";
}

const emptyParts = (): Record<ButlerPart, number> => Object.fromEntries(BUTLER_PARTS.map((p) => [p, 0])) as Record<ButlerPart, number>;

/**
 * 内存监控（WS-M A，设计 §2）：每分钟读一次整张进程表，算每个开着的 session 的整棵树和 Butler 自己的进程，读系统可用内存。
 * 最近一次的结果给「现在」页，每 5 次写一次历史；采样结果再交给注册的 hook（优先级、孤儿、换新……）。一次采样没结束不起下一次。
 */
export class MemoryMonitor {
  private latest = new Map<string, SessionMemory>();
  private snap: MemorySnapshot | null = null;
  private count = 0;
  private running = false;
  /** stop() 以后：还在跑的那次采样读完表就停，不再写库、不再调 hook（退出时数据库可能已经关了）。 */
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private soonTimer: ReturnType<typeof setTimeout> | null = null;
  /** soon() 到点时正好有一次采样在跑：它可能是在终端开之前读的表，跑完再采一次。 */
  private again = false;
  /** 上一次补采的时间。 */
  private lastSoonAt = Number.NEGATIVE_INFINITY;
  private readonly hooks: SampleHook[] = [];

  constructor(private readonly d: MemoryMonitorDeps) {}

  onSample(hook: SampleHook): void {
    this.hooks.push(hook);
  }

  start(intervalMs = SAMPLE_INTERVAL_MS): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.soonTimer = null;
    this.again = false;
  }

  /**
   * 开了或关了一个终端：过 delayMs 补采一次，「现在」页的 session 数和读数不用等到下一分钟（每分钟一次的采样
   * 可能正好在终端开之前）。连着来的几次只采一次。
   */
  soon(delayMs = SOON_MS): void {
    if (this.stopped || this.soonTimer) return;
    // 离上一次补采不到 soonGapMs：推到满了再采（不丢，读数还是会更新）。
    const wait = Math.max(delayMs, this.lastSoonAt + (this.d.soonGapMs ?? SOON_GAP_MS) - this.d.now());
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      this.lastSoonAt = this.d.now();
      if (this.running) this.again = true;
      else void this.tick();
    }, wait);
    this.soonTimer.unref?.();
  }

  /** 这个 head 最近一次的读数；监控关着或没采到为 null。 */
  memoryOf(head: string): SessionMemory | null {
    return this.d.recordOn() ? (this.latest.get(head) ?? null) : null;
  }

  snapshot(): MemorySnapshot | null {
    return this.d.recordOn() ? this.snap : null;
  }

  /** since 以后的历史，每个时间点一个：Butler、所有 session 加起来、系统可用百分比。 */
  history(since: number): MemoryHistoryPoint[] {
    const points = new Map<number, MemoryHistoryPoint>();
    for (const r of this.d.samples.since(since)) {
      const p = points.get(r.at) ?? { at: r.at, butlerKb: 0, sessionsKb: 0, freePercent: null };
      if (r.kind === "butler") p.butlerKb += r.totalKb;
      else if (r.kind === "session") p.sessionsKb += r.totalKb;
      else if (r.detail && typeof r.detail.freePercent === "number") p.freePercent = r.detail.freePercent;
      points.set(r.at, p);
    }
    return [...points.values()].sort((a, b) => a.at - b.at);
  }

  /** 采一次；关着、上一次还没完或者进程表读不到时返回 null。 */
  async tick(): Promise<MonitorSample | null> {
    if (this.running || this.stopped || !this.d.enabled()) return null;
    this.running = true;
    try {
      return await perfOpAsync("procs.sample", () => this.sample());
    } catch (e) {
      this.d.log("memory sample failed", e);
      return null;
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        void this.tick();
      }
    }
  }

  private async sample(): Promise<MonitorSample | null> {
    const [table, system] = await Promise.all([this.d.readTable(), this.d.readSystem().catch(() => null)]);
    if (!table || this.stopped) return null;
    const at = this.d.now();
    const children = childrenIndex(table);
    const terms: TermSample[] = [];
    const inSessions = new Set<number>();
    for (const t of this.d.terms()) {
      const tree = classifyTree(t.pid, table, children);
      if (tree.length === 0) continue;
      for (const p of tree) inSessions.add(p.pid);
      terms.push({ ...t, tree, summary: summarize(tree) });
    }
    const snapshot = this.butlerSnapshot(at, table, children, inSessions, terms, system);
    const sample: MonitorSample = { at, table, children, terms, system, snapshot };
    this.record(sample);
    for (const hook of this.hooks) {
      if (this.stopped) break;
      try {
        await hook(sample);
      } catch (e) {
        this.d.log("memory sample hook failed", e);
      }
    }
    return sample;
  }

  /**
   * Butler 自己：Electron 报的各个进程（主进程、渲染、GPU、utility），加上主进程下面不在任何 session 树里的进程
   * （共享 MCP、无头 claude 和它的子进程、Windows 的终端宿主）。Electron 报过的进程不再从进程表重复算。
   */
  private butlerSnapshot(at: number, table: ProcTable, children: Map<number, number[]>, inSessions: Set<number>, terms: TermSample[], system: SystemMemory | null): MemorySnapshot {
    const parts = emptyParts();
    const electron = new Set<number>();
    for (const m of this.d.appMetrics()) {
      electron.add(m.pid);
      parts[partOfMetric(m.type)] += m.kb;
    }
    for (const c of children.get(this.d.mainPid) ?? []) {
      if (electron.has(c) || inSessions.has(c)) continue;
      const proc = table.get(c);
      if (!proc) continue;
      const part = butlerPartOf(proc.args);
      for (const p of treeOf(c, table, children)) if (!electron.has(p.pid) && !inSessions.has(p.pid)) parts[part] += p.rssKb;
    }
    const butlerKb = Object.values(parts).reduce((a, b) => a + b, 0);
    return {
      at,
      butlerKb,
      butler: parts,
      sessionsKb: terms.reduce((n, t) => n + t.summary.totalKb, 0),
      sessions: terms.length,
      butlerMcpKb: terms.reduce((n, t) => n + t.summary.byClass.mcp_butler, 0),
      system: system ? { totalKb: system.totalKb, freeKb: system.freeKb, freePercent: system.freePercent } : null,
    };
  }

  private record(s: MonitorSample): void {
    if (!this.d.recordOn()) {
      const shown = this.snap !== null || this.latest.size > 0;
      this.latest.clear();
      this.snap = null;
      if (shown) this.d.changed();
      return;
    }
    this.latest = new Map(s.terms.map((t) => [t.head, { ...t.summary, at: s.at }]));
    this.snap = s.snapshot;
    for (const t of s.terms) this.d.sessions.setMemory(t.head, t.summary.totalKb, s.at);
    this.count++;
    if (this.count % HISTORY_EVERY === 1) {
      const rows: MemorySampleRow[] = [
        ...s.terms.map((t) => ({ at: s.at, kind: "session" as const, sessionId: t.head, totalKb: t.summary.totalKb, detail: { ...t.summary.byClass } })),
        { at: s.at, kind: "butler", sessionId: null, totalKb: s.snapshot.butlerKb, detail: { ...s.snapshot.butler } },
        ...(s.system ? [{ at: s.at, kind: "system" as const, sessionId: null, totalKb: s.system.freeKb, detail: { totalKb: s.system.totalKb, freePercent: s.system.freePercent } }] : []),
      ];
      this.d.samples.insertMany(rows);
    }
    if (this.count % PRUNE_EVERY === 1) this.d.samples.prune(s.at - HISTORY_KEEP_MS);
    this.d.changed();
  }
}
