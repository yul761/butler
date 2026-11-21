import type { ConvMessage } from "./conversation";

export type ForkMode = "full" | "light";
/** 一个问题最多这么多字（按字算，trim 以后；ForkService、IPC 校验和对话 tab 的输入框用同一个数）。 */
export const FORK_QUESTION_MAX = 20_000;
export type ForkStatus = "running" | "idle" | "failed";
/**
 * 失败原因：HeadlessFailure 的取值，加上 interrupted（app 退出时还在跑）、no_answer（跑完了但回答是空的）、
 * not_forked（CLI 没分叉，返回的就是 --resume 的开发 session；这个分叉不能再接着问，要重新开一个）。
 */
export type ForkErrorCode = "timeout" | "spawn_failed" | "exit_nonzero" | "bad_output" | "rate_limited" | "claude_error"
  | "model_unavailable" | "aborted" | "interrupted" | "no_answer" | "not_forked";

export interface ForkView {
  id: number;
  rootSessionId: string;
  mode: ForkMode;
  status: ForkStatus;
  costUsd: number | null;
  costPartial: boolean;
  /** 费用是约数（可能偏高也可能偏低），显示成「约 $X」。 */
  costApprox: boolean;
  startedAt: number;
  lastAt: number;
  summarySentAt: number | null;
  conclusion: string | null;
  reaskOf: number | null;
  error: { code: ForkErrorCode; resetAt: number | null } | null;
  /** 这个分叉的问答，从旧到新（第 4 层 byFork）。 */
  messages: ConvMessage[];
}

/** IPC 拒绝时的 code（经 toIpcResult 变成 { ok:false, code }）。 */
export type ForkRefusal = "fork_busy" | "dev_busy" | "no_transcript" | "no_claude" | "not_found" | "bad_question" | "not_forked";

export class ForkError extends Error {
  constructor(readonly code: ForkRefusal, message?: string) {
    super(message ?? code);
    this.name = "ForkError";
  }
}

/**
 * 发给开发 session 没排上的原因（BTL-248 起走信箱，不再有「正忙、在打字」这类 guard 的原因）：
 * not_found 找不到 session；failed 排队失败；in_flight 同一个结论还在发；fork_busy、no_conclusion 是分叉自己的。
 */
export type DevSendBlock = "not_found" | "failed" | "in_flight" | "fork_busy" | "no_conclusion";
/** state：排队那一刻目标的状态（在忙：下一次调用工具时送；停着：马上送；关着：打开后送）。 */
export type DevSendResult = { ok: true; at: number; state: "busy" | "idle" | "closed" } | { ok: false; reason: DevSendBlock };
/** disabled：记忆关着；no_scope：这个 session 没有 ticket 也没有 feature（Butler 总控），没处可记。 */
export type RememberResult = "written" | "full" | "disabled" | "failed" | "busy" | "no_conclusion" | "no_scope";
/** 真去写记忆（MemoryService.rememberText）时可能的结果。 */
export type RememberWriteResult = Exclude<RememberResult, "busy" | "no_conclusion" | "no_scope">;
