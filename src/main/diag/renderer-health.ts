// 渲染进程的健康记录（BTL-262）：崩溃（render-process-gone）记下原因和退出码，自动重新加载，但有频率限制；
// 卡住（unresponsive）和恢复（responsive）也记下来。全部进导出诊断（BTL-242 查 Windows 卡顿要用）。

/** 5 分钟里最多自动重新加载 3 次；再崩就停下，交给用户。 */
export const RELOAD_WINDOW_MS = 5 * 60_000;
export const MAX_RELOADS = 3;
/** 崩了以后等一下再重新加载：别跟正在退出的进程抢，也别在一个立即崩的页面上打转。 */
export const RELOAD_DELAY_MS = 1000;
/** 诊断里最多留这么多条。 */
export const MAX_EVENTS = 50;

export type RendererEvent =
  | { at: number; kind: "gone"; reason: string; exitCode: number; action: "reload" | "gave-up" | "none" }
  | { at: number; kind: "unresponsive" }
  | { at: number; kind: "responsive"; afterMs: number | null }
  | { at: number; kind: "reloaded"; by: "auto" | "user" };

/** 导出用：时间换成 ISO 字符串（按每种事件分开 Omit，保留 kind 的区分）。 */
export type RendererEventOut = RendererEvent extends infer E ? (E extends RendererEvent ? Omit<E, "at"> & { at: string } : never) : never;

export interface RendererHealthDeps {
  now: () => number;
  log: (line: string) => void;
  /** 重新加载界面（webContents.reload()）。 */
  reload: () => void;
  /** 次数用完了：停下，告诉用户（主进程的对话框，界面已经没了）。 */
  gaveUp: (info: { reason: string; exitCode: number; reloads: number }) => void;
  /** 正在退出：不重新加载。 */
  quitting?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  maxReloads?: number;
  windowMs?: number;
  delayMs?: number;
}

export class RendererHealth {
  private readonly list: RendererEvent[] = [];
  private reloads: number[] = [];
  private unresponsiveSince: number | null = null;
  private pending: unknown = null;
  private stopped = false;

  constructor(private readonly d: RendererHealthDeps) {}

  private push(e: RendererEvent): void {
    this.list.push(e);
    if (this.list.length > MAX_EVENTS) this.list.splice(0, this.list.length - MAX_EVENTS);
  }

  /** render-process-gone。clean-exit（窗口正常关掉）和退出时不重新加载。 */
  gone(details: { reason: string; exitCode: number }): void {
    const now = this.d.now();
    const windowMs = this.d.windowMs ?? RELOAD_WINDOW_MS;
    const max = this.d.maxReloads ?? MAX_RELOADS;
    this.unresponsiveSince = null;
    this.reloads = this.reloads.filter((t) => now - t < windowMs);
    let action: "reload" | "gave-up" | "none";
    if (details.reason === "clean-exit" || this.d.quitting?.() || this.pending !== null) action = "none";
    else if (this.stopped || this.reloads.length >= max) action = "gave-up";
    else action = "reload";
    this.push({ at: now, kind: "gone", reason: details.reason, exitCode: details.exitCode, action });
    this.d.log(`renderer: process gone (reason=${details.reason}, exitCode=${details.exitCode}); ${
      action === "reload" ? `reloading (${this.reloads.length + 1}/${max} in ${Math.round(windowMs / 60_000)} min)` : action === "gave-up" ? `not reloading: ${this.reloads.length} reloads in ${Math.round(windowMs / 60_000)} min` : "not reloading"
    }`);
    if (action === "reload") {
      this.reloads.push(now);
      const setTimer = this.d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
      this.pending = setTimer(() => {
        this.pending = null;
        if (this.d.quitting?.()) return;
        this.push({ at: this.d.now(), kind: "reloaded", by: "auto" });
        try {
          this.d.reload();
        } catch (e) {
          this.d.log(`renderer: reload failed (${e instanceof Error ? e.message : String(e)})`);
        }
      }, this.d.delayMs ?? RELOAD_DELAY_MS);
    } else if (action === "gave-up" && !this.stopped) {
      this.stopped = true;
      this.d.gaveUp({ reason: details.reason, exitCode: details.exitCode, reloads: this.reloads.length });
    }
  }

  /** 用户在提示里点了「重新加载」：重新开始计数。 */
  userReload(): void {
    this.stopped = false;
    this.reloads = [];
    this.push({ at: this.d.now(), kind: "reloaded", by: "user" });
    this.d.log("renderer: reloading at the user's request");
    try {
      this.d.reload();
    } catch (e) {
      this.d.log(`renderer: reload failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  /** 崩掉的窗口被关掉以后，用户从托盘 / Dock 又打开了一个新窗口：重新开始计数。 */
  windowReopened(): void {
    this.stopped = false;
    this.reloads = [];
    this.push({ at: this.d.now(), kind: "reloaded", by: "user" });
    this.d.log("renderer: opening a new window at the user's request");
  }

  unresponsive(): void {
    const now = this.d.now();
    if (this.unresponsiveSince === null) this.unresponsiveSince = now;
    this.push({ at: now, kind: "unresponsive" });
    this.d.log("renderer: unresponsive");
  }

  responsive(): void {
    const now = this.d.now();
    const afterMs = this.unresponsiveSince === null ? null : now - this.unresponsiveSince;
    this.unresponsiveSince = null;
    this.push({ at: now, kind: "responsive", afterMs });
    this.d.log(`renderer: responsive again${afterMs === null ? "" : ` after ${afterMs} ms`}`);
  }

  /** 导出诊断用：最近的事件，时间换成 ISO。 */
  events(): RendererEventOut[] {
    return this.list.map((e) => ({ ...e, at: new Date(e.at).toISOString() }) as RendererEventOut);
  }

  dispose(): void {
    if (this.pending !== null) (this.d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.pending);
    this.pending = null;
  }
}
