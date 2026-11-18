import { describe, expect, it, vi } from "vitest";
import type { SpendLevel } from "../../shared/model-routing";
import { readBgSettings } from "./bg-settings";
import { fakeIdleSignal } from "./idle";
import { BackgroundScheduler, type BgQuota } from "./scheduler";

const at = (h: number, m = 0) => new Date(2026, 10, 18, h, m).getTime();

function setup(o: { settings?: Record<string, string>; idleSeconds?: number; locked?: boolean; now?: number; level?: SpendLevel; maxRatio?: number | null; cost?: Set<string> } = {}) {
  const settings: Record<string, string> = { ...o.settings };
  const idle = fakeIdleSignal({ idleSeconds: o.idleSeconds ?? 0, locked: o.locked ?? false });
  let now = o.now ?? at(12);
  let level: SpendLevel = o.level ?? "ok";
  let maxRatio: number | null = o.maxRatio === undefined ? null : o.maxRatio;
  const cost = o.cost ?? new Set<string>();
  const quota: BgQuota = { level: () => level, maxRatio: () => maxRatio, until: () => at(23, 59) };
  const events: string[] = [];
  const s = new BackgroundScheduler({
    settings: () => readBgSettings({ get: (k) => settings[k] ?? "" }),
    setSetting: (k, v) => { settings[k] = v; },
    idle, quota: () => quota, costBlocked: (key) => cost.has(key), now: () => now,
    onEvent: (kind, refs) => events.push(`${kind}:${refs.kind}`), log: () => undefined,
    setInterval: () => 1, clearInterval: () => undefined,
  });
  s.start();
  return {
    s, idle, settings, events, cost,
    setNow: (t: number) => { now = t; },
    setLevel: (l: SpendLevel) => { level = l; },
    setRatio: (r: number | null) => { maxRatio = r; },
  };
}

describe("background scheduler gate", () => {
  it("lets everything run by default, like 2.1.0", () => {
    const { s } = setup();
    expect(s.gate("lesson_backfill")).toEqual({ run: true });
    expect(s.gate("lesson_analyze")).toEqual({ run: true });
  });

  it("only-when-idle waits while the user is active and runs when idle or locked", () => {
    const t = setup({ settings: { bgWindow: "idle", bgIdleMinutes: "10" }, idleSeconds: 30 });
    expect(t.s.gate("lesson_backfill")).toEqual({ run: false, reason: "user_active", until: null });
    t.idle.set({ idleSeconds: 600 });
    expect(t.s.gate("lesson_backfill")).toEqual({ run: true });
    t.idle.set({ idleSeconds: 0, locked: true });
    expect(t.s.gate("lesson_backfill")).toEqual({ run: true });
  });

  it("these-hours runs inside the hours and says when the next window starts", () => {
    const t = setup({ settings: { bgWindow: "hours", bgHours: "22:00-07:00" }, now: at(12) });
    expect(t.s.gate("backtest")).toEqual({ run: false, reason: "outside_hours", until: at(22) });
    t.setNow(at(23));
    expect(t.s.gate("backtest")).toEqual({ run: true });
  });

  it("idle-or-hours runs on either", () => {
    const t = setup({ settings: { bgWindow: "idle_or_hours", bgHours: "22:00-07:00" }, now: at(12), idleSeconds: 0 });
    expect(t.s.gate("backtest").run).toBe(false);
    t.idle.set({ idleSeconds: 3600 });
    expect(t.s.gate("backtest").run).toBe(true);
    t.idle.set({ idleSeconds: 0 });
    t.setNow(at(2));
    expect(t.s.gate("backtest").run).toBe(true);
  });

  it("does not hold high-priority or not-idle-eligible kinds to the window", () => {
    const t = setup({ settings: { bgWindow: "idle" }, idleSeconds: 0 });
    expect(t.s.gate("intake")).toEqual({ run: true });
    t.settings.bgKinds = JSON.stringify({ backtest: { priority: "high" } });
    expect(t.s.gate("backtest")).toEqual({ run: true });
  });

  it("uses a per-kind window over the global one", () => {
    const t = setup({ settings: { bgWindow: "anytime", bgKinds: JSON.stringify({ lesson_backfill: { window: "idle" } }) }, idleSeconds: 0 });
    expect(t.s.gate("lesson_backfill").run).toBe(false);
    expect(t.s.gate("lesson_analyze").run).toBe(true);
  });

  it("pause-first: soft stops low priority, hard stops normal too, high keeps running", () => {
    const t = setup({ level: "soft" });
    expect(t.s.gate("lesson_backfill")).toEqual({ run: false, reason: "quota", until: at(23, 59) });
    expect(t.s.gate("lesson_analyze")).toEqual({ run: true });
    t.setLevel("hard");
    expect(t.s.gate("lesson_analyze").run).toBe(false);
    expect(t.s.gate("intake")).toEqual({ run: true });
  });

  it("downgrade-first: soft stops nothing, hard stops only low priority", () => {
    const t = setup({ settings: { bgQuotaOrder: "downgrade_first" }, level: "soft" });
    expect(t.s.gate("lesson_backfill").run).toBe(true);
    t.setLevel("hard");
    expect(t.s.gate("lesson_backfill").run).toBe(false);
    expect(t.s.gate("lesson_analyze").run).toBe(true);
  });

  it("plentiful quota lifts the window but not the quota or cost checks", () => {
    const t = setup({ settings: { bgWindow: "idle", bgPlentifulPercent: "30" }, idleSeconds: 0, maxRatio: 0.1 });
    expect(t.s.gate("lesson_backfill").run).toBe(true);
    t.setRatio(0.5);
    expect(t.s.gate("lesson_backfill").run).toBe(false);
    t.setRatio(null);
    expect(t.s.gate("lesson_backfill").run).toBe(false);
  });

  it("manual pause and cost pause come first", () => {
    const t = setup({ cost: new Set(["T-1"]) });
    expect(t.s.gate("pre_review", { ticketKey: "T-1" })).toEqual({ run: false, reason: "cost", until: null });
    expect(t.s.gate("pre_review", { ticketKey: "T-2" })).toEqual({ run: true });
    t.s.setKindPaused("pre_review", true);
    expect(t.s.gate("pre_review", { ticketKey: "T-2" })).toEqual({ run: false, reason: "manual", until: null });
    expect(JSON.parse(t.settings.bgKinds)).toEqual({ pre_review: { paused: true } });
    t.s.setKindPaused("pre_review", false);
    expect(t.settings.bgKinds).toBe("");
  });
});

describe("background scheduler changes", () => {
  it("tells subscribers when a gate flips, and asks interruptible kinds to yield only in interrupt mode", () => {
    const t = setup({ settings: { bgWindow: "idle" }, idleSeconds: 3600 });
    const changed = vi.fn();
    const yielded = vi.fn();
    t.s.subscribe(changed);
    t.s.onYield(yielded);
    t.s.tick();
    expect(changed).not.toHaveBeenCalled();
    t.idle.set({ idleSeconds: 0 });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(yielded).not.toHaveBeenCalled();
    t.settings.bgYield = "interrupt";
    t.idle.set({ idleSeconds: 3600 });
    t.idle.set({ idleSeconds: 0 });
    expect(yielded).toHaveBeenCalledWith({ kinds: expect.arrayContaining(["lesson_analyze", "lesson_backfill", "backtest"]) });
    expect(yielded.mock.calls[0][0].kinds).not.toContain("intake");
    expect(t.events).toContain("yield:lesson_backfill");
    expect(t.events).toContain("resume:lesson_backfill");
  });

  it("notices hours passing on the poll tick", () => {
    const t = setup({ settings: { bgWindow: "hours", bgHours: "22:00-07:00" }, now: at(21, 59) });
    const changed = vi.fn();
    t.s.subscribe(changed);
    t.s.tick();
    expect(changed).not.toHaveBeenCalled();
    t.setNow(at(22));
    t.s.tick();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("asks a ticket's tasks to yield when its background is cost-paused", () => {
    const t = setup();
    const yielded = vi.fn();
    t.s.onYield(yielded);
    t.s.yieldTicket("T-9");
    expect(yielded).toHaveBeenCalledWith({ ticketKey: "T-9" });
  });

  it("reports counts from registered sources in the status view", () => {
    const t = setup({ settings: { bgWindow: "idle" } });
    t.s.registerSource(() => ({ lesson_backfill: { queued: 3, running: 1 } }));
    const v = t.s.status();
    const row = v.kinds.find((k) => k.kind === "lesson_backfill")!;
    expect(row).toMatchObject({ queued: 3, running: 1, window: "idle", priority: "low", gate: { run: false, reason: "user_active" } });
    expect(v.idle).toEqual({ idle: false, idleSeconds: 0, locked: false });
  });
});
