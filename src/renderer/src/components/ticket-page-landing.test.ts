// TicketPage 的落点 effect（M-7）：卡片带着轮次进来，页面一打开就落；看板后来才到，也不再落一次。
// 测试环境没有 DOM，effect 不会在 renderToStaticMarkup 里跑：这里把 TicketPage 当函数调，换一套最小的 useState / useRef / useEffect，
// 每「渲染」一次按顺序取槽位、依赖变了才跑 effect（同 React 的规则），看它交给 PageTabs 的 forceTab / forceSeq。
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Turn, TurnBoard } from "../../../shared/turn";
import type { SessionView, TicketView } from "../../../shared/types";
import { PageTabs } from "./PageTabs";
import { TicketPage } from "./TicketPage";

const h = vi.hoisted(() => {
  let slots: unknown[] = [];
  let at = 0;
  let pending: (() => unknown)[] = [];
  return {
    reset: () => { slots = []; },
    begin: () => { at = 0; pending = []; },
    flush: () => { for (const f of pending) f(); pending = []; },
    useState: (init: unknown) => {
      const k = at++;
      if (!(k in slots)) slots[k] = typeof init === "function" ? (init as () => unknown)() : init;
      return [slots[k], (v: unknown) => { slots[k] = typeof v === "function" ? (v as (x: unknown) => unknown)(slots[k]) : v; }];
    },
    useRef: (init: unknown) => {
      const k = at++;
      if (!(k in slots)) slots[k] = { current: init };
      return slots[k];
    },
    useEffect: (fn: () => unknown, deps?: unknown[]) => {
      const k = at++;
      const prev = slots[k] as unknown[] | undefined;
      if (prev === undefined || deps === undefined || deps.some((d, j) => !Object.is(d, prev[j]))) {
        slots[k] = deps ?? [];
        pending.push(fn);
      }
    },
  };
});
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useState: h.useState, useRef: h.useRef, useEffect: h.useEffect }));

const tb = vi.hoisted(() => ({ board: null as TurnBoard | null }));
vi.mock("./useTurnBoard", () => ({ useTurnBoard: () => ({ board: tb.board, error: null, reload: () => {} }) }));
const term = vi.hoisted(() => ({ setActive: vi.fn(), open: vi.fn(async () => {}), panesRef: { current: ["t1"] } }));
vi.mock("./TicketTerminalTab", () => ({ useTicketTerminals: () => term, TicketTerminalTab: () => null }));

const stopped: Turn = { owner: "you", kind: "unattended", why: "agent_stopped", canSend: false, sessionId: "s1" };
const ticket = {
  key: "K-1", title: null, repos: [], status: "active", statusManual: null, createdAt: 0, archivedAt: null, featureId: null,
  effectiveStatus: "active", hiddenSessions: [], waiting: false, sessions: [{ id: "s1", termId: "t1" } as SessionView],
} as unknown as TicketView;
const board: TurnBoard = {
  items: [{ ticketKey: "K-1", epicId: null, featureId: null, pr: null, turn: stopped, since: 0, others: 0, ticketLevel: true }],
  scopes: [], stats: { mergedToday: 0, ciFixedToday: 0, staleCount: 0 },
} as unknown as TurnBoard;

type Tabs = ReactElement<{ forceTab: string | null; forceSeq?: number; tabs: { id: string; content: ReactElement<{ focus?: unknown }> }[] }>;

/** 渲染一次：调 TicketPage，跑依赖变了的 effect，返回它交给的 PageTabs。 */
function renderTabs(props: Parameters<typeof TicketPage>[0]): Tabs {
  h.begin();
  const el = TicketPage(props) as ReactElement;
  h.flush();
  const find = (n: ReactNode): ReactElement | null => {
    if (Array.isArray(n)) return n.map(find).find((x) => x !== null) ?? null;
    if (n === null || typeof n !== "object" || !("type" in n)) return null;
    const e = n as ReactElement<{ children?: ReactNode }>;
    return e.type === PageTabs ? e : find(e.props.children);
  };
  return find(el) as Tabs;
}

/** 渲染一次，返回交给 PageTabs 的落点。 */
function render(props: Parameters<typeof TicketPage>[0]) {
  const tabs = renderTabs(props);
  return { forceTab: tabs.props.forceTab, forceSeq: tabs.props.forceSeq };
}

/** 渲染一次，返回「对话」页签内容拿到的落点 session。 */
const convFocus = (props: Parameters<typeof TicketPage>[0]): unknown =>
  renderTabs(props).props.tabs.find((t) => t.id === "conversation")?.content.props.focus ?? null;

describe("TicketPage lands once from the card's turn", () => {
  beforeEach(() => {
    h.reset();
    tb.board = null;
    term.setActive.mockClear();
  });
  const props = { ticket, onArchived: () => {}, landing: stopped, onFix: () => {} };

  it("lands before the board arrives, and the board arriving does not land again", () => {
    render(props);
    // 看板还没到：已经落在终端，切到那个 session 的终端。
    expect(render(props)).toEqual({ forceTab: "terminal", forceSeq: 1 });
    expect(term.setActive).toHaveBeenCalledWith("t1");
    // 用户这时自己点了别的页签（PageTabs 记着）。看板到了：落点不变，forceSeq 不加，PageTabs 不会把用户拉回终端。
    tb.board = board;
    render(props);
    expect(render(props)).toEqual({ forceTab: "terminal", forceSeq: 1 });
    expect(term.setActive).toHaveBeenCalledTimes(1);
  });

  it("a stuck card on the fix session lands on the conversation with that session selected", () => {
    const stuck: Turn = { owner: "you", kind: "stuck", source: "silent", detail: null, sessionId: "s2" };
    const p = { ticket, onArchived: () => {}, landing: stuck, onFix: () => {} };
    render(p);
    expect(render(p)).toEqual({ forceTab: "conversation", forceSeq: 1 });
    expect(convFocus(p)).toEqual({ sessionId: "s2", n: 1 });
    expect(term.setActive).not.toHaveBeenCalled();
  });

  it("without a landing it never forces a tab, board or not", () => {
    const plain = { ticket, onArchived: () => {}, onFix: () => {} };
    render(plain);
    tb.board = board;
    render(plain);
    expect(render(plain)).toEqual({ forceTab: null, forceSeq: undefined });
  });
});
