import { describe, expect, it } from "vitest";
import { createQuitState } from "./quit-state";

describe("quit state", () => {
  it("sets quitting before quitting, and quits only once", () => {
    const seen: boolean[] = [];
    const s = createQuitState(() => seen.push(s.quitting));
    expect(s.quitting).toBe(false);
    s.requestQuit();
    s.requestQuit();
    expect(seen).toEqual([true]);
  });

  it("markQuitting does not trigger a quit", () => {
    let calls = 0;
    const s = createQuitState(() => calls++);
    s.markQuitting();
    expect(s.quitting).toBe(true);
    expect(calls).toBe(0);
  });
});
