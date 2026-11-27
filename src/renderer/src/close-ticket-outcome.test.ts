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
      { url: "https://github.com/o/r/pull/9", error: "never read", kind: "unread" as const },
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
});
