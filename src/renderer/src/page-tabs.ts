/**
 * 展开时停在哪个 tab：记着的最近那个还在就用它，
 * 没记过、记着的 tab 已经没了（比如「已归档」那个 tab 没东西了）、或是旧版本存的空字符串，就回到默认的。
 */
export function pickTab(saved: string | null, ids: readonly string[], fallback: string): string {
  if (saved !== null && ids.includes(saved)) return saved;
  return ids.includes(fallback) ? fallback : (ids[0] ?? "");
}

/** 页签永远有一个选中：落点（forced）有效就用它，压过记着的；否则记着的有效用记着的，再不然 fallback，最后第一个。 */
export function resolveTab(saved: string | null, forced: string | null | undefined, ids: readonly string[], fallback: string): string {
  if (forced != null && ids.includes(forced)) return forced;
  return pickTab(saved, ids, fallback);
}

/** 落点什么时候再触发一次：tab 变了，或者调用方把 seq 加一（同一个 tab 也能再落一次）。没有落点为 null。 */
export function landingKey(forced: string | null | undefined, seq?: number): string | null {
  return forced == null ? null : `${forced}#${seq ?? 0}`;
}

/**
 * 这一次落点（key = 页面 + landingKey）该不该现在执行：目标 tab 在列表里、这一次还没落过。
 * 目标 tab 可能后出现（比如内容晚到才有的 tab）：那时再补落；落过以后 tab 列表再变也不再拉回去。
 */
export function landingDue(forced: string | null | undefined, ids: readonly string[], key: string, done: string | null): boolean {
  return forced != null && ids.includes(forced) && key !== done;
}
