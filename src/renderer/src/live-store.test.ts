import { describe, expect, it } from "vitest";
import type { FeatureView, NowView, TicketView } from "../../shared/types";
import { createLiveStore, selectAllTickets, selectLiveTickets, selectNameCtx, type LiveApi } from "./live-store";
import { LIVE_SCOPES } from "./state-bus";

const ticket = (key: string, o: Partial<TicketView> = {}): TicketView =>
  ({ key, title: `${key} title`, featureId: null, sessions: [], hiddenSessions: [], waiting: false, ...o }) as unknown as TicketView;
const feature = (id: number, o: Partial<FeatureView> = {}): FeatureView =>
  ({ id, name: `F${id}`, tickets: [ticket(`T-${id}`, { featureId: id })], sessions: [], hiddenSessions: [], waiting: false, activity: {}, ...o }) as unknown as FeatureView;
const now = (running: number): NowView => ({ notices: [], features: [], shipherd: null, running, memory: [], merges: [] }) as unknown as NowView;

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

function fakeApi() {
  const data = { tickets: [ticket("S-1")], features: [feature(1), feature(2)], now: now(0), unclaimed: 0 };
  let listener: ((s: never) => void) | null = null;
  let scopes: readonly string[] | undefined;
  const api: LiveApi = {
    listTickets: async () => structuredClone(data.tickets),
    listFeatures: async () => structuredClone(data.features),
    unclaimed: async () => Array.from({ length: data.unclaimed }, () => ({}) as never),
    nowView: async () => structuredClone(data.now),
    onStateChanged: (cb, s) => {
      listener = cb as never;
      scopes = s;
      return () => void (listener = null);
    },
  };
  return { api, data, fire: () => listener?.([] as never), scopes: () => scopes, listening: () => listener !== null };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("live store (BTL-277)", () => {
  it("loads the lists and nowView, and tells subscribers only when something changed", async () => {
    const f = fakeApi();
    const store = createLiveStore(f.api, { onError: (e) => { throw e; } });
    let calls = 0;
    store.subscribe(() => calls++);
    expect(await store.refresh()).toBe(true);
    await tick();
    const s = store.getState();
    expect(s.features.map((x) => x.id)).toEqual([1, 2]);
    expect(s.nowView?.running).toBe(0);
    expect(calls).toBeGreaterThan(0);
    calls = 0;
    await store.refresh();
    await tick();
    // 内容没变：同一个 state，不通知。
    expect(store.getState()).toBe(s);
    expect(calls).toBe(0);
  });

  it("keeps the untouched features and the name context when one session's activity changes", async () => {
    const f = fakeApi();
    const store = createLiveStore(f.api, { onError: (e) => { throw e; } });
    await store.refresh();
    const before = store.getState();
    const ctx = selectNameCtx(before);
    const live = selectLiveTickets(before);
    f.data.features[1] = feature(2, { activity: { "T-2": { state: "working" } as never } });
    await store.refresh();
    const after = store.getState();
    expect(after.features).not.toBe(before.features);
    expect(after.features[0]).toBe(before.features[0]);
    expect(after.features[1]).not.toBe(before.features[1]);
    expect(after.tickets).toBe(before.tickets);
    expect(selectNameCtx(after)).toBe(ctx);
    expect(selectLiveTickets(after)).toBe(live);
    expect(selectAllTickets(after)).toBe(selectAllTickets(after));
    // 改了名字：ctx 换新的。
    f.data.features[0] = feature(1, { name: "renamed" });
    await store.refresh();
    expect(selectNameCtx(store.getState())).not.toBe(ctx);
    expect(selectNameCtx(store.getState()).features.get(1)).toBe("renamed");
  });

  it("lets only the latest refresh write, for the lists and for nowView", async () => {
    const f = fakeApi();
    const slow = deferred<FeatureView[]>();
    const slowNow = deferred<NowView>();
    let first = true;
    const api: LiveApi = {
      ...f.api,
      listFeatures: () => (first ? slow.promise : f.api.listFeatures()),
      nowView: () => (first ? ((first = false), slowNow.promise) : f.api.nowView()),
    };
    const store = createLiveStore(api, { onError: (e) => { throw e; } });
    const a = store.refresh();
    f.data.now = now(5);
    await store.refresh();
    await tick();
    slow.resolve([feature(9)]);
    slowNow.resolve(now(99));
    expect(await a).toBe(true);
    await tick();
    expect(store.getState().features.map((x) => x.id)).toEqual([1, 2]);
    expect(store.getState().nowView?.running).toBe(5);
  });

  it("reports a failed list and returns false; a failed nowView is reported on its own and the lists still load", async () => {
    const f = fakeApi();
    const errors: unknown[] = [];
    const store = createLiveStore({ ...f.api, nowView: () => Promise.reject(new Error("now")) }, { onError: (e) => errors.push(e) });
    expect(await store.refresh()).toBe(true);
    await tick();
    expect(store.getState().features).toHaveLength(2);
    expect(errors.map((e) => (e as Error).message)).toEqual(["now"]);
    const broken = createLiveStore({ ...f.api, listTickets: () => Promise.reject(new Error("list")) }, { onError: (e) => errors.push(e) });
    expect(await broken.refresh()).toBe(false);
    expect(errors.map((e) => (e as Error).message)).toContain("list");
  });

  it("counts the unclaimed sessions with unclaimedCount when the api has it, without fetching the list (BTL-275)", async () => {
    const f = fakeApi();
    f.data.unclaimed = 3;
    const old = createLiveStore(f.api, { onError: (e) => { throw e; } });
    await old.refresh();
    expect(old.getState().unclaimedCount).toBe(3);
    let listed = 0;
    const counted = createLiveStore({ ...f.api, unclaimed: () => (listed++, f.api.unclaimed()), unclaimedCount: async () => 7 }, { onError: (e) => { throw e; } });
    await counted.refresh();
    expect(counted.getState().unclaimedCount).toBe(7);
    expect(listed).toBe(0);
  });

  it("listens to the live scopes and folds a burst of changes into one refresh", async () => {
    const f = fakeApi();
    let fetches = 0;
    const timers: (() => void)[] = [];
    const store = createLiveStore({ ...f.api, listTickets: () => (fetches++, f.api.listTickets()) }, {
      onError: (e) => { throw e; },
      setTimeout: (fn) => timers.push(fn),
      clearTimeout: () => void timers.pop(),
    });
    const stop = store.start();
    expect(f.scopes()).toEqual(LIVE_SCOPES);
    await tick();
    expect(fetches).toBe(1);
    f.fire();
    f.fire();
    f.fire();
    expect(timers).toHaveLength(1);
    timers.shift()!();
    await tick();
    expect(fetches).toBe(2);
    stop();
    expect(f.listening()).toBe(false);
  });
});
