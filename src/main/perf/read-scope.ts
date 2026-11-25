// 一次构建里只读一次（BTL-265）：首页拼 turn 输入时，每个 PR 都要问「开着的 head」「休眠的 head」，每问一次都是几次查询。
// ReadScope.memo 包住的读只在 run(fn) 期间缓存：第一次调用时算，run 返回（或抛错）就全部作废；不在 run 里调用就每次现读。
// 所以 run 里只能放只读的构建（拼 turn 输入），写入的路径（sendToAgent 等）不在 run 里，读到的永远是新的。
// 给出去的是同一份：调用方不要改它。
export class ReadScope {
  private memos: Map<object, unknown> | null = null;

  /** 在这个范围里跑 fn：期间 memo 的读各算一次。嵌套调用沿用外层的范围。 */
  run<T>(fn: () => T): T {
    if (this.memos) return fn();
    this.memos = new Map();
    try {
      return fn();
    } finally {
      this.memos = null;
    }
  }

  /** 包一个只读函数：在 run 里第一次调用时算并记下（抛错不记），run 外每次都现算。 */
  memo<T>(fn: () => T): () => T {
    const key = {};
    return () => {
      const m = this.memos;
      if (!m) return fn();
      if (m.has(key)) return m.get(key) as T;
      const v = fn();
      m.set(key, v);
      return v;
    };
  }
}
