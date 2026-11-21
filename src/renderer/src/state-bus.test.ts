import { describe, expect, it } from "vitest";
import { createStateBus, LIVE_SCOPES } from "./state-bus";

describe("state bus (BTL-242)", () => {
  it("listeners without scopes hear only data; old payloads count as data", () => {
    const bus = createStateBus();
    const heard: string[][] = [];
    bus.subscribe((s) => heard.push(s));
    bus.dispatch({ scopes: ["activity"] });
    bus.dispatch({ scopes: ["procs"] });
    expect(heard).toEqual([]);
    bus.dispatch(undefined);
    bus.dispatch({ scopes: ["activity", "data"] });
    expect(heard).toEqual([["data"], ["activity", "data"]]);
  });

  it("live listeners hear activity and procs; unsubscribe stops it", () => {
    const bus = createStateBus();
    let n = 0;
    const off = bus.subscribe(() => n++, LIVE_SCOPES);
    bus.dispatch({ scopes: ["procs"] });
    bus.dispatch({ scopes: ["activity"] });
    bus.dispatch({ scopes: ["messages"] });
    expect(n).toBe(2);
    off();
    bus.dispatch({ scopes: ["data"] });
    expect(n).toBe(2);
    expect(bus.size()).toBe(0);
  });

  it("one throwing listener does not stop the others", () => {
    const bus = createStateBus();
    let n = 0;
    bus.subscribe(() => {
      throw new Error("x");
    });
    bus.subscribe(() => n++);
    const err = console.error;
    console.error = () => {};
    try {
      bus.dispatch({ scopes: ["data"] });
    } finally {
      console.error = err;
    }
    expect(n).toBe(1);
  });
});
