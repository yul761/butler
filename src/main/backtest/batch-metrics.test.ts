import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { BacktestRepo } from "../db/backtest-repo";
import { backtestBatchMetrics } from "./batch-metrics";

function setup() {
  const db = memDb();
  db.prepare(`INSERT INTO lesson_repos (slug, local_path, created_at) VALUES ('acme/web', '/w', 1)`).run();
  const batch = Number(db.prepare(`INSERT INTO admission_batches (created_at, kind, origin, entity, scope, summary) VALUES (1, 'admission_plan', 'auto', 'lesson', '{}', '{}')`).run().lastInsertRowid);
  const lesson = (after: Record<string, unknown>) => {
    const id = Number(db.prepare(`INSERT INTO lessons (repo_slug, text, why, status, last_seen_at, created_at, updated_at) VALUES ('acme/web', 't', 'w', 'pending', 1, 1, 1)`).run().lastInsertRowid);
    db.prepare(`INSERT INTO admission_batch_items (batch_id, entity, entity_id, before, after) VALUES (?, 'lesson', ?, '{}', ?)`).run(batch, id, JSON.stringify({ id, ...after }));
    return id;
  };
  const backtest = (lessonId: number, def: string, slug: string, at: number, r: { comments: number; matched: number; hits: number; fp: number }) =>
    db.prepare(
      `INSERT INTO check_backtests (def_hash, sources_hash, material_key, lesson_id, repo_slug, status, hits, false_positives, comments, comments_matched, samples, created_at) VALUES (?, '', '', ?, ?, 'done', ?, ?, ?, ?, '{}', ?)`,
    ).run(def, lessonId, slug, r.hits, r.fp, r.comments, r.matched, at);
  const m = backtestBatchMetrics({ db, repo: new BacktestRepo(db) });
  return { db, batch, lesson, backtest, m };
}

describe("backtestBatchMetrics", () => {
  it("computes coverage over the batch's lessons", () => {
    const t = setup();
    t.lesson({ admission: "auto", status: "pending" });
    t.lesson({ admission: "shelved", shelved_reason: "covered" });
    t.lesson({ admission: "shelved", shelved_reason: "low_score" });
    t.lesson({ admission: "shelved", shelved_reason: "duplicate" });
    const withCheck = t.lesson({ admission: "shelved", shelved_reason: "backtest_fp" });
    t.db.prepare(`INSERT INTO checks (key, scope_kind, type, severity, mode, enabled, lesson_id, created_at, updated_at) VALUES ('k1', 'global', 'forbidden_pattern', 'block', 'enforce', 1, ?, 1, 1)`).run(withCheck);
    // auto + covered + 已有检查 = 3，重复的不算分母：3 / 4
    expect(t.m.metrics(t.batch)?.coverage).toBe(0.75);
  });

  it("sums the latest backtest of each admitted draft", () => {
    const t = setup();
    const a = t.lesson({ admission: "auto" });
    const b = t.lesson({ admission: "auto" });
    const shelved = t.lesson({ admission: "shelved", shelved_reason: "backtest_fp" });
    t.backtest(a, "old", "acme/web", 1, { comments: 10, matched: 0, hits: 50, fp: 50 });
    t.backtest(a, "new", "acme/web", 2, { comments: 4, matched: 2, hits: 10, fp: 1 });
    t.backtest(a, "new", "acme/api", 3, { comments: 2, matched: 1, hits: 0, fp: 0 });
    t.backtest(b, "b", "acme/web", 2, { comments: 4, matched: 3, hits: 10, fp: 2 });
    t.backtest(shelved, "s", "acme/web", 2, { comments: 4, matched: 0, hits: 10, fp: 9 });
    expect(t.m.metrics(t.batch)).toMatchObject({ backtestRecall: 0.6, backtestFalsePositives: 3, backtestFalsePositiveRate: 0.15 });
  });

  it("returns null for a batch without lessons and nulls without data", () => {
    const t = setup();
    expect(t.m.metrics(9999)).toBeNull();
    t.lesson({ admission: "auto" });
    expect(t.m.metrics(t.batch)).toMatchObject({ coverage: 1, backtestRecall: null, backtestFalsePositives: null, backtestFalsePositiveRate: null });
  });
});
