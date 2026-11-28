// 「谁该动」的那一句话（UI 重做第 1 层）：第 2、3 层的卡片和行都用它。位置、多久以前不在句子里。
import type { Turn, TurnItem } from "../../shared/turn";
import type { NowNotice } from "../../shared/types";
import type { UiStrings } from "./strings";

/** 要你动手的 Shipherd 提醒的一句短话；只覆盖 noticeNeedsYou 为真的几种，其余是 other。 */
function shipherdSentence(n: NowNotice, t: UiStrings["turn"]["shipherd"]): string {
  switch (n.kind) {
    case "approval":
      return n.startup ? t.approvalStartup : t.approval;
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
      return n.stack.reason === "stuck" || n.stack.reason === "prs_unreadable" ? t.stackStuck : n.stack.reason === "confirm" ? t.stackConfirm : n.stack.reason === "markers" || n.stack.reason === "held_below" ? t.stackMarkers : n.stack.reason === "no_push_remote" ? t.stackNoPushRemote : n.stack.reason === "ticket_closed" ? t.stackTicketClosed : t.stackConflict;
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
        case "shipherd":
          return shipherdSentence(turn.notice, t.shipherd);
      }
      break;
    case "agent":
      return t.agent[turn.kind];
    case "external":
      if (turn.kind === "awaiting_review") return t.external.awaitingReview(turn.names);
      if (turn.kind === "stack_below") return t.external.stackBelow(turn.names);
      return t.external[turn.kind];
    case "done":
      return turn.kind === "closed" ? t.closed : t.done;
    case "idle":
      return t.idle;
  }
  return "";
}

/**
 * 外部在推进时「谁」那几个字：首页和范围页的「进行中」、「全部 ticket」表格共用一份。
 * 栈的上层等的是下一层（分支名写在那一句里，不当成人名）；有名字写名字；CI 在跑写 CI；其余写「外部」。
 */
export function externalWho(turn: Extract<Turn, { owner: "external" }>, s: UiStrings): string {
  if (turn.kind === "stack_below") return s.hm.whoStackBelow;
  if (turn.names.length > 0) return turn.names.join(s.lay.nameSep);
  return turn.kind === "ci_running" ? s.hm.whoCi : s.hm.whoExternal;
}
