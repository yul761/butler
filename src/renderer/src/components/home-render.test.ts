import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EpicView, FeatureView, TicketView } from "../../../shared/types";
import { dotKey, type Dot } from "../sidebar-view";
import { S } from "../strings";
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
