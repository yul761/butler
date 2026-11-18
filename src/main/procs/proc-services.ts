import { execFile } from "node:child_process";
import { isWorking, type SessionActivity } from "../../shared/activity";
import type { MemorySamplesRepo } from "../db/memory-samples-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import type { SettingsRepo } from "../db/settings-repo";
import { backgroundPriorityOn, memoryMonitorOn, orphanCleanupOn, refreshMemoryMb } from "../settings/settings-values";
import { MemoryMonitor, type AppMetric } from "./memory-monitor";
import { MemoryRefresh } from "./memory-refresh";
import { OrphanSweeper, platformKill } from "./orphans";
import { platformBackend, PriorityManager } from "./priority";
import { readProcTable } from "./proc-table";
import { readSystemMemory } from "./system-memory";

/**
 * WS-M 的进程相关服务装在一起（A 监控、E 优先级、F 孤儿、G 内存换新），index.ts 只调这里。
 * 全部跟着一个 60 秒的采样走；hook 的顺序：孤儿记录 → 优先级 → 内存换新。
 */
export interface ProcServicesDeps {
  settings: SettingsRepo;
  sessions: Pick<SessionsRepo, "head" | "setMemory">;
  samples: MemorySamplesRepo;
  pty: { openIds(): string[]; pid(termId: string): number | null };
  activity: (head: string) => SessionActivity | null;
  refresher: { precheck(id: string, trigger: "auto"): unknown; refresh(id: string, trigger: "auto"): Promise<unknown>; isRefreshing(id: string): boolean };
  appMetrics: () => AppMetric[];
  /** 主窗口在屏幕上（没最小化、没藏到托盘）。 */
  windowShown: () => boolean;
  ownedFile: string;
  platform?: NodeJS.Platform;
  log: (msg: string, err?: unknown) => void;
  /** 「现在」页的内存读数变了：发 stateChanged。 */
  changed: () => void;
}

export interface ProcServices {
  monitor: MemoryMonitor;
  priority: PriorityManager;
  orphans: OrphanSweeper;
  /** 渲染进程报的终端可见性。出现在屏幕上时那棵树马上恢复优先级。 */
  terminalVisible(termId: string, visible: boolean): void;
  /** claude 收下一条输入（UserPromptSubmit）或者用户在终端里打字：马上恢复优先级。 */
  terminalActive(termId: string): void;
  /** 主窗口又出现在屏幕上（show / restore）：看得见的终端马上恢复优先级。 */
  windowShown(): void;
  /** 终端结束：清它留下的孤儿。 */
  terminalExited(termId: string): void;
  start(): void;
  /** 退出前：停采样，恢复改过的优先级。 */
  stop(): Promise<void>;
}

/** 停着：回合结束、没有后台命令、没在等确认。 */
export const idleActivity = (a: SessionActivity | null): boolean => a !== null && !isWorking(a) && a.kind !== "approval" && !a.background;

export function createProcServices(d: ProcServicesDeps): ProcServices {
  const platform = d.platform ?? process.platform;
  const visible = new Set<string>();
  const monitor = new MemoryMonitor({
    terms: () =>
      d.pty.openIds().flatMap((termId) => {
        const pid = d.pty.pid(termId);
        const head = d.sessions.head(termId);
        return pid !== null && head ? [{ termId, head: head.id, pid }] : [];
      }),
    appMetrics: d.appMetrics,
    mainPid: process.pid,
    readTable: () => readProcTable(platform),
    readSystem: () => readSystemMemory(platform),
    enabled: () => memoryMonitorOn(d.settings) || backgroundPriorityOn(d.settings) || orphanCleanupOn(d.settings),
    recordOn: () => memoryMonitorOn(d.settings),
    sessions: d.sessions,
    samples: d.samples,
    now: Date.now,
    log: d.log,
    changed: d.changed,
  });
  const orphans = new OrphanSweeper({
    enabled: () => orphanCleanupOn(d.settings),
    readTable: () => readProcTable(platform),
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
    // PR 2 的钉住接在这里。
    exempt: () => false,
    backend: platformBackend(platform),
    log: d.log,
  });
  const memRefresh = new MemoryRefresh({
    enabled: () => memoryMonitorOn(d.settings),
    limitMb: () => refreshMemoryMb(d.settings),
    precheck: (head) => d.refresher.precheck(head, "auto"),
    refresh: (head) => d.refresher.refresh(head, "auto"),
    refreshing: (head) => d.refresher.isRefreshing(head),
    now: Date.now,
    log: d.log,
  });
  monitor.onSample((s) => orphans.onSample(s));
  monitor.onSample((s) => priority.onSample(s));
  monitor.onSample((s) => memRefresh.onSample(s));

  const restore = (termId: string): void => void priority.restoreTerm(termId).catch((e: unknown) => d.log("restoring priority failed", e));
  return {
    monitor,
    priority,
    orphans,
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
    terminalExited: (termId) => {
      visible.delete(termId);
      void orphans.termExited(termId).catch((e: unknown) => d.log("orphan cleanup failed", e));
    },
    start: () => {
      void orphans.sweepAtStartup().catch((e: unknown) => d.log("orphan startup sweep failed", e));
      monitor.start();
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
