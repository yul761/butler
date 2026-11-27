import { M } from "../strings";

/**
 * 总控结束一个开着终端的 session 之前看得准的拒绝理由（end_session 和 close_ticket 的 end_sessions 共用）：
 * 正在干活（监控还没看到的也当在忙）、没停下来等输入、屏幕上有等用户回答的确认。可以关就返回 null。
 */
export function endSessionRefusal(id: string, o: { kind: string | null; waitingForInput: boolean; screenNeedsUser: () => boolean }): string | null {
  if ((o.kind !== "idle" && o.kind !== "waiting") || !o.waitingForInput) return M().ctlSessionBusy(id, o.kind ?? "unknown");
  if (o.screenNeedsUser()) return M().ctlSessionNeedsUser(id);
  return null;
}
