// 页面上共用的时间文字（原先进度页的小工具，进度页删掉后只剩这一个）。

/** 时间点给人看：月/日 时:分。 */
export function shortTime(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
