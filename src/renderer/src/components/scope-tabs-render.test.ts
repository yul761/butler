import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InboxItemView } from "../../../shared/types";
import type { ScopeTurnRow, TurnItem } from "../../../shared/turn";
import type { NameCtx, RunningRow } from "../home-view";
import type { TicketRow } from "../scope-view";
import { S, STRINGS } from "../strings";
import { ControlFeed } from "./ControlConversation";
import { ConversationFeed } from "./ConversationTab";
import { buildTimeline } from "../conversation-view";
import { ControlSplit, ScopeBoard, ScopeOverview, ScopeRunning, ScopeTicketTable } from "./ScopeParts";

const noop = () => {};
const ctx: NameCtx = { epics: new Map(), features: new Map(), tickets: new Map([["T-1", "one"]]) };
const bar = { done: 9, agent: 2, you: 2, external: 1, idle: 1 };
const total: ScopeTurnRow = { kind: "epic", id: 1, name: "E", total: 15, merged: 9, bar, youCount: 2, slowest: "收尾 R/X" };
const feat: ScopeTurnRow = { kind: "feature", id: 3, name: "工作流 J–N", total: 8, merged: 6, bar: { ...bar, done: 6 }, youCount: 0, slowest: null };
const youItem: TurnItem = { ticketKey: "T-1", pr: { repo: "r", number: 5, title: "t", url: "u" }, epicId: 1, featureId: 3, turn: { owner: "you", kind: "merge", risk: null }, since: 0, others: 0 };
const cards = { ctx, now: 1000, onFix: noop, onOpen: noop, onGo: noop, onChanged: noop };
const overview = (o: Partial<Parameters<typeof ScopeOverview>[0]> = {}) => renderToStaticMarkup(createElement(ScopeOverview, { rows: [feat], total, youItems: [youItem], kind: "epic", emptyText: "EMPTY", cards, ...o }));

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
  it("empty scope still shows the cards that are your turn (a coordinator's question before any ticket)", () => {
    const zero = { done: 0, agent: 0, you: 0, external: 0, idle: 0 };
    const html = overview({ kind: "feature", rows: [], total: { ...total, kind: "feature", total: 0, merged: 0, youCount: 0, bar: zero, slowest: null }, onCreate: noop });
    expect(html).toContain("EMPTY");
    expect(html).toContain('class="scope-you"');
    expect(html).toContain('data-testid="turn-card"');
    expect(html).not.toContain("NaN");
    const none = overview({ kind: "feature", rows: [], total: null, onCreate: noop });
    expect(none).toContain('data-testid="turn-card"');
  });
  it("epic with features but no tickets still lists the features", () => {
    const zero = { done: 0, agent: 0, you: 0, external: 0, idle: 0 };
    const html = overview({
      rows: [{ ...feat, name: "空 feature", total: 0, merged: 0, bar: zero }],
      total: { ...total, total: 0, merged: 0, youCount: 0, bar: zero, slowest: null }, youItems: [],
    });
    expect(html).toContain("空 feature");
    expect(html).toContain("0/0 合了");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("EMPTY");
    expect(html).not.toContain("turn-bar");
  });
  it("a feature's ticket rows: a ticket with no PR says so instead of 0/1 merged", () => {
    const tRow = (id: string, merged: number): ScopeTurnRow => ({ kind: "ticket", id, name: id, total: 1, merged, bar: { ...bar, done: merged }, youCount: 0, slowest: null });
    const html = overview({ kind: "feature", rows: [tRow("K-1", 0), tRow("K-2", 0)], ticketsWithPr: new Set(["K-2"]) });
    const line = (key: string) => new RegExp(`title="${key}">${key}</button><span class="line muted">([^<]*)</span>`).exec(html)?.[1];
    expect(line("K-1")).toBe("还没开 PR");
    expect(line("K-2")).toBe("0/1 合了");
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
    expect(renderToStaticMarkup(createElement(ScopeRunning, { rows: [], onOpenTicket: noop }))).toContain("现在没有 agent、CI 或别人在处理的事");
  });
});

describe("ScopeTicketTable", () => {
  const mk = (key: string, prs: TicketRow["prs"], others = 0): TicketRow => ({
    key, title: "标题", featureId: 3, turn: { owner: "external", kind: "awaiting_review", names: [] }, others,
    item: { ...youItem, turn: { owner: "external", kind: "awaiting_review", names: [] } }, since: 0, prs, asks: [],
  });
  const html = (groups: Parameters<typeof ScopeTicketTable>[0]["groups"], emptyText = "EMPTY") => renderToStaticMarkup(createElement(ScopeTicketTable, { groups, onOpenTicket: noop, emptyText }));
  it("groups, columns, PR cells", () => {
    const h = html([{ name: "工作流 J–N", merged: 3, total: 5, rows: [mk("A-1", []), mk("A-2", [{ tag: "#52", number: 52, repo: "r" }, { tag: "#53", number: 53, repo: "r" }], 1)] }]);
    expect(h).toContain("ticket-table");
    expect(h).toContain("工作流 J–N · 3/5 合了");
    for (const c of ["ticket", "谁该动", "现在怎么样", "PR"]) expect(h).toContain(`<th>${c}</th>`);
    expect(h).toContain("—");
    expect(h).toContain("#52 #53");
    expect(h).toContain("另有 1 个 PR");
  });
  it("ticket key is a button so the row opens from the keyboard", () => {
    const h = html([{ name: null, merged: 0, total: 1, rows: [mk("A-1", [])] }]);
    expect(h).toMatch(/<button type="button" class="key">A-1<\/button>/);
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
  it("a long conversation scrolls in its own column instead of stretching the terminal past the window (wide layout)", () => {
    const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");
    const wide = /@media \(min-width: 901px\)\s*\{([^@]*?)\}\s*\}/.exec(css)?.[1] ?? "";
    const right = /\.control-right\s*\{([^}]*)/.exec(wide)?.[1] ?? "";
    // contain: size：右栏不参与这一行的高度，行高只看左栏（终端那一半）；右栏在这个高度里自己滚动。
    expect(right).toMatch(/contain:\s*size/);
    expect(right).toMatch(/overflow-y:\s*auto/);
  });
  it("the control tab starts with a one-line lede above the split", () => {
    const h = renderToStaticMarkup(createElement(ControlSplit, { lede: S.lay.ctlLede, left: "LEFT", right: "RIGHT" }));
    expect(S.lay.ctlLede).toBe("总控是帮你拆活、协调各个 ticket 的 session。左边是终端，右边是对话。");
    expect(STRINGS.en.lay.ctlLede).toBe("The control session splits up work and coordinates the tickets. Terminal on the left, conversation on the right.");
    expect(h).toContain(`<p class="muted control-lede">${S.lay.ctlLede}</p>`);
    expect(h.indexOf(S.lay.ctlLede)).toBeLessThan(h.indexOf("control-split"));
  });
  it("split renders both sides", () => {
    const h = renderToStaticMarkup(createElement(ControlSplit, { left: "LEFT", right: "RIGHT" }));
    expect(h).toContain("control-split");
    expect(h).toContain("LEFT");
    expect(h).toContain("RIGHT");
  });
  it("the conversation feed puts the reports in time order, oldest first", () => {
    const reports = [rep(2, 200, "NEWER"), rep(1, 100, "OLDER")];
    const items = buildTimeline({ messages: [], refreshMarks: [], convHasMore: false, forks: [], reports, reportsHasMore: false, filter: "all" });
    const actions = { followUp: async () => true, sendConclusion: noop, remember: noop, reaskFull: noop, retry: noop, pending: {}, notice: {}, memoryOn: true, canRemember: true };
    const h = renderToStaticMarkup(createElement(ConversationFeed, { items, hasOlder: false, onOlder: noop, actions, now: 1000 }));
    expect(h.indexOf("OLDER")).toBeLessThan(h.indexOf("NEWER"));
    expect(h).toContain("inbox-report");
    expect(reports[0].id).toBe(2);
  });
  it("without a control session the feed still lists reports oldest first and keeps the footer", () => {
    const reports = [rep(2, 200, "NEWER"), rep(1, 100, "OLDER")];
    const h = renderToStaticMarkup(createElement(ControlFeed, { reports, footer: createElement("i", null, "FOOT") }));
    expect(h.indexOf("OLDER")).toBeLessThan(h.indexOf("NEWER"));
    expect(h).toContain("<i>FOOT</i>");
  });
  it("empty feed", () => {
    expect(renderToStaticMarkup(createElement(ControlFeed, { reports: [] }))).toContain("子 session 的完成和卡住汇报会按时间出现在这里");
  });
});

describe("ScopeBoard", () => {
  const board = { items: [], counts: { you: 0 }, scopes: [], generatedAt: 0 } as never;
  const render = (turn: { board: unknown; error: string | null }) =>
    renderToStaticMarkup(createElement(ScopeBoard, { turn: turn as never, children: () => createElement("p", null, "BODY") }));
  it("shows a skeleton while loading, the board error with its own class, then the content", () => {
    expect(render({ board: null, error: null })).toBe('<div class="scope-overview" aria-busy="true"><p class="muted">…</p></div>');
    expect(render({ board: null, error: "boom" })).toBe('<p class="board-error">boom</p>');
    expect(render({ board, error: "stale" })).toBe("<p>BODY</p>");
  });
});
