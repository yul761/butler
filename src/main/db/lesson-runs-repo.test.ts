import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { capHead, capTail, LessonRunsRepo, RUN_CAPS, RUN_MAX_AGE_MS, RUNS_PER_PR, RUNS_WITH_BODY } from "./lesson-runs-repo";

const DAY = 86_400_000;

function setup() {
  const db = memDb();
  db.prepare(`INSERT INTO lesson_repos (slug, local_path, created_at) VALUES ('acme/app', '/r/app', 1)`).run();
  db.prepare(`INSERT INTO lesson_repos (slug, local_path, created_at) VALUES ('acme/api', '/r/api', 1)`).run();
  return { db, runs: new LessonRunsRepo(db) };
}
const mk = (runs: LessonRunsRepo, at: number, over: { slug?: string; pr?: number; finish?: boolean; material?: string } = {}) => {
  const id = runs.start({ queueId: null, slug: over.slug ?? "acme/app", prNumber: over.pr ?? 1, origin: "merged", startedAt: at });
  if (over.finish !== false) runs.finish(id, { status: "done", reason: null, finishedAt: at + 1, material: over.material ?? "m", rawOutput: "r" });
  return id;
};
const lone = (s: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

describe("LessonRunsRepo", () => {
  it("start then finish stores every field", () => {
    const { runs } = setup();
    const id = runs.start({ queueId: null, slug: "acme/app", prNumber: 7, origin: "daily", startedAt: 100 });
    expect(runs.get(id)).toMatchObject({ status: "running", finishedAt: null, trimmed: false, findings: null, created: 0 });
    runs.finish(id, {
      status: "failed", reason: "claude_error", finishedAt: 200, message: "boom", stderrTail: "err", ghStderr: "gh", prTitle: "T", prUrl: "https://x/pull/7",
      material: "mat", rawOutput: "raw", findings: [{ a: 1 }], created: 1, hit: 2, dropped: 3, model: "opus", costUsd: 0.5, inputTokens: 10, outputTokens: 20, durationMs: 99,
      requestedTier: "mid", actualModel: "corp-low", fallbackFrom: "corp-mid",
    });
    expect(runs.get(id)).toEqual({
      id, queueId: null, slug: "acme/app", prNumber: 7, origin: "daily", status: "failed", reason: "claude_error", message: "boom", stderrTail: "err", ghStderr: "gh",
      prTitle: "T", prUrl: "https://x/pull/7", material: "mat", rawOutput: "raw", findings: [{ a: 1 }], trimmed: false, created: 1, hit: 2, dropped: 3,
      model: "opus", costUsd: 0.5, inputTokens: 10, outputTokens: 20, durationMs: 99, startedAt: 100, finishedAt: 200,
      requestedTier: "mid", actualModel: "corp-low", fallbackFrom: "corp-mid",
    });
    expect(runs.get(999)).toBeNull();
  });

  it("finish caps message, stderr tail and material", () => {
    const { runs } = setup();
    const id = mk(runs, 1, { finish: false });
    runs.finish(id, {
      status: "failed", reason: "error", finishedAt: 2,
      message: "A".repeat(5000) + "Z", stderrTail: "S" + "B".repeat(9000) + "END", material: "HEAD" + "m".repeat(70000),
    });
    const r = runs.get(id)!;
    expect(r.message!.startsWith("AAAA")).toBe(true);
    expect(r.message).toMatch(/\n\[… 1001 chars cut\]$/);
    expect(r.message!.length).toBeLessThan(RUN_CAPS.message + 40);
    expect(r.stderrTail!.endsWith("BBBEND")).toBe(true);
    expect(r.stderrTail).toMatch(/^\[… \d+ chars cut\]\n/);
    expect(r.material!.startsWith("HEAD")).toBe(true);
    expect(r.material).toMatch(/\[… \d+ chars cut\]$/);
  });

  it("capHead and capTail never split a surrogate pair", () => {
    const s = "😀".repeat(5000);
    for (const out of [capHead(s, 4001), capTail(s, 4001)]) {
      expect(lone(out)).toBe(false);
      expect(out).toMatch(/chars cut\]/);
    }
    expect(capHead("abc", 3)).toBe("abc");
    expect(capTail("abc", 3)).toBe("abc");
    expect(capHead("abcdef", 4)).toBe("abcd\n[… 2 chars cut]");
    expect(capTail("abcdef", 4)).toBe("[… 2 chars cut]\ncdef");
  });

  it("invalid findings JSON reads back as null", () => {
    const { db, runs } = setup();
    const id = mk(runs, 1);
    db.prepare(`UPDATE lesson_runs SET findings_json = '{nope' WHERE id = ?`).run(id);
    expect(runs.get(id)!.findings).toBeNull();
  });

  it("abortRunning marks running rows aborted with app_quit", () => {
    const { runs } = setup();
    const a = mk(runs, 1, { finish: false });
    const b = mk(runs, 2);
    expect(runs.abortRunning(50)).toBe(1);
    expect(runs.get(a)).toMatchObject({ status: "aborted", reason: "app_quit", finishedAt: 50 });
    expect(runs.get(b)!.status).toBe("done");
  });

  it("forPr lists newest first and recentFinished orders by finished_at", () => {
    const { runs } = setup();
    const a = mk(runs, 10);
    const b = mk(runs, 20);
    mk(runs, 30, { pr: 2 });
    expect(runs.forPr("acme/app", 1).map((r) => r.id)).toEqual([b, a]);
    mk(runs, 5, { finish: false });
    expect(runs.recentFinished(10)).toHaveLength(3);
    // finished_at order differs from started_at order: c started last but finished first
    const x = mk(runs, 100, { finish: false });
    const y = mk(runs, 200, { finish: false });
    const z = mk(runs, 300, { finish: false });
    runs.finish(z, { status: "failed", reason: "timeout", finishedAt: 1000 });
    runs.finish(x, { status: "aborted", reason: "cancelled", finishedAt: 3000 });
    runs.finish(y, { status: "failed", reason: "gh", finishedAt: 2000 });
    expect(runs.recentFinished(3)).toEqual([
      { status: "aborted", reason: "cancelled" },
      { status: "failed", reason: "gh" },
      { status: "failed", reason: "timeout" },
    ]);
  });

  it("prune keeps the newest 3 runs per PR", () => {
    const { runs } = setup();
    const now = 1_000_000;
    const ids = [1, 2, 3, 4, 5].map((i) => mk(runs, now - i * 10));
    const other = mk(runs, now - 100, { pr: 2 });
    expect(runs.prune(now)).toEqual({ deleted: 2, trimmed: 0 });
    expect(RUNS_PER_PR).toBe(3);
    expect(ids.map((id) => runs.get(id) !== null)).toEqual([true, true, true, false, false]);
    expect(runs.get(other)).not.toBeNull();
  });

  it("prune deletes runs older than 90 days", () => {
    const { runs } = setup();
    const now = 200 * DAY;
    const old = mk(runs, now - RUN_MAX_AGE_MS - 1);
    const fresh = mk(runs, now - RUN_MAX_AGE_MS + 1, { pr: 2 });
    expect(runs.prune(now).deleted).toBe(1);
    expect(runs.get(old)).toBeNull();
    expect(runs.get(fresh)).not.toBeNull();
  });

  it("prune trims material and raw output beyond the newest 200 and sets trimmed", () => {
    const { runs } = setup();
    const now = 1_000_000;
    const ids = Array.from({ length: RUNS_WITH_BODY + 2 }, (_, i) => mk(runs, now - 1000 + i, { pr: i + 1 }));
    expect(runs.prune(now)).toEqual({ deleted: 0, trimmed: 2 });
    expect(runs.get(ids[0])).toMatchObject({ material: null, rawOutput: null, trimmed: true });
    expect(runs.get(ids[1])).toMatchObject({ material: null, trimmed: true });
    expect(runs.get(ids[2])).toMatchObject({ material: "m", rawOutput: "r", trimmed: false });
    expect(runs.prune(now)).toEqual({ deleted: 0, trimmed: 0 });
  });

  it("prune never touches running rows", () => {
    const { runs } = setup();
    const now = 300 * DAY;
    const old = mk(runs, 1, { finish: false });
    const ids = [1, 2, 3, 4].map((i) => mk(runs, now - i, { pr: 9, finish: false }));
    runs.prune(now);
    expect(runs.get(old)).not.toBeNull();
    for (const id of ids) expect(runs.get(id)).not.toBeNull();
  });

  it("prune keeps runs opened in Claude", () => {
    const { db, runs } = setup();
    const now = 1_000_000;
    const ids = [1, 2, 3, 4].map((i) => mk(runs, now - i * 10));
    db.prepare(`INSERT INTO sessions (id, cwd, origin, created_at, lesson_run_id) VALUES ('s', '/w', 'butler', 1, ?)`).run(ids[3]);
    expect(runs.prune(now).deleted).toBe(0);
    expect(runs.get(ids[3])).not.toBeNull();
  });

  it("deleting a run nulls lesson_sources.run_id and lesson_queue.last_run_id", () => {
    const { db, runs } = setup();
    const id = mk(runs, 1);
    db.prepare(`INSERT INTO lessons (id, repo_slug, text, why, status, last_seen_at, created_at, updated_at) VALUES (1, 'acme/app', 't', 'w', 'confirmed', 1, 1, 1)`).run();
    db.prepare(`INSERT INTO lesson_sources (lesson_id, pr_number, url, at, run_id) VALUES (1, 1, NULL, 1, ?)`).run(id);
    db.prepare(`INSERT INTO lesson_queue (repo_slug, pr_number, origin, status, enqueued_at, last_run_id) VALUES ('acme/app', 1, 'merged', 'done', 1, ?)`).run(id);
    db.prepare(`DELETE FROM lesson_runs WHERE id = ?`).run(id);
    expect(db.prepare(`SELECT run_id FROM lesson_sources`).get()).toEqual({ run_id: null });
    expect(db.prepare(`SELECT last_run_id FROM lesson_queue`).get()).toEqual({ last_run_id: null });
  });
});
