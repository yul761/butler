/** 度量（ws-h，契约 4.7）在主进程和界面之间共用的类型。 */

/** 事件归类：人介入、打断、返工、评论、其他。 */
export type MetricKindGroup = "intervention" | "interrupt" | "rework" | "comment" | "other";

/** 打断原因（7.4）：权限确认、选择题、缺信息、真问题、卡住。 */
export const INTERRUPT_CATEGORIES = ["permission", "choice", "missing_info", "question", "stuck"] as const;
export type InterruptCategory = (typeof INTERRUPT_CATEGORIES)[number];

export const isInterruptCategory = (v: unknown): v is InterruptCategory =>
  typeof v === "string" && (INTERRUPT_CATEGORIES as readonly string[]).includes(v);
