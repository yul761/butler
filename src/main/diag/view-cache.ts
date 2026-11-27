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
  /** 只作废了这几个 key（invalidate(keys)）的次数。 */
  private readonly keyGen = new Map<string, number>();
  private readonly entries = new Map<string, { gen: string; at: number; value: unknown }>();
  private readonly ttlMs: number;

  constructor(private readonly d: ViewCacheDeps) {
    this.ttlMs = d.ttlMs ?? 1000;
  }

  /** 不给 keys：全部作废。给了：只作废这几个（BTL-265：按 state:changed 的范围，见 view-scopes.ts）。 */
  invalidate(keys?: readonly string[]): void {
    if (keys === undefined) {
      this.gen += 1;
      this.entries.clear();
      return;
    }
    for (const k of keys) {
      this.keyGen.set(k, (this.keyGen.get(k) ?? 0) + 1);
      this.entries.delete(k);
    }
  }

  get<T>(key: string, build: () => T): T {
    const now = this.d.now();
    const e = this.entries.get(key);
    const gen = this.genOf(key);
    if (e && e.gen === gen && now - e.at < this.ttlMs) return e.value as T;
    const value = build();
    // 拼的时候作废了：这一份可能是旧的，这次照样返回，但不留下。
    if (gen === this.genOf(key)) this.entries.set(key, { gen, at: now, value });
    return value;
  }

  /** 视图还取决于一个参数（BTL-275：now:view 带着最近的合并）：参数（签名）一样才用缓存的，不一样就重拼、换掉。 */
  getFor<T>(key: string, sig: string, build: () => T): T {
    const hit = this.get(key, () => ({ sig, value: build() }));
    if (hit.sig === sig) return hit.value;
    this.entries.delete(key);
    return this.get(key, () => ({ sig, value: build() })).value;
  }

  wrap<T>(key: string, build: () => T): () => T {
    return () => this.get(key, build);
  }

  private genOf(key: string): string {
    return `${this.gen}:${this.keyGen.get(key) ?? 0}`;
  }
}
