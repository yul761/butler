// ticket「概况」页签的纯函数（UI 重做第 3 层）：主按钮、基本信息里的几行字、对话页要用的 session 标签。
// 状态一律取自第 1 层的 Turn，这里不判断任何 PR 的状态。
import type { Turn } from "../../shared/turn";
import type { PrStagesTicket } from "../../shared/pr-stages";
import type { TicketGlance } from "../../shared/ticket-glance";
import type { SessionView } from "../../shared/types";
import { newestRow } from "./pr-stages-view";
import { sessionLabel } from "./sessions";
import type { UiStrings } from "./strings";
import type { TicketTab } from "./ticket-tabs";

export interface MainAction {
  id: "open_pr" | "answer" | "look" | "fix" | "send" | "pr_details";
  label: string;
  primary: boolean;
  goTab?: TicketTab;
}

/** 概况页的主按钮：能不能送给 agent 看 turn 自己带的 canSend；能不能开修复 session 由调用方按 TurnCard 的规则算好传进来。 */
export function mainActions(turn: Turn, o: { hasPr: boolean; canFix: boolean }, S: UiStrings): MainAction[] {
  if (turn.owner !== "you") return [];
  switch (turn.kind) {
    case "merge":
      return o.hasPr ? [{ id: "open_pr", label: S.hm.act.openPr, primary: true }] : [];
    case "answer":
      return [{ id: "answer", label: S.lay.actAnswer, primary: true, goTab: "terminal" }];
    case "stuck": {
      const out: MainAction[] = [{ id: "look", label: S.hm.act.look, primary: true, goTab: "terminal" }];
      if (o.canFix) out.push({ id: "fix", label: S.hm.act.fix, primary: false });
      return out;
    }
    case "unattended": {
      const details: MainAction = { id: "pr_details", label: S.lay.actPrDetails, primary: false, goTab: "pr" };
      if (turn.canSend) return [{ id: "send", label: S.hm.act.send, primary: true }, details];
      if (turn.why === "agent_stopped") return [{ id: "look", label: S.hm.act.look, primary: true, goTab: "terminal" }];
      return [{ ...details, primary: true }];
    }
    default:
      return [];
  }
}

const kilo = (n: number): string => `${Math.round(n / 1000)}k`;
/** 到阈值的这个比例就提示快换新了。 */
const NEAR_REFRESH = 0.8;

export function contextLine(ctx: TicketGlance["context"], S: UiStrings): { text: string; nearRefresh: boolean } {
  if (ctx === null) return { text: S.lay.ctxUnknown, nearRefresh: false };
  if (ctx.threshold <= 0) return { text: S.lay.ctxOff(kilo(ctx.tokens)), nearRefresh: false };
  return { text: `${kilo(ctx.tokens)} / ${kilo(ctx.threshold)}`, nearRefresh: ctx.tokens >= ctx.threshold * NEAR_REFRESH };
}

/** PR 走到哪：取最新的那个 PR 行（没关闭的优先）；还有别的没关闭的 PR 就补一句；全关了标（已关闭）。 */
export function prStageLine(t: Pick<PrStagesTicket, "rows"> | null, S: UiStrings): string {
  const prs = (t?.rows ?? []).filter((r) => !r.noPr);
  const best = newestRow({ rows: prs } as PrStagesTicket);
  if (best === null) return S.lay.noPrYet;
  const line = S.lay.stagesDone(best.stages.filter((c) => c.state === "done").length, best.stages.length);
  if (best.closed) return `${line}${S.lay.prClosedNote}`;
  const others = prs.filter((r) => !r.closed).length - 1;
  return others > 0 ? `${line} · ${S.lay.morePrs(others)}` : line;
}

/** 主 session：sessions 已按最近活动排序；先找不是修复、也不是总控开的最近一个，没有就取第一个。 */
export function primarySession(sessions: SessionView[]): SessionView | null {
  return sessions.find((s) => s.fixesSession === null && s.spawnedBy === null) ?? sessions[0] ?? null;
}

export function conversationSessions(sessions: SessionView[], S: UiStrings): { id: string; label: string }[] {
  return sessions.map((s) => {
    const label = sessionLabel(s, S.newSession);
    return { id: s.id, label: s.fixesSession === null ? label : `${S.lay.fixPrefix}${label}` };
  });
}

/** agent 最后说的话太长就截断（按字符，不切开代理对）。 */
export function clipSaid(text: string, max = 280): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}
