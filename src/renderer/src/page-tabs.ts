/** 页面上半部分 tab 的状态：last 是最近停的 tab，open 是展开还是收起（默认收起）。 */
export interface TabState {
  tab: string;
  open: boolean;
}

/**
 * 展开时停在哪个 tab：记着的最近那个还在就用它，
 * 没记过、记着的 tab 已经没了（比如「已归档」那个 tab 没东西了）、或是旧版本存的空字符串，就回到默认的。
 */
export function pickTab(saved: string | null, ids: readonly string[], fallback: string): string {
  if (saved !== null && ids.includes(saved)) return saved;
  return ids.includes(fallback) ? fallback : (ids[0] ?? "");
}

/** 只有记着 "1" 才是展开；没记过、旧版本的空字符串都算收起。 */
export const tabIsOpen = (flag: string | null): boolean => flag === "1";

/** 点一个 tab：收起时点哪个都展开到它；展开时点的是当前的就收起（记着它），否则切过去。 */
export const clickTab = (state: TabState, clicked: string): TabState =>
  state.open && state.tab === clicked ? { tab: clicked, open: false } : { tab: clicked, open: true };

/** 展开/收起按钮：停在最近那个 tab。 */
export const toggleTabs = (state: TabState): TabState => ({ tab: state.tab, open: !state.open });
