import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PrStagesTicket, PrStagesView } from "../../../shared/pr-stages";
import type { TurnItem } from "../../../shared/turn";
import type { TicketView } from "../../../shared/types";
import type { TicketRow } from "../scope-view";
import { S } from "../strings";
import { turnSentence } from "../turn-text";
import type { CardAction } from "../home-view";
import { landingTab } from "../ticket-tabs";
import { runTicketAsk, TicketHome, type TicketHomeProps } from "./TicketHome";

const noop = () => {};
const ticket = { key: "BTL-1", title: "T", repos: [{ branch: "feat/btl-1" }], sessions: [] } as unknown as TicketView;
const pr = { repo: "r", number: 52, title: "t", url: "https://x/pr/52" };
const merge: TicketItemTurn = { owner: "you", kind: "merge", risk: null };
type TicketItemTurn = TurnItem["turn"];
const mkRow = (turn: TicketItemTurn = merge, others = 0): TicketRow => {
  const item: TurnItem = { ticketKey: "BTL-1", pr, epicId: null, featureId: null, turn, since: 0, others };
  return { key: "BTL-1", title: "T", featureId: null, turn, others, item, since: 0, prs: [{ tag: "#52", number: 52, repo: "r" }], asks: [] };
};
const stageRow: PrStagesView = {
  ticketKey: "BTL-1", featureId: null, repoId: 1, repoName: "r", prId: 1, slug: null, noPr: false, prNumber: 52, prUrl: "https://x/pr/52", closed: false,
  stages: Array.from({ length: 6 }, (_, i) => ({ id: "dev" as const, state: i < 5 ? ("done" as const) : ("todo" as const), round: 1, at: null })), timeline: [],
};
const stages = (rows: PrStagesView[]): PrStagesTicket => ({ ticketKey: "BTL-1", title: null, featureId: null, archived: false, merged: false, hasRepos: true, rows });
const props = (o: Partial<TicketHomeProps> = {}): TicketHomeProps => ({
  ticket, row: mkRow(), canFix: false, notice: null,
  glance: { rootSessionId: "s", lastSaid: { text: "测试都过了", at: 1 }, context: { tokens: 148000, threshold: 150000 } },
  stages: stages([stageRow]), onGoTab: noop, onOpenPr: noop, onSend: noop, onFix: noop, onAsk: noop, ...o,
});
const html = (o?: Partial<TicketHomeProps>) => renderToStaticMarkup(createElement(TicketHome, props(o)));
/** 在 TicketHome 返回的元素树里找文字是 label 的按钮（只有原生元素，不用渲染）。 */
type El = { type: unknown; props: { children?: unknown; onClick?: () => void } };
function findButton(node: unknown, label: string): El & { props: { onClick: () => void } } {
  const walk = (n: unknown): El | null => {
    if (Array.isArray(n)) { for (const c of n) { const f = walk(c); if (f) return f; } return null; }
    if (n === null || typeof n !== "object" || !("props" in n)) return null;
    const e = n as El;
    if (e.type === "button" && e.props.children === label) return e;
    return walk(e.props.children);
  };
  const b = walk(node);
  if (!b || !b.props.onClick) throw new Error(`no button ${label}`);
  return b as never;
}

describe("TicketHome", () => {
  it("mergeable: sentence, primary button, last said, basic info", () => {
    const h = html();
    expect(h).toContain("可以合并了");
    expect(h).toContain("打开 PR");
    expect(h).toContain("agent 最后说的");
    expect(h).toContain("测试都过了");
    expect(h).toContain("feat/btl-1");
    expect(h).toContain("148k / 150k");
    expect(h).toContain("快要换新了（对话不会丢）");
    expect(h).toContain("6 个阶段走完 5 个");
    expect(h).toContain("看完整对话");
  });
  it("no PR: says so and offers no PR button", () => {
    const h = html({ stages: stages([]), row: mkRow(), glance: null });
    expect(h).toContain("还没开 PR");
    expect(h).not.toContain("打开 PR");
  });
  it("last said missing vs glance not loaded", () => {
    const g = { rootSessionId: null, lastSaid: null, context: null };
    expect(html({ glance: g })).toContain(S.lay.lastSaidNone);
    const loading = html({ glance: null });
    expect(loading).not.toContain(S.lay.lastSaidNone);
    expect(loading).not.toContain("NaN");
  });
  it("row not loaded renders a skeleton, not the not-started state", () => {
    const h = html({ row: null });
    expect(h).toContain("ticket-home-skeleton");
    expect(h).not.toContain("没开始");
  });
  it("two repos with the same PR number: open PR uses this PR's repo, not the first with that number", () => {
    const opened: string[] = [];
    const row = mkRow();
    row.item = { ...row.item, pr: { repo: "acme/api", number: 52, title: "t", url: "https://github.com/acme/api/pull/52" } };
    const other: PrStagesView = { ...stageRow, repoId: 2, repoName: "web", prUrl: "https://github.com/acme/web/pull/52" };
    const mine: PrStagesView = { ...stageRow, repoId: 1, repoName: "api", prUrl: "https://github.com/acme/api/pull/52" };
    const el = TicketHome({ ...props({ row, stages: stages([other, mine]) }), onOpenPr: (u) => opened.push(u) });
    const button = findButton(el, S.hm.act.openPr);
    button.props.onClick();
    expect(opened).toEqual(["https://github.com/acme/api/pull/52"]);
  });
  it("an orphan question shows under the ticket's own state, with a way to answer it", async () => {
    const ask: TurnItem = { ticketKey: "BTL-1", pr: null, epicId: null, featureId: null, since: 0, others: 0,
      turn: { owner: "you", kind: "answer", question: "用哪个库？", options: ["zod", "valibot"], askId: 3, sessionId: "s" } };
    const row = { ...mkRow(), asks: [ask] };
    const h = html({ row });
    expect(h).toContain("ticket-home-asks");
    expect(h).toContain(turnSentence(ask.turn, ask, S));
    // 按钮和首页卡片一样：两个选项 + 去看看。
    const clicked: [CardAction, TurnItem][] = [];
    const el = TicketHome({ ...props({ row }), onAsk: (a, item) => clicked.push([a, item]) });
    findButton(el, "zod").props.onClick();
    expect(clicked).toEqual([[{ id: "answer", option: "zod", primary: true }, ask]]);
    expect(() => findButton(el, S.hm.act.look)).not.toThrow();
    // 点选项走 inbox 回答（发问的 session 已经结束，终端里答不了）。
    const answered: [number, string][] = [];
    const went: string[] = [];
    const deps = { answerInbox: async (id: number, text: string) => (answered.push([id, text]), true), onGoTab: (t: string) => went.push(t), onChanged: noop };
    expect(await runTicketAsk(clicked[0][0], ask, deps, S)).toBe(S.hm.act.answered("zod"));
    expect(answered).toEqual([[3, "zod"]]);
    expect(went).toEqual([]);
  });
  it("an answer that no longer exists says so and reloads the board", async () => {
    const ask: TurnItem = { ticketKey: "BTL-1", pr: null, epicId: null, featureId: null, since: 0, others: 0,
      turn: { owner: "you", kind: "answer", question: "q", options: ["a"], askId: 3, sessionId: "s" } };
    let reloaded = 0;
    const deps = { answerInbox: async () => false, onGoTab: noop, onChanged: () => void reloaded++ };
    expect(await runTicketAsk({ id: "answer", option: "a", primary: true }, ask, deps, S)).toBe(S.hm.act.answerGone);
    expect(reloaded).toBe(1);
  });
  it("a question without options only offers a look, landing where the home card would", async () => {
    const ask: TurnItem = { ticketKey: "BTL-1", pr: null, epicId: null, featureId: null, since: 0, others: 0,
      turn: { owner: "you", kind: "answer", question: "q", options: [], askId: 3, sessionId: "s" } };
    const clicked: CardAction[] = [];
    const el = TicketHome({ ...props({ row: { ...mkRow(), asks: [ask] } }), onAsk: (a) => clicked.push(a) });
    findButton(el, S.hm.act.look).props.onClick();
    expect(clicked).toEqual([{ id: "look", primary: true }]);
    const went: string[] = [];
    expect(await runTicketAsk(clicked[0], ask, { answerInbox: async () => true, onGoTab: (t) => went.push(t), onChanged: noop }, S)).toBeNull();
    expect(went).toEqual([landingTab(ask.turn)]);
  });
  it("no orphan questions: no questions section", () => {
    expect(html()).not.toContain("ticket-home-asks");
  });
  it("several PRs", () => {
    expect(html({ row: mkRow(merge, 1) })).toContain("另有 1 个 PR");
  });
  it("shows the send feedback", () => {
    expect(html({ notice: "没送出去：现在送不了" })).toContain("没送出去：现在送不了");
  });
  it("stuck with canFix shows both buttons", () => {
    const h = html({ canFix: true, row: mkRow({ owner: "you", kind: "stuck", source: "silent", detail: null, sessionId: "s" }) });
    expect(h).toContain("去看看");
    expect(h).toContain("开修复 session");
  });
});
