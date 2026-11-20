// 「谁该动」的那一句话（UI 重做第 1 层）：第 2、3 层的卡片和行都用它。位置、多久以前不在句子里。
import type { Turn, TurnItem } from "../../shared/turn";
import type { NowNotice } from "../../shared/types";
import type { UiStrings } from "./strings";

/** 要你动手的 Butler 提醒的一句短话；只覆盖 noticeNeedsYou 为真的几种，其余是 other。 */
function butlerSentence(n: NowNotice, t: UiStrings["turn"]["butler"]): string {
  switch (n.kind) {
    case "approval":
    case "claude_limited":
    case "model_unavailable":
    case "session_limited":
    case "ci_undelivered":
    case "cost":
    case "intake":
      return t[n.kind];
    case "comments_waiting":
      return n.waiting.reason === "review" ? t.commentsReview(n.waiting.count) : t.commentsUndelivered(n.waiting.count);
    case "stack":
      return n.stack.reason === "stuck" ? t.stackStuck : t.stackConflict;
    default:
      return t.other;
  }
}

/** 一个 Turn 的那一句话。item 留给以后按位置区分的文案用（现在不看）。 */
export function turnSentence(turn: Turn, _item: TurnItem, s: UiStrings): string {
  const t = s.turn;
  switch (turn.owner) {
    case "you":
      switch (turn.kind) {
        case "answer":
          return t.answer(turn.question);
        case "merge":
          return turn.risk === null ? t.merge : t.mergeRisk(turn.risk);
        case "review":
          return t.review(turn.author, turn.title);
        case "stuck":
          return t.stuck[turn.source](turn.detail);
        case "unattended":
          return t.unattended[turn.why];
        case "butler":
          return butlerSentence(turn.notice, t.butler);
      }
      break;
    case "agent":
      return t.agent[turn.kind];
    case "external":
      if (turn.kind === "awaiting_review") return t.external.awaitingReview(turn.names);
      if (turn.kind === "stack_below") return t.external.stackBelow(turn.names);
      return t.external[turn.kind];
    case "done":
      return t.done;
    case "idle":
      return t.idle;
  }
  return "";
}
