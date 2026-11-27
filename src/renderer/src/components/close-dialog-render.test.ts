// @vitest-environment happy-dom
// 关闭框（BTL-270 审查）：真的挂载（happy-dom），看它交给 onClose 的「这次真关掉了的 PR」（关闭加上每次重试，ticket 页按它等监视记录跟上），
// 和 ticket 刚被别人关了、勾了的又没处理成时的提示（不说「没有要你再做的」）。
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloseLeftoversResult } from "../close-ticket-outcome";
import type { Ticket } from "../../../shared/types";

const h = vi.hoisted(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  return { results: [] as (CloseLeftoversResult | Error)[], calls: [] as string[] };
});
const next = () => {
  const r = h.results.shift()!;
  return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
};
vi.mock("../api", () => ({
  api: {
    closePreview: () => Promise.resolve({ closable: [{ url: "u1", number: 1 }, { url: "u2", number: 2 }], unclosable: [] }),
    closeTicket: () => (h.calls.push("close"), next()),
    retryClose: () => (h.calls.push("retry"), next()),
  },
}));

const { createRoot } = await import("react-dom/client");
const { CloseTicketDialog } = await import("./CloseTicketDialog");
const { S } = await import("../strings");

const result = (r: Partial<CloseLeftoversResult>): CloseLeftoversResult => ({ closedPrs: [], prErrors: [], endedSessions: [], sessionErrors: [], reopenedMeanwhile: false, ...r });
const failed = (url: string) => ({ url, error: "gh boom", kind: "failed" as const });
const ticket = { key: "T-1", closure: { reason: "r", source: "user", at: 1 } } as unknown as Ticket;

describe("CloseTicketDialog reports what it closed and what was left (BTL-270 review)", () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let closed: (string[] | null)[];
  let notices: string[];
  const mount = async (rest: boolean) => {
    await act(async () => root.render(createElement(CloseTicketDialog, { ticket, rest, onClose: (c: string[] | null) => closed.push(c), onNotice: (t: string) => notices.push(t) })));
  };
  const q = <T extends Element>(sel: string) => container.querySelector<T>(sel)!;
  const click = async (el: HTMLElement) => act(async () => el.click());
  const submit = async () => act(async () => q<HTMLFormElement>("form").requestSubmit());
  const tick = async () => {
    for (const box of container.querySelectorAll<HTMLInputElement>(".close-prs input[type=checkbox]")) await click(box);
  };

  beforeEach(() => {
    h.results = [];
    h.calls = [];
    closed = [];
    notices = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("passes the PRs closed by the first try and by the retry together", async () => {
    await mount(true);
    await tick();
    h.results.push(result({ closedPrs: ["u1"], prErrors: [failed("u2")] }), result({ closedPrs: ["u2"] }));
    await submit();
    expect(container.querySelector(".close-ticket-leftovers")).not.toBeNull();
    expect(closed).toEqual([]);
    await submit();
    expect(h.calls).toEqual(["retry", "retry"]);
    expect(closed).toEqual([["u1", "u2"]]);
    // 「关掉剩下的 PR」框本来就是关着的 ticket：有没处理成的也不提示「刚被关了」。
    expect(notices).toEqual([]);
  });

  it("leaving the leftovers passes only what was closed; cancelling without submitting passes null", async () => {
    await mount(true);
    await tick();
    h.results.push(result({ closedPrs: ["u1"], prErrors: [failed("u2")] }));
    await submit();
    await click([...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === S.tc.leaveIt)!);
    expect(closed).toEqual([["u1"]]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount(true);
    await click([...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === S.cancel)!);
    expect(closed).toEqual([["u1"], null]);
  });

  it("a submit that threw still counts as tried: cancelling afterwards passes an empty list, not null", async () => {
    await mount(true);
    await tick();
    h.results.push(new Error("ipc boom"));
    await submit();
    expect(container.textContent).toContain("ipc boom");
    await click([...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === S.cancel)!);
    expect(closed).toEqual([[]]);
  });

  it("closed meanwhile with a ticked PR that failed: says what was left, not 'nothing more to do', and keeps the retry box", async () => {
    await mount(false);
    const box = q<HTMLTextAreaElement>("textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "不做了");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick();
    h.results.push(result({ prErrors: [failed("u1"), failed("u2")], alreadyClosed: true }));
    await submit();
    expect(h.calls).toEqual(["close"]);
    expect(notices).toEqual([S.tc.closedMeanwhile.failed]);
    expect(notices).not.toContain(S.tc.closedMeanwhile.nothing);
    expect(container.querySelector(".close-ticket-leftovers")).not.toBeNull();
    expect(closed).toEqual([]);
  });
});
