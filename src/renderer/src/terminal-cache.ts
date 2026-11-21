// 终端留着不拆（BTL-242）：最近看过的几个终端的 xterm 留在内存里，切回来只把它挂回页面、量一下尺寸，不再从快照重放。
// 原来每次切走就 dispose、切回来按 256 KB 的快照重建，Windows 上一次要好几百毫秒。挂在页面上的（pinned）不会被挤掉。

/** 最多留几个（WS-M D 的内存目标：不是每个开着的终端都有 xterm）。 */
export const TERMINAL_CACHE_MAX = 4;

export class LruCache<T> {
  private readonly entries = new Map<string, T>();
  private readonly pins = new Map<string, number>();

  constructor(
    private readonly max: number,
    private readonly dispose: (key: string, value: T) => void,
  ) {}

  /** 挂上页面：取出（没有就用 make 建一个）、标成最近用过、钉住（挂着的不会被挤掉）。 */
  acquire(key: string, make: () => T): T {
    let v = this.entries.get(key);
    if (v === undefined) v = make();
    else this.entries.delete(key);
    this.entries.set(key, v);
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
    this.evict();
    return v;
  }

  /** 从页面上摘下；这时超出的才会被挤掉（最久没用的先走）。 */
  release(key: string): void {
    const n = (this.pins.get(key) ?? 0) - 1;
    if (n > 0) this.pins.set(key, n);
    else this.pins.delete(key);
    this.evict();
  }

  /** 马上拆掉（终端关了）；还挂着的不拆。 */
  drop(key: string): void {
    const v = this.entries.get(key);
    if (v === undefined || this.pins.has(key)) return;
    this.entries.delete(key);
    this.dispose(key, v);
  }

  peek(key: string): T | undefined {
    return this.entries.get(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  private evict(): void {
    for (const key of [...this.entries.keys()]) {
      if (this.entries.size <= this.max) return;
      if (this.pins.has(key)) continue;
      const v = this.entries.get(key) as T;
      this.entries.delete(key);
      this.dispose(key, v);
    }
  }
}
