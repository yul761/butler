// feature 页整页的渲染（renderToStaticMarkup，不调 api）：看板换成固定的一份，看页面把它接到哪里。
// 只测接线：页签标红、概况里的卡片跟 ticket 级的轮次走（scopeBoardView），「总控」页签上面有那句说明。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Turn, TurnBoard, TurnFilter } from "../../../shared/turn";
import type { FeatureView, SessionView, TicketView } from "../../../shared/types";
import { buildTurnBoard, type BoardTicket } from "../../../main/turn/turn-board";
import type { NameCtx } from "../home-view";
import { S } from "../strings";
import { FeaturePage } from "./FeaturePage";

const mock = vi.hoisted(() => ({ board: null as TurnBoard | null, filters: [] as unknown[] }));
vi.mock("./useTurnBoard", () => ({
  useTurnBoard: (filter?: unknown) => {
    mock.filters.push(filter);
    return { board: mock.board, error: null, reload: () => {} };
  },
}));

// session 行上的成本提示订阅一个外部 store，服务端渲染没有快照；这里只看「总控」页签的那句说明，不要它。
vi.mock("./SessionCost", () => ({ SessionCost: () => null }));

const NOW = 1_000_000;
const review: Turn = { owner: "external", kind: "awaiting_review", names: ["amy"] };
const stopped: Turn = { owner: "you", kind: "unattended", why: "agent_stopped", canSend: false, sessionId: "s1" };
/** 主进程按这个 filter 取的看板：K-1 在 feature 10 下，session 停着；withPr 时还有一个在等 amy review 的 PR。 */
const boardFor = (filter: TurnFilter, withPr: boolean): TurnBoard => {
  const k1: BoardTicket = {
    key: "K-1", name: "K-1", featureId: 10, moreAsks: [], others: [{ turn: stopped, since: NOW - 5 }],
    prs: withPr ? [{ repo: "acme/app", number: 5, title: "t", url: "u", turn: review, since: NOW - 9, mergedAt: null }] : [],
  };
  return buildTurnBoard({ features: [{ id: 10, name: "F" }], tickets: [k1], loose: [], reviews: [], dayStart: 0, now: NOW }, filter);
};

const session = (id: string, o: Partial<SessionView> = {}): SessionView => ({
  id, ticketKey: null, cwd: "/w", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null, waitingForInput: false,
  replacedBy: null, dismissed: false, createdAt: 0, repoId: null, coordinator: true, spawnedBy: null, featureId: null, fixesSession: null,
  model: null, termId: null, rootId: id, ...o,
} as SessionView);
const ticket = { key: "K-1", title: "one", repos: [], status: "active", statusManual: null, createdAt: 0, archivedAt: null, featureId: 10, effectiveStatus: "active", sessions: [], hiddenSessions: [], waiting: false } as unknown as TicketView;
const feature = (o: Partial<FeatureView> = {}): FeatureView => ({
  id: 10, name: "F", workspaceDir: "/w/f", repos: [], createdAt: 0, archivedAt: null, brief: null, automationLevel: null,
  tickets: [ticket], blocks: [], sessions: [], hiddenSessions: [], waiting: false, summary: null, ticketPrs: {}, activity: {}, ...o,
});
const ctx: NameCtx = { features: new Map([[10, "F"]]), tickets: new Map([["K-1", "one"]]) };
const noop = () => {};

const featurePage = (o: { landing?: "control"; feature?: FeatureView } = {}) => renderToStaticMarkup(createElement(FeaturePage, {
  feature: o.feature ?? feature(), onOpenTicket: noop, onTicketCreated: noop, landing: o.landing, onOpenTarget: noop, ctx, onFix: noop, onGo: noop,
}));
/** 「概况」页签按钮的 class。 */
const overviewTab = (html: string) => /<button[^>]*class="([^"]*tab-overview[^"]*)"/.exec(html)![1];

describe("feature page overview wiring", () => {
  const filter: TurnFilter = { featureId: 10 };
  const render = () => featurePage();
  it("a PR waiting for review and a stopped session: the overview tab is not flagged and has no card", () => {
    mock.board = boardFor(filter, true);
    mock.filters = [];
    const html = render();
    expect(mock.filters).toContainEqual(filter);
    expect(overviewTab(html)).not.toContain("attention");
    expect(html).not.toContain('data-testid="turn-card"');
    expect(html).toContain(S.lay.noYouHere);
  });
  it("a stopped session with no PR is your turn: flagged, with its card", () => {
    mock.board = boardFor(filter, false);
    const html = render();
    expect(overviewTab(html)).toContain("attention");
    expect(html).toContain('data-testid="turn-card"');
  });
});

describe("the control tab's lede on the feature page", () => {
  it("feature page", () => {
    mock.board = boardFor({ featureId: 10 }, true);
    const html = featurePage({ landing: "control", feature: feature({ sessions: [session("f1", { featureId: 10 })] }) });
    expect(html).toContain("tab-panel-control");
    expect(html).toContain(`<p class="muted control-lede">${S.lay.ctlLede}</p>`);
  });
});

describe("feature page header", () => {
  it("has no move-to picker any more: rename, archive and the epic level (BTL-247) only", () => {
    mock.board = boardFor({ featureId: 10 }, true);
    const html = featurePage();
    expect(html.match(/<select/g)).toHaveLength(1);
    expect(html).toContain('data-testid="epic-level-select"');
    expect(html).toContain(S.archiveFeature);
  });
});
