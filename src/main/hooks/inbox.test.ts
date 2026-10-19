import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HookEnvelope } from "../../shared/hook-envelope";
import { tempDir } from "../test-utils";
import { HookInbox, MAX_HANDLE_ATTEMPTS } from "./inbox";

const envelope = (n: number) => JSON.stringify({ v: 1, receivedAt: n, ticket: null, butlerSession: null, payload: { n } });

describe("HookInbox.drain", () => {
  it("handles files in name order, deletes them, quarantines bad ones after retries, skips .tmp", async () => {
    const root = tempDir();
    const dir = join(root, "inbox");
    const bad = join(dir, "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "0002-a.json"), envelope(2));
    writeFileSync(join(dir, "0001-a.json"), envelope(1));
    writeFileSync(join(dir, "0003-a.json"), "{broken");
    writeFileSync(join(dir, "0004-a.json"), envelope(4));
    writeFileSync(join(dir, "0005-a.json.tmp"), envelope(5));

    const seen: number[] = [];
    const calls: number[] = [];
    const inbox = new HookInbox({
      dir, badDir: bad,
      handle: (e: HookEnvelope) => {
        calls.push(e.receivedAt);
        if (e.receivedAt === 4) throw new Error("handler failed");
        seen.push(e.receivedAt);
      },
    });
    expect(await inbox.drain()).toBe(2);
    expect(seen).toEqual([1, 2]);
    // 解析失败的 0003 立即进 bad/；handle 失败的 0004 留在 inbox 里等待重试。
    expect(readdirSync(dir).sort()).toEqual(["0004-a.json", "0005-a.json.tmp", "bad"]);
    expect(readdirSync(bad)).toEqual(["0003-a.json"]);
    for (let i = 1; i < MAX_HANDLE_ATTEMPTS; i++) await inbox.drain();
    expect(calls.filter((n) => n === 4)).toHaveLength(MAX_HANDLE_ATTEMPTS);
    expect(readdirSync(dir).sort()).toEqual(["0005-a.json.tmp", "bad"]);
    expect(readdirSync(bad).sort()).toEqual(["0003-a.json", "0004-a.json"]);
  });

  it("a handler that fails once and then succeeds applies the file and deletes it", async () => {
    const dir = join(tempDir(), "inbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "0001-a.json"), envelope(1));
    let fail = true;
    const seen: number[] = [];
    const inbox = new HookInbox({
      dir, badDir: join(dir, "bad"),
      handle: (e: HookEnvelope) => {
        if (fail) { fail = false; throw new Error("transient"); }
        seen.push(e.receivedAt);
      },
    });
    expect(await inbox.drain()).toBe(0);
    expect(existsSync(join(dir, "0001-a.json"))).toBe(true);
    expect(await inbox.drain()).toBe(1);
    expect(seen).toEqual([1]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("does not re-apply a file whose handle succeeded but whose unlink failed", async () => {
    const dir = join(tempDir(), "inbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "0001-a.json"), envelope(1));
    const log = vi.fn();
    let calls = 0;
    const inbox = new HookInbox({
      dir, badDir: join(dir, "bad"), log,
      handle: () => {
        calls++;
        // 让目录只读，使本次 unlink 失败。
        chmodSync(dir, 0o500);
      },
    });
    try {
      expect(await inbox.drain()).toBe(1);
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(log).toHaveBeenCalled();
    expect(await inbox.drain()).toBe(0);
    expect(calls).toBe(1);
    expect(existsSync(join(dir, "bad"))).toBe(false);
  });

  it("an overlapping drain waits for the in-flight run and the handler runs once", async () => {
    const dir = join(tempDir(), "inbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "0001-a.json"), envelope(1));
    let calls = 0;
    const inbox = new HookInbox({ dir, badDir: join(dir, "bad"), handle: () => { calls++; } });
    const [a, b] = await Promise.all([inbox.drain(), inbox.drain()]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(calls).toBe(1);
    expect(existsSync(join(dir, "0001-a.json"))).toBe(false);
  });

  it("never rejects on I/O failure and logs instead", async () => {
    const file = join(tempDir(), "not-a-dir");
    writeFileSync(file, "x");
    const log = vi.fn();
    const dir = join(file, "inbox");
    const inbox = new HookInbox({ dir, badDir: join(dir, "bad"), handle: () => undefined, log });
    await expect(inbox.drain()).resolves.toBe(0);
    expect(log).toHaveBeenCalled();
  });

  it("creates the directory if missing", async () => {
    const dir = join(tempDir(), "inbox");
    const inbox = new HookInbox({ dir, badDir: join(dir, "bad"), handle: () => undefined });
    expect(await inbox.drain()).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("HookInbox.start", () => {
  it("creates a missing dir and handles a file written afterwards", async () => {
    const dir = join(tempDir(), "inbox");
    const seen: number[] = [];
    const inbox = new HookInbox({
      dir, badDir: join(dir, "bad"), intervalMs: 50,
      handle: (e: HookEnvelope) => { seen.push(e.receivedAt); },
    });
    inbox.start();
    try {
      expect(existsSync(dir)).toBe(true);
      writeFileSync(join(dir, "0001-a.json"), envelope(1));
      const deadline = Date.now() + 3000;
      while (seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([1]);
    } finally {
      inbox.stop();
    }
  });
});
