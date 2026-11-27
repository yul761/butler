import { execFile } from "node:child_process";
import { isWorking, type SessionActivity } from "../../shared/activity";
import type { MemorySamplesRepo } from "../db/memory-samples-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import type { SettingsRepo } from "../db/settings-repo";
import { backgroundPriorityOn, memoryMonitorOn, orphanCleanupOn, refreshMemoryMb } from "../settings/settings-values";
import { MemoryMonitor, sampleIntervalMs, type AppMetric, type MonitorSample } from "./memory-monitor";
import { MemoryRefresh } from "./memory-refresh";
import { OrphanSweeper, platformKill } from "./orphans";
import { platformBackend, PriorityManager } from "./priority";
import { procTableReader, sharedProcTable, type RunCommand, type TimedProcTable } from "./proc-table";
import { readSystemMemory } from "./system-memory";

/**
 * WS-M 的进程相关服务装在一起（A 监控、E 优先级、F 孤儿、G 内存换新），index.ts 只调这里。
 * 全部跟着一个 60 秒的采样走；hook 的顺序：孤儿记录 → 优先级 → 内存换新。
 */
export interface ProcServicesDeps {
  settings: SettingsRepo;
  sessions: Pick<SessionsRepo, "head" | "setMemoryMany">;
  samples: MemorySamplesRepo;
  pty: { openIds(): string[]; pid(termId: string): number | null };
  activity: (head: string) => SessionActivity | null;
  refresher: { precheck(id: string, trigger: "auto"): unknown; refresh(id: string, trigger: "auto"): Promise<unknown>; isRefreshing(id: string): boolean };
  appMetrics: () => AppMetric[];
  /** 主窗口在屏幕上（没最小化、没藏到托盘）。 */
  windowShown: () => boolean;
  ownedFile: string;
  /** 钉住的 session（head）：不降优先级（WS-M B 的「钉住」）。 */
  pinned?: (head: string) => boolean;
  /** 换新也没把内存降下来：结束再 --resume（Hibernator.restart，WS-M G）。 */
  restart?: (head: string) => Promise<unknown>;
  /** 每次采样（内存紧张时休眠，WS-M C）。 */
  onSample?: (s: MonitorSample) => void;
  /** 别的功能也要采样（内存紧张时休眠要系统的空闲内存）。 */
  sampleNeeded?: () => boolean;
  platform?: NodeJS.Platform;
  /** 跑 ps / PowerShell（测试换掉它）。 */
  run?: RunCommand;
  now?: () => number;
  log: (msg: string, err?: unknown) => void;
  /** 「现在」页的内存读数变了：发 stateChanged。 */
  changed: () => void;
}

export interface ProcServices {
  monitor: MemoryMonitor;
  priority: PriorityManager;
  orphans: OrphanSweeper;
  /** 最多 5 秒旧的整张进程表，和内存采样共用（BTL-275）：活动探测从这里读子孙进程的 CPU。要杀进程的地方别用它。 */
  table(): Promise<TimedProcTable | null>;
  /** 渲染进程报的终端可见性。出现在屏幕上时那棵树马上恢复优先级。 */
  terminalVisible(termId: string, visible: boolean): void;
  /** claude 收下一条输入（UserPromptSubmit）或者用户在终端里打字：马上恢复优先级。 */
  terminalActive(termId: string): void;
  /** 主窗口又出现在屏幕上（show / restore）：看得见的终端马上恢复优先级。 */
  windowShown(): void;
  /** 终端开了：过一会儿补采一次内存（「现在」页的 session 数马上对上）。 */
  terminalOpened(termId: string): void;
  /** 终端结束：清它留下的孤儿，过一会儿补采一次内存。 */
  terminalExited(termId: string): void;
  /** 渲染进程里看得见这个终端（不管主窗口在不在屏幕上：休眠只看它）。 */
  isVisible(termId: string): boolean;
  start(): void;
  /** 退出前：停采样，恢复改过的优先级。 */
  stop(): Promise<void>;
}

/** 停着：回合结束、没有后台命令、没在等确认。 */
export const idleActivity = (a: SessionActivity | null): boolean => a !== null && !isWorking(a) && a.kind !== "approval" && !a.background;

/** 共用进程表能旧多久。 */
export const SHARED_TABLE_MS = 5_000;

export function createProcServices(d: ProcServicesDeps): ProcServices {
  const platform = d.platform ?? process.platform;
  const visible = new Set<string>();
  // 采样和孤儿清理共用一个：失败原因只记一次。
  const readTable = procTableReader(platform, (m) => d.log(m), d.run);
  // 内存采样和活动探测共用一张最多 5 秒旧的表（BTL-275）；孤儿清理每次现读（要按它杀进程）。
  const table = sharedProcTable(readTable, { ttlMs: SHARED_TABLE_MS, now: d.now ?? Date.now });
  const monitor = new MemoryMonitor({
    terms: () =>
      d.pty.openIds().flatMap((termId) => {
        const pid = d.pty.pid(termId);
        const head = d.sessions.head(termId);
        return pid !== null && head ? [{ termId, head: head.id, pid }] : [];
      }),
    appMetrics: d.appMetrics,
    mainPid: process.pid,
    readTable: () => table().then((t) => t?.table ?? null),
    readSystem: () => readSystemMemory(platform),
    enabled: () => memoryMonitorOn(d.settings) || backgroundPriorityOn(d.settings) || orphanCleanupOn(d.settings) || !!d.sampleNeeded?.(),
    recordOn: () => memoryMonitorOn(d.settings),
    sessions: d.sessions,
    samples: d.samples,
    now: Date.now,
    log: d.log,
    changed: d.changed,
  });
  const orphans = new OrphanSweeper({
    enabled: () => orphanCleanupOn(d.settings),
    readTable,
    liveRoots: () => d.pty.openIds().flatMap((t) => d.pty.pid(t) ?? []),
    kill: platformKill(platform, (cmd, args) => void execFile(cmd, args, { windowsHide: true }, () => undefined)),
    file: d.ownedFile,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => d.log(m),
  });
  const priority = new PriorityManager({
    enabled: () => backgroundPriorityOn(d.settings),
    visible: (termId) => visible.has(termId) && d.windowShown(),
    idle: (head) => idleActivity(d.activity(head)),
    exempt: (head) => d.pinned?.(head) ?? false,
    backend: platformBackend(platform),
    log: d.log,
  });
  const memRefresh = new MemoryRefresh({
    enabled: () => memoryMonitorOn(d.settings),
    limitMb: () => refreshMemoryMb(d.settings),
    precheck: (head) => d.refresher.precheck(head, "auto"),
    refresh: (head) => d.refresher.refresh(head, "auto"),
    refreshing: (head) => d.refresher.isRefreshing(head),
    restart: d.restart,
    now: Date.now,
    log: d.log,
  });
  monitor.onSample((s) => orphans.onSample(s));
  monitor.onSample((s) => priority.onSample(s));
  monitor.onSample((s) => memRefresh.onSample(s));
  if (d.onSample) monitor.onSample(d.onSample);

  const restore = (termId: string): void => void priority.restoreTerm(termId).catch((e: unknown) => d.log("restoring priority failed", e));
  return {
    monitor,
    priority,
    orphans,
    table,
    terminalVisible: (termId, v) => {
      if (v) {
        visible.add(termId);
        restore(termId);
      } else visible.delete(termId);
    },
    terminalActive: restore,
    windowShown: () => {
      for (const termId of visible) restore(termId);
    },
    isVisible: (termId) => visible.has(termId),
    terminalOpened: () => monitor.soon(),
    terminalExited: (termId) => {
      visible.delete(termId);
      void orphans.termExited(termId).catch((e: unknown) => d.log("orphan cleanup failed", e));
      monitor.soon();
    },
    start: () => {
      void orphans.sweepAtStartup().catch((e: unknown) => d.log("orphan startup sweep failed", e));
      monitor.start(sampleIntervalMs(platform));
      // 启动后很快采第一次（「现在」页不用等一分钟才有数）。
      setTimeout(() => void monitor.tick(), 5_000).unref?.();
    },
    stop: async () => {
      monitor.stop();
      priority.close();
      await priority.restoreAll().catch((e: unknown) => d.log("restoring priority failed", e));
    },
  };
}
