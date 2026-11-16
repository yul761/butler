/**
 * 页面上半部分的 tab 停在哪：记着的那个还在就用它（空字符串是收起），
 * 记着的 tab 已经没了（比如「已归档」那个 tab 没东西了）就回到默认的。
 */
export function pickTab(saved: string | null, ids: readonly string[], fallback: string): string {
  if (saved === "") return "";
  if (saved !== null && ids.includes(saved)) return saved;
  return ids.includes(fallback) ? fallback : (ids[0] ?? "");
}

/** 点一个 tab：点的是当前的就收起，否则切过去。 */
export const clickTab = (current: string, clicked: string): string => (current === clicked ? "" : clicked);
