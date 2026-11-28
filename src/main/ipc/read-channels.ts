// 只读的 invoke 通道（BTL-242）：按通道名的最后一段认（list、view、get……）。其余的都当写操作：
// 调之前和调完都作废视图缓存。认错成写只是少用一次缓存；所以拿不准的一律不算只读。
const READ_LAST = new Set([
  "list", "view", "get", "status", "state", "summary", "snapshot", "since", "history", "limits", "hits", "rules", "search", "batches", "runs",
  "pending", "stats", "archived", "glance", "unclaimed", "unclaimedCount", "messages", "breakers", "violations", "queue", "events", "language", "why", "board",
  "assessment", "reports", "turn",
]);

export function isReadChannel(channel: string): boolean {
  const last = channel.slice(channel.lastIndexOf(":") + 1);
  return READ_LAST.has(last) || /^[a-z]+Get$/.test(last);
}
