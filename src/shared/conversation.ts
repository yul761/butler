// UI 重做第 4 层（BTL-234）：Shipherd 自己另存的对话（只存双方说的话，不存工具调用）。

export interface ConvMessage {
  id: number;
  /** replaced_by 链的根 session id，换新以后这个值不变。 */
  rootSessionId: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  /** 属于哪个分叉讨论；不是分叉讨论的为 null（分叉讨论由第 5 层写入）。 */
  forkId: number | null;
  qa: boolean;
  /** 属于哪一轮：同一轮的几条 assistant 消息 turnId 相同（第 5 层把同一轮合成一块显示）。 */
  turnId: number;
}

export interface ConvPage { messages: ConvMessage[]; refreshMarks: { at: number; sessionId: string }[]; hasMore: boolean }

/** conv:list 的选项。before 是已显示的最早那条消息的 id（不是时间）；结果按时间升序；qaOnly 时只要问答轮和分叉讨论。 */
export interface ConvListOpts { before?: number; limit: number; qaOnly?: boolean }

/** conv:list 一页最多几条。 */
export const CONV_LIST_MAX = 200;
/** 搜索词最多几个字符。 */
export const CONV_QUERY_MAX = 200;
/** 搜索最多返回几条。 */
export const CONV_SEARCH_LIMIT = 50;
