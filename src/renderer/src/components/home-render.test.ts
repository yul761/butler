import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EpicView, FeatureView, NowNotice, NowView, TicketView } from "../../../shared/types";
import type { ScopeTurnRow, TurnBoard } from "../../../shared/turn";
import { dotKey, type Dot } from "../sidebar-view";
import { S } from "../strings";
import { AllWorkBody, type AllWorkBodyProps } from "./AllWorkPage";
import { HomeMore } from "./HomeMore";
import { Notice, noticeKey } from "./Notice";
import { Sidebar } from "./Sidebar";

// UI 重做第 2 层：侧栏、卡片、首页、全部工作的渲染测试（renderToStaticMarkup，不调 api）。

const ticket = (key: string, o: Partial<TicketView> = {}): TicketView =>
  ({ key, title: `${key} title`, featureId: null, effectiveStatus: "active", status: "active", sessions: [], hiddenSessions: [], waiting: false, ...o }) as TicketView;
const feature = (id: number, epicId: number | null, tickets: TicketView[]): FeatureView =>
  ({ id, name: `Feature ${id}`, epicId, tickets, sessions: [], hiddenSessions: [], waiting: false, summary: null, ticketPrs: {}, activity: {} }) as unknown as FeatureView;
const epic = (id: number): EpicView =>
  ({ id, name: `Epic ${id}`, sessions: [], hiddenSessions: [], waiting: false, stuck: false, features: [] }) as unknown as EpicView;

describe("Sidebar", () => {
  const epics = [epic(1), epic(2)];
  const features = [feature(11, 1, [ticket("BTL-11", { featureId: 11 })]), feature(12, 2, [ticket("BTL-12", { featureId: 12 })])];
  const long = "x".repeat(200);
  const tickets = [ticket("BTL-9", { title: long })];
  const render = (youCount: number | null, dots = new Map<string, Dot>()) =>
    renderToStaticMarkup(createElement(Sidebar, {
      tickets, features, epics, youCount, dots, route: { page: "home" }, onNavigate: () => {}, keepAwake: false, onKeepAwake: () => {},
    }));

  it("lists the entries in order and drops the old ones", () => {
    const html = render(null);
    const order = [S.home, S.allWork, "Epic 1", "Feature 11", "BTL-11", "Epic 2", "BTL-9", S.butlerNav, S.selfGroup, S.lessons, S.effectNav, S.audit, S.settings, S.keepAwake];
    let at = -1;
    for (const s of order) {
      const i = html.indexOf(s, at + 1);
      expect(i, s).toBeGreaterThan(at);
      at = i;
    }
    for (const gone of [S.newTicket, S.progressNav, S.unclaimed, S.archived]) expect(html).not.toContain(gone);
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
    const html = render(1, new Map([[dotKey("epic", 1), { tone: "ask", you: 2 }]]));
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
    notices: [], needsYou: [], decisions: [], epics: [], butler: null, running: 0, memory: [], merges: [], ...o,
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
    epics: [epic(1), epic(2)], features: [] as FeatureView[], tickets: [ticket("BTL-9")], unclaimedCount: 0, now: 1000,
    onNewTicket: () => {}, onNewFeature: () => {}, onNewEpic: () => {}, onGo: () => {}, onOpenTicket: () => {},
  };
  const render = (o: Partial<AllWorkBodyProps> = {}) => renderToStaticMarkup(createElement(AllWorkBody, { board: null, ...base, ...o }));

  it("has the create buttons, the two entries and the four columns", () => {
    const html = render({ board: board([scope("epic", 1, { youCount: 2 }), scope("epic", 2), scope("ticket", "BTL-9", { total: 1, merged: 0 })]) });
    for (const t of [`+ ${S.newTicket}`, `+ ${S.newFeature}`, `+ ${S.newEpic}`, S.archived, S.hm.all.unclaimedBtn(0)]) expect(html).toContain(t);
    for (const c of [S.hm.all.colName, S.hm.all.colWho, S.hm.all.colNow, S.hm.all.colProgress]) expect(html).toContain(`>${c}</th>`);
    expect(html).toContain(S.hm.all.lede(2, 1));
    expect(html).toContain(S.hm.whoYou(2));
    expect(html).toContain(S.hm.scopeLine(4, 1, null));
    expect(html).toContain('class="turn-bar"');
    // 轮到你多的在前。
    expect(html.indexOf("Epic 1")).toBeLessThan(html.indexOf("Epic 2"));
  });

  it("counts unclaimed sessions on the button", () => {
    expect(S.hm.all.unclaimedBtn(0)).not.toMatch(/\d/);
    expect(render({ unclaimedCount: 1 })).toContain(S.hm.all.unclaimedBtn(1));
  });

  it("still draws the rows without a board, and a row with no stats shows a dash", () => {
    const html = render({ board: board([scope("epic", 1)]) });
    expect(html).toContain("Epic 2");
    expect(html).not.toContain("NaN");
    const row = /<tr[^>]*>(?:(?!<\/tr>).)*Epic 2(?:(?!<\/tr>).)*<\/tr>/.exec(html)![0];
    expect(row.match(/>—</g)?.length).toBe(3);
    expect(render()).toContain("Epic 1");
  });

  it("says so when there is no work, keeping the create buttons", () => {
    const html = render({ epics: [], tickets: [] });
    expect(html).toContain(S.hm.all.empty);
    expect(html).toContain(`+ ${S.newEpic}`);
    expect(html).not.toContain("<table");
  });

  it("puts the full name in a title", () => {
    const long = "y".repeat(200);
    expect(render({ epics: [{ ...epic(1), name: long } as EpicView] })).toContain(`title="${long}"`);
  });

  it("opens the stacks and intake fold only when a notice sent you here", () => {
    const fold = (open: boolean) => new RegExp(`aria-expanded="${open}"[^>]*>(?:(?!</button>).)*${S.hm.all.moreHeading}`);
    expect(render({ focusMore: "stacks" })).toMatch(fold(true));
    expect(render()).toMatch(fold(false));
  });
});
