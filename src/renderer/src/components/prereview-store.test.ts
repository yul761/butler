import { describe, expect, it } from "vitest";
import { noPreReview, PRE_REVIEW_STATUS_MAX, type PreReviewStatusBatch, type PreReviewStatusRequest } from "../../../shared/prereview";
import { PreReviewStore } from "./prereview-store";

function setup() {
  const calls: PreReviewStatusRequest[] = [];
  const timers: (() => void)[] = [];
  let state: (() => void) | null = null;
  const store = new PreReviewStore({
    fetch: async (req) => {
      calls.push(req);
      const out: PreReviewStatusBatch = { tickets: {}, sessions: {}, prs: {} };
      for (const k of req.tickets ?? []) out.tickets[k] = { ticketKey: k, overall: { ...noPreReview(k), state: "queued", position: 1, id: 1 }, items: [] };
      for (const s of req.sessions ?? []) if (s === "s1") out.sessions[s] = { ...noPreReview("T-1"), state: "running", id: 2 };
      return out;
    },
    onStateChanged: (fn) => {
      state = fn;
      return () => (state = null);
    },
    setTimeout: (fn) => void timers.push(fn),
    report: (e) => {
      throw e;
    },
  });
  const flush = async () => {
    while (timers.length) timers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { store, calls, flush, fire: () => state?.(), listening: () => state !== null };
}

describe("PreReviewStore (BTL-271)", () => {
  it("badges mounted in the same render share one request", async () => {
    const t = setup();
    const off = t.store.subscribe(() => {});
    t.store.hold("tickets", "T-1");
    t.store.hold("tickets", "T-2");
    t.store.hold("sessions", "s1");
    t.store.hold("sessions", "s2");
    await t.flush();
    expect(t.calls).toEqual([{ tickets: ["T-1", "T-2"], sessions: ["s1", "s2"], prs: [] }]);
    expect(t.store.ticket("T-2")!.overall.state).toBe("queued");
    expect(t.store.session("s1")!.state).toBe("running");
    // 没有预审的 session 是 null（取过了），不是 undefined（还没取）
    expect(t.store.session("s2")).toBeNull();
    expect(t.store.session("s3")).toBeUndefined();
    off();
  });

  it("a state change refetches only what is still on the page; the last badge going away stops listening", async () => {
    const t = setup();
    const off = t.store.subscribe(() => {});
    const a = t.store.hold("tickets", "T-1");
    const b = t.store.hold("tickets", "T-2");
    await t.flush();
    b();
    t.fire();
    await t.flush();
    expect(t.calls.at(-1)).toEqual({ tickets: ["T-1"], sessions: [], prs: [] });
    a();
    off();
    expect(t.listening()).toBe(false);
  });

  it("two badges for the same ticket: one going away keeps the other", async () => {
    const t = setup();
    const off = t.store.subscribe(() => {});
    const a = t.store.hold("tickets", "T-1");
    t.store.hold("tickets", "T-1");
    await t.flush();
    a();
    t.fire();
    await t.flush();
    expect(t.calls.at(-1)!.tickets).toEqual(["T-1"]);
    off();
  });

  it("more ids than one request takes are split, none dropped", async () => {
    const t = setup();
    const off = t.store.subscribe(() => {});
    const n = PRE_REVIEW_STATUS_MAX + 3;
    for (let i = 0; i < n; i++) t.store.hold("tickets", `T-${i}`);
    await t.flush();
    expect(t.calls.length).toBe(2);
    expect(t.calls.every((c) => (c.tickets ?? []).length <= PRE_REVIEW_STATUS_MAX)).toBe(true);
    expect(t.calls.flatMap((c) => c.tickets ?? []).length).toBe(n);
    expect(t.store.ticket(`T-${n - 1}`)).toBeDefined();
    off();
  });
});
