// 刷新回来的数据和手上的一样就留着旧对象（BTL-242）：React 看到同一个引用，下面的 memo 和组件都不用重算重画。
// 主进程每次都是新序列化的一份，内容没变引用也变；比一下 JSON 比整页重画便宜得多。

export function keepSame<T>(prev: T, next: T): T {
  if (prev === next) return prev;
  if (prev === null || prev === undefined) return next;
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}
