import type { MonitorSample } from "./memory-monitor";

/**
 * 内存过大时换新（WS-M G，设计 §9）：只看 claude 本身（MCP、dev server 换新也不会变小）。
 * 超过上限就在下一个停下来的时候换新（precheck 不过就等下一次采样再试，等于「下一个空闲点」）。
 * 换新完的下一次采样还在上限的 80% 以上：换新没用（多半是 claude 自己的堆），交给 restart（PR 2 的休眠再唤醒），没有 restart 就记一笔。
 * 每个终端 6 小时内最多换新一次、重启一次，不会来回折腾。按终端认：换新以后 head 变了，终端还是那个。
 */
export const MEMORY_REFRESH_COOLDOWN_MS = 6 * 3600_000;
const STILL_HIGH = 0.8;

export interface MemoryRefreshDeps {
  enabled(): boolean;
  limitMb(): number;
  /** SessionRefresher.precheck(head, "auto")：null 表示现在可以开始。 */
  precheck(head: string): unknown;
  refresh(head: string): Promise<unknown>;
  refreshing(head: string): boolean;
  /** PR 2：结束再 --resume（休眠模块的 restart）。没有时只记日志。 */
  restart?: (head: string) => Promise<unknown>;
  now(): number;
  log(msg: string, err?: unknown): void;
}

export class MemoryRefresh {
  private readonly refreshedAt = new Map<string, number>();
  private readonly restartedAt = new Map<string, number>();
  /** 换新开始了、还没在换新完以后看过内存的终端。 */
  private readonly checking = new Set<string>();

  constructor(private readonly d: MemoryRefreshDeps) {}

  onSample(s: MonitorSample): void {
    const open = new Set(s.terms.map((t) => t.termId));
    for (const id of [...this.checking]) if (!open.has(id)) this.checking.delete(id);
    if (!this.d.enabled()) return;
    const limitKb = this.d.limitMb() * 1024;
    if (!(limitKb > 0)) return;
    const now = this.d.now();
    for (const t of s.terms) {
      const kb = t.summary.byClass.claude;
      if (this.checking.has(t.termId)) {
        if (this.d.refreshing(t.head)) continue;
        this.checking.delete(t.termId);
        if (kb <= limitKb * STILL_HIGH) continue;
        if (now - (this.restartedAt.get(t.termId) ?? -Infinity) < MEMORY_REFRESH_COOLDOWN_MS) continue;
        this.restartedAt.set(t.termId, now);
        if (!this.d.restart) {
          this.d.log(`memory refresh: ${t.head} still uses ${Math.round(kb / 1024)} MB after a refresh`);
          continue;
        }
        this.d.log(`memory refresh: ${t.head} still uses ${Math.round(kb / 1024)} MB after a refresh, restarting it`);
        this.d.restart(t.head).catch((e: unknown) => this.d.log(`memory restart ${t.head} failed`, e));
        continue;
      }
      if (kb <= limitKb) continue;
      if (now - (this.refreshedAt.get(t.termId) ?? -Infinity) < MEMORY_REFRESH_COOLDOWN_MS) continue;
      if (this.d.precheck(t.head) !== null) continue;
      this.refreshedAt.set(t.termId, now);
      this.checking.add(t.termId);
      this.d.log(`memory refresh: ${t.head} uses ${Math.round(kb / 1024)} MB (limit ${this.d.limitMb()} MB), refreshing it`);
      this.d.refresh(t.head).catch((e: unknown) => this.d.log(`memory refresh ${t.head} failed`, e));
    }
  }
}
