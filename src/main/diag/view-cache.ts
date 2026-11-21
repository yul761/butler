// 视图缓存（BTL-242）：ticket、feature、epic 的视图和看板的输入，在下一次 notify、任何写操作或 ttl 到了之前共用同一份。
// 渲染进程一次刷新会要 listTickets、listFeatures、listEpics、nowView、turnBoard（有的还要好几次），原来每个都重新拼一遍 allTicketViews。
// 返回的是同一个对象：调用的地方不能改它（IPC 送出去时会序列化一份）。

export interface ViewCacheDeps {
  now: () => number;
  /** 最多用这么久，防止漏了 notify 的写操作让界面一直是旧的。 */
  ttlMs?: number;
}

export class ViewCache {
  private gen = 0;
  private readonly entries = new Map<string, { gen: number; at: number; value: unknown }>();
  private readonly ttlMs: number;

  constructor(private readonly d: ViewCacheDeps) {
    this.ttlMs = d.ttlMs ?? 1000;
  }

  invalidate(): void {
    this.gen += 1;
    this.entries.clear();
  }

  get<T>(key: string, build: () => T): T {
    const now = this.d.now();
    const e = this.entries.get(key);
    if (e && e.gen === this.gen && now - e.at < this.ttlMs) return e.value as T;
    const gen = this.gen;
    const value = build();
    // 拼的时候作废了：这一份可能是旧的，这次照样返回，但不留下。
    if (gen === this.gen) this.entries.set(key, { gen, at: now, value });
    return value;
  }

  wrap<T>(key: string, build: () => T): () => T {
    return () => this.get(key, build);
  }
}
