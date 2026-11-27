// 视图缓存按范围作废（BTL-265）：哪种 notify 作废 ViewCache 里的哪些 key。
// 原来每次 notify 都整个作废，在干活的 session 一分钟三十多次活动变化，每次首页、看板都要从头拼一遍。
//
//   data      存下来的东西变了：全部作废。
//   messages  留给信箱（BTL-245，现在没人发）：保守起见全部作废。
//   activity  ActivityMonitor 内存里的「在做什么、卡住、撞限」变了：
//             features（FeatureView.activity 读它）和 turn.input（sessionTurn 读它）作废；
//             tickets 和 tickets.all 不读活动（session 的 waiting 存在库里，终端开关、改 waiting 的写入都要发 data：hook 事件、终端退出、end_session、onTurnEnd），留着：
//             features 重拼时直接用缓存的 tickets.all。
//   procs     一次内存采样：只作废「现在」页（now，它带内存读数），别的视图里没有内存读数。
//   output    在跑的 session 只是又有了输出：只作废 now（它带最近的活动），别的视图只看 visible 的活动（quiet 的输出、工具调用界面从 activity:event 拿）。
//   now（BTL-275）每种都作废：缓存只省掉同一批变化之间的重复 now:view（窗口切回来、几个地方同时取），任何 state:changed 之后取的都是新拼的。
//
// 依赖：tickets、features 用 tickets.all 拼，turn.input 用 tickets、features 拼。作废了下面的范围一定也作废上面的（view-scopes.test 检查）。
// 不管哪种都还有 ViewCache 的 1 秒上限兜底：漏了 notify 的写入最多旧 1 秒。
import type { StateScope } from "../../shared/state-scope";

export const VIEW_KEYS = { ticketsAll: "tickets.all", tickets: "tickets", features: "features", turnInput: "turn.input", now: "now" } as const;

/** 每个 key 是用哪些 key 拼的。 */
export const VIEW_DEPENDS: Record<string, readonly string[]> = {
  [VIEW_KEYS.tickets]: [VIEW_KEYS.ticketsAll],
  [VIEW_KEYS.features]: [VIEW_KEYS.ticketsAll],
  [VIEW_KEYS.turnInput]: [VIEW_KEYS.tickets, VIEW_KEYS.features],
  [VIEW_KEYS.now]: [VIEW_KEYS.tickets, VIEW_KEYS.features],
};

/** undefined：全部作废。 */
export const SCOPE_INVALIDATES: Record<StateScope, readonly string[] | undefined> = {
  data: undefined,
  messages: undefined,
  activity: [VIEW_KEYS.features, VIEW_KEYS.turnInput, VIEW_KEYS.now],
  procs: [VIEW_KEYS.now],
  output: [VIEW_KEYS.now],
};
