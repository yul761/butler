import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { workerEvaluator } from "./evaluator";
import type { EvalInput, EvalOutput } from "./evaluate";

const input = { check: { type: "forbidden_pattern", params: {}, globs: [], excludeGlobs: [] }, ticketPattern: "", tolerance: 3, prs: [], prComments: {}, sources: [] } as EvalInput;
const out = { prs: 0, hits: 0, matched: 0, unmatched: [], unmatchedTotal: 0, comments: 0, commentsMatched: 0, caught: [], missed: [] } as EvalOutput;

function fakeWorker() {
  const w = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 0) });
  return w as typeof w & Worker;
}

describe("workerEvaluator", () => {
  it("returns the worker's answer and terminates it", async () => {
    const w = fakeWorker();
    const p = workerEvaluator(() => w)(input);
    w.emit("message", { ok: true, out });
    await expect(p).resolves.toEqual(out);
    expect(w.terminate).toHaveBeenCalled();
  });

  it("rejects on an error message, a crash and the timeout (a pathological regex)", async () => {
    const a = fakeWorker();
    const pa = workerEvaluator(() => a)(input);
    a.emit("message", { ok: false, error: "bad regex" });
    await expect(pa).rejects.toThrow("bad regex");
    const b = fakeWorker();
    const pb = workerEvaluator(() => b)(input);
    b.emit("exit", 1);
    await expect(pb).rejects.toThrow("exited");
    const c = fakeWorker();
    await expect(workerEvaluator(() => c, 10)(input)).rejects.toThrow("timed out");
    expect(c.terminate).toHaveBeenCalled();
  });
});
