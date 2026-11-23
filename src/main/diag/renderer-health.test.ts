import { describe, expect, it } from "vitest";
import { MAX_EVENTS, RendererHealth, type RendererHealthDeps } from "./renderer-health";

function setup(o: Partial<RendererHealthDeps> = {}) {
  let t = Date.UTC(2026, 10, 23);
  const logs: string[] = [];
  const timers: Array<() => void> = [];
  const gaveUp: Array<{ reason: string; exitCode: number; reloads: number }> = [];
  let reloads = 0;
  let quitting = false;
  const h = new RendererHealth({
    now: () => t, log: (l) => logs.push(l), reload: () => void reloads++, gaveUp: (i) => void gaveUp.push(i),
    quitting: () => quitting, setTimer: (fn) => timers.push(fn), clearTimer: () => undefined, ...o,
  });
  const fire = () => timers.splice(0).forEach((f) => f());
  return {
    h, logs, gaveUp, fire,
    reloads: () => reloads,
    advance: (ms: number) => void (t += ms),
    quit: () => void (quitting = true),
  };
}

describe("RendererHealth: crashes", () => {
  it("logs reason and exit code, then reloads after a short delay", () => {
    const s = setup();
    s.h.gone({ reason: "crashed", exitCode: 11 });
    expect(s.logs[0]).toContain("reason=crashed");
    expect(s.logs[0]).toContain("exitCode=11");
    expect(s.reloads()).toBe(0);
    s.fire();
    expect(s.reloads()).toBe(1);
    expect(s.h.events().map((e) => e.kind)).toEqual(["gone", "reloaded"]);
    expect(s.h.events()[0]).toMatchObject({ reason: "crashed", exitCode: 11, action: "reload" });
  });

  it("reloads at most 3 times in 5 minutes, then stops and tells the user once", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) {
      s.h.gone({ reason: "oom", exitCode: -536870904 });
      s.fire();
      s.advance(30_000);
    }
    expect(s.reloads()).toBe(3);
    s.h.gone({ reason: "oom", exitCode: -536870904 });
    s.fire();
    expect(s.reloads()).toBe(3);
    expect(s.gaveUp).toEqual([{ reason: "oom", exitCode: -536870904, reloads: 3 }]);
    expect(s.h.events().at(-1)).toMatchObject({ kind: "gone", action: "gave-up" });
    expect(s.logs.at(-1)).toContain("not reloading");
    // 再崩（比如别的地方又加载了一次）也不会再弹第二次。
    s.h.gone({ reason: "oom", exitCode: 1 });
    expect(s.gaveUp).toHaveLength(1);
  });

  it("crashes spread over more than 5 minutes keep reloading", () => {
    const s = setup();
    for (let i = 0; i < 6; i++) {
      s.h.gone({ reason: "crashed", exitCode: 1 });
      s.fire();
      s.advance(2 * 60_000);
    }
    expect(s.reloads()).toBe(6);
    expect(s.gaveUp).toEqual([]);
  });

  it("the user's reload starts the count again", () => {
    const s = setup({ maxReloads: 1 });
    s.h.gone({ reason: "crashed", exitCode: 1 });
    s.fire();
    s.h.gone({ reason: "crashed", exitCode: 1 });
    expect(s.gaveUp).toHaveLength(1);
    s.h.userReload();
    expect(s.reloads()).toBe(2);
    s.h.gone({ reason: "crashed", exitCode: 1 });
    s.fire();
    expect(s.reloads()).toBe(3);
    expect(s.h.events().flatMap((e) => (e.kind === "reloaded" ? [e.by] : []))).toEqual(["auto", "user", "auto"]);
  });

  it("a window reopened after the crashed one was closed starts the count again, without reloading anything (BTL-262 review)", () => {
    const s = setup({ maxReloads: 1 });
    s.h.gone({ reason: "crashed", exitCode: 1 });
    s.fire();
    s.h.gone({ reason: "crashed", exitCode: 1 });
    expect(s.gaveUp).toHaveLength(1);
    s.h.windowReopened();
    expect(s.reloads()).toBe(1);
    s.h.gone({ reason: "crashed", exitCode: 1 });
    s.fire();
    expect(s.reloads()).toBe(2);
    expect(s.gaveUp).toHaveLength(1);
    expect(s.logs).toContain("renderer: opening a new window at the user's request");
  });

  it("does not reload on a clean exit or while quitting", () => {
    const s = setup();
    s.h.gone({ reason: "clean-exit", exitCode: 0 });
    s.fire();
    s.quit();
    s.h.gone({ reason: "crashed", exitCode: 1 });
    s.fire();
    expect(s.reloads()).toBe(0);
    expect(s.gaveUp).toEqual([]);
    expect(s.h.events().map((e) => (e.kind === "gone" ? e.action : null))).toEqual(["none", "none"]);
  });

  it("a reload that throws is logged, not thrown", () => {
    const s = setup({ reload: () => { throw new Error("destroyed"); } });
    s.h.gone({ reason: "crashed", exitCode: 1 });
    expect(() => s.fire()).not.toThrow();
    expect(s.logs.at(-1)).toContain("reload failed (destroyed)");
  });
});

describe("RendererHealth: hangs", () => {
  it("logs unresponsive and how long until it was responsive again", () => {
    const s = setup();
    s.h.unresponsive();
    s.advance(4200);
    s.h.unresponsive();
    s.advance(800);
    s.h.responsive();
    expect(s.logs).toEqual(["renderer: unresponsive", "renderer: unresponsive", "renderer: responsive again after 5000 ms"]);
    expect(s.h.events().at(-1)).toMatchObject({ kind: "responsive", afterMs: 5000 });
    expect(s.h.events()[0].at).toBe("2026-11-23T00:00:00.000Z");
  });

  it("keeps only the latest events", () => {
    const s = setup();
    for (let i = 0; i < MAX_EVENTS + 10; i++) s.h.unresponsive();
    expect(s.h.events()).toHaveLength(MAX_EVENTS);
  });
});
