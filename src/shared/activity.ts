/** 一个 session 此刻在做什么。 */
export type ActivityKind = "edit" | "read" | "push" | "ci" | "test" | "command" | "agent" | "thinking" | "approval" | "waiting" | "idle";

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
