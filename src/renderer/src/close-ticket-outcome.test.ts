import { describe, expect, it } from "vitest";
import { closeOutcome, retryRequest, type CloseLeftoversResult } from "./close-ticket-outcome";

const base: CloseLeftoversResult = { closedPrs: [], prErrors: [], endedSessions: [], sessionErrors: [], reopenedMeanwhile: false };

describe("closeOutcome (BTL-270 close dialog)", () => {
  it("is done only when every PR and session was handled", () => {
    expect(closeOutcome({ ...base, closedPrs: ["u1"], endedSessions: ["s1"] })).toEqual({ done: true, reopenedMeanwhile: false });
  });

  it("is not done when the ticket closed but a PR did not, and keeps every reason to show", () => {
    const prErrors = [
      { url: "https://github.com/o/r/pull/2", error: "gh: timeout", kind: "failed" as const },
      { url: "https://github.com/o/r/pull/9", error: "never read", kind: "never_read" as const },
    ];
    const r = closeOutcome({ ...base, closedPrs: ["https://github.com/o/r/pull/1"], prErrors });
    expect(r).toEqual({ done: false, prErrors, sessionErrors: [] });
  });

  it("is not done when a session was not ended", () => {
    expect(closeOutcome({ ...base, sessionErrors: [{ id: "s2", error: "working" }] })).toEqual({ done: false, prErrors: [], sessionErrors: [{ id: "s2", error: "working" }] });
  });

  it("offers no retry when the ticket was reopened while closing", () => {
    expect(closeOutcome({ ...base, prErrors: [{ url: "u", error: "e", kind: "failed" }], reopenedMeanwhile: true })).toEqual({ done: true, reopenedMeanwhile: true });
  });

  it("retries exactly what was left", () => {
    expect(retryRequest({ prErrors: [{ url: "u2", error: "e", kind: "failed" }], sessionErrors: [{ id: "s2" }] })).toEqual({ prUrls: ["u2"], sessionIds: ["s2"] });
  });

  it("retries only what can succeed: gh failures and the switch being off, not PRs that can't be closed (BTL-270 review)", () => {
    const prErrors = [
      { url: "u1", error: "e", kind: "failed" as const },
      { url: "u2", error: "e", kind: "skipped" as const },
      ...(["never_read", "given_up", "foreign", "not_own_branch", "shared"] as const).map((kind, i) => ({ url: `x${i}`, error: "e", kind })),
    ];
    expect(retryRequest({ prErrors, sessionErrors: [] })).toEqual({ prUrls: ["u1", "u2"], sessionIds: [] });
    // 都是关不了的：没东西可重试。
    expect(retryRequest({ prErrors: prErrors.slice(2), sessionErrors: [] })).toBeNull();
    expect(retryRequest({ prErrors: prErrors.slice(2), sessionErrors: [{ id: "s" }] })).toEqual({ prUrls: [], sessionIds: ["s"] });
  });
});
