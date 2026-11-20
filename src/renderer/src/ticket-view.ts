// ticket「概况」页签的纯函数（UI 重做第 3 层）：主按钮、基本信息里的几行字、对话页要用的 session 标签。
// 状态一律取自第 1 层的 Turn，这里不判断任何 PR 的状态。
import type { Turn } from "../../shared/turn";
import type { PrStagesTicket } from "../../shared/pr-stages";
import type { TicketGlance } from "../../shared/ticket-glance";
import type { SessionView } from "../../shared/types";
import { newestRow } from "./pr-stages-view";
import { sessionLabel } from "./sessions";
import type { UiStrings } from "./strings";
import { landingTab, type TicketTab } from "./ticket-tabs";

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

/** PR 地址里的 owner/repo（github.com/owner/repo/pull/N）；看不出来为 null。 */
function urlSlug(url: string | null): string | null {
  const m = url === null ? null : /\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url);
  return m ? m[1].toLowerCase() : null;
}

/**
 * 概况「打开 PR」的地址：PR 进度取到了就以它为准（没有这个 PR 就没有按钮），还没取到时用 turn 带的地址。
 * 多仓库的 ticket 可能有同号的 PR：同号不止一个时按地址里的仓库（turn 的 repo 是 owner/repo）对上。
 */
export function prUrlOf(pr: { repo: string; number: number; url: string } | null, stages: Pick<PrStagesTicket, "rows"> | null): string | null {
  if (pr === null) return null;
  if (stages === null) return pr.url;
  const same = stages.rows.filter((r) => r.prNumber === pr.number);
  if (same.length <= 1) return same[0]?.prUrl ?? null;
  const repo = pr.repo.toLowerCase();
  return same.find((r) => r.prUrl === pr.url || urlSlug(r.prUrl) === repo || r.slug?.toLowerCase() === repo)?.prUrl ?? null;
}

export function conversationSessions(sessions: SessionView[], S: UiStrings): { id: string; label: string }[] {
  return sessions.map((s) => {
    const label = sessionLabel(s, S.newSession);
    // id 用链根：换新以后 head 变了，这一项还是同一项（对话、分叉、发话都按链上任意 id 解析）。
    return { id: s.rootId, label: s.fixesSession === null ? label : `${S.lay.fixPrefix}${label}` };
  });
}

/** agent 最后说的话太长就截断（按字符，不切开代理对）。 */
export function clipSaid(text: string, max = 280): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/**
 * 落在终端页签时顺手打开 turn 所在的 session：它的终端已经开着就切过去，没开就恢复它；turn 不带 session 就什么都不做。
 * 落点取自 landingTab：只有 unattended(agent_stopped) 落到终端（answer、stuck 落在对话），它可能带 sessionId。
 */
export function terminalLanding(turn: Turn, sessions: Pick<SessionView, "id" | "termId">[], panes: readonly string[]): { activate: string } | { open: string } | null {
  const sessionId = "sessionId" in turn ? turn.sessionId : null;
  if (sessionId === null) return null;
  const termId = sessions.find((s) => s.id === sessionId)?.termId ?? null;
  return termId !== null && panes.includes(termId) ? { activate: termId } : { open: sessionId };
}

/**
 * 从卡片的「去看看」进 ticket 页：按那张卡片自己的轮次落到哪个页签（landingTab），落在终端时顺手切到 / 恢复哪个 session。
 * 不等这个 ticket 的看板：卡片已经带着轮次，页面一打开就落；等看板的话，看板回来之前用户自己点的页签会被拉回去。
 */
export function ticketLanding(
  turn: Turn, sessions: Pick<SessionView, "id" | "termId">[], panes: readonly string[],
): { tab: TicketTab; terminal: { activate: string } | { open: string } | null; conversation: string | null } {
  const tab = landingTab(turn);
  // 落在对话：对话 tab 选中轮到你的那个 session（修复 session、子 session 也一样），不是 ticket 的主链。
  const conversation = tab === "conversation" && "sessionId" in turn ? turn.sessionId : null;
  return { tab, terminal: tab === "terminal" ? terminalLanding(turn, sessions, panes) : null, conversation };
}

/** 落点给的 session（id、终端 id 或链根都行）→ 它的链根；没给或找不到时用 ticket 自己的链根。 */
export function convFocusRoot(sessions: Pick<SessionView, "id" | "termId" | "rootId">[], focus: string | null, fallback: string): string {
  if (focus === null) return fallback;
  return sessions.find((s) => s.id === focus || s.termId === focus || s.rootId === focus)?.rootId ?? fallback;
}

/** 总控对话区默认显示哪条链：第一个不是修复 session 的（总控自己），没有就第一个；一个都没有为 null。 */
export function defaultConvRoot(sessions: Pick<SessionView, "rootId" | "fixesSession">[]): string | null {
  return (sessions.find((s) => s.fixesSession === null) ?? sessions[0])?.rootId ?? null;
}
