import type { ConvMessage } from "./conversation";

export type ForkMode = "full" | "light";
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

/** 发给开发 session 被挡下的原因：DeliveryBlock 的取值加上 refreshing、投递结果和本层自己的几种。 */
/** refreshing 留着给以后：现在真正的 DeliveryGuard 把换新中报成 busy。 */
export type DevSendBlock = "closed" | "hibernated" | "busy" | "screen" | "needs_you" | "typing" | "draft" | "cost_paused"
  | "refreshing" | "exited" | "timeout" | "blocked" | "in_flight" | "fork_busy" | "no_conclusion" | "not_found";
export type DevSendResult = { ok: true; at: number } | { ok: false; reason: DevSendBlock };
export type RememberResult = "written" | "full" | "disabled" | "failed" | "busy" | "no_conclusion";
