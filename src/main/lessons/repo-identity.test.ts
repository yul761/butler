import { execFileSync } from "node:child_process";
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

  it("remoteSlugsOf gives origin and upstream, deduplicated, each cached on its own (fork workflow, BTL-261)", () => {
    let up = 0;
    const id = new RepoIdentity({ git: () => "git@github.com:me/web.git", upstreamGit: () => (up++, "https://github.com/acme/web.git"), exists: () => true });
    expect(id.remoteSlugsOf("/a")).toEqual(["me/web", "acme/web"]);
    expect(id.remoteSlugsOf("/a")).toEqual(["me/web", "acme/web"]);
    expect(up).toBe(1);
    expect(id.slugOf("/a")).toBe("me/web");
    const same = new RepoIdentity({ git: () => "https://github.com/acme/web", upstreamGit: () => "git@github.com:acme/web.git", exists: () => true });
    expect(same.remoteSlugsOf("/a")).toEqual(["acme/web"]);
    const noUpstream = new RepoIdentity({ git: () => "https://github.com/acme/web", upstreamGit: () => null, exists: () => true });
    expect(noUpstream.remoteSlugsOf("/a")).toEqual(["acme/web"]);
  });

  it("gives the renamed name once the rename service is attached; rawSlugOf keeps what the remote says (BTL-261)", () => {
    const id = new RepoIdentity({ git: () => "git@github.com:o/old.git", upstreamGit: () => "https://github.com/up/old", exists: () => true });
    expect(id.slugOf("/a")).toBe("o/old");
    id.useCanonical((s) => ({ "o/old": "o/new", "up/old": "up/new" })[s] ?? s);
    expect(id.slugOf("/a")).toBe("o/new");
    expect(id.rawSlugOf("/a")).toBe("o/old");
    expect(id.remoteSlugsOf("/a")).toEqual(["o/new", "up/new"]);
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

  describe("warm (BTL-275): the first lessons:state asks git off the main thread", () => {
    it("fills the cache asynchronously, so slugOf afterwards does not run the blocking git", async () => {
      const git = vi.fn(() => "git@github.com:acme/sync.git");
      const asyncGit = vi.fn(async (p: string) => (p === "/none" ? null : `git@github.com:acme/${p.slice(1)}.git`));
      const id = new RepoIdentity({ git, asyncGit, exists: () => true });
      await id.warm(["/web", "/api", "/none", "/web"]);
      expect(asyncGit).toHaveBeenCalledTimes(3);
      expect([id.slugOf("/web"), id.slugOf("/api"), id.slugOf("/none")]).toEqual(["acme/web", "acme/api", null]);
      expect(git).not.toHaveBeenCalled();
      await id.warm(["/web"]);
      expect(asyncGit).toHaveBeenCalledTimes(3);
    });

    it("a lookup that failed is not cached; missing paths and non-repos are handled like slugOf", async () => {
      const git = vi.fn(() => "git@github.com:acme/later.git");
      const asyncGit = vi.fn(async () => {
        throw new Error("timeout");
      });
      const id = new RepoIdentity({ git, asyncGit, exists: (p) => !p.startsWith("/gone") && !p.startsWith("/plain/") });
      await id.warm(["/slow", "/gone", "/plain"]);
      expect(asyncGit).toHaveBeenCalledTimes(1);
      expect(id.slugOf("/slow")).toBe("acme/later");
      expect(id.slugOf("/plain")).toBeNull();
      expect(git).toHaveBeenCalledTimes(1);
    });

    it("an answer that arrives after slugOf already cached one does not overwrite it", async () => {
      let release!: (v: string) => void;
      const asyncGit = vi.fn(() => new Promise<string>((r) => (release = r)));
      const id = new RepoIdentity({ git: () => "git@github.com:acme/fresh.git", asyncGit, exists: () => true });
      const w = id.warm(["/r"]);
      expect(id.slugOf("/r")).toBe("acme/fresh");
      release("git@github.com:acme/stale.git");
      await w;
      expect(id.slugOf("/r")).toBe("acme/fresh");
    });

    it("the default asynchronous git reads the real origin, and knows a repo without one", async () => {
      const [withOrigin, without] = [makeRepo(), makeRepo()];
      execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/real.git"], { cwd: withOrigin });
      const git = vi.fn(() => "git@github.com:acme/blocking.git");
      const id = new RepoIdentity({ git });
      await id.warm([withOrigin, without]);
      expect([id.slugOf(withOrigin), id.slugOf(without)]).toEqual(["acme/real", null]);
      expect(git).not.toHaveBeenCalled();
    });
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
