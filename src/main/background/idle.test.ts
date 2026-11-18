import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { COMMON_IDLE_EVENTS, electronIdleSignal, fakeIdleSignal, MAC_IDLE_EVENTS, userIdle, type PowerMonitorLike } from "./idle";

function fakePm(idle = 0, state: "active" | "idle" | "locked" | "unknown" = "active") {
  const em = new EventEmitter();
  const pm: PowerMonitorLike & { idle: number; state: typeof state; emit: (e: string) => void; count: (e: string) => number } = {
    idle, state,
    getSystemIdleTime: () => pm.idle,
    getSystemIdleState: () => pm.state,
    on: (e, fn) => em.on(e, fn),
    removeListener: (e, fn) => em.removeListener(e, fn),
    emit: (e) => em.emit(e),
    count: (e) => em.listenerCount(e),
  };
  return pm;
}

describe("electron idle signal", () => {
  it("listens to the events both platforms have, plus the macOS-only ones on macOS", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const pm = fakePm();
      const s = electronIdleSignal(pm, platform);
      for (const e of COMMON_IDLE_EVENTS) expect(pm.count(e), `${platform} ${e}`).toBe(1);
      for (const e of MAC_IDLE_EVENTS) expect(pm.count(e), `${platform} ${e}`).toBe(platform === "darwin" ? 1 : 0);
      s.dispose?.();
      for (const e of [...COMMON_IDLE_EVENTS, ...MAC_IDLE_EVENTS]) expect(pm.count(e)).toBe(0);
    }
  });

  it("treats lock and sleep as away until unlock or resume, on both platforms", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const pm = fakePm(0);
      const s = electronIdleSignal(pm, platform);
      const fn = vi.fn();
      s.subscribe(fn);
      expect(s.locked()).toBe(false);
      pm.emit("lock-screen");
      expect(s.locked()).toBe(true);
      pm.emit("unlock-screen");
      expect(s.locked()).toBe(false);
      pm.emit("suspend");
      expect(s.locked()).toBe(true);
      pm.emit("resume");
      expect(s.locked()).toBe(false);
      expect(fn).toHaveBeenCalledTimes(4);
    }
  });

  it("reports locked from the idle state and idle time from the system", () => {
    const pm = fakePm(42, "locked");
    const s = electronIdleSignal(pm, "win32");
    expect(s.locked()).toBe(true);
    expect(s.idleSeconds()).toBe(42);
    pm.state = "active";
    expect(s.locked()).toBe(false);
  });

  it("handles macOS user switching", () => {
    const pm = fakePm();
    const s = electronIdleSignal(pm, "darwin");
    pm.emit("user-did-resign-active");
    expect(s.locked()).toBe(true);
    pm.emit("user-did-become-active");
    expect(s.locked()).toBe(false);
  });
});

describe("userIdle", () => {
  it("is idle when locked or after the threshold", () => {
    const s = fakeIdleSignal({ idleSeconds: 599 });
    expect(userIdle(s, 10)).toBe(false);
    s.set({ idleSeconds: 600 });
    expect(userIdle(s, 10)).toBe(true);
    s.set({ idleSeconds: 0, locked: true });
    expect(userIdle(s, 10)).toBe(true);
  });
});
