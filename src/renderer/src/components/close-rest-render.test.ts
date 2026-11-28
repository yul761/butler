// @vitest-environment happy-dom
// 关着的 ticket 页上「关掉剩下的 PR」的缓存接线（BTL-270 审查）：真的挂载 TicketPage（happy-dom），对话框换成桩，
// 数 closePreview 被叫了几次：get 比 stamp、set 看代数、重新打开时 drop、对话框关掉了 PR 以后等监视记录跟上再预览一次、监视记录读不到照常预览不缓存。
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TicketView, WatchedPr } from "../../../shared/types";

const h = vi.hoisted(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const state = {
    watched: [] as unknown[] | "failed",
    previews: [] as { key: string; resolve: (n: number) => void }[],
    listeners: new Set<() => void>(),
    dialogs: [] as { rest: boolean; onClose: (closed: string[] | null) => void }[],
    watchCalls: [] as unknown[],
  };
  return state;
});

vi.mock("../api", () => {
  const known: Record<string, unknown> = {
    prWatchList: (key?: string) => {
      h.watchCalls.push(key);
      return h.watched === "failed" ? Promise.reject(new Error("db")) : Promise.resolve(h.watched);
    },
    closePreview: (key: string) =>
      new Promise((res) => h.previews.push({ key, resolve: (n) => res({ closable: Array.from({ length: n }, (_, i) => ({ url: `c${i}`, number: i })), unclosable: [] }) })),
    onStateChanged: (fn: () => void) => {
      h.listeners.add(fn);
      return () => h.listeners.delete(fn);
    },
  };
  return { api: new Proxy({}, { get: (_t, k) => known[String(k)] ?? (String(k).startsWith("on") ? () => () => {} : () => new Promise(() => {})) }) };
});
vi.mock("./CloseTicketDialog", () => ({
  CloseTicketDialog: (p: { rest?: boolean; onClose: (closed: string[] | null) => void }) => {
    h.dialogs.push({ rest: p.rest === true, onClose: p.onClose });
    return null;
  },
}));

const { createRoot } = await import("react-dom/client");
const { TicketPage } = await import("./TicketPage");
const { restPreviews, REST_SETTLE_MS } = await import("../close-ticket-outcome");
const { STATE_DEBOUNCE_MS } = await import("./useStateRefetch");
const { S } = await import("../strings");

let n = 0;
const watch = (ticketKey: string, url: string, state: WatchedPr["state"] = "open") => ({ ticketKey, url, state }) as unknown as WatchedPr;
const ticket = (key: string, closed: boolean): TicketView =>
  ({
    key, title: "t", repos: [], sessions: [], hiddenSessions: [], status: "active", statusManual: closed ? "closed" : null,
    closure: closed ? { reason: "r", source: "user", at: 1 } : null, featureId: null,
  }) as unknown as TicketView;

const settle = async (ms = 0) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};
/** 监视记录变了：发一次 stateChanged，等防抖和重读。 */
const changed = async () => {
  await act(async () => {
    for (const fn of [...h.listeners]) fn();
  });
  await settle(STATE_DEBOUNCE_MS + 20);
};
const answer = async (count: number) => {
  const p = h.previews.shift()!;
  await act(async () => p.resolve(count));
  await settle();
};

describe("TicketPage's close-the-rest button and its preview cache (BTL-270 review)", () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let key: string;
  const mount = async (closed: boolean) => {
    await act(async () => root.render(createElement(TicketPage, { ticket: ticket(key, closed), onArchived: () => {}, onFix: () => {} })));
    await settle();
  };
  const remount = async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount(true);
  };
  const button = () => container.querySelector<HTMLButtonElement>(".ticket-close-rest");

  beforeEach(() => {
    key = `T-${++n}`;
    h.watched = [watch(key, "u1"), watch(key, "u2"), watch("OTHER", "x")];
    h.previews = [];
    h.dialogs = [];
    h.watchCalls = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("reads only this ticket's watch list, previews once, and a remount with the same open PRs uses the count; a changed stamp previews again", async () => {
    await mount(true);
    expect(h.watchCalls).toEqual([key]);
    expect(h.previews).toHaveLength(1);
    await answer(2);
    expect(button()).not.toBeNull();
    await remount();
    expect(h.previews).toHaveLength(0);
    expect(button()).not.toBeNull();
    // 总控在别处关了 u2：stamp 对不上，重新预览。
    h.watched = [watch(key, "u1")];
    await changed();
    expect(h.previews).toHaveLength(1);
    await answer(0);
    expect(button()).toBeNull();
  });

  it("a preview that comes back after the ticket was reopened is not cached, and reopening forgets the count", async () => {
    await mount(true);
    await answer(1);
    await remount();
    expect(h.previews).toHaveLength(0);
    // 重新打开：记下的数作废；再关上时要重新预览。
    await mount(false);
    await mount(true);
    expect(h.previews).toHaveLength(1);
    // 这次预览还在路上时又重新打开了：晚到的结果不写进缓存。
    await mount(false);
    await answer(3);
    await mount(true);
    expect(h.previews).toHaveLength(1);
  });

  it("after the dialog closed a PR, waits for the watch list to drop it and then previews exactly once", async () => {
    await mount(true);
    await answer(2);
    await act(async () => button()!.click());
    const d = h.dialogs.at(-1)!;
    expect(d.rest).toBe(true);
    await act(async () => d.onClose(["u1"]));
    await settle();
    // 监视记录还没跟上（u1 还开着）：不预览，按钮先藏起来（不显示算上了 u1 的旧数）。
    expect(h.previews).toHaveLength(0);
    expect(button()).toBeNull();
    h.watched = [watch(key, "u2")];
    await changed();
    expect(h.previews).toHaveLength(1);
    await answer(1);
    // 之后监视记录又刷新了一次（内容没变）：不再预览。
    await changed();
    expect(h.previews).toHaveLength(0);
    expect(button()).not.toBeNull();
  });

  it("the very first render after a close that is still waiting already hides the button (no one-frame flash)", async () => {
    await mount(true);
    await answer(2);
    await act(async () => button()!.click());
    // 数 settle 之后按钮被渲染了几次：读一次文案就是渲染了一次按钮。
    const tc = S.tc as unknown as Record<string, unknown>;
    const text = tc.closeRest;
    let rendered = 0;
    Object.defineProperty(tc, "closeRest", { configurable: true, enumerable: true, get: () => (rendered++, text) });
    try {
      await act(async () => h.dialogs.at(-1)!.onClose(["u1"]));
      await settle();
      expect(rendered).toBe(0);
      expect(button()).toBeNull();
    } finally {
      Object.defineProperty(tc, "closeRest", { configurable: true, enumerable: true, writable: true, value: text });
    }
  });

  it("cancelling the dialog without submitting keeps the count: no new preview, the button stays", async () => {
    await mount(true);
    await answer(2);
    await act(async () => button()!.click());
    await act(async () => h.dialogs.at(-1)!.onClose(null));
    await settle();
    expect(h.previews).toHaveLength(0);
    expect(button()).not.toBeNull();
    await remount();
    expect(h.previews).toHaveLength(0);
  });

  describe("waiting for the watch list, on fake timers", () => {
    /** 假定时器下往前走 ms（顺带跑完 promise）。 */
    const adv = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    const mountFake = async () => {
      await act(async () => root.render(createElement(TicketPage, { ticket: ticket(key, true), onArchived: () => {}, onFix: () => {} })));
      await adv(0);
    };
    const answerFake = async (count: number) => {
      const p = h.previews.shift()!;
      await act(async () => p.resolve(count));
      await adv(0);
    };
    const closeU1 = async () => {
      await mountFake();
      await answerFake(2);
      await act(async () => button()!.click());
      await act(async () => h.dialogs.at(-1)!.onClose(["u1"]));
      await adv(0);
    };
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });

    it("the watch list never drops the closed PR: previews exactly once when REST_SETTLE_MS is up", async () => {
      await closeU1();
      expect(h.previews).toHaveLength(0);
      expect(button()).toBeNull();
      await adv(REST_SETTLE_MS - 1);
      expect(h.previews).toHaveLength(0);
      await adv(1);
      expect(h.previews).toHaveLength(1);
      // 等完了、新的预览还没回来：还是不显示旧数。
      expect(button()).toBeNull();
      await answerFake(1);
      expect(button()).not.toBeNull();
      await adv(REST_SETTLE_MS * 3);
      expect(h.previews).toHaveLength(0);
    });

    it("unmounted while waiting: the timer is cleared and nothing previews later", async () => {
      await closeU1();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await act(async () => root.unmount());
      expect(vi.getTimerCount()).toBe(0);
      await adv(REST_SETTLE_MS * 2);
      expect(h.previews).toHaveLength(0);
      root = createRoot(container);
    });
  });

  it("a dialog that closed nothing previews once right away", async () => {
    await mount(true);
    await answer(2);
    await act(async () => button()!.click());
    await act(async () => h.dialogs.at(-1)!.onClose([]));
    await settle();
    expect(h.previews).toHaveLength(1);
    await answer(2);
    await changed();
    expect(h.previews).toHaveLength(0);
  });

  it("the first close (from the open ticket) also waits for the watch list before previewing", async () => {
    await mount(false);
    await act(async () => container.querySelector<HTMLButtonElement>(".ticket-close")!.click());
    const d = h.dialogs.at(-1)!;
    expect(d.rest).toBe(false);
    await act(async () => d.onClose(["u1"]));
    await mount(true);
    expect(h.previews).toHaveLength(0);
    h.watched = [watch(key, "u2")];
    await changed();
    expect(h.previews).toHaveLength(1);
  });

  it("a failed watch list read still previews and shows the button, but does not cache the count", async () => {
    h.watched = "failed";
    await mount(true);
    expect(h.previews).toHaveLength(1);
    await answer(1);
    expect(button()).not.toBeNull();
    expect(restPreviews.get(key, "")).toBeUndefined();
    await remount();
    expect(h.previews).toHaveLength(1);
  });

  it("a failed watch list read does not use a count cached for a ticket with no open PRs", async () => {
    h.watched = [];
    await mount(true);
    await answer(1);
    await remount();
    expect(h.previews).toHaveLength(0);
    h.watched = "failed";
    await changed();
    expect(h.previews).toHaveLength(1);
  });
});
