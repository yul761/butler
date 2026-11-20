import { describe, expect, it, vi } from "vitest";
import { PR_SLOW_MS } from "./pr-schedule";
import { REVIEW_AWAY_MS, REVIEW_CATCHUP_MS, ReviewRequestPoller, bindFocusCatchUp, reviewCatchUpDue, reviewPollDue, scopeReviews } from "./review-requests";

describe("review request schedule", () => {
  it("polls every PR_SLOW_MS, every 15 min when away", () => {
    expect(reviewPollDue(null, 0, false)).toBe(true);
    expect(reviewPollDue(0, PR_SLOW_MS - 1, false)).toBe(false);
    expect(reviewPollDue(0, PR_SLOW_MS, false)).toBe(true);
    expect(reviewPollDue(0, PR_SLOW_MS, true)).toBe(false);
    expect(reviewPollDue(0, REVIEW_AWAY_MS, true)).toBe(true);
  });
  it("catches up only after a minute", () => {
    expect(reviewCatchUpDue(null, 0)).toBe(true);
    expect(reviewCatchUpDue(0, REVIEW_CATCHUP_MS)).toBe(false);
    expect(reviewCatchUpDue(0, REVIEW_CATCHUP_MS + 1)).toBe(true);
  });
  it("scope registered keeps known slugs only", () => {
    const list = [{ slug: "a/b" }, { slug: "c/d" }];
    expect(scopeReviews(list, "all", new Set())).toEqual(list);
    expect(scopeReviews(list, "registered", new Set(["c/d"]))).toEqual([{ slug: "c/d" }]);
  });
});

describe("ReviewRequestPoller", () => {
  const make = (fetch: () => Promise<unknown>) => {
    let now = 1_000;
    let rows: unknown[] = [];
    const d = {
      fetch: vi.fn(fetch),
      repo: { replaceAll: vi.fn((list: { url: string; title: string; author: string }[], at: number) => void (rows = list.map((p) => ({ ...p, firstSeenAt: at, lastSeenAt: at })))), list: vi.fn(() => rows) },
      away: () => false, ghAvailable: () => true, changed: vi.fn(), now: () => now, log: vi.fn(),
    };
    return { d, poller: new ReviewRequestPoller(d as never), advance: (ms: number) => (now += ms) };
  };
  it("keeps the list when gh fails, and does not retry right away", async () => {
    const { d, poller, advance } = make(async () => null);
    await poller.tick();
    expect(d.repo.replaceAll).not.toHaveBeenCalled();
    advance(REVIEW_CATCHUP_MS - 1);
    poller.catchUp();
    await poller.tick();
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });
  it("replaces the list and reports a change", async () => {
    const pr = { url: "u", slug: "a/b", number: 1, title: "t", author: "amy" };
    const { d, poller, advance } = make(async () => [pr]);
    await poller.tick();
    expect(d.repo.replaceAll).toHaveBeenCalledWith([pr], 1_000);
    expect(d.changed).toHaveBeenCalledTimes(1);
    // 同样的结果再查一次：不算变化
    advance(PR_SLOW_MS);
    await poller.tick();
    expect(d.fetch).toHaveBeenCalledTimes(2);
    expect(d.changed).toHaveBeenCalledTimes(1);
  });
  it("catchUp runs a query after a minute; only one query runs at a time", async () => {
    let release: (v: unknown) => void = () => undefined;
    const { d, poller, advance } = make(() => new Promise((r) => (release = r)));
    const first = poller.tick();
    poller.catchUp();
    expect(d.fetch).toHaveBeenCalledTimes(1);
    release([]);
    await first;
    advance(REVIEW_CATCHUP_MS + 1);
    poller.catchUp();
    expect(d.fetch).toHaveBeenCalledTimes(2);
    release([]);
  });
  it("catchUp is skipped while you are away, and after stop", async () => {
    const { d, poller, advance } = make(async () => []);
    await poller.tick();
    advance(REVIEW_CATCHUP_MS + 1);
    d.away = () => true;
    poller.catchUp();
    expect(d.fetch).toHaveBeenCalledTimes(1);
    d.away = () => false;
    poller.stop();
    poller.catchUp();
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });
  it("a window coming to the front catches up; unbinding stops it", () => {
    const handlers = new Map<string, () => void>();
    const app = { on: vi.fn((e: string, f: () => void) => void handlers.set(e, f)), removeListener: vi.fn((e: string) => void handlers.delete(e)) };
    const poller = { catchUp: vi.fn() };
    const unbind = bindFocusCatchUp(app, poller);
    handlers.get("browser-window-focus")!();
    expect(poller.catchUp).toHaveBeenCalledTimes(1);
    unbind();
    expect(handlers.has("browser-window-focus")).toBe(false);
  });
  it("skips when gh is not available", async () => {
    const { d, poller } = make(async () => []);
    d.ghAvailable = () => false;
    await poller.tick();
    poller.catchUp();
    expect(d.fetch).not.toHaveBeenCalled();
  });
});
