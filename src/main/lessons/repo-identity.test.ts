import { describe, expect, it, vi } from "vitest";
import { makeRepo, tempDir } from "../test-utils";
import { defaultGit, parseRemoteSlug, RepoIdentity } from "./repo-identity";

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
    const id = new RepoIdentity({ git: () => (calls++, "git@github.com:acme/web.git"), exists: () => true });
    expect(id.slugOf("/a")).toBe("acme/web");
    expect(id.slugOf("/a")).toBe("acme/web");
    expect(calls).toBe(1);
    let nullCalls = 0;
    const none = new RepoIdentity({ git: () => (nullCalls++, null), exists: () => true });
    expect(none.slugOf("/b")).toBeNull();
    expect(none.slugOf("/b")).toBeNull();
    expect(nullCalls).toBe(1);
  });

  it("does not cache a lookup that threw (timeout or error)", () => {
    let calls = 0;
    const id = new RepoIdentity({
      git: () => {
        if (calls++ === 0) throw new Error("timeout");
        return "git@github.com:acme/web.git";
      },
      exists: () => true,
    });
    expect(id.slugOf("/a")).toBeNull();
    expect(id.slugOf("/a")).toBe("acme/web");
    expect(calls).toBe(2);
  });

  it("resolve explains why", () => {
    const id = new RepoIdentity({ git: () => null });
    expect(id.resolve(makeRepo())).toEqual({ reason: "no_remote" });
    expect(id.resolve(tempDir())).toEqual({ reason: "not_git" });
  });

  it("resolve returns slug when remote parses", () => {
    const id = new RepoIdentity({ git: () => "https://github.com/acme/web.git", exists: () => true });
    expect(id.resolve("/x")).toEqual({ slug: "acme/web" });
  });

  it("default git implementation returns null without a remote", () => {
    expect(new RepoIdentity().slugOf(makeRepo())).toBeNull();
  });

  it("a path without .git is not spawned twice and resolves not_git", () => {
    const git = vi.fn(() => "git@github.com:acme/web.git");
    const id = new RepoIdentity({ git, exists: (p) => !p.endsWith(".git") });
    expect(id.slugOf("/plain")).toBeNull();
    expect(id.slugOf("/plain")).toBeNull();
    expect(id.resolve("/plain")).toEqual({ reason: "not_git" });
    expect(git).not.toHaveBeenCalled();
  });

  it("a missing path is not cached", () => {
    let present = false;
    const git = vi.fn(() => "git@github.com:acme/web.git");
    const id = new RepoIdentity({ git, exists: () => present });
    expect(id.slugOf("/mnt/x")).toBeNull();
    expect(git).not.toHaveBeenCalled();
    present = true;
    expect(id.slugOf("/mnt/x")).toBe("acme/web");
  });
});

describe("defaultGit", () => {
  it("returns null on status 2 and throws on other errors", () => {
    const fail = (status: number) =>
      (() => {
        throw Object.assign(new Error("x"), { status });
      }) as unknown as typeof import("node:child_process").execFileSync;
    expect(defaultGit("/r", fail(2))).toBeNull();
    expect(() => defaultGit("/r", fail(128))).toThrow();
  });
});
