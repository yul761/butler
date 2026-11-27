import { describe, expect, it } from "vitest";
import { closedMeanwhile, closeOutcome, closePrsRequest, pickableInPreview, REST_PREVIEW_TTL_MS, REST_SETTLE_MS, restPreviewCache, restStamp, retryableInPreview, retryRequest, type CloseLeftoversResult } from "./close-ticket-outcome";

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
      ...(["never_read", "given_up", "foreign", "not_own_branch", "shared", "shared_branch"] as const).map((kind, i) => ({ url: `x${i}`, error: "e", kind })),
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
    // 关掉的 ticket 上「关掉剩下的 PR」按钮按这个数显示：能勾的 + 能再核对的，关不了的不算。
    expect(pickableInPreview(preview)).toBe(1);
    expect(pickableInPreview({ closable: [{ url: "u", number: 1 }], unclosable: [] })).toBe(1);
    expect(pickableInPreview({ closable: [], unclosable: [preview.unclosable[1]] })).toBe(0);
    expect(pickableInPreview(null)).toBe(0);
    expect(closePrsRequest(preview, new Set([unverified.url, "https://github.com/o/r/pull/9"]))).toEqual({ closePrs: true, prUrls: [unverified.url] });
  });
  it("are not done after closing, and the retry sends them again", () => {
    const o = closeOutcome({ closedPrs: [], prErrors: [unverified], endedSessions: [], sessionErrors: [], reopenedMeanwhile: false });
    expect(o).toEqual({ done: false, prErrors: [unverified], sessionErrors: [] });
    expect(retryRequest({ prErrors: [unverified], sessionErrors: [] })).toEqual({ prUrls: [unverified.url], sessionIds: [] });
  });
});

// BTL-270 审查（第二轮）：关着的 ticket 页不每次打开都预览（要跑 gh）；关闭框里 ticket 被别人先关了要提示。
describe("the closed ticket page's remaining-PR count and the closed-meanwhile notice", () => {
  it("keeps a ticket's count for a short while, then reads again; drop forgets it at once", () => {
    let t = 0;
    const c = restPreviewCache(() => t);
    expect(c.get("T-1", "a")).toBeUndefined();
    expect(c.set("T-1", 2, "a", c.begin("T-1"))).toBe(true);
    t = REST_PREVIEW_TTL_MS - 1;
    expect(c.get("T-1", "a")).toBe(2);
    expect(c.get("T-2", "a")).toBeUndefined();
    t = REST_PREVIEW_TTL_MS;
    expect(c.get("T-1", "a")).toBeUndefined();
    c.set("T-1", 0, "a", c.begin("T-1"));
    expect(c.get("T-1", "a")).toBe(0);
    c.drop("T-1");
    expect(c.get("T-1", "a")).toBeUndefined();
  });

  it("a preview that comes back after a drop is not written; a count taken with other open PRs is not used (BTL-270 review)", () => {
    const c = restPreviewCache(() => 0);
    // 预览开始后对话框关上了（drop）：晚到的旧结果不写。
    const gen = c.begin("T-1");
    c.drop("T-1");
    expect(c.set("T-1", 3, "a", gen)).toBe(false);
    expect(c.get("T-1", "a")).toBeUndefined();
    // drop 之后开始的照常写；别的 ticket 的代数不受影响。
    expect(c.set("T-1", 1, "a", c.begin("T-1"))).toBe(true);
    expect(c.get("T-1", "a")).toBe(1);
    const other = c.begin("T-2");
    c.drop("T-1");
    expect(c.set("T-2", 4, "b", other)).toBe(true);
    // 总控关了一个 PR：开着的 PR 变了，stamp 对不上，不用记下的数。
    expect(c.get("T-2", "b2")).toBeUndefined();
  });

  it("after the dialog closed PRs, waits for the watch list to drop them (or for REST_SETTLE_MS) before one preview (BTL-270 review)", () => {
    let t = 0;
    const c = restPreviewCache(() => t);
    c.set("T-1", 2, "u1\nu2", c.begin("T-1"));
    const gen = c.begin("T-1");
    c.settle("T-1", ["u1"]);
    // settle 也是 drop：记下的数和路上的预览都作废。
    expect(c.get("T-1", "u1\nu2")).toBeUndefined();
    expect(c.set("T-1", 2, "u1\nu2", gen)).toBe(false);
    // 监视记录还没跟上：等着，给剩下的时间；别的 ticket 不等。
    expect(c.waiting("T-1", "u1\nu2")).toBe(REST_SETTLE_MS);
    expect(c.waiting("T-2", "u1\nu2")).toBe(0);
    t = 5_000;
    expect(c.waiting("T-1", "u1\nu2")).toBe(REST_SETTLE_MS - 5_000);
    // 跟上了：不等，而且忘掉这次等待（之后别的 PR 再出现也不等）。
    expect(c.waiting("T-1", "u2")).toBe(0);
    expect(c.waiting("T-1", "u1\nu2")).toBe(0);
    // 一直没跟上：等到头也照常预览。
    c.settle("T-1", ["u2"]);
    t += REST_SETTLE_MS;
    expect(c.waiting("T-1", "u2")).toBe(0);
    // 什么都没关、监视记录读不到、ticket 重新打开（drop）：都不等。
    c.settle("T-1", []);
    expect(c.waiting("T-1", "u2")).toBe(0);
    c.settle("T-1", ["u2"]);
    expect(c.waiting("T-1", null)).toBe(0);
    c.settle("T-1", ["u2"]);
    c.drop("T-1");
    expect(c.waiting("T-1", "u2")).toBe(0);
  });

  it("stamps a ticket by its open PRs from the watch list, in any order; a failed read is null", () => {
    const w = (ticketKey: string, n: number, state: "open" | "closed" | "merged" | null) => ({ ticketKey, url: n ? `u${n}` : null, state });
    expect(restStamp("failed", "T-1")).toBeNull();
    expect(restStamp([], "T-1")).toBe("");
    const a = restStamp([w("T-1", 2, "open"), w("T-1", 1, "open"), w("T-2", 3, "open"), w("T-1", 4, "closed"), w("T-1", 0, null)], "T-1");
    expect(a).toBe(restStamp([w("T-1", 1, "open"), w("T-1", 2, "open")], "T-1"));
    expect(restStamp([w("T-1", 1, "open"), w("T-1", 2, "closed")], "T-1")).not.toBe(a);
  });

  it("says the ticket had just been closed only for the close dialog, by what this submit did, and not when it was reopened meanwhile (BTL-270 review)", () => {
    const r = { closedPrs: ["u"], prErrors: [], endedSessions: [], sessionErrors: [], reopenedMeanwhile: false };
    expect(closedMeanwhile({ ...r, alreadyClosed: true }, false)).toBe("prs");
    expect(closedMeanwhile({ ...r, closedPrs: [], endedSessions: ["s"], alreadyClosed: true }, false)).toBe("sessions");
    expect(closedMeanwhile({ ...r, endedSessions: ["s"], alreadyClosed: true }, false)).toBe("both");
    expect(closedMeanwhile({ ...r, closedPrs: [], alreadyClosed: true }, false)).toBe("nothing");
    // 勾了的有没处理成的（下面的框里列出来、可以重试）：不说「没有要你再做的」，也不说「只关了你勾的」。
    const prError = { url: "u2", error: "boom", kind: "failed" as const };
    expect(closedMeanwhile({ ...r, closedPrs: [], prErrors: [prError], alreadyClosed: true }, false)).toBe("failed");
    expect(closedMeanwhile({ ...r, prErrors: [prError], alreadyClosed: true }, false)).toBe("failed");
    expect(closedMeanwhile({ ...r, closedPrs: [], sessionErrors: [{ id: "s", error: "busy" }], alreadyClosed: true }, false)).toBe("failed");
    expect(closedMeanwhile({ ...r, alreadyClosed: true }, true)).toBeNull();
    expect(closedMeanwhile(r, false)).toBeNull();
    expect(closedMeanwhile({ ...r, alreadyClosed: true, reopenedMeanwhile: true }, false)).toBeNull();
  });
});
