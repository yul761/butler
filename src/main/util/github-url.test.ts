import { describe, expect, it, vi } from "vitest";
import { isAllowedGithubUrl, openKnownPr } from "./github-url";

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
      "https://ghe.acme.io.evil.com/t/a/pull/3",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(isAllowedGithubUrl(bad, ["ghe.acme.io/t/a"]), bad).toBe(false);
    }
  });
});

describe("openKnownPr", () => {
  const setup = (known: string[], slugs: string[]) => {
    const openExternal = vi.fn();
    const prs = { byUrl: (url: string) => known.filter((k) => k === url), slugs: () => slugs };
    return { open: (url: string) => openKnownPr(url, { prs, openExternal }), openExternal };
  };

  it("opens a linked PR on an allowed host", () => {
    const { open, openExternal } = setup(["https://github.com/a/b/pull/1"], ["a/b"]);
    expect(open("https://github.com/A/B/pull/1/")).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith("https://github.com/A/B/pull/1/");
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
