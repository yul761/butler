import { appendFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../test-utils";
import { DebouncedWatch, nodeWatch, type WatchFn } from "./transcript-watch";

/** 假的 fs.watch：记下每个监视器，测试里手动触发事件。 */
function fakeWatch() {
  const watchers: { file: string; emit: (type: "change" | "rename") => void; fail: (e: Error) => void; closed: boolean }[] = [];
  let missing = false;
  const watch: WatchFn = (file, onEvent, onError) => {
    if (missing) throw new Error("ENOENT");
    const w = { file, emit: onEvent, fail: onError, closed: false };
    watchers.push(w);
    return { close: () => void (w.closed = true) };
  };
  return { watch, watchers, setMissing: (v: boolean) => (missing = v), live: () => watchers.filter((w) => !w.closed) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DebouncedWatch (BTL-190 7)", () => {
  it("turns a burst of change events (macOS fires several for one write) into one call 300ms after the first", () => {
    vi.useFakeTimers();
    const f = fakeWatch();
    const onChange = vi.fn();
    const w = new DebouncedWatch("/t.jsonl", { delayMs: 300, onChange, watch: f.watch });
    expect(w.ensure()).toBe(true);
    const [x] = f.watchers;
    x.emit("change");
    x.emit("change");
    vi.advanceTimersByTime(200);
    x.emit("change");
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledTimes(1);
    // 一直在写也不会一直往后推：每 300ms 至少一次。
    for (let i = 0; i < 10; i++) {
      x.emit("change");
      vi.advanceTimersByTime(100);
    }
    expect(onChange).toHaveBeenCalledTimes(4);
    // 最后一次事件之后的那一次照样会来，然后就停了。
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(5);
  });

  it("ensure() keeps one watcher, and makes a new one after a rename (rotation) or an error", () => {
    vi.useFakeTimers();
    const f = fakeWatch();
    const onChange = vi.fn();
    const log = vi.fn();
    const w = new DebouncedWatch("/t.jsonl", { delayMs: 300, onChange, watch: f.watch, log });
    w.ensure();
    w.ensure();
    expect(f.live()).toHaveLength(1);
    // 轮转：旧的监视器看的是旧 inode，关掉；这次照样算一次变化，下一次 ensure 重新挂上。
    f.watchers[0].emit("rename");
    expect(f.live()).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(1);
    w.ensure();
    expect(f.live()).toHaveLength(1);
    f.watchers[1].fail(new Error("EPERM"));
    expect(f.live()).toHaveLength(0);
    expect(log).toHaveBeenCalledTimes(1);
    w.ensure();
    expect(f.live()).toHaveLength(1);
  });

  it("ensure() returns false while the file does not exist yet, and retries next time", () => {
    const f = fakeWatch();
    const w = new DebouncedWatch("/t.jsonl", { delayMs: 300, onChange: () => {}, watch: f.watch });
    f.setMissing(true);
    expect(w.ensure()).toBe(false);
    f.setMissing(false);
    expect(w.ensure()).toBe(true);
  });

  it("close() stops the watcher and a pending call; ensure() after close does nothing", () => {
    vi.useFakeTimers();
    const f = fakeWatch();
    const onChange = vi.fn();
    const w = new DebouncedWatch("/t.jsonl", { delayMs: 300, onChange, watch: f.watch });
    w.ensure();
    f.watchers[0].emit("change");
    w.close();
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
    expect(f.live()).toHaveLength(0);
    expect(w.ensure()).toBe(false);
    expect(f.watchers).toHaveLength(1);
  });

  it("nodeWatch sees appends to a real file and survives the file being replaced", async () => {
    const dir = tempDir("butler-watch-");
    const file = join(dir, "t.jsonl");
    writeFileSync(file, "a\n");
    let calls = 0;
    const w = new DebouncedWatch(file, { delayMs: 20, onChange: () => calls++, watch: nodeWatch });
    /** macOS 上刚挂上的监视器可能漏掉紧跟着的那次写：每 100ms 追加一行，直到看到变化。 */
    const appendUntilSeen = async (line: string) => {
      const before = calls;
      for (let i = 0; i < 30 && calls === before; i++) {
        appendFileSync(file, line);
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(calls).toBeGreaterThan(before);
    };
    try {
      expect(w.ensure()).toBe(true);
      await appendUntilSeen("b\n");
      const next = join(dir, "next.jsonl");
      writeFileSync(next, "c\n");
      rmSync(file);
      renameSync(next, file);
      const before = calls;
      await vi.waitFor(() => expect(calls).toBeGreaterThan(before), { timeout: 3000 });
      // 监视器跟着新文件重新挂上，之后的追加照样看得到。
      w.ensure();
      await appendUntilSeen("d\n");
    } finally {
      w.close();
    }
  });
});
