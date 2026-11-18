import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import type { Worker } from "node:worker_threads";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { BaselinesRepo } from "../db/baselines-repo";
import { BatchRecorder } from "../batches/batch-recorder";
import { checkAdapter, lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";
import { ChecksService } from "../checks/checks-service";
import { LegacyScanService } from "./legacy-service";
import { inProcessRunner, workerRunner, type JobRunner } from "./runner";
import { runJob, type JobMessage } from "./jobs";
import { legacyEvaluate } from "./legacy";
import { writeRepo } from "./test-repo";
import type { CheckInput } from "../../shared/checks";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  "src/a.ts": "import x from '../internal/secret';\r\nconsole.log(x);\r\n// TODO temporary hack\r\nexport const a = 1;\r\n",
  "src/b.ts": "export const b = 2;\nconsole.log(b); console.log(b);\n",
  "src/c.ts": "// TODO(ABC-12) tracked\nexport const c = 3;\n",
  "src/img.png": "\u0000\u0001binary console.log",
  "internal/secret.ts": "export default 1;\n",
  "docs/readme.md": "console.log in docs\n",
};

const input = (over: Partial<CheckInput>): CheckInput => ({
  type: "forbidden_pattern", name: "x", params: { pattern: "console\\.log" }, globs: ["src/**"], excludeGlobs: [], severity: "block", mode: "shadow", enabled: false, message: "", ...over,
});

function setup(runner: JobRunner = inProcessRunner, maxFiles = 50_000, files = FILES) {
  const root = writeRepo(files);
  roots.push(root);
  const db = memDb();
  const lessons = new LessonsRepo(db);
  lessons.upsertRepo("a/web", root, 1);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db), checkAdapter(db)]);
  let t = 1000;
  const now = () => ++t;
  const checks = new ChecksService({ db, lessons, recorder, now, config: () => ({ enabled: true, editTimeoutSec: 8, pushTimeoutSec: 60, ticketPattern: "[A-Z]+-\\d+" }) });
  const repo = new BaselinesRepo(db);
  const svc = new LegacyScanService({
    repo, checks, localPath: (s) => (s === "a/web" ? root : null), runner, now, config: () => ({ maxFiles, ticketPattern: "[A-Z]+-\\d+", editTimeoutSec: 8, pushTimeoutSec: 60 }),
  });
  const add = (over: Partial<CheckInput>, scope: { kind: "global" } | { kind: "repo"; slug: string } = { kind: "global" }) => {
    const r = checks.save(scope, null, input(over));
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.id!;
  };
  return { root, repo, svc, checks, add };
}

describe("legacy scan", () => {
  it("counts a forbidden pattern across the repo with lines, CRLF included, skipping binaries", async () => {
    const { svc, add } = setup();
    const id = add({});
    const r = await svc.run(id, "a/web");
    // 一行一处（和 hook 一样），二进制文件不看。
    expect(r).toMatchObject({ ok: true, scan: { status: "done", count: 2, filesTotal: 4, filesScanned: 4 } });
    const scan = (r as { scan: { scanId: number; checkKey: string } }).scan;
    expect(svc.violations(scan.scanId, 0, 10)).toEqual([
      { file: "src/a.ts", line: 2, snippet: "console.log(x);" },
      { file: "src/b.ts", line: 2, snippet: "console.log(b); console.log(b);" },
    ]);
    expect(svc.violations(scan.scanId, 1, 10)).toHaveLength(1);
    expect(svc.latest(scan.checkKey, "a/web")).toMatchObject({ count: 2, status: "done", scanId: scan.scanId });
  });

  it("covers import boundaries and the comment policy the same way the hook does", async () => {
    const { svc, add } = setup();
    const ib = await svc.run(add({ type: "import_boundary", params: { forbid: ["internal/**"] } }), "a/web");
    expect(ib).toMatchObject({ ok: true, scan: { count: 1 } });
    const cp = await svc.run(add({ type: "comment_policy", params: {} }), "a/web");
    expect(cp).toMatchObject({ ok: true, scan: { count: 1 } });
    const v = svc.violations((cp as { scan: { scanId: number } }).scan.scanId, 0, 5);
    expect(v).toEqual([{ file: "src/a.ts", line: 3, snippet: "// TODO temporary hack" }]);
    expect(legacyEvaluate({ type: "comment_policy", params: {}, globs: [], excludeGlobs: [] }, "x.ts", "﻿// hack\r\n", "[A-Z]+-\\d+")).toEqual([{ file: "x.ts", line: 1, snippet: "// hack" }]);
  });

  it("uses the repo layer's version of a check", async () => {
    const { svc, add, checks } = setup();
    const id = add({});
    const key = checks.repo.get(id)!.key;
    // 仓库层把同一个 key 覆盖成找 export。
    checks.repo.insert({ kind: "repo", slug: "a/web" }, key, input({ params: { pattern: "^export" } }), { lessonId: null, now: 5 });
    const r = await svc.run(id, "a/web");
    expect(r).toMatchObject({ ok: true, scan: { count: 3 } });
  });

  it.skipIf(process.platform === "win32")("runs a per-file command for each file and a push command once", async () => {
    const { svc, add } = setup();
    const edit = await svc.run(add({ type: "run_command", params: { command: 'grep -q "console" "$1" && exit 1 || exit 0', stage: "edit" }, globs: ["src/**/*.ts"] }), "a/web");
    expect(edit).toMatchObject({ ok: true, scan: { count: 2, filesScanned: 3 } });
    const v = svc.violations((edit as { scan: { scanId: number } }).scan.scanId, 0, 10);
    expect(v.map((x) => x.file).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    const push = await svc.run(add({ type: "run_command", params: { command: "echo broken >&2; exit 3", stage: "push" }, globs: [] }), "a/web");
    expect(push).toMatchObject({ ok: true, scan: { count: 1 } });
    expect(svc.violations((push as { scan: { scanId: number } }).scan.scanId, 0, 10)).toEqual([{ file: ".", line: null, snippet: "broken" }]);
  });

  it("truncates at the file limit and replaces older scans of the same pair", async () => {
    const { svc, add, repo } = setup(inProcessRunner, 2);
    const id = add({});
    const first = await svc.run(id, "a/web");
    expect(first).toMatchObject({ ok: true, scan: { status: "truncated", filesTotal: 2, filesScanned: 2 } });
    const second = await svc.run(id, "a/web");
    const s1 = (first as { scan: { scanId: number } }).scan.scanId;
    expect(repo.scan(s1)).toBeNull();
    expect(svc.views()).toHaveLength(1);
    expect((second as { scan: { scanId: number } }).scan.scanId).toBeGreaterThan(s1);
  });

  it("refuses unknown checks, repos without a copy and a second run of the same pair", async () => {
    const { svc, add } = setup();
    expect(await svc.run(999, "a/web")).toMatchObject({ ok: false });
    const id = add({});
    expect(await svc.run(id, "a/none")).toMatchObject({ ok: false });
    const p = svc.run(id, "a/web");
    expect(svc.start(id, "a/web")).toMatchObject({ ok: false });
    await p;
  });

  it("keeps a cancelled scan's partial result", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 450; i++) many[`src/f${i}.ts`] = "console.log(1);\n";
    const { svc, add } = setup(inProcessRunner, 50_000, many);
    const id = add({});
    const p = svc.run(id, "a/web");
    const scanId = svc.views()[0].scanId;
    expect(svc.isRunning(scanId)).toBe(true);
    expect(svc.cancel(scanId)).toBe(true);
    const r = await p;
    expect(r).toMatchObject({ ok: true, scan: { status: "cancelled" } });
    expect((r as { scan: { filesScanned: number } }).scan.filesScanned).toBeLessThan(450);
    expect(svc.cancel(scanId)).toBe(false);
  });

  it("marks a scan failed with the file it stalled on, and interrupted scans on startup", async () => {
    const stalling: JobRunner = (_job, on) => {
      on({ type: "progress", filesTotal: 4, filesScanned: 1, count: 0, file: "src/b.ts" });
      return { done: Promise.resolve({ kind: "stalled", lastFile: "src/b.ts" }), cancel: () => {} };
    };
    const { svc, add, repo } = setup(stalling);
    const r = await svc.run(add({}), "a/web");
    expect(r).toMatchObject({ ok: true, scan: { status: "failed" } });
    expect((r as { scan: { error: string } }).scan.error).toContain("src/b.ts");
    const sid = repo.startScan(null, "k", "a/web", 1);
    expect(svc.recover()).toBe(1);
    expect(repo.scan(sid)).toMatchObject({ status: "failed" });
  });
});

/** 假的 worker：跑同一份 runJob，或者什么都不发（卡住）。 */
class FakeWorker extends EventEmitter {
  terminated = false;
  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

describe("worker runner", () => {
  it("forwards messages and finishes on the result", async () => {
    const w = new FakeWorker();
    const run = workerRunner(() => w as unknown as Worker, 1000);
    const got: JobMessage[] = [];
    const h = run({ kind: "scan", root: "/x", files: [], truncated: false, rules: { markers: [], keywords: [], invalid: {}, origin: {} } }, (m) => got.push(m));
    await runJob({ kind: "scan", root: "/x", files: [], truncated: false, rules: { markers: [], keywords: [], invalid: {}, origin: {} } }, (m) => w.emit("message", m));
    expect(await h.done).toEqual({ kind: "finished" });
    expect(got.map((m) => m.type)).toEqual(["scan"]);
    expect(w.terminated).toBe(true);
  });

  it("stops a worker that goes quiet and reports the last file", async () => {
    const w = new FakeWorker();
    const run = workerRunner(() => w as unknown as Worker, 30);
    const h = run({ kind: "legacy", root: "/x", files: [], check: { type: "forbidden_pattern", params: {}, globs: [], excludeGlobs: [] }, ticketPattern: "", maxFiles: 1, timeoutMs: 10, env: {} }, () => {});
    w.emit("message", { type: "progress", filesTotal: 9, filesScanned: 3, count: 0, file: "src/slow.ts" });
    expect(await h.done).toEqual({ kind: "stalled", lastFile: "src/slow.ts" });
    expect(w.terminated).toBe(true);
  });

  it("waits longer than the command timeout for a whole-repo command, and handles cancel and crashes", async () => {
    const w = new FakeWorker();
    const run = workerRunner(() => w as unknown as Worker, 10);
    const h = run({ kind: "legacy", root: "/x", files: [], check: { type: "run_command", params: { stage: "push" }, globs: [], excludeGlobs: [] }, ticketPattern: "", maxFiles: 1, timeoutMs: 40, env: {} }, () => {});
    let ended = false;
    void h.done.then(() => (ended = true));
    await new Promise((r) => setTimeout(r, 25));
    expect(ended).toBe(false);
    h.cancel();
    expect(await h.done).toEqual({ kind: "cancelled" });
    const w2 = new FakeWorker();
    const h2 = workerRunner(() => w2 as unknown as Worker, 1000)({ kind: "scan", root: "/x", files: [], truncated: false, rules: { markers: [], keywords: [], invalid: {}, origin: {} } }, () => {});
    w2.emit("error", new Error("boom"));
    expect(await h2.done).toEqual({ kind: "crashed", message: "boom" });
  });
});
