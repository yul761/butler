// notify() 的合并（BTL-242）：一段时间里的多次 notify 合成一次 state:changed（带上所有范围），
// turn:changed 也在同一次里发。原来每次 notify 立刻推一次，3 个在干活的 session 一秒能推七八次，每次渲染进程都重取一大堆。
import type { StateScope } from "../../shared/state-scope";

export interface InvalidatorDeps {
  /** 合并后发出去（state:changed 和 turn:changed）。 */
  emit: (scopes: StateScope[]) => void;
  /** 每次 notify 时马上调（视图缓存按它作废，不等合并）。 */
  onChange?: (scope: StateScope) => void;
  /** 最后一次 notify 之后这么久没有新的就发。 */
  quietMs?: number;
  /** 第一次 notify 之后最多等这么久。 */
  maxWaitMs?: number;
  /**
   * 窗口现在看不看得见（BTL-275）：看不见（藏到托盘、最小化）时不发，范围攒着，窗口回来时 resume() 一次补发。
   * 渲染进程藏着时照样会按每次 state:changed 重取。视图缓存照旧每次 notify 马上作废。不给就当一直看得见。
   */
  visible?: () => boolean;
}

export class Invalidator {
  private pending = new Set<StateScope>();
  /** 窗口看不见时到点没发出去的范围：窗口回来（resume）或者看得见以后的下一次发送时一起发。 */
  private held = new Set<StateScope>();
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private max: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly quietMs: number;
  private readonly maxWaitMs: number;

  constructor(private readonly d: InvalidatorDeps) {
    this.quietMs = d.quietMs ?? 120;
    this.maxWaitMs = d.maxWaitMs ?? 250;
  }

  notify(scope: StateScope = "data"): void {
    if (this.disposed) return;
    this.d.onChange?.(scope);
    this.pending.add(scope);
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.flushNow(), this.quietMs);
    this.max ??= setTimeout(() => this.flushNow(), this.maxWaitMs);
  }

  flushNow(): void {
    this.clear();
    if (this.disposed || this.pending.size === 0) return;
    if (this.d.visible && !this.d.visible()) {
      for (const s of this.pending) this.held.add(s);
      this.pending = new Set();
      return;
    }
    const scopes = [...new Set([...this.held, ...this.pending])];
    this.held = new Set();
    this.pending = new Set();
    this.d.emit(scopes);
  }

  /** 窗口又看得见了（show / restore / focus）：把看不见时攒下的范围马上发一次。还看不见、或者没攒下什么，什么都不做。 */
  resume(): void {
    if (this.disposed || this.held.size === 0) return;
    for (const s of this.held) this.pending.add(s);
    this.held = new Set();
    this.flushNow();
  }

  private clear(): void {
    if (this.quiet) clearTimeout(this.quiet);
    if (this.max) clearTimeout(this.max);
    this.quiet = null;
    this.max = null;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    this.pending.clear();
    this.held.clear();
  }
}
