import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeRepo, tempDir } from "../test-utils";
import { KeyedMutex, LockReentryError, LockWaitTimeoutError, repoLockKey } from "./repo-lock";

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

  it("throws instead of hanging when a holder takes the same key again; other keys and other mutexes are fine", async () => {
    const m = new KeyedMutex();
    const other = new KeyedMutex();
    const r = await m.run("k", async () => {
      await expect(m.run("k", async () => 1, "inner")).rejects.toBeInstanceOf(LockReentryError);
      return (await m.run("j", async () => 2)) + (await other.run("k", async () => 3));
    });
    expect(r).toBe(5);
    expect(m.held("k")).toBe(false);
  });

  it("does not count async work started inside the lock but run after it is released as reentry", async () => {
    const m = new KeyedMutex();
    const g = gate();
    let later!: Promise<number>;
    await m.run("k", async () => {
      later = g.p.then(() => m.run("k", async () => 7));
    });
    g.open();
    expect(await later).toBe(7);
  });

  it("logs who it is waiting for after warnAfterMs, and gives up after maxWaitMs without letting later waiters jump the holder", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const logs: string[] = [];
      const m = new KeyedMutex({ warnAfterMs: 30_000, maxWaitMs: 600_000, log: (l) => logs.push(l) });
      const g = gate();
      const order: string[] = [];
      const a = m.run("k", async () => {
        await g.p;
        order.push("a");
      }, "create PROJ-1");
      const b = m.run("k", async () => void order.push("b"), "switch PROJ-2").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/switch PROJ-2 has waited 30s; waiting for create PROJ-1/);
      const c = m.run("k", async () => void order.push("c"), "late");
      await vi.advanceTimersByTimeAsync(570_000);
      const err = (await b) as LockWaitTimeoutError;
      expect(err).toBeInstanceOf(LockWaitTimeoutError);
      expect(err.holder).toBe("create PROJ-1");
      expect(m.holder("k")).toBe("create PROJ-1");
      // c 排在放弃了的 b 后面：b 走了也要等 a 做完。
      expect(order).toEqual([]);
      g.open();
      await a;
      await c;
      expect(order).toEqual(["a", "c"]);
      expect(m.held("k")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

  it("gives repos whose git directories sit side by side (--separate-git-dir) their own keys", async () => {
    const gitDirs = tempDir("shipherd-gitdirs-");
    const [a, b] = ["a", "b"].map((n) => {
      const work = tempDir(`shipherd-sep-${n}-`);
      execFileSync("git", ["init", "-q", `--separate-git-dir=${join(gitDirs, n)}`, work], { stdio: "ignore" });
      return work;
    });
    expect(await repoLockKey(a!)).not.toBe(await repoLockKey(b!));
  });

  it("falls back to the directory itself outside a repo", async () => {
    const dir = tempDir("shipherd-plain-");
    expect(await repoLockKey(dir)).toBe(process.platform === "win32" ? dir.toLowerCase() : dir);
  });
});
