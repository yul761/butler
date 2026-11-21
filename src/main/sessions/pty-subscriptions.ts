// 渲染进程挂着哪些终端（BTL-242）：pty:data 只发给挂着的。原来每个终端的每一块输出都发过去，渲染进程再按 id 丢掉。
// pty:snapshot 挂上（+1），pty:detach 摘下（-1）：同一个终端可能同时挂着两份（快照的回复排在之前发出的数据后面，顺序不变）。
export class PtySubscriptions {
  private readonly counts = new Map<string, number>();

  attach(termId: string): void {
    this.counts.set(termId, (this.counts.get(termId) ?? 0) + 1);
  }

  detach(termId: string): void {
    const n = (this.counts.get(termId) ?? 0) - 1;
    if (n > 0) this.counts.set(termId, n);
    else this.counts.delete(termId);
  }

  has(termId: string): boolean {
    return this.counts.has(termId);
  }

  /** 渲染进程重新加载了：之前挂的都不算了。 */
  clear(): void {
    this.counts.clear();
  }
}
