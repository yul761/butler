import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, test } from "./fixtures";

/**
 * 规矩质量与自动准入（工作流 D）。规矩直接插进 DB（后台分析走真 gh，e2e 不碰），模型是假的 claude。
 */
test("old lessons get their scope and checkability filled in, without analysing PRs again", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);

  const file = join(s.butlerHome, "app.db");
  const db = new DatabaseSync(file);
  const now = Date.now();
  db.prepare("INSERT INTO lesson_repos (slug, local_path, created_at) VALUES (?, ?, ?)").run("acme/web", s.repo, now);
  const ins = db.prepare("INSERT INTO lessons (repo_slug, text, why, status, hits, last_seen_at, created_at, updated_at) VALUES ('acme/web', ?, '', ?, 1, ?, ?, ?)");
  const a = Number(ins.run("不要留 console.log", "pending", now, now, now).lastInsertRowid);
  const b = Number(ins.run("错误信息要说清楚下一步", "confirmed", now, now, now).lastInsertRowid);
  db.close();
  await page.reload();

  await page.getByTestId("lessons-nav").click();
  await expect(page.getByTestId("lessons-enrich")).toHaveText(S.lessonEnrich(2));
  await page.getByTestId("lessons-enrich").click();
  await expect(page.getByTestId("lessons-enrich")).toHaveCount(0);
  await expect(page.getByTestId("lessons-enrich-running")).toHaveCount(0);

  const after = new DatabaseSync(file);
  const rows = after.prepare("SELECT id, status, scope_globs, checkability, enriched_at FROM lessons ORDER BY id").all() as { id: number; status: string; scope_globs: string; checkability: string; enriched_at: number | null }[];
  const batch = after.prepare("SELECT kind, origin FROM admission_batches ORDER BY id DESC LIMIT 1").get() as { kind: string; origin: string };
  const analyses = (after.prepare("SELECT COUNT(*) AS n FROM lesson_runs").get() as { n: number }).n;
  after.close();
  expect(rows.map((r) => [r.id, r.status, r.scope_globs, r.checkability])).toEqual([
    [a, "pending", '["src/**"]', "checkable"],
    [b, "confirmed", '["src/**"]', "prose"],
  ]);
  expect(rows.every((r) => r.enriched_at !== null)).toBe(true);
  expect(batch).toEqual({ kind: "lesson_enrich", origin: "auto" });
  expect(analyses).toBe(0);
});
