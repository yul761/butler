export interface TicketGlance {
  /** 主 session 链的根（第 5 层的对话按它存）；ticket 没有 session 为 null。 */
  rootSessionId: string | null;
  /** 最近一个有回复的 session 的最后一条回复；终端没开着（ActivityMonitor 没在跟）为 null。 */
  lastSaid: { text: string; at: number | null } | null;
  /** 主 session 最近一轮的上下文 token 数和自动换新阈值（0 = 关）；没有用量记录为 null。 */
  context: { tokens: number; threshold: number } | null;
}
