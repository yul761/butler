import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FeatureView, NowNotice, NowView, TicketView } from "../../../shared/types";
import type { ScopeTurnRow, Turn, TurnBoard, TurnItem } from "../../../shared/turn";
import { buildTurnBoard } from "../../../main/turn/turn-board";
import { runningRows, type NameCtx } from "../home-view";
import { whoLabel } from "../scope-view";
import { turnSentence } from "../turn-text";
import { dotKey, type Dot } from "../sidebar-view";
import { S } from "../strings";
import { AllWorkBody, type AllWorkBodyProps } from "./AllWorkPage";
import { HomeMore } from "./HomeMore";
import { HomeBody, type HomeBodyProps } from "./HomePage";
import { Notice, noticeKey } from "./Notice";
import { Sidebar } from "./Sidebar";
import { TurnCard } from "./TurnCard";

// UI 重做第 2 层：侧栏、卡片、首页、全部工作的渲染测试（renderToStaticMarkup，不调 api）。

const ticket = (key: string, o: Partial<TicketView> = {}): TicketView =>
  ({ key, title: `${key} title`, featureId: null, effectiveStatus: "active", status: "active", sessions: [], hiddenSessions: [], waiting: false, ...o }) as TicketView;
const feature = (id: number, tickets: TicketView[] = []): FeatureView =>
  ({ id, name: `Feature ${id}`, tickets, sessions: [], hiddenSessions: [], waiting: false, summary: null, ticketPrs: {}, activity: {} }) as unknown as FeatureView;

describe("Sidebar", () => {
  const features = [feature(11, [ticket("BTL-11", { featureId: 11 })]), feature(12, [ticket("BTL-12", { featureId: 12 })])];
  const long = "x".repeat(200);
  const tickets = [ticket("BTL-9", { title: long })];
  const render = (youCount: number | null, dots = new Map<string, Dot>()) =>
    renderToStaticMarkup(createElement(Sidebar, {
      tickets, features, youCount, dots, route: { page: "home" }, onNavigate: () => {}, keepAwake: false, onKeepAwake: () => {},
    }));

  it("lists the entries in order and drops the old ones", () => {
    const html = render(null);
    const order = [S.home, S.allWork, "Feature 11", "BTL-11", "Feature 12", "BTL-12", "BTL-9", S.shipherdNav, S.selfGroup, S.lessons, S.effectNav, S.audit, S.settings, S.keepAwake];
    let at = -1;
    for (const s of order) {
      const i = html.indexOf(s, at + 1);
      expect(i, s).toBeGreaterThan(at);
      at = i;
    }
    for (const gone of [S.newTicket, "进度", S.unclaimed, S.archived]) expect(html).not.toContain(gone);
    // 没有 feature 上面的一层了：每个 feature 直接列在树的第一层。
    expect(html).not.toContain("epic-group");
    expect(html.split('class="feature-group"').length - 1).toBe(2);
  });

  it("shows the your-turn badge only above zero, with the count described for screen readers", () => {
    const html = render(3);
    expect(html).toContain("needs-you-badge");
    expect(html).toContain(S.nowNeedsYouBadge(3));
    expect(html).toContain(`aria-label="${S.home}"`);
    expect(render(0)).not.toContain("needs-you-badge");
    expect(render(null)).not.toContain("needs-you-badge");
    expect(render(150)).toContain(">99+<");
  });

  it("draws a dot where something moves and none elsewhere", () => {
    const html = render(1, new Map([[dotKey("feature", 11), { tone: "ask", you: 2 }]]));
    expect(html).toContain("turn-dot turn-ask");
    expect(html).toContain('<span class="cnt">2</span>');
    expect(html.match(/turn-dot/g)).toHaveLength(1);
  });

  it("keeps long names on one line with a title and the full ticket key", () => {
    const html = render(null);
    expect(html).toContain(`title="BTL-9 ${long}"`);
    expect(html).toContain('<span class="key">BTL-9</span>');
  });
});

describe("Notice (moved out of the Now page)", () => {
  it("keeps the notice keys", () => {
    expect(noticeKey({ kind: "lessons_paused" } as NowNotice)).toBe("lessons_paused");
    expect(noticeKey({ kind: "cost", breaker: { subjectKind: "ticket", subjectId: "BTL-1" } } as unknown as NowNotice)).toBe("cost:ticket:BTL-1");
  });

  it("an approval notice has a Take-a-look button", () => {
    const n: NowNotice = { kind: "approval", target: { page: "ticket", key: "BTL-1", sessionId: "s" }, title: "登录" };
    const html = renderToStaticMarkup(createElement(Notice, { notice: n, now: 0, onOpen: () => {}, onGo: () => {} }));
    expect(html).toContain('data-testid="now-notice-approval"');
    expect(html).toContain(S.noticeApproval("登录"));
    expect(html).toContain(`>${S.hm.act.look}</button>`);
    expect(noticeKey(n)).toBe("approval:ticket:BTL-1:s");
  });
});

describe("HomeMore (the old Now page's run-status blocks)", () => {
  const view = (o: Partial<NowView> = {}): NowView => ({
    notices: [], features: [], shipherd: null, running: 0, memory: [], merges: [], ...o,
  });
  const render = (v: NowView) => renderToStaticMarkup(createElement(HomeMore, { view: v, onOpen: () => {}, onOpenTicket: () => {}, liveTickets: new Set<string>(), onGo: () => {} }));

  it("shows the live window, recent merges and the intake log", () => {
    const html = render(view({
      merges: [{ id: 1, repoPath: "/r/app", kind: "wait", ticketKey: "BTL-1", branch: "b", otherTicket: null, otherBranch: null, files: [], createdAt: 1 }],
      intake: [{ at: 1, key: "BTL-2", what: "started", detail: null }],
    }));
    expect(html).toContain(S.liveTitle);
    expect(html).toContain(S.nowRecentMerges);
    expect(html).toContain('data-testid="now-intake"');
  });

  it("lists Shipherd's tell-you-only notices; the ones that need you are cards, not here", () => {
    const html = render(view({ notices: [
      { kind: "check_promoted", eventId: 3, batchId: null, names: ["lint"], at: 1 },
      { kind: "approval", target: { page: "ticket", key: "BTL-1", sessionId: "s" }, title: null } as NowNotice,
    ] }));
    expect(html).toContain(S.hm.infoNotices);
    expect(html).toContain('data-testid="now-notice-check_promoted"');
    expect(html).not.toContain('data-testid="now-notice-approval"');
    expect(render(view({ notices: [{ kind: "approval", target: { page: "ticket", key: "BTL-1", sessionId: "s" }, title: null } as NowNotice] }))).not.toContain(S.hm.infoNotices);
  });

  it("leaves out empty blocks", () => {
    const html = render(view());
    expect(html).not.toContain(S.nowRecentMerges);
    expect(html).not.toContain('data-testid="now-intake"');
    expect(html).not.toContain("now-mem-card");
  });
});

describe("AllWorkBody", () => {
  const scope = (kind: ScopeTurnRow["kind"], id: number | string, o: Partial<ScopeTurnRow> = {}): ScopeTurnRow => ({
    kind, id, name: String(id), total: 4, merged: 1, bar: { done: 1, agent: 1, you: 2, external: 0, idle: 0 }, youCount: 0, slowest: null, ...o,
  });
  const board = (scopes: ScopeTurnRow[]): TurnBoard => ({ items: [], counts: { you: 0, agent: 0, external: 0, mergedToday: 0 }, scopes, generatedAt: 1 });
  const base = {
    features: [feature(1), feature(2)], tickets: [ticket("BTL-9")], unclaimedCount: 0, now: 1000,
    onNewTicket: () => {}, onNewFeature: () => {}, onGo: () => {}, onOpenTicket: () => {},
  };
  const render = (o: Partial<AllWorkBodyProps> = {}) => renderToStaticMarkup(createElement(AllWorkBody, { board: null, ...base, ...o }));

  it("has the create buttons, the two entries and the four columns", () => {
    const html = render({ board: board([scope("feature", 1, { youCount: 2 }), scope("feature", 2), scope("ticket", "BTL-9", { total: 1, merged: 0 })]) });
    for (const t of [`+ ${S.newTicket}`, `+ ${S.newFeature}`, S.archived]) expect(html).toContain(t);
    // 「显示 Shipherd 之外开的 session」默认关：没有未认领入口（BTL-244）。
    expect(html).not.toContain(S.hm.all.unclaimedBtn(0));
    expect(render({ showUnclaimed: true, unclaimedCount: 3 })).toContain(S.hm.all.unclaimedBtn(3));
    // 只有两个新建按钮（ticket、feature）和「已归档」入口（BTL-246 去掉了新建 epic）。
    const actions = /<div class="actions all-work-actions">((?:(?!<\/div>).)*)<\/div>/.exec(html)![1];
    expect(actions.split("<button").length - 1).toBe(3);
    for (const c of [S.hm.all.colName, S.hm.all.colWho, S.hm.all.colNow, S.hm.all.colProgress]) expect(html).toContain(`>${c}</th>`);
    expect(html).toContain(S.hm.all.lede(2, 1));
    expect(html).toContain(S.hm.whoYou(2));
    expect(html).toContain(S.hm.scopeLine(4, 1, null));
    expect(html).toContain('class="turn-bar"');
    // 轮到你多的在前。
    expect(html.indexOf("Feature 1")).toBeLessThan(html.indexOf("Feature 2"));
  });

  it("a ticket row keeps its key whole and says the ticket's own state, not a scope count", () => {
    const merged = scope("ticket", "BTL-9", { total: 1, merged: 1, bar: { done: 1, agent: 0, you: 0, external: 0, idle: 0 } });
    const html = render({ board: board([merged]) });
    expect(html).toContain('<span class="key">BTL-9</span><span class="title">BTL-9 title</span>');
    expect(html).toContain('title="BTL-9 BTL-9 title"');
    expect(html).toContain(`<td>${S.turn.done}</td>`);
    expect(html).not.toContain(S.hm.scopeLine(1, 1, null));
  });

  it("counts unclaimed sessions on the button", () => {
    expect(S.hm.all.unclaimedBtn(0)).not.toMatch(/\d/);
    expect(render({ showUnclaimed: true, unclaimedCount: 1 })).toContain(S.hm.all.unclaimedBtn(1));
  });

  it("still draws the rows without a board, and a row with no stats shows a dash", () => {
    const html = render({ board: board([scope("feature", 1)]) });
    expect(html).toContain("Feature 2");
    expect(html).not.toContain("NaN");
    const row = /<tr[^>]*>(?:(?!<\/tr>).)*Feature 2(?:(?!<\/tr>).)*<\/tr>/.exec(html)![0];
    expect(row.match(/>—</g)?.length).toBe(3);
    expect(render()).toContain("Feature 1");
  });

  it("a single ticket's row says where the ticket's own item stands", () => {
    const turn: Turn = { owner: "external", kind: "ci_running", names: [] };
    const it9: TurnItem = { ticketKey: "BTL-9", pr: null, featureId: null, turn, since: 1, others: 0, ticketLevel: true };
    const html = render({ board: { ...board([scope("ticket", "BTL-9", { total: 1, merged: 0 })]), items: [it9] } });
    const row = /<tr[^>]*all-work-row-ticket-BTL-9(?:(?!<\/tr>).)*<\/tr>/.exec(html)![0];
    expect(row).toContain(turnSentence(turn, it9, S));
    expect(row).not.toContain(S.hm.scopeLine(1, 0, null));
  });

  describe("a single ticket's who says it the same way as the home page's running tab and the scope pages", () => {
    // 主进程不带 filter 的看板（App 给全部工作页的就是它）：BTL-9 单独一个，有一个 PR。
    const NOW = 1_000_000;
    const homeBoard = (prTurn: Turn, sessionTurn: Turn): TurnBoard => buildTurnBoard({
      features: [], loose: [], reviews: [], dayStart: 0, now: NOW,
      tickets: [{
        key: "BTL-9", name: "BTL-9", featureId: null, moreAsks: [], others: [{ turn: sessionTurn, since: NOW - 5 }],
        prs: [{ repo: "acme/app", number: 5, title: "t", url: "u", turn: prTurn, since: NOW - 9, mergedAt: null }],
      }],
    }, null);
    const whoCell = (b: TurnBoard) => /<tr[^>]*all-work-row-ticket-BTL-9[^>]*>(?:(?!<\/td>).)*<\/td><td>((?:(?!<\/td>).)*)<\/td>/.exec(render({ board: b }))![1];
    it("the PR waits for amy's review while the session works: agent, not external", () => {
      const b = homeBoard({ owner: "external", kind: "awaiting_review", names: ["amy"] }, { owner: "agent", kind: "working", sessionId: "s" });
      const run = runningRows(b.items, S, NOW);
      expect(run.map((r) => r.who)).toEqual([S.hm.whoAgent]);
      expect(whoCell(b)).toContain(`>${S.hm.whoAgent}</span>`);
      expect(whoCell(b)).toContain("turn-agent");
      expect(whoCell(b)).not.toContain(S.hm.whoExternal);
    });
    it("CI is running while the session is stopped: CI, like the running tab", () => {
      const b = homeBoard({ owner: "external", kind: "ci_running", names: [] }, { owner: "you", kind: "unattended", why: "agent_stopped", canSend: false, sessionId: "s" });
      const run = runningRows(b.items, S, NOW);
      expect(run.map((r) => r.who)).toEqual([S.hm.whoCi]);
      expect(whoCell(b)).toContain(`>${whoLabel(b.items[0].turn, S)}</span>`);
      expect(whoCell(b)).toContain(`>${S.hm.whoCi}</span>`);
    });
  });

  it("says so when there is no work, keeping the create buttons", () => {
    const html = render({ features: [], tickets: [] });
    expect(html).toContain(S.hm.all.empty);
    expect(html).toContain(`+ ${S.newFeature}`);
    expect(html).not.toContain("<table");
  });

  it("puts the full name in a title", () => {
    const long = "y".repeat(200);
    expect(render({ features: [{ ...feature(1), name: long }] })).toContain(`title="${long}"`);
  });

  it("opens the stacks and intake fold only when a notice sent you here", () => {
    const fold = (open: boolean) => new RegExp(`aria-expanded="${open}"[^>]*>(?:(?!</button>).)*${S.hm.all.moreHeading}`);
    expect(render({ focusMore: "stacks" })).toMatch(fold(true));
    expect(render()).toMatch(fold(false));
  });
});

describe("TurnCard", () => {
  const ctx: NameCtx = { features: new Map([[11, "Feature名"]]), tickets: new Map([["BTL-1", "t"]]) };
  const item = (turn: Turn, o: Partial<TurnItem> = {}): TurnItem =>
    ({ ticketKey: "BTL-1", pr: null, featureId: 11, turn, since: 1, others: 0, ...o });
  const render = (i: TurnItem) => renderToStaticMarkup(createElement(TurnCard, {
    item: i, ctx, now: 60_001, onFix: () => {}, onOpen: () => {}, onGo: () => {}, onChanged: () => {},
  }));
  const pr = { repo: "acme/app", number: 12, title: "PR", url: "https://github.com/acme/app/pull/12" };

  it("an answer card offers the options and a look", () => {
    const turn: Turn = { owner: "you", kind: "answer", question: "要不要先回测？", options: ["可以", "不行，先回测"], askId: 7, sessionId: "s" };
    const html = render(item(turn));
    expect(html).toContain('class="turn-tag turn-ask"');
    expect(html).toContain(S.hm.kind.answer);
    expect(html).toContain(">可以</button>");
    expect(html).toContain(">不行，先回测</button>");
    expect(html).toContain(`>${S.hm.act.look}</button>`);
    expect(html).toContain(turnSentence(turn, item(turn), S));
    expect(html).toContain('<span class="path" title="Feature名 › BTL-1"><span class="scope">Feature名 › </span><span class="key">BTL-1</span></span>');
    expect(render(item({ ...turn, askId: null }))).not.toContain(">可以</button>");
  });

  it("a merge card opens the PR", () => {
    const html = render(item({ owner: "you", kind: "merge", risk: null }, { pr }));
    expect(html).toContain(`>${S.hm.act.openPr}</button>`);
    expect(html).toContain('class="turn-tag turn-merge"');
  });

  it("a review card shows the repo and author, with no look", () => {
    const html = render(item({ owner: "you", kind: "review", author: "bob", title: "PR", url: pr.url }, { ticketKey: null, featureId: null, pr }));
    expect(html).toContain("acme/app#12 · bob");
    expect(html).not.toContain(S.hm.act.look);
  });

  it("a stuck card offers a fix session only inside a feature", () => {
    const turn: Turn = { owner: "you", kind: "stuck", source: "silent", detail: null, sessionId: "s" };
    expect(render(item(turn))).toContain(`>${S.hm.act.fix}</button>`);
    expect(render(item(turn, { featureId: null }))).not.toContain(S.hm.act.fix);
  });

  it("a silent stuck card can be ignored; a stuck the session reported itself cannot", () => {
    const silent: Turn = { owner: "you", kind: "stuck", source: "silent", detail: null, sessionId: "s" };
    expect(render(item(silent))).toContain(`>${S.hm.act.ignore}</button>`);
    expect(render(item({ ...silent, source: "needs_you", detail: "卡在权限上" }))).not.toContain(`>${S.hm.act.ignore}</button>`);
  });

  it("a silent stuck card shows the judge's suggestion on a line after the reason", () => {
    const silent: Turn = { owner: "you", kind: "stuck", source: "silent", detail: "在等锁", action: "结束进程再重跑", sessionId: "s" };
    const html = render(item(silent));
    expect(html).toMatch(/在等锁<\/p><p class="stuck-action">/);
    expect(html).toContain(`<p class="stuck-action">${S.hm.stuckAction("结束进程再重跑")}</p>`);
    expect(render(item({ ...silent, action: null }))).not.toContain("stuck-action");
  });

  it("a Shipherd card renders the notice with its own buttons", () => {
    const html = render(item({ owner: "you", kind: "shipherd", notice: { kind: "lessons_paused" } }, { ticketKey: null, featureId: null }));
    expect(html).toContain('data-testid="now-notice-lessons_paused"');
    expect(html).toContain(S.hm.kind.shipherd);
    expect(html).not.toContain(S.hm.act.look);
  });

  it("puts the full location in a title", () => {
    const long = "z".repeat(200);
    const html = renderToStaticMarkup(createElement(TurnCard, {
      item: item({ owner: "you", kind: "merge", risk: null }), ctx: { ...ctx, features: new Map([[11, long]]) }, now: 1, onFix: () => {}, onOpen: () => {}, onGo: () => {}, onChanged: () => {},
    }));
    expect(html).toContain(`title="${long} › BTL-1"`);
  });
});

describe("HomeBody", () => {
  const ctx: NameCtx = { features: new Map(), tickets: new Map() };
  const you = (n: number): TurnItem => ({ ticketKey: `BTL-${n}`, pr: null, featureId: null, turn: { owner: "you", kind: "merge", risk: null }, since: 1, others: 0 });
  const busy = (n: number): TurnItem => ({ ticketKey: `RUN-${n}`, pr: null, featureId: null, turn: { owner: "agent", kind: "working", sessionId: "s" }, since: 1, others: 0 });
  const scope = (id: number, o: Partial<ScopeTurnRow> = {}): ScopeTurnRow => ({
    kind: "feature", id, name: `Feature ${id}`, total: 4, merged: 1, bar: { done: 1, agent: 1, you: 2, external: 0, idle: 0 }, youCount: 0, slowest: null, ...o,
  });
  const counts = { you: 0, agent: 2, external: 1, mergedToday: 3 };
  const board = (items: TurnItem[], scopes: ScopeTurnRow[] = [scope(1, { youCount: 2 })]): TurnBoard => ({ items, counts, scopes, generatedAt: 1 });
  const nowView: NowView = { notices: [], features: [], shipherd: null, running: 0, memory: [], merges: [], mem: { lines: [], updatedAt: 1 } as unknown as NowView["mem"] };
  const render = (o: Partial<HomeBodyProps> = {}) => renderToStaticMarkup(createElement(HomeBody, {
    board: null, error: null, noWork: false, firstRun: createElement("div", { "data-testid": "first-run" }), ctx, now: 10_000, nowView,
    liveTickets: new Set<string>(), onRetry: () => {}, onFix: () => {}, onOpen: () => {}, onGo: () => {}, onOpenTicket: () => {}, onChanged: () => {}, onResumeSetup: () => {}, ...o,
  }));
  const cards = (html: string) => html.split('data-testid="turn-card"').length - 1;

  it("shows the title, lede, cards, the scope table and a folded running list", () => {
    const html = render({ board: board([you(1), you(2), you(3), busy(1), busy(2)]) });
    expect(html).toContain(S.hm.title(3));
    expect(html).toContain(S.hm.lede(2, 1, 3));
    expect(cards(html)).toBe(3);
    expect(html).toContain(S.hm.scopeLine(4, 1, null));
    expect(html).toContain('<div class="turn-bar">');
    expect(html).toContain(S.hm.whoYou(2));
    expect(html).toContain(S.hm.running(2));
    expect(html).not.toContain("RUN-1");
  });

  it("with nothing for you still shows the scope table", () => {
    const html = render({ board: board([busy(1)]) });
    expect(html).toContain(S.hm.titleZero);
    expect(cards(html)).toBe(0);
    expect(html).toContain(S.hm.scopesHeading);
  });

  it("caps the cards at 20 and the scopes at 8", () => {
    const html = render({ board: board(Array.from({ length: 25 }, (_, i) => you(i)), Array.from({ length: 12 }, (_, i) => scope(i))) });
    expect(cards(html)).toBe(20);
    expect(html).toContain(S.hm.showAll(25));
    expect(html.split('class="home-scope"').length - 1).toBe(8);
    expect(html).toContain(S.hm.scopeMore(12));
  });

  it("shows a failure with retry, a stale note, or loading", () => {
    const failed = render({ error: "boom" });
    expect(failed).toContain(S.hm.boardFailed);
    expect(failed).toContain(S.hm.retry);
    expect(failed).not.toContain(S.hm.titleZero);
    const stale = render({ board: board([you(1)]), error: "boom" });
    expect(stale).toContain(S.hm.boardStale);
    expect(cards(stale)).toBe(1);
    expect(render()).toContain(S.loading);
  });

  it("renders only the first-run node when there is no work", () => {
    const html = render({ board: board([you(1)]), noWork: true });
    expect(html).toContain('data-testid="first-run"');
    expect(html).not.toContain(S.hm.title(1));
  });

  it("puts a long scope name in a title and keeps run status folded", () => {
    const long = "y".repeat(200);
    const html = render({ board: board([], [scope(1, { name: long })]) });
    expect(html).toContain(`title="${long}"`);
    expect(html).toContain(S.hm.moreHeading);
    expect(html).not.toContain("now-mem-card");
    expect(html).not.toContain(S.liveTitle);
  });
});
