// 轮到你卡片上按钮的动作（UI 重做第 2 层）：从 TurnCard 拿出来，好在 node 里用假的 api 测。
import type { TurnItem, TurnSendReason } from "../../shared/turn";
import type { NowTarget } from "../../shared/types";
import type { Route } from "./App";
import { ciReasonText } from "./availability-view";
import { lookTarget, prUrl, type CardAction } from "./home-view";
import type { UiStrings } from "./strings";

/** 卡片要用的 IPC 和 App 给的回调（TurnCard 传 api 的同名函数）。 */
export interface CardDeps {
  answerInbox: (id: number, text: string) => Promise<boolean>;
  prOpen: (url: string) => Promise<{ ok: true } | { ok: false; reason: "bad_url" }>;
  turnSendToAgent: (req: { ticketKey: string; pr: { repo: string; number: number } }) => Promise<{ ok: boolean; reason?: TurnSendReason }>;
  /** 「没事，忽略」：这一次的卡住不再提醒（直到它又动起来再卡住）。 */
  dismissActivity: (sessionId: string) => Promise<void>;
  onOpen: (t: NowTarget) => void;
  /** 挂在 ticket 上的卡片「去看看」：去 ticket 页，按这张卡片的轮次落到对应的页签（landing）。 */
  onGo: (r: Route) => void;
  onFix: (featureId: number, sessionId: string) => void;
  /** 回答没送到、送出成功以后让首页重取。 */
  onChanged: () => void;
}

/** 按完以后卡片显示什么：回答送到了（换成「已回答」）、一行提示，或者什么都不变。 */
export type CardOutcome = { answered: string } | { message: string } | null;

export function sendReasonText(reason: TurnSendReason | undefined, S: UiStrings): string {
  if (reason === undefined) return "";
  const own = S.hm.act.sendReason as Record<string, string>;
  return Object.prototype.hasOwnProperty.call(own, reason) ? own[reason] : ciReasonText(reason, S);
}

export async function runCardAction(a: CardAction, item: TurnItem, d: CardDeps, S: UiStrings): Promise<CardOutcome> {
  const t = item.turn;
  switch (a.id) {
    case "answer": {
      if (t.owner !== "you" || t.kind !== "answer" || t.askId === null) return null;
      if (await d.answerInbox(t.askId, a.option)) return { answered: a.option };
      d.onChanged();
      return { message: S.hm.act.answerGone };
    }
    case "openPr": {
      const url = prUrl(item);
      if (!url) return null;
      const r = await d.prOpen(url);
      return r.ok ? null : { message: S.hm.act.prOpenNot };
    }
    case "look": {
      if (item.ticketKey !== null) {
        // 落点按这张卡片自己的轮次：范围页的卡片可能是一个 PR 的，和这个 ticket 别的 PR、session 不一样。
        d.onGo({ page: "ticket", key: item.ticketKey, landing: t });
        return null;
      }
      const target = lookTarget(item);
      if (target) d.onOpen(target);
      return null;
    }
    case "fix": {
      // 修复 session 开在卡住的 ticket 上：总控卡住（ticketKey 为 null）时开不了。
      if (t.owner === "you" && t.kind === "stuck" && item.featureId !== null && item.ticketKey !== null && t.sessionId !== null) d.onFix(item.featureId, t.sessionId);
      return null;
    }
    case "ignore": {
      if (t.owner !== "you" || t.kind !== "stuck" || t.sessionId === null) return null;
      await d.dismissActivity(t.sessionId);
      d.onChanged();
      return null;
    }
    case "send": {
      if (item.ticketKey === null || item.pr === null) return null;
      const r = await d.turnSendToAgent({ ticketKey: item.ticketKey, pr: { repo: item.pr.repo, number: item.pr.number } });
      if (r.ok) {
        d.onChanged();
        return null;
      }
      return { message: S.hm.act.sendNot(sendReasonText(r.reason, S)) };
    }
  }
}
