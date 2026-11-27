import { describe, expect, it } from "vitest";
import { endSessionRefusal } from "./end-guard";

describe("endSessionRefusal (end_session and close_ticket end_sessions)", () => {
  const screen = (v: boolean) => () => v;
  it("refuses a working session, one not waiting for input, one the monitor has not seen, and one with a confirm on screen", () => {
    expect(endSessionRefusal("s", { kind: "working", waitingForInput: true, screenNeedsUser: screen(false) })).toContain("s");
    expect(endSessionRefusal("s", { kind: "idle", waitingForInput: false, screenNeedsUser: screen(false) })).not.toBeNull();
    expect(endSessionRefusal("s", { kind: null, waitingForInput: true, screenNeedsUser: screen(false) })).not.toBeNull();
    expect(endSessionRefusal("s", { kind: "waiting", waitingForInput: true, screenNeedsUser: screen(true) })).not.toBeNull();
  });
  it("lets an idle session waiting for input be ended", () => {
    expect(endSessionRefusal("s", { kind: "idle", waitingForInput: true, screenNeedsUser: screen(false) })).toBeNull();
    expect(endSessionRefusal("s", { kind: "waiting", waitingForInput: true, screenNeedsUser: screen(false) })).toBeNull();
  });
});
