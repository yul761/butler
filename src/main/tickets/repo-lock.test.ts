import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRepo, tempDir } from "../test-utils";
import { KeyedMutex, repoLockKey } from "./repo-lock";

/** 一个手动放行的 promise。 */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("KeyedMutex", () => {
  it("runs work on the same key one at a time, in arrival order", async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const g1 = gate();
    const a = m.run("k", async () => {
      order.push("a:start");
      await g1.p;
      order.push("a:end");
    });
    const b = m.run("k", async () => {
      order.push("b:start");
      order.push("b:end");
    });
    const c = m.run("k", async () => {
      order.push("c");
    });
    await tick();
    expect(order).toEqual(["a:start"]);
    g1.open();
    await Promise.all([a, b, c]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c"]);
    expect(m.held("k")).toBe(false);
  });

  it("does not make different keys wait for each other", async () => {
    const m = new KeyedMutex();
    const g1 = gate();
    const started: string[] = [];
    const a = m.run("repo-a", async () => {
      started.push("a");
      await g1.p;
    });
    const b = m.run("repo-b", async () => {
      started.push("b");
    });
    await b;
    expect(started).toEqual(["a", "b"]);
    expect(m.held("repo-a")).toBe(true);
    g1.open();
    await a;
    expect(m.held("repo-a")).toBe(false);
  });

  it("keeps going after a failed holder, and passes the result and the error through", async () => {
    const m = new KeyedMutex();
    const failed = m.run("k", async () => {
      throw new Error("boom");
    });
    const next = m.run("k", async () => 42);
    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe(42);
    expect(m.held("k")).toBe(false);
  });
});

describe("repoLockKey", () => {
  it("gives a repo's worktrees and subdirectories the main repo's key, and other repos their own", async () => {
    const repo = makeRepo();
    const wt = join(tempDir("shipherd-wt-"), "wt");
    execFileSync("git", ["worktree", "add", "-q", "--detach", wt], { cwd: repo, stdio: "ignore" });
    mkdirSync(join(repo, "sub"));
    const key = await repoLockKey(repo);
    expect(await repoLockKey(wt)).toBe(key);
    expect(await repoLockKey(join(repo, "sub"))).toBe(key);
    expect(await repoLockKey(makeRepo())).not.toBe(key);
  });

  it.skipIf(process.platform === "win32")("resolves a symlinked path to the real directory", async () => {
    const repo = makeRepo();
    const link = join(tempDir("shipherd-link-"), "link");
    symlinkSync(repo, link);
    expect(await repoLockKey(link)).toBe(await repoLockKey(repo));
  });

  it("falls back to the directory itself outside a repo", async () => {
    const dir = tempDir("shipherd-plain-");
    expect(await repoLockKey(dir)).toBe(process.platform === "win32" ? dir.toLowerCase() : dir);
  });
});
