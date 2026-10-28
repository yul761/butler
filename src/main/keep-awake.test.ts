import { describe, expect, it } from "vitest";
import { KeepAwake, type PowerBlocker } from "./keep-awake";

function fakeBlocker(): PowerBlocker & { active: Set<number>; types: string[] } {
  let next = 1;
  const active = new Set<number>();
  const types: string[] = [];
  return {
    active,
    types,
    start: (type) => {
      types.push(type);
      active.add(next);
      return next++;
    },
    stop: (id) => void active.delete(id),
    isStarted: (id) => active.has(id),
  };
}

describe("KeepAwake", () => {
  it("starts off; turning it on holds one display-sleep blocker, turning it off releases it", () => {
    const blocker = fakeBlocker();
    const changes: boolean[] = [];
    const k = new KeepAwake({ blocker, onChange: (on) => changes.push(on) });
    expect(k.isOn()).toBe(false);

    k.set(true);
    expect(k.isOn()).toBe(true);
    expect(blocker.types).toEqual(["prevent-display-sleep"]);
    expect(blocker.active.size).toBe(1);

    k.set(false);
    expect(k.isOn()).toBe(false);
    expect(blocker.active.size).toBe(0);
    expect(changes).toEqual([true, false]);
  });

  it("does nothing when asked for the state it is already in", () => {
    const blocker = fakeBlocker();
    const changes: boolean[] = [];
    const k = new KeepAwake({ blocker, onChange: (on) => changes.push(on) });
    k.set(false);
    k.set(true);
    k.set(true);
    expect(blocker.types).toHaveLength(1);
    expect(changes).toEqual([true]);
  });

  it("reports off if the system dropped the blocker on its own", () => {
    const blocker = fakeBlocker();
    const k = new KeepAwake({ blocker, onChange: () => undefined });
    k.set(true);
    blocker.active.clear();
    expect(k.isOn()).toBe(false);
    // 再打开时重新申请一个。
    k.set(true);
    expect(blocker.types).toHaveLength(2);
    expect(k.isOn()).toBe(true);
  });

  it("a failing onChange does not leave the blocker in a half state", () => {
    const blocker = fakeBlocker();
    const k = new KeepAwake({
      blocker,
      onChange: () => {
        throw new Error("ui gone");
      },
      log: () => undefined,
    });
    k.set(true);
    expect(k.isOn()).toBe(true);
    k.set(false);
    expect(blocker.active.size).toBe(0);
  });
});
