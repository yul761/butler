// @vitest-environment happy-dom
// 一个 session 的活动变了、board 里一项变了，只有用到它的那一块重画（BTL-277）。
// 真的挂载（happy-dom），在 React 的 DevTools 钩子上数每个组件这次提交里渲染了几次（生产构建的 react-dom 也这样报）。
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureView, NowView, TicketView } from "../../../shared/types";
import type { ScopeTurnRow, TurnBoard, TurnItem } from "../../../shared/turn";
import { keepSame } from "../keep-same";

const renders = vi.hoisted(() => {
  const counts = new Map<string, number>();
  type Fiber = { tag: number; type: unknown; flags: number; alternate: Fiber | null; child: Fiber | null; sibling: Fiber | null };
  const COMPONENT = new Set([0, 1, 11, 15]);
  const nameOf = (t: unknown): string => {
    const f = t as { displayName?: string; name?: string; render?: { name?: string }; type?: { name?: string } } | null;
    return f?.displayName ?? f?.name ?? f?.render?.name ?? f?.type?.name ?? "?";
  };
  const walk = (f: Fiber | null) => {
    while (f) {
      const prev = f.alternate;
      if (COMPONENT.has(f.tag) && (prev === null || (f.flags & 1) !== 0)) counts.set(nameOf(f.type), (counts.get(nameOf(f.type)) ?? 0) + 1);
      if (f.child && (prev === null || f.child !== prev.child)) walk(f.child);
      f = f.sibling;
    }
  };
  (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), inject() { return 1; }, checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) { walk(root.current.child); },
  };
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  return counts;
});

vi.mock("../api", () => ({
  api: new Proxy({}, { get: (_t, k) => (String(k).startsWith("on") ? () => () => {} : () => new Promise(() => {})) }),
}));

const { createRoot } = await import("react-dom/client");
const { createLiveStore, LiveStoreContext } = await import("../live-store");
const { LiveHomePage, LiveSidebar } = await import("./live-pages");

const ticket = (key: string, featureId: number | null): TicketView =>
  ({ key, title: `${key} title`, featureId, effectiveStatus: "active", status: "active", sessions: [{ id: `s-${key}` }], hiddenSessions: [], waiting: false }) as unknown as TicketView;
const feature = (id: number, activity: string, name = `Feature ${id}`): FeatureView =>
  ({ id, name, tickets: [ticket(`T-${id}`, id)], sessions: [], hiddenSessions: [], waiting: false, summary: null, ticketPrs: {}, activity: { [`T-${id}`]: { state: activity } } }) as unknown as FeatureView;
const nowView = { notices: [], features: [], shipherd: null, running: 0, memory: [], merges: [], mem: null } as unknown as NowView;

const card = (n: number, question: string): TurnItem => ({
  ticketKey: `T-${n}`, pr: null, featureId: n, since: 1, others: 0,
  turn: { owner: "you", kind: "answer", question, options: ["好"], askId: n, sessionId: `s-T-${n}` },
});
const scope = (id: number, youCount: number): ScopeTurnRow => ({
  kind: "feature", id, name: `Feature ${id}`, total: 1, merged: 0, closed: 0, bar: { done: 0, agent: 0, you: youCount, external: 0, idle: 1 - youCount }, youCount, slowest: null,
});
const board = (q2: string): TurnBoard => ({
  items: [card(1, "第一个问题？"), card(2, q2)], scopes: [scope(1, 1), scope(2, 1)], counts: { you: 2, agent: 0, external: 0, mergedToday: 0 }, generatedAt: 1,
});

describe("live store + memo: only what changed re-renders (BTL-277)", () => {
  let data: { features: FeatureView[] };
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let store: ReturnType<typeof createLiveStore>;
  const noop = () => {};
  const dots = new Map();
  const tree = (b: TurnBoard) =>
    createElement(LiveStoreContext.Provider, { value: store },
      createElement(LiveSidebar, { youCount: 2, dots, route: { page: "home" }, onNavigate: noop, keepAwake: false, onKeepAwake: noop }),
      createElement(LiveHomePage, {
        state: { board: b, error: null, reload: noop }, firstRun: null,
        onFix: noop, onOpen: noop, onGo: noop, onOpenTicket: noop, onChanged: noop, onResumeSetup: noop,
      }));
  const count = (name: string) => renders.get(name) ?? 0;
  const total = () => [...renders.values()].reduce((a, b) => a + b, 0);

  beforeEach(async () => {
    renders.clear();
    data = { features: [feature(1, "idle"), feature(2, "idle")] };
    store = createLiveStore({
      listTickets: async () => [],
      listFeatures: async () => structuredClone(data.features),
      unclaimed: async () => [],
      nowView: async () => structuredClone(nowView),
      onStateChanged: () => () => {},
    }, { onError: (e) => { throw e; } });
    await store.refresh();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(tree(board("第二个问题？"))));
    expect(container.querySelectorAll('[data-testid="turn-card"]')).toHaveLength(2);
    expect(container.querySelectorAll(".feature-group")).toHaveLength(2);
    expect(count("TurnCard")).toBe(2);
    renders.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("a session's activity changing re-renders nothing on the home page or in the sidebar", async () => {
    data.features[1] = feature(2, "working");
    await act(async () => void (await store.refresh()));
    expect(store.getState().features[1].activity).toEqual({ "T-2": { state: "working" } });
    expect(Object.fromEntries(renders)).toEqual({});
    expect(total()).toBe(0);
  });

  it("one card changing on the board re-renders that card only", async () => {
    const b1 = board("第二个问题？");
    await act(async () => root.render(tree(b1)));
    renders.clear();
    const b2 = keepSame(b1, board("换了一个问题？"));
    await act(async () => root.render(tree(b2)));
    expect(count("TurnCard")).toBe(1);
    expect(count("ScopeRow")).toBe(0);
    expect(count("FeatureGroup")).toBe(0);
    expect(count("TicketButton")).toBe(0);
    expect(container.textContent).toContain("换了一个问题？");
  });

  it("renaming one feature re-renders that sidebar group only", async () => {
    data.features[0] = feature(1, "idle", "改名了");
    await act(async () => void (await store.refresh()));
    expect(count("FeatureGroup")).toBe(1);
    expect(count("TicketButton")).toBe(0);
    expect(container.querySelector(".sidebar")?.textContent).toContain("改名了");
  });

  it("a nested field changing (one ticket's title inside a feature) still reaches the page, and only that ticket re-renders", async () => {
    const f = feature(2, "idle");
    (f.tickets[0] as { title: string }).title = "嵌套字段改了";
    data.features[1] = f;
    const untouched = store.getState().features[0];
    await act(async () => void (await store.refresh()));
    expect(store.getState().features[1].tickets[0].title).toBe("嵌套字段改了");
    expect(store.getState().features[0]).toBe(untouched);
    expect(count("TicketButton")).toBe(1);
    expect(container.querySelector(".sidebar")?.textContent).toContain("嵌套字段改了");
  });
});
