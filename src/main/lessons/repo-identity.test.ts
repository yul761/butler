import { describe, expect, it } from "vitest";
import { makeRepo, tempDir } from "../test-utils";
import { parseRemoteSlug, RepoIdentity } from "./repo-identity";

describe("parseRemoteSlug", () => {
  it.each([
    ["https://github.com/acme/web.git", "acme/web"],
    ["git@github.com:acme/web.git", "acme/web"],
    ["ssh://git@github.com/acme/web", "acme/web"],
    ["https://ghe.corp.com/team/api.git", "ghe.corp.com/team/api"],
    ["https://github.com/Acme/Web", "acme/web"],
    ["/local/path/repo.git", null],
    ["", null],
  ])("%s -> %s", (url, slug) => {
    expect(parseRemoteSlug(url)).toBe(slug);
  });
});

describe("RepoIdentity", () => {
  it("caches per path, including null", () => {
    let calls = 0;
    const id = new RepoIdentity({ git: () => (calls++, "git@github.com:acme/web.git") });
    expect(id.slugOf("/a")).toBe("acme/web");
    expect(id.slugOf("/a")).toBe("acme/web");
    expect(calls).toBe(1);
    let nullCalls = 0;
    const none = new RepoIdentity({ git: () => (nullCalls++, null) });
    expect(none.slugOf("/b")).toBeNull();
    expect(none.slugOf("/b")).toBeNull();
    expect(nullCalls).toBe(1);
  });

  it("resolve explains why", () => {
    const id = new RepoIdentity({ git: () => null });
    expect(id.resolve(makeRepo())).toEqual({ reason: "no_remote" });
    expect(id.resolve(tempDir())).toEqual({ reason: "not_git" });
  });

  it("resolve returns slug when remote parses", () => {
    const id = new RepoIdentity({ git: () => "https://github.com/acme/web.git" });
    expect(id.resolve("/x")).toEqual({ slug: "acme/web" });
  });

  it("default git implementation returns null without a remote", () => {
    expect(new RepoIdentity().slugOf(makeRepo())).toBeNull();
  });
});
