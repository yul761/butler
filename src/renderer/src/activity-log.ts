// 推过来的 activity:event，从启动起一直收（BTL-242）。新的工具调用只算 quiet，不再让界面重取 nowView，
// 实况窗口靠推送补上最近几条；它没挂着时（用户在 ticket 页）推来的也得留着，不然回到首页卡片上缺了中间那几条，
// 要等下一次 visible 的变化才补上。
import { useSyncExternalStore } from "react";
import type { ActivityEvent } from "../../shared/activity";
import { api } from "./api";

/** 留最近这么多条（所有 session 合起来）。 */
export const ACTIVITY_LOG_LIMIT = 200;

export class ActivityLog {
  private events: ActivityEvent[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly limit: number) {}

  push(e: ActivityEvent): void {
    this.events = [...this.events, e].slice(-this.limit);
    for (const fn of this.listeners) fn();
  }

  /** 同一份数组，直到有新的进来。 */
  snapshot(): ActivityEvent[] {
    return this.events;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

let log: ActivityLog | null = null;

/** 开始收（main.tsx 启动时调一次）。 */
export function startActivityLog(): void {
  if (log) return;
  const l = new ActivityLog(ACTIVITY_LOG_LIMIT);
  log = l;
  api.onActivityEvent((e) => l.push(e));
}

const EMPTY: ActivityEvent[] = [];
const subscribe = (fn: () => void): (() => void) => log?.subscribe(fn) ?? (() => {});
const snapshot = (): ActivityEvent[] => log?.snapshot() ?? EMPTY;

/** 启动以来推过来的事件（最近 ACTIVITY_LOG_LIMIT 条）。 */
export function useActivityLog(): ActivityEvent[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
