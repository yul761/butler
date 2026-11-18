import { describe, expect, it, vi } from "vitest";
import { BackgroundRepo } from "../db/background-repo";
import type { Db } from "../db/database";
import { memDb } from "../test-utils";
import { readBgSettings } from "./bg-settings";
import { fakeIdleSignal } from "./idle";
import { BackgroundQueue, type BgHandler, type SessionAdmission } from "./queue";
import { BackgroundScheduler } from "./scheduler";

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(o: { db?: Db; settings?: Record<string, string>; idleSeconds?: number; hibernated?: Set<string>; admission?: SessionAdmission; cost?: Set<string> } = {}) {
  const db = o.db ?? memDb();
  const settings: Record<string, string> = { bgWindow: "idle", bgYield: "interrupt", ...o.settings };
  const idle = fakeIdleSignal({ idleSeconds: o.idleSeconds ?? 0 });
  const now = 1_000_000;
  const cost = o.cost ?? new Set<string>();
  const scheduler = new BackgroundScheduler({
    settings: () => readBgSettings({ get: (k) => settings[k] ?? "" }), setSetting: (k, v) => { settings[k] = v; },
    idle, quota: () => null, costBlocked: (k) => cost.has(k), now: () => now, setInterval: () => 1, clearInterval: () => undefined,
  });
  scheduler.start();
  const repo = new BackgroundRepo(db);
  const queue = new BackgroundQueue({
    repo, scheduler, now: () => now, isHibernated: (id) => o.hibernated?.has(id) ?? false,
    admission: () => o.admission ?? null, setTimer: () => 1, clearTimer: () => undefined,
  });
  return { db, repo, queue, scheduler, idle, settings, cost };
}

/** 分几步做的任务：每步存检查点，被叫停就停。 */
function stepper(steps: number, ran: number[], gate: { wait: Promise<void> | null } = { wait: null }): BgHandler {
  return async (ctx) => {
    let i = (ctx.checkpoint as { i?: number } | null)?.i ?? 0;
    while (i < steps) {
      if (gate.wait) await gate.wait;
      if (ctx.signal.aborted) return { defer: true };
      ran.push(i);
      i++;
      ctx.save({ i });
      await flush();
    }
    return { done: true };
  };
}

describe("background queue", () => {
  it("waits while the user is active and runs once idle", async () => {
    const t = setup({ idleSeconds: 0 });
    const ran: number[] = [];
    t.queue.register("backtest", stepper(2, ran));
    t.queue.start();
    const id = t.queue.enqueue("backtest", { pr: 1 });
    await flush();
    expect(ran).toEqual([]);
    expect(t.repo.get(id)?.state).toBe("queued");
    t.idle.set({ idleSeconds: 3600 });
    for (let i = 0; i < 5; i++) await flush();
    expect(ran).toEqual([0, 1]);
    expect(t.repo.get(id)?.state).toBe("done");
  });

  it("yields when the user comes back and continues from its checkpoint", async () => {
    const t = setup({ idleSeconds: 3600 });
    const ran: number[] = [];
    let release!: () => void;
    const gate: { wait: Promise<void> | null } = { wait: null };
    t.queue.register("backtest", stepper(4, ran, gate));
    t.queue.start();
    const id = t.queue.enqueue("backtest", {});
    await flush();
    await flush();
    expect(ran.length).toBeGreaterThan(0);
    gate.wait = new Promise((r) => { release = r; });
    t.idle.set({ idleSeconds: 0 });
    release();
    for (let i = 0; i < 5; i++) await flush();
    const done = ran.length;
    expect(done).toBeLessThan(4);
    expect(t.repo.get(id)).toMatchObject({ state: "queued", checkpoint: { i: done } });
    gate.wait = null;
    t.idle.set({ idleSeconds: 3600 });
    for (let i = 0; i < 10; i++) await flush();
    expect(ran).toEqual([0, 1, 2, 3]);
    expect(t.repo.get(id)?.state).toBe("done");
  });

  it("keeps progress across a restart", async () => {
    const db = memDb();
    const a = setup({ db, idleSeconds: 3600 });
    const ran: number[] = [];
    const gate: { wait: Promise<void> | null } = { wait: null };
    a.queue.register("backtest", stepper(3, ran, gate));
    a.queue.start();
    const id = a.queue.enqueue("backtest", {});
    await flush();
    gate.wait = new Promise(() => undefined); // 卡在第二步：模拟退出时还在跑
    await flush();
    expect(a.repo.get(id)?.state).toBe("running");
    const saved = a.repo.get(id)?.checkpoint;
    // 重开：新的队列在同一个库上
    const b = setup({ db, idleSeconds: 3600 });
    const ran2: number[] = [];
    b.queue.register("backtest", stepper(3, ran2));
    b.queue.start();
    for (let i = 0; i < 10; i++) await flush();
    expect(saved).toEqual({ i: ran.length });
    expect([...ran, ...ran2]).toEqual([0, 1, 2]);
    expect(b.repo.get(id)?.state).toBe("done");
  });

  it("does not wake hibernated sessions", async () => {
    const t = setup({ idleSeconds: 3600, hibernated: new Set(["s-1"]) });
    const seen: boolean[] = [];
    t.queue.register("pre_review", async (ctx) => {
      seen.push(ctx.sessionAwake("s-1"), ctx.sessionAwake("s-2"));
      return ctx.sessionAwake("s-1") ? { done: true } : { defer: true };
    });
    t.queue.start();
    const id = t.queue.enqueue("pre_review", {});
    await flush();
    await flush();
    expect(seen).toEqual([false, true]);
    expect(t.repo.get(id)?.state).toBe("queued");
    expect(t.repo.get(id)?.notBefore).toBeGreaterThan(1_000_000);
  });

  it("defers jobs of a cost-paused ticket and stops them when the breaker trips", async () => {
    const t = setup({ settings: { bgWindow: "anytime", bgYield: "finish" } });
    const ran: string[] = [];
    let block!: () => void;
    t.queue.register("pre_review", async (ctx) => {
      ran.push(ctx.ticketKey ?? "-");
      await new Promise<void>((r) => { block = r; ctx.signal.addEventListener("abort", () => r()); });
      return ctx.signal.aborted ? { defer: true } : { done: true };
    });
    t.queue.start();
    const a = t.queue.enqueue("pre_review", {}, { ticketKey: "T-1" });
    await flush();
    expect(ran).toEqual(["T-1"]);
    t.cost.add("T-1");
    t.scheduler.yieldTicket("T-1");
    await flush();
    await flush();
    expect(t.repo.get(a)?.state).toBe("queued");
    const b = t.queue.enqueue("pre_review", {}, { ticketKey: "T-2" });
    await flush();
    expect(ran).toEqual(["T-1", "T-2"]);
    block();
    await flush();
    await flush();
    expect(t.repo.get(b)?.state).toBe("done");
    expect(t.repo.get(a)?.state).toBe("queued");
  });

  describe("session admission (workstream W)", () => {
    /** 和 W 的 MemoryAdmission 同样的记账：放行一个记一个，release 只还自己的。 */
    function fakeAdmission(capacity: number) {
      let pending = 0;
      const admit = vi.fn(async () => {
        if (pending >= capacity) return { ok: false as const, reason: "memory" };
        pending++;
        let back = false;
        return { ok: true as const, release: () => { if (!back) { back = true; pending--; } } };
      });
      return { admission: { admit }, pending: () => pending, admit };
    }

    it("defers when admission refuses", async () => {
      const f = fakeAdmission(0);
      const t = setup({ idleSeconds: 3600, admission: f.admission });
      t.queue.register("intake", async (ctx) => {
        const a = await ctx.admitSession("intake T-1");
        if (!a.ok) return { defer: true, reason: a.reason };
        a.opened();
        return { done: true };
      });
      t.queue.start();
      const id = t.queue.enqueue("intake", {});
      await flush();
      await flush();
      expect(f.admit).toHaveBeenCalledWith("intake T-1");
      expect(t.repo.get(id)).toMatchObject({ state: "queued", error: "memory" });
    });

    it("counts a session it just opened against the next admit, and gives the slot back when opening fails", async () => {
      const f = fakeAdmission(1);
      const t = setup({ idleSeconds: 3600, admission: f.admission });
      const outcomes: string[] = [];
      t.queue.register("intake", async (ctx) => {
        const a = await ctx.admitSession(`intake ${String((ctx.payload as { n: number }).n)}`);
        if (!a.ok) {
          outcomes.push("refused");
          return { defer: true, reason: a.reason };
        }
        if ((ctx.payload as { fail?: boolean }).fail) throw new Error("could not open the terminal");
        a.opened();
        outcomes.push("opened");
        return { done: true };
      });
      t.queue.start();
      t.queue.enqueue("intake", { n: 1 });
      await flush();
      await flush();
      expect(outcomes).toEqual(["opened"]);
      expect(f.pending()).toBe(1);
      // 第二个：刚开的那个还算着，不放行
      t.queue.enqueue("intake", { n: 2 });
      await flush();
      await flush();
      expect(outcomes).toEqual(["opened", "refused"]);
      // 失败的那条路径一定还回去
      const g = fakeAdmission(1);
      const u = setup({ idleSeconds: 3600, admission: g.admission });
      u.queue.register("intake", async (ctx) => {
        const a = await ctx.admitSession("intake x");
        if (!a.ok) return { defer: true };
        throw new Error("could not open the terminal");
      });
      u.queue.start();
      const id = u.queue.enqueue("intake", {});
      await flush();
      await flush();
      expect(g.pending()).toBe(0);
      expect(u.repo.get(id)).toMatchObject({ state: "failed", error: "could not open the terminal" });
    });

    it("lets everything through before W is wired", async () => {
      const t = setup({ idleSeconds: 3600 });
      t.queue.register("intake", async (ctx) => {
        const a = await ctx.admitSession("intake");
        return a.ok ? { done: true } : { failed: "refused" };
      });
      t.queue.start();
      const id = t.queue.enqueue("intake", {});
      await flush();
      await flush();
      expect(t.repo.get(id)?.state).toBe("done");
    });
  });

  it("take finds a runnable job behind any number of blocked ones, asking once per ticket", () => {
    const repo = new BackgroundRepo(memDb());
    for (let i = 0; i < 250; i++) repo.enqueue({ kind: "backtest", ticketKey: "T-PAUSED", now: 1 });
    const ok = repo.enqueue({ kind: "backtest", ticketKey: "T-OK", now: 1 });
    const allow = vi.fn((k: string) => k !== "T-PAUSED");
    expect(repo.take("backtest", 2, allow)?.id).toBe(ok);
    expect(allow).toHaveBeenCalledTimes(2);
    expect(repo.take("backtest", 2, allow)).toBeNull();
  });

  it("prunes finished jobs older than the cutoff and leaves queued ones", () => {
    const repo = new BackgroundRepo(memDb());
    const old = repo.enqueue({ kind: "backtest", now: 1 });
    const fresh = repo.enqueue({ kind: "backtest", now: 1 });
    const queued = repo.enqueue({ kind: "backtest", now: 1 });
    repo.finish(old, "done", 10);
    repo.finish(fresh, "failed", 100);
    expect(repo.pruneFinished(50)).toBe(1);
    expect(repo.get(old)).toBeNull();
    expect(repo.get(fresh)?.state).toBe("failed");
    expect(repo.get(queued)?.state).toBe("queued");
  });

  it("dedupes queued jobs and lets them be cancelled", () => {
    const t = setup();
    const a = t.queue.enqueue("backtest", {}, { dedupeKey: "pr-1" });
    const b = t.queue.enqueue("backtest", {}, { dedupeKey: "pr-1" });
    expect(b).toBe(a);
    expect(t.queue.cancel(a)).toBe(true);
    expect(t.repo.get(a)?.state).toBe("cancelled");
    expect(t.queue.enqueue("backtest", {}, { dedupeKey: "pr-1" })).not.toBe(a);
  });
});
