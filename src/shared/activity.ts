/** 一个 session 此刻在做什么。 */
export type ActivityKind = "edit" | "read" | "push" | "rebase" | "ci" | "test" | "command" | "agent" | "thinking" | "approval" | "waiting" | "idle";

export interface SessionActivity {
  sessionId: string;
  kind: ActivityKind;
  /** 文件名，或命令的前 40 个字符。 */
  detail: string | null;
  background: boolean;
  startedAt: number | null;
  lastOutputAt: number | null;
  /** null：不在检测范围内。 */
  stuck: boolean | null;
  reason: string | null;
  action: string | null;
  lastOutput: string[];
}

/** 实况窗口（BTL-190 第 7 点）的一条信号：一次工具调用、一次记忆写入或读取、一轮开始或结束。 */
export type ActivityEventKind = "tool" | "memory-write" | "memory-read" | "turn-start" | "turn-end";

/** 主进程每看到一个新的 tool_use 或者轮次变化就通过 IPC activity:event 推一条；「现在」页的行上也带着最近几条。 */
export interface ActivityEvent {
  /** session 现在的 head。 */
  sessionId: string;
  /** transcript 里这条记录的时间。 */
  at: number;
  kind: ActivityEventKind;
  /** 一行字：工具名加参数摘要；记忆读写是写了什么、查了什么；轮次开始、结束是空串。 */
  label: string;
}

/** 在干活：思考中、跑工具、后台命令。等你批准、等你回话、空闲、还没读到都不算。 */
export function isWorking(a: SessionActivity | null): boolean {
  return a !== null && a.kind !== "approval" && a.kind !== "waiting" && a.kind !== "idle";
}
