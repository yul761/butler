import { describe, expect, it, vi } from "vitest";
import { InterruptsFacade, interruptsActionArg } from "./facade";

describe("interruptsActionArg", () => {
  it("accepts each action and rejects malformed ones", () => {
    expect(interruptsActionArg({ op: "profile_decide", slug: "a/b", confirm: ["Bash(gh pr view:*)"], dismiss: [] })).toEqual({ op: "profile_decide", slug: "a/b", confirm: ["Bash(gh pr view:*)"], dismiss: [] });
    expect(interruptsActionArg({ op: "choices_review", ids: null })).toEqual({ op: "choices_review", ids: null });
    expect(interruptsActionArg({ op: "default_save", id: null, pattern: "x", answer: "", enabled: true })).toMatchObject({ id: null });
    expect(interruptsActionArg({ op: "notify_test", extra: 1 })).toEqual({ op: "notify_test" });
    for (const bad of [null, {}, { op: "nope" }, { op: "profile_decide", slug: "a/b", confirm: "x", dismiss: [] }, { op: "default_delete", id: -1 }, { op: "choices_review", ids: [1.5] }, { op: "webhook_save", url: 5 }])
      expect(() => interruptsActionArg(bad)).toThrow();
  });
});

describe("InterruptsFacade", () => {
  it("runs the action and returns the fresh state, with the test result for notify_test", async () => {
    const decide = vi.fn();
    const f = new InterruptsFacade({
      profiles: { rules: () => [], state: () => ({ scannedAt: null, candidates: [], pending: [] }), scan: vi.fn(), explain: vi.fn(), decide, remove: vi.fn() },
      choices: { list: () => [], unreviewed: () => 0, review: vi.fn(), defaults: () => [], saveDefault: vi.fn(), deleteDefault: vi.fn() },
      webhook: { state: () => ({ saved: false, host: null, unreadable: false, encryptionAvailable: true }), save: vi.fn(), clear: vi.fn() },
      notifier: { test: async () => ({ ok: false, error: "off" }) },
      log: { recent: () => [] },
    });
    const r = await f.act({ op: "profile_decide", slug: "a/b", confirm: ["x"], dismiss: [] });
    expect(decide).toHaveBeenCalledWith("a/b", ["x"], []);
    expect(r.test).toBeUndefined();
    expect((await f.act({ op: "notify_test" })).test).toEqual({ ok: false, error: "off" });
  });
});
