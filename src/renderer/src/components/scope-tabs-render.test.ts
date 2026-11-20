import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InboxItemView } from "../../../shared/types";
import type { ScopeTurnRow, TurnItem } from "../../../shared/turn";
import type { NameCtx, RunningRow } from "../home-view";
import type { TicketRow } from "../scope-view";
import { ControlFeed } from "./ControlConversation";
import { ControlSplit, ScopeOverview, ScopeRunning, ScopeTicketTable } from "./ScopeParts";

const noop = () => {};
const ctx: NameCtx = { epics: new Map(), features: new Map(), tickets: new Map([["T-1", "one"]]) };
const bar = { done: 9, agent: 2, you: 2, external: 1, idle: 1 };
const total: ScopeTurnRow = { kind: "epic", id: 1, name: "E", total: 15, merged: 9, bar, youCount: 2, slowest: "收尾 R/X" };
const feat: ScopeTurnRow = { kind: "feature", id: 3, name: "工作流 J–N", total: 8, merged: 6, bar: { ...bar, done: 6 }, youCount: 0, slowest: null };
const youItem: TurnItem = { ticketKey: "T-1", pr: { repo: "r", number: 5, title: "t", url: "u" }, epicId: 1, featureId: 3, turn: { owner: "you", kind: "merge", risk: null }, since: 0, others: 0 };
const cards = { ctx, now: 1000, onFix: noop, onOpen: noop, onGo: noop, onChanged: noop };
const overview = (o: object = {}) => renderToStaticMarkup(createElement(ScopeOverview, { rows: [feat], total, youItems: [youItem], kind: "epic", emptyText: "EMPTY", cards, ...o }));

describe("ScopeOverview", () => {
  it("shows progress, slowest, you cards and feature rows", () => {
    const html = overview();
    expect(html).toContain("15 个里合了 9 个 · 2 件轮到你");
    expect(html).toContain("最慢的是「收尾 R/X」");
    expect(html).toContain('data-testid="turn-card"');
    expect(html).toContain("6/8 合了");
    expect(html).toContain("turn-bar");
  });
  it("empty scope shows emptyText and create button, no NaN or bar", () => {
    const html = overview({ rows: [], total: { ...total, total: 0, merged: 0, youCount: 0, bar: { done: 0, agent: 0, you: 0, external: 0, idle: 0 }, slowest: null }, youItems: [], onCreate: noop });
    expect(html).toContain("EMPTY");
    expect(html).toContain("<button");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("turn-bar");
  });
  it("no you items says so", () => {
    expect(overview({ youItems: [] })).toContain("这里没有事轮到你");
  });
});

describe("ScopeRunning", () => {
  const row: RunningRow = { key: "k", ticketKey: "T-1", owner: "agent", who: "agent", sentence: "在修 CI", age: "3 分钟前" };
  it("renders rows", () => {
    const html = renderToStaticMarkup(createElement(ScopeRunning, { rows: [row], onOpenTicket: noop }));
    expect(html).toContain("turn-agent");
    expect(html).toContain("在修 CI");
    expect(html).toContain("3 分钟前");
  });
  it("empty", () => {
    expect(renderToStaticMarkup(createElement(ScopeRunning, { rows: [], onOpenTicket: noop }))).toContain("现在没有 agent 或 CI 在处理的事");
  });
});

describe("ScopeTicketTable", () => {
  const mk = (key: string, prs: TicketRow["prs"], others = 0): TicketRow => ({
    key, title: "标题", featureId: 3, turn: { owner: "external", kind: "awaiting_review", names: [] }, others,
    item: { ...youItem, turn: { owner: "external", kind: "awaiting_review", names: [] } }, since: 0, prs,
  });
  const html = (groups: object[], emptyText = "EMPTY") => renderToStaticMarkup(createElement(ScopeTicketTable, { groups: groups as never, onOpenTicket: noop, emptyText }));
  it("groups, columns, PR cells", () => {
    const h = html([{ name: "工作流 J–N", merged: 3, total: 5, rows: [mk("A-1", []), mk("A-2", [{ tag: "#52", number: 52, repo: "r" }, { tag: "#53", number: 53, repo: "r" }], 1)] }]);
    expect(h).toContain("ticket-table");
    expect(h).toContain("工作流 J–N · 3/5 合了");
    for (const c of ["ticket", "谁该动", "现在怎么样", "PR"]) expect(h).toContain(c);
    expect(h).toContain("—");
    expect(h).toContain("#52 #53");
    expect(h).toContain("另有 1 个 PR");
  });
  it("empty groups", () => {
    const h = html([]);
    expect(h).toContain("EMPTY");
    expect(h).not.toContain("<table");
  });
  it("empty group shows one note", () => {
    expect(html([{ name: "G", merged: 0, total: 0, rows: [] }])).toContain("这一组还没有 ticket。");
  });
});

describe("ControlSplit / ControlFeed", () => {
  const rep = (id: number, createdAt: number, text: string): InboxItemView => ({
    id, kind: "report", sessionId: "s", role: "ticket", ticketKey: "T-1", featureId: null, epicId: null, repo: null, text,
    options: [], context: null, reportKind: "done", answer: null, createdAt, open: true, target: {} as never,
  });
  it("split renders both sides", () => {
    const h = renderToStaticMarkup(createElement(ControlSplit, { left: "LEFT", right: "RIGHT" }));
    expect(h).toContain("control-split");
    expect(h).toContain("LEFT");
    expect(h).toContain("RIGHT");
  });
  it("feed is oldest first and keeps footer", () => {
    const reports = [rep(2, 200, "NEWER"), rep(1, 100, "OLDER")];
    const h = renderToStaticMarkup(createElement(ControlFeed, { reports, footer: createElement("i", null, "FOOT") }));
    expect(h.indexOf("OLDER")).toBeLessThan(h.indexOf("NEWER"));
    expect(h).toContain("<i>FOOT</i>");
    expect(reports[0].id).toBe(2);
  });
  it("empty feed", () => {
    expect(renderToStaticMarkup(createElement(ControlFeed, { reports: [] }))).toContain("子 session 的完成和卡住汇报会按时间出现在这里");
  });
});
