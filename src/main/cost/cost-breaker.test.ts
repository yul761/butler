import { describe, expect, it, vi } from "vitest";
import type { Db } from "../db/database";
import { CostRepo } from "../db/cost-repo";
import { UsageRepo } from "../db/usage-repo";
import { memDb } from "../test-utils";
import { COST_STOP_AFTER_MS, CostBreaker, type CostSessionInfo } from "./cost-breaker";
import { CostPolicyService } from "./cost-policy";

const T0 = 1_000_000;

function setup(o: { db?: Db; caps?: Record<string, unknown>; models?: Record<string, string | null> } = {}) {
  const db = o.db ?? memDb();
  const usage = new UsageRepo(db);
  const repo = new CostRepo(db);
  const policy = new CostPolicyService({ db, productsOf: () => [], productName: () => null, now: () => T0 });
  if (o.caps) policy.setLayer({ kind: "global" }, o.caps);
  let now = T0;
  let n = 0;
  const sessions = new Map<string, CostSessionInfo>();
  const busy = new Set<string>();
  const typed = new Map<string, number>();
  const next: Record<string, string | null> = o.models ?? { opus: "sonnet", sonnet: "haiku", haiku: null };
  const calls: string[] = [];
  const nudgeOk = { value: true };
  const scheduler = { yieldTicket: vi.fn(), changed: vi.fn() };
  const judge = vi.fn();
  const addSession = (root: string, over: Partial<CostSessionInfo> = {}) =>
    sessions.set(root, { rootId: root, headId: root, ticketKey: "T-1", title: `session ${root}`, chainIds: [root], repos: [], model: "opus", open: true, ...over });
  const b = new CostBreaker({
    repo, policy, usage, registry: () => [], warnPercent: () => 70,
    rootOf: (id) => [...sessions.values()].find((s) => s.chainIds.includes(id))?.rootId ?? null,
    session: (root) => sessions.get(root) ?? null,
    ticket: (key) => {
      const ss = [...sessions.values()].filter((s) => s.ticketKey === key);
      return { key, title: key, repos: [], sessionIds: ss.flatMap((s) => s.chainIds), openRoots: ss.filter((s) => s.open).map((s) => s.rootId) };
    },
    active: () => ({ sessions: [...sessions.values()].filter((s) => s.open).map((s) => s.rootId), tickets: [...new Set([...sessions.values()].map((s) => s.ticketKey!).filter(Boolean))] }),
    nextModel: (m) => (m ? (next[m] ?? null) : null),
    switchModel: async (head, model) => {
      calls.push(`switch ${head} ${model}`);
      const s = [...sessions.values()].find((x) => x.headId === head)!;
      s.model = model;
      return { ok: true, model };
    },
    busy: (h) => busy.has(h),
    interrupt: (h) => void calls.push(`esc ${h}`),
    kill: (h) => {
      calls.push(`kill ${h}`);
      const s = [...sessions.values()].find((x) => x.headId === h);
      if (s) s.open = false;
    },
    lastUserInputAt: (h) => typed.get(h) ?? 0,
    nudge: async (h, text) => {
      if (!nudgeOk.value) return false;
      calls.push(`nudge ${h}: ${text}`);
      return true;
    },
    scheduler,
    texts: () => ({ continueAfterDowngrade: (m) => `continue on ${m}`, continueAfterRaise: (c) => `continue, cap ${c}` }),
    now: () => now,
  });
  /** 给 session / ticket 记一笔花费（美元）。 */
  const spend = (usd: number, o2: { session?: string; ticket?: string } = { session: "s1" }) =>
    usage.record([{
      messageId: `m${++n}`, sessionId: o2.session ?? null, agentId: null, source: o2.ticket ? "headless" : "session", job: null, at: now, model: "opus",
      input: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 100, context: 0, costUsd: usd, ticketKey: o2.ticket ?? null,
    }]);
  return {
    b, db, repo, policy, sessions, addSession, busy, typed, calls, nudgeOk, scheduler, judge, spend,
    advance: (ms: number) => void (now += ms), now: () => now,
    events: () => repo.events().map((e) => e.kind).reverse(),
  };
}

describe("cost breaker: a session over its cap (acceptance)", () => {
  it("warns, downgrades first, pauses when still over, and one-click continue raises the cap", async () => {
    const t = setup({ caps: { sessionCap: 10 } });
    t.addSession("s1");
    t.spend(7.5);
    await t.b.check();
    expect(t.b.views()).toEqual([expect.objectContaining({ subjectKind: "session", subjectId: "s1", state: "warned", spent: 7.5, cap: 10, unit: "usd" })]);

    t.spend(2.5);
    await t.b.check();
    expect(t.calls).toEqual(["switch s1 sonnet", "nudge s1: continue on sonnet"]);
    expect(t.b.views()[0]).toMatchObject({ state: "downgraded", fromModel: "opus", toModel: "sonnet" });

    // 宽限 20%：12 以下还跑
    t.spend(1.5);
    await t.b.check();
    expect(t.b.views()[0]?.state).toBe("downgraded");

    t.busy.add("s1");
    t.spend(1);
    await t.b.check();
    expect(t.b.views()[0]).toMatchObject({ state: "paused", spent: 12.5, pauseScope: "session" });
    expect(t.calls.at(-1)).toBe("esc s1");
    expect(t.b.sessionPaused("s1")).toBe(true);

    const r = await t.b.resume("session", "s1");
    // max(10, 12.5) + 10 × 50%
    expect(r).toEqual({ ok: true, cap: 17.5 });
    expect(t.b.sessionPaused("s1")).toBe(false);
    expect(t.calls.at(-1)).toBe("nudge s1: continue, cap $17.50");
    expect(t.events()).toEqual(["warn", "downgrade", "pause", "raise", "resume"]);
    // 降过的档不升回
    expect(t.sessions.get("s1")?.model).toBe("sonnet");
    // 12.5 / 17.5 过了 70% 的提醒线
    await t.b.check();
    expect(t.b.views()).toEqual([expect.objectContaining({ state: "warned", cap: 17.5 })]);
  });

  it("keeps the downgrade nudge until the session can take it", async () => {
    const t = setup({ caps: { sessionCap: 1 } });
    t.addSession("s1");
    t.nudgeOk.value = false;
    t.spend(1);
    await t.b.check();
    expect(t.calls).toEqual(["switch s1 sonnet"]);
    t.nudgeOk.value = true;
    await t.b.sessionStopped("s1");
    expect(t.calls).toEqual(["switch s1 sonnet", "nudge s1: continue on sonnet"]);
  });

  it("pauses straight away with the pause action, or when there is no lower model", async () => {
    const a = setup({ caps: { sessionCap: 1, action: "pause" } });
    a.addSession("s1");
    a.spend(1);
    await a.b.check();
    expect(a.calls).toEqual([]);
    expect(a.b.views()[0]?.state).toBe("paused");

    const b = setup({ caps: { sessionCap: 1 } });
    b.addSession("s1", { model: "haiku" });
    b.spend(1);
    await b.b.check();
    expect(b.b.views()[0]?.state).toBe("paused");
  });

  it("does nothing at all when no cap is set, like 2.1.0", async () => {
    const t = setup();
    t.addSession("s1");
    t.spend(1000);
    await t.b.check();
    expect(t.b.views()).toEqual([]);
    expect(t.repo.all()).toEqual([]);
    expect(t.b.gate({ task: "handoff", ticketKey: "T-1" })).toBe("ok");
  });
});

describe("cost breaker: ticket caps and background work", () => {
  it("counts the ticket's sessions and its headless calls, downgrades background calls, then pauses them", async () => {
    const t = setup({ caps: { ticketCap: 10, pauseScope: "background" } });
    t.addSession("s1");
    t.addSession("s2");
    t.spend(4, { session: "s1" });
    t.spend(3, { session: "s2" });
    t.spend(3, { ticket: "T-1" });
    t.spend(50, { ticket: "T-9" });
    await t.b.check();
    expect(t.b.gate({ task: "handoff", ticketKey: "T-1" })).toBe("downgrade");
    expect(t.calls).toEqual([]); // 只停后台：交互 session 不动
    t.spend(2.5, { ticket: "T-1" });
    await t.b.check();
    expect(t.b.gate({ task: "handoff", ticketKey: "T-1" })).toBe("pause");
    expect(t.b.allowBackground("T-1")).toBe(false);
    expect(t.b.allowBackground("T-9")).toBe(true);
    expect(t.scheduler.yieldTicket).toHaveBeenCalledWith("T-1");
    expect(t.b.sessionPaused("s1")).toBe(false);
    // 卡住判断不受熔断影响
    expect(t.b.gate({ task: "stuck_judge", ticketKey: "T-1" })).toBe("ok");
    expect(t.b.views()).toEqual([expect.objectContaining({ subjectKind: "ticket", subjectId: "T-1", state: "paused", pauseScope: "background" })]);
    await t.b.resume("ticket", "T-1");
    expect(t.b.gate({ task: "handoff", ticketKey: "T-1" })).toBe("ok");
    expect(t.scheduler.changed).toHaveBeenCalled();
  });

  it("a session cap with background-only scope stops the ticket's background calls and leaves the session alone", async () => {
    const t = setup({ caps: { sessionCap: 5, pauseScope: "background", action: "pause" } });
    t.addSession("s1");
    t.busy.add("s1");
    t.spend(5);
    await t.b.check();
    expect(t.b.sessionPaused("s1")).toBe(false);
    expect(t.calls).toEqual([]);
    expect(t.b.gate({ task: "handoff_refresh", ticketKey: "T-1" })).toBe("pause");
    expect(t.scheduler.yieldTicket).toHaveBeenCalledWith("T-1");
  });

  it("a ticket cap with session scope pauses every open session of the ticket", async () => {
    const t = setup({ caps: { ticketCap: 4, action: "pause" } });
    t.addSession("s1");
    t.addSession("s2");
    t.busy.add("s2");
    t.spend(2, { session: "s1" });
    t.spend(2, { session: "s2" });
    await t.b.check();
    expect(t.b.sessionPaused("s1")).toBe(true);
    expect(t.b.sessionPaused("s2")).toBe(true);
    expect(t.calls).toEqual(["esc s2"]);
    expect(t.b.gate({ task: "handoff", ticketKey: "T-1" })).toBe("pause");
  });
});

describe("cost breaker: after the pause", () => {
  it("stops the terminal when spending goes on and nobody typed, once", async () => {
    const t = setup({ caps: { sessionCap: 1, action: "pause" } });
    t.addSession("s1");
    t.spend(1);
    await t.b.check();
    t.advance(COST_STOP_AFTER_MS - 1);
    t.spend(0.5);
    await t.b.check();
    expect(t.calls).toEqual([]);
    t.advance(1);
    await t.b.check();
    expect(t.calls).toEqual(["kill s1"]);
    expect(t.b.views()[0]).toMatchObject({ state: "paused", stoppedAt: t.now() });
    // 用户自己重开：不再结束
    t.sessions.get("s1")!.open = true;
    t.advance(COST_STOP_AFTER_MS);
    t.spend(1);
    await t.b.check();
    expect(t.calls).toEqual(["kill s1"]);
  });

  it("does not stop a terminal that is quiet after the pause", async () => {
    const t = setup({ caps: { sessionCap: 1, action: "pause" } });
    t.addSession("s1");
    t.spend(1);
    await t.b.check();
    t.advance(COST_STOP_AFTER_MS * 2);
    await t.b.check();
    expect(t.calls).toEqual([]);
  });

  it("treats typing in the paused terminal as the user taking over", async () => {
    const t = setup({ caps: { sessionCap: 1, action: "pause" } });
    t.addSession("s1");
    t.spend(1);
    await t.b.check();
    t.advance(1000);
    t.typed.set("s1", t.now());
    t.spend(3);
    await t.b.check();
    t.advance(COST_STOP_AFTER_MS);
    t.spend(3);
    await t.b.check();
    expect(t.calls).toEqual([]);
    expect(t.b.views()[0]).toMatchObject({ state: "paused", takenOver: true });
    expect(t.events()).toEqual(["pause", "takeover"]);
  });

  it("keeps the pause across a restart", async () => {
    const db = memDb();
    const a = setup({ db, caps: { sessionCap: 1, action: "pause" } });
    a.addSession("s1");
    a.spend(1);
    await a.b.check();
    const b = setup({ db });
    b.addSession("s1");
    expect(b.b.sessionPaused("s1")).toBe(true);
    expect(b.b.views()[0]).toMatchObject({ state: "paused", spent: 1 });
  });

  it("lifts the pause when the cap is raised or removed in settings", async () => {
    const t = setup({ caps: { sessionCap: 1, action: "pause" } });
    t.addSession("s1");
    t.spend(1);
    await t.b.check();
    t.policy.setLayer({ kind: "global" }, { sessionCap: 100, action: "pause" });
    await t.b.check();
    expect(t.b.sessionPaused("s1")).toBe(false);
    expect(t.calls).toEqual(["nudge s1: continue, cap $100.00"]);
    t.policy.setLayer({ kind: "global" }, { sessionCap: 1, action: "pause" });
    await t.b.check();
    expect(t.b.sessionPaused("s1")).toBe(true);
    t.policy.setLayer({ kind: "global" }, {});
    await t.b.check();
    expect(t.b.sessionPaused("s1")).toBe(false);
    expect(t.repo.all()).toEqual([]);
  });
});

describe("cost breaker: a dead loop burning tokens", () => {
  it("brings it to a stop by money alone, without the stuck judge", async () => {
    const t = setup({ caps: { sessionCap: 5 } });
    t.addSession("s1");
    t.busy.add("s1");
    // 每 30 秒烧 $1，从不停下来、从不等输入（卡住判断看不出来：它一直有输出）
    let ticks = 0;
    while (t.sessions.get("s1")!.open && ticks < 40) {
      t.spend(1);
      t.advance(30_000);
      await t.b.check();
      ticks++;
    }
    expect(t.calls.filter((c) => !c.startsWith("nudge"))).toEqual(["switch s1 sonnet", "esc s1", "kill s1"]);
    expect(t.events()).toEqual(["warn", "downgrade", "pause", "stop"]);
    // 5 到上限，6 过宽限暂停，再 3 个 tick（90 秒）结束
    expect(ticks).toBe(9);
    expect(t.judge).not.toHaveBeenCalled();
  });
});
