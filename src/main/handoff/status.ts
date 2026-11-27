import type { Handoff, Pr } from "../../shared/handoff";
import { prUrlKey } from "../../shared/pr-url";
import type { TicketStatus } from "../../shared/types";
import { combinedPr } from "./prs";

export type StatusInput = Pick<Handoff, "status" | "prs" | "blockers">;

export interface StatusContext {
  /** 记着的 PR（以前合并过的、Shipherd 存下来的）。只用来判断有没有开着的，合并的不决定状态。 */
  remembered: Pr[];
  /** ticket_prs 里是否有链接的 PR 还开着。 */
  linkedOpen: boolean;
  /** Shipherd 放弃读的 PR（prUrlKey 形式）：一直读不到，记着的“开着”不再当真，h.prs 和 remembered 里都去掉。 */
  givenUp?: ReadonlySet<string>;
  /**
   * 不在 ticket 任何一个仓库里的 PR（BTL-261）：Shipherd 不跟踪它（PrLinker 不收录），读不到也就永远不会放弃，
   * 模型写的「开着」不能把 ticket 一直钉在 in_review。h.prs 和 remembered 里都去掉。
   */
  foreign?: (url: string) => boolean;
}

/**
 * 从最新一次 handoff（或刷新）推导 ticket 状态。手动状态优先由 effectiveStatus 处理，这里只算自动值。
 * h.prs 是模型（或 PR 刷新）自己报的 PR；ctx 里是记着的和链接的，它们只能让 ticket 保持 in_review，不会让它变成 done。
 * 1. 任何一个 PR 还开着（h.prs、ctx.linkedOpen、remembered）：模型明确说 blocked 仍是 blocked，否则 in_review
 * 2. 模型认为 done / merged_pending_followup：还有未完成的 followup → merged_pending_followup，否则 done
 * 3. 模型说 in_review / needs_decision 且自己报的 PR 都合并了：同上
 * 4. 自己报的 PR 全被关闭（没合并），模型没明确说 active（又开始干了）；或者模型报 needs_decision / closed → needs_decision（BTL-270：
 *    等人决定重开、另开还是关掉。之前的 blockers / blocked 不再沿用，也不悄悄变回 active。closed 只能手动关，见 closeTicket）
 * 5. 模型说 blocked，或列了阻塞原因 → blocked
 * 6. 其余沿用模型的 in_review，否则 active（模型说 active 加一个合并了的 PR 是连续几个 PR 的中间状态，仍是 active）
 * 几个 PR（多仓库 ticket）合起来看，见 combinedPr：还有一个开着就还在 review，全部合并（关掉的不算）才算合并。
 */
export function deriveStatus(h: StatusInput, openFollowups: number, ctx: StatusContext = { remembered: [], linkedOpen: false }): TicketStatus {
  const kept = (prs: Pr[]): Pr[] =>
    ctx.givenUp?.size || ctx.foreign ? prs.filter((p) => !ctx.givenUp?.has(prUrlKey(p.url)) && !ctx.foreign?.(p.url)) : prs;
  const pr = combinedPr(kept(h.prs));
  const anyOpen = pr?.state === "open" || ctx.linkedOpen || kept(ctx.remembered).some((p) => p.state === "open");
  if (anyOpen) return h.status === "blocked" ? "blocked" : "in_review";
  const afterMerge = openFollowups > 0 ? "merged_pending_followup" : "done";
  if (h.status === "done" || h.status === "merged_pending_followup") return afterMerge;
  if ((h.status === "in_review" || h.status === "needs_decision") && pr?.state === "merged") return afterMerge;
  // 模型明确说 active（又开始干了）才不用决定；之前的 blockers 是对着关掉的 PR 说的，不再算。
  if (h.status === "needs_decision" || h.status === "closed" || (pr?.state === "closed" && h.status !== "active")) return "needs_decision";
  if (h.status === "blocked" || h.blockers.length > 0) return "blocked";
  return h.status === "in_review" ? "in_review" : "active";
}
