import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PrStagesTicket, PrStagesView } from "../../../shared/pr-stages";
import type { TurnItem } from "../../../shared/turn";
import type { TicketView } from "../../../shared/types";
import type { TicketRow } from "../scope-view";
import { S } from "../strings";
import { TicketHome, type TicketHomeProps } from "./TicketHome";

const noop = () => {};
const ticket = { key: "BTL-1", title: "T", repos: [{ branch: "feat/btl-1" }], sessions: [] } as unknown as TicketView;
const pr = { repo: "r", number: 52, title: "t", url: "https://x/pr/52" };
const merge: TicketItemTurn = { owner: "you", kind: "merge", risk: null };
type TicketItemTurn = TurnItem["turn"];
const mkRow = (turn: TicketItemTurn = merge, others = 0): TicketRow => {
  const item: TurnItem = { ticketKey: "BTL-1", pr, epicId: null, featureId: null, turn, since: 0, others };
  return { key: "BTL-1", title: "T", featureId: null, turn, others, item, since: 0, prs: [{ tag: "#52", number: 52, repo: "r" }] };
};
const stageRow: PrStagesView = {
  ticketKey: "BTL-1", featureId: null, repoId: 1, repoName: "r", prId: 1, slug: null, noPr: false, prNumber: 52, prUrl: "https://x/pr/52", closed: false,
  stages: Array.from({ length: 6 }, (_, i) => ({ id: "dev" as const, state: i < 5 ? ("done" as const) : ("todo" as const), round: 1, at: null })), timeline: [],
};
const stages = (rows: PrStagesView[]): PrStagesTicket => ({ ticketKey: "BTL-1", title: null, featureId: null, archived: false, merged: false, hasRepos: true, rows });
const props = (o: Partial<TicketHomeProps> = {}): TicketHomeProps => ({
  ticket, row: mkRow(), canFix: false, notice: null,
  glance: { rootSessionId: "s", lastSaid: { text: "测试都过了", at: 1 }, context: { tokens: 148000, threshold: 150000 } },
  stages: stages([stageRow]), onGoTab: noop, onOpenPr: noop, onSend: noop, onFix: noop, ...o,
});
const html = (o?: Partial<TicketHomeProps>) => renderToStaticMarkup(createElement(TicketHome, props(o)));

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
