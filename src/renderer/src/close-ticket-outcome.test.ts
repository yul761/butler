import { describe, expect, it } from "vitest";
import { closeOutcome, closePrsRequest, retryableInPreview, retryRequest, type CloseLeftoversResult } from "./close-ticket-outcome";

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

// BTL-270 审查（建议 4）：只有关不了的 PR、什么都没勾时，提交后不再把它们当作没处理完的再列一遍。
describe("closePrsRequest (what the close dialog asks to close)", () => {
  const preview = {
    closable: [{ url: "https://github.com/o/r/pull/1", number: 1 }, { url: "https://github.com/o/r/pull/2", number: 2 }],
    unclosable: [{ url: "https://github.com/o/r/pull/9", error: "e", kind: "not_own_branch" as const }],
  };
  it("asks to close only the ticked PRs that the preview listed as closable", () => {
    expect(closePrsRequest(preview, new Set(["https://github.com/o/r/pull/2", "https://github.com/o/r/pull/9", "https://github.com/o/r/pull/5"])))
      .toEqual({ closePrs: true, prUrls: ["https://github.com/o/r/pull/2"] });
  });
  it("with nothing ticked asks to close no PR, so PRs it can't close are not listed again as leftovers", () => {
    expect(closePrsRequest({ closable: [], unclosable: preview.unclosable }, new Set())).toEqual({ closePrs: false, prUrls: [] });
    expect(closePrsRequest(preview, new Set())).toEqual({ closePrs: false, prUrls: [] });
    expect(closePrsRequest(null, new Set())).toEqual({ closePrs: false, prUrls: [] });
    // 不要求关 PR 时结果里没有 PR 的错误：直接算完成。
    expect(closeOutcome({ closedPrs: [], prErrors: [], endedSessions: [], sessionErrors: [], reopenedMeanwhile: false })).toEqual({ done: true, reopenedMeanwhile: false });
  });
});

// BTL-270 审查：关之前核对 head 失败的（unverified）可以重试：预览里能勾，关的时候再核对；没处理完的里面重试按钮能点。
describe("PRs whose head check failed (unverified)", () => {
  const unverified = { url: "https://github.com/o/r/pull/3", error: "关之前核对 PR 失败（timed out after 10s）", kind: "unverified" as const };
  const preview = { closable: [], unclosable: [unverified, { url: "https://github.com/o/r/pull/9", error: "e", kind: "not_own_branch" as const }] };
  it("can be ticked in the preview and are sent to be checked again; PRs that can't be closed can't", () => {
    expect(retryableInPreview(preview)).toEqual([unverified]);
    expect(closePrsRequest(preview, new Set([unverified.url, "https://github.com/o/r/pull/9"]))).toEqual({ closePrs: true, prUrls: [unverified.url] });
  });
  it("are not done after closing, and the retry sends them again", () => {
    const o = closeOutcome({ closedPrs: [], prErrors: [unverified], endedSessions: [], sessionErrors: [], reopenedMeanwhile: false });
    expect(o).toEqual({ done: false, prErrors: [unverified], sessionErrors: [] });
    expect(retryRequest({ prErrors: [unverified], sessionErrors: [] })).toEqual({ prUrls: [unverified.url], sessionIds: [] });
  });
});
