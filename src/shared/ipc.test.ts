import { describe, expect, it } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS, IPC, SEND_CHANNELS } from "./ipc";

describe("IPC whitelist", () => {
  it("lists every channel exactly once", () => {
    const listed = [...INVOKE_CHANNELS, ...SEND_CHANNELS, ...EVENT_CHANNELS];
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(Object.values(IPC).sort());
  });
});
