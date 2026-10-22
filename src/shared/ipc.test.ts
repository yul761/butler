import { describe, expect, it } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS, IPC, SEND_CHANNELS } from "./ipc";

describe("IPC whitelist", () => {
  it("lists every channel exactly once", () => {
    const listed = [...INVOKE_CHANNELS, ...SEND_CHANNELS, ...EVENT_CHANNELS];
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(Object.values(IPC).sort());
  });

  it("exposes the personal API channels as invoke-only", () => {
    for (const c of [IPC.llmStatus, IPC.llmKeySave, IPC.llmKeyClear, IPC.termsList, IPC.termsSave, IPC.auditList]) {
      expect(INVOKE_CHANNELS).toContain(c);
      expect(EVENT_CHANNELS).not.toContain(c);
    }
  });

  it("exposes the memory channels as invoke-only", () => {
    for (const c of [IPC.memoryView, IPC.memoryWhy]) {
      expect(INVOKE_CHANNELS).toContain(c);
      expect(EVENT_CHANNELS).not.toContain(c);
    }
  });

  it("exposes the memory-changed notification as an event only (final review 4)", () => {
    expect(EVENT_CHANNELS).toContain(IPC.memoryChanged);
    expect(INVOKE_CHANNELS).not.toContain(IPC.memoryChanged);
    expect(SEND_CHANNELS).not.toContain(IPC.memoryChanged);
  });

  it("exposes the autostart channels as invoke-only", () => {
    for (const c of [IPC.appAutostartGet, IPC.appAutostartSet]) expect(INVOKE_CHANNELS).toContain(c);
  });
});
