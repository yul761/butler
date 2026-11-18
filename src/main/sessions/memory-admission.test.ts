import { describe, expect, it, vi } from "vitest";
import type { MemoryReading } from "./available-memory";
import { MemoryAdmission, PENDING_MS, type AdmissionDeps, type AdmissionSettings } from "./memory-admission";

const MB = 1024;

function setup(o: { availableMb?: number; pressure?: MemoryReading["pressure"]; settings?: Partial<AdmissionSettings>; measured?: number[]; running?: number; readFails?: boolean } = {}) {
  let now = 1_000_000;
  let available = o.availableMb ?? 10_000;
  let running = o.running ?? 0;
  const d = {
    read: vi.fn(async (): Promise<MemoryReading> => {
      if (o.readFails) throw new Error("vm_stat hung");
      return { totalKb: 48 * 1024 * MB, availableKb: available * MB, source: "vm_stat", pressure: o.pressure ?? "normal" };
    }),
    settings: () => ({ reserveMb: 2048, sessionMb: 1024, maxRunning: 0, ...o.settings }),
    measuredSessionsKb: o.measured ? () => o.measured! : undefined,
    running: () => running,
    now: () => now,
    log: vi.fn<(msg: string, err?: unknown) => void>(),
  } satisfies AdmissionDeps;
  return {
    d, a: new MemoryAdmission(d),
    tick: (ms: number) => (now += ms),
    setAvailable: (v: number) => (available = v),
    setRunning: (n: number) => (running = n),
  };
}

describe("MemoryAdmission", () => {
  it("admits while available − estimate stays above the reserve, and says how many more fit", async () => {
    const s = setup({ availableMb: 6000 });
    // (6000 − 2048) / 1024 = 3.86 → 3 个
    expect((await s.a.capacity()).canStart).toBe(3);
    const r = await s.a.admit("T-1");
    expect(r).toMatchObject({ ok: true, capacity: { canStart: 2, pending: 1, availableMb: 6000 - 1024, estimate: "setting" } });
  });

  it("refuses when memory would drop below the reserve, with the numbers for the message", async () => {
    const s = setup({ availableMb: 3000 });
    const r = await s.a.admit("T-1");
    expect(r).toEqual({ ok: false, reason: "memory", capacity: expect.objectContaining({ availableMb: 3000, sessionMb: 1024, reserveMb: 2048, canStart: 0 }) });
    expect(s.d.log).toHaveBeenCalledWith(expect.stringMatching(/T-1 refused \(memory\)/));
  });

  it("counts sessions it just admitted until they have had time to grow (a burst of start_session)", async () => {
    const s = setup({ availableMb: 5000 });
    expect((await s.a.admit("a")).ok).toBe(true);
    expect((await s.a.admit("b")).ok).toBe(true);
    // 读数还是 5000（新 session 还没长起来），但已经扣了两个：5000 − 2048 = 2952 < 2048 + 1024
    expect(await s.a.admit("c")).toMatchObject({ ok: false, reason: "memory", capacity: { pending: 2, availableMb: 5000 - 2048 } });
    s.tick(PENDING_MS);
    expect((await s.a.admit("c")).ok).toBe(true);
  });

  it("gives back an admission whose session did not open", async () => {
    const s = setup({ availableMb: 4000 });
    const a = await s.a.admit("a");
    expect(a.ok).toBe(true);
    expect((await s.a.admit("b")).ok).toBe(false);
    if (a.ok) {
      a.release();
      a.release();
    }
    expect((await s.a.admit("b")).ok).toBe(true);
    expect((await s.a.capacity()).pending).toBe(1);
  });

  it("two admissions at the same time see each other (the second waits for the first)", async () => {
    const s = setup({ availableMb: 4000 });
    const [a, b] = await Promise.all([s.a.admit("a"), s.a.admit("b")]);
    expect([a.ok, b.ok]).toEqual([true, false]);
  });

  it("a release gives back only its own slot, not one admitted later", async () => {
    const s = setup({ availableMb: 6000 });
    const a = await s.a.admit("a");
    s.tick(PENDING_MS - 10);
    await s.a.admit("b");
    if (a.ok) a.release();
    s.tick(20);
    // b 还在两分钟内：仍算一个。
    expect((await s.a.capacity()).pending).toBe(1);
  });

  it("prefers the measured per-session memory to the setting", async () => {
    const s = setup({ availableMb: 6000, measured: [1500 * MB, 2500 * MB] });
    expect(await s.a.capacity()).toMatchObject({ sessionMb: 2000, estimate: "measured", canStart: 1 });
    const none = setup({ availableMb: 6000, measured: [] });
    expect(await none.a.capacity()).toMatchObject({ sessionMb: 1024, estimate: "setting" });
  });

  it("refuses under critical memory pressure however much looks free", async () => {
    const s = setup({ availableMb: 40_000, pressure: "critical" });
    expect(await s.a.admit("x")).toMatchObject({ ok: false, reason: "pressure", capacity: { canStart: 0 } });
    expect((await setup({ availableMb: 40_000, pressure: "warn" }).a.admit("x")).ok).toBe(true);
  });

  it("the hard limit is off by default; when set it caps the count even with memory to spare", async () => {
    const off = setup({ availableMb: 100_000, running: 50 });
    expect((await off.a.admit("x")).ok).toBe(true);
    const on = setup({ availableMb: 100_000, running: 4, settings: { maxRunning: 5 } });
    expect(await on.a.capacity()).toMatchObject({ canStart: 1, maxRunning: 5 });
    expect((await on.a.admit("x")).ok).toBe(true);
    on.setRunning(5);
    expect(await on.a.admit("y")).toMatchObject({ ok: false, reason: "max_running" });
  });

  it("admits when memory cannot be read (an error must not stop work), only the hard limit applies", async () => {
    const s = setup({ readFails: true });
    expect(await s.a.admit("x")).toMatchObject({ ok: true, capacity: { availableMb: null, canStart: null } });
    expect(s.d.log).toHaveBeenCalledWith(expect.stringMatching(/reading memory failed/), expect.any(Error));
    const capped = setup({ readFails: true, running: 3, settings: { maxRunning: 3 } });
    expect((await capped.a.admit("x")).ok).toBe(false);
  });
});
