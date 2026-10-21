import type { Handoff } from "../../shared/handoff";
import type { TicketStatus } from "../../shared/types";

export type StatusInput = Pick<Handoff, "status" | "pr" | "blockers">;

/**
 * 从最新一次 handoff（或刷新）推导 ticket 状态。手动状态优先由 effectiveStatus 处理，这里只算自动值。
 * - PR 还开着：in_review（模型明确说 blocked 时仍是 blocked），优先于下面的 done 判断
 * - PR 已合并，或模型认为已完成：还有未完成的 followup → merged_pending_followup，否则 done
 * - 模型明确说 blocked → blocked
 * - PR 打开中 → in_review（“等 review”常被写进 blockers，不算阻塞）
 * - 列出了阻塞原因 → blocked
 * - PR 被关闭（没合并）→ active
 * - 其余沿用模型的 in_review，否则 active
 */
export function deriveStatus(h: StatusInput, openFollowups: number): TicketStatus {
  // PR 还开着就还没完成：模型的 done / merged_pending_followup 不作数（模型明确说 blocked 仍然优先）。
  if (h.pr?.state === "open") return h.status === "blocked" ? "blocked" : "in_review";
  if (h.pr?.state === "merged" || h.status === "done" || h.status === "merged_pending_followup") {
    return openFollowups > 0 ? "merged_pending_followup" : "done";
  }
  if (h.status === "blocked") return "blocked";
  if (h.blockers.length > 0) return "blocked";
  if (h.pr?.state === "closed") return "active";
  return h.status === "in_review" ? "in_review" : "active";
}
