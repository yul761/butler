import { describe, expect, it, vi } from "vitest";
import { prUrlKey } from "../../shared/pr-url";
import { isAllowedGithubUrl, knownPrLookup, openKnownPr } from "./github-url";

describe("isAllowedGithubUrl", () => {
  it("accepts github.com over https", () => {
    expect(isAllowedGithubUrl("https://github.com/a/b/pull/1", [])).toBe(true);
  });

  it("accepts the host of a known three-part (enterprise) slug", () => {
    expect(isAllowedGithubUrl("https://ghe.acme.io/t/a/pull/3", ["ghe.acme.io/t/a"])).toBe(true);
    expect(isAllowedGithubUrl("https://ghe.acme.io/t/a/pull/3", ["t/a"])).toBe(false);
  });

  it("rejects credentials, lookalike hosts and plain http", () => {
    for (const bad of [
      "https://github.com@evil.com/a/b/pull/1",
      "https://github.com.evil.com/a/b",
      "https://evilgithub.com/a",
      "http://github.com/a",
      "https://user:pw@github.com/a",
      "https://user@github.com/a",
      "https://github.com:8443/a",
      "https://ghe.acme.io.evil.com/t/a/pull/3",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(isAllowedGithubUrl(bad, ["ghe.acme.io/t/a"]), bad).toBe(false);
    }
  });
});

describe("openKnownPr", () => {
  // 和 TicketPrsRepo.byUrl 一样：按 prUrlKey 比较。known 是 ticket_prs 里链接过的 PR，trusted 是 git remote 认出来的 slug。
  const setup = (known: string[], trusted: string[]) => {
    const openExternal = vi.fn();
    const prs = { byUrl: (url: string) => known.filter((k) => prUrlKey(k) === prUrlKey(url)) };
    return { open: (url: string) => openKnownPr(url, { prs, trustedSlugs: () => trusted, openExternal, log: vi.fn() }), openExternal };
  };

  it("logs a failed open instead of leaving the rejection unhandled", async () => {
    const boom = new Error("no browser");
    const log = vi.fn();
    const prs = { byUrl: () => ["https://github.com/a/b/pull/1"] };
    const r = openKnownPr("https://github.com/a/b/pull/1", { prs, trustedSlugs: () => [], openExternal: () => Promise.reject(boom), log });
    expect(r).toEqual({ ok: true });
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("opening https://github.com/a/b/pull/1 failed", boom));
  });

  it("opens a linked PR on an allowed host", () => {
    const { open, openExternal } = setup(["https://github.com/a/b/pull/1"], []);
    expect(open("https://github.com/A/B/pull/1/")).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith("https://github.com/A/B/pull/1/");
  });

  it("opens the normalized href of the validated URL, not the raw input", () => {
    const { open, openExternal } = setup(["https://github.com/a/b/pull/1"], []);
    expect(open("  https://github.com/a/b/pull/1 ")).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith("https://github.com/a/b/pull/1");
  });

  it("opens an enterprise PR whose host is a trusted repo slug", () => {
    const { open, openExternal } = setup(["https://ghe.acme.io/t/a/pull/3"], ["ghe.acme.io/t/a"]);
    expect(open("https://ghe.acme.io/t/a/pull/3")).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith("https://ghe.acme.io/t/a/pull/3");
  });

  it("refuses a linked PR on a host that only ticket_prs knows (not a trusted repo slug)", () => {
    // 一份 handoff 报了 evil.example 上的 PR：ticket_prs 里有它（slug evil.example/x/y），但它不是用户的仓库。
    const { open, openExternal } = setup(["https://evil.example/x/y/pull/1"], ["a/b"]);
    expect(open("https://evil.example/x/y/pull/1")).toEqual({ ok: false, reason: "bad_url" });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("refuses a URL no ticket links", () => {
    const { open, openExternal } = setup(["https://github.com/a/b/pull/1"], ["a/b"]);
    expect(open("https://github.com/a/b/pull/2")).toEqual({ ok: false, reason: "bad_url" });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("refuses a linked PR whose host is not allowed", () => {
    const { open, openExternal } = setup(["http://github.com/a/b/pull/1"], ["a/b"]);
    expect(open("http://github.com/a/b/pull/1")).toEqual({ ok: false, reason: "bad_url" });
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("knownPrLookup (UI redesign layer 2: the review card's 打开 PR)", () => {
  const open = (url: string, ticketPrs: string[], reviews: string[], trusted: string[] = []) => {
    const openExternal = vi.fn();
    const prs = knownPrLookup({ byUrl: (u) => ticketPrs.filter((k) => prUrlKey(k) === prUrlKey(u)) }, () => reviews.map((url) => ({ url })));
    return { r: openKnownPr(url, { prs, trustedSlugs: () => trusted, openExternal, log: vi.fn() }), openExternal };
  };

  it("opens a PR someone asked you to review, though no ticket links it", () => {
    const { r, openExternal } = open("https://github.com/Other/Lib/pull/40/", [], ["https://github.com/other/lib/pull/40"]);
    expect(r).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith("https://github.com/Other/Lib/pull/40/");
  });

  it("still opens ticket PRs, and refuses a PR neither knows", () => {
    expect(open("https://github.com/a/b/pull/1", ["https://github.com/a/b/pull/1"], []).r).toEqual({ ok: true });
    expect(open("https://github.com/a/b/pull/2", ["https://github.com/a/b/pull/1"], ["https://github.com/c/d/pull/2"]).r).toEqual({ ok: false, reason: "bad_url" });
  });

  it("a review request on an untrusted host is still refused", () => {
    const url = "https://evil.example/x/y/pull/1";
    expect(open(url, [], [url], ["a/b"]).r).toEqual({ ok: false, reason: "bad_url" });
    expect(open("https://ghe.acme.io/t/a/pull/3", [], ["https://ghe.acme.io/t/a/pull/3"], ["ghe.acme.io/t/a"]).r).toEqual({ ok: true });
  });
});
