import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, test, openLessonsAdvanced } from "./fixtures";

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

  await openLessonsAdvanced(page);
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

/** 插一条规矩（可以带分数和来源 PR）；返回 id。 */
function addLesson(db: DatabaseSync, text: string, o: { status?: string; score?: number; parts?: unknown; prs?: number[] } = {}): number {
  const now = Date.now();
  const prs = o.prs ?? [];
  const id = Number(
    db
      .prepare("INSERT INTO lessons (repo_slug, text, why, status, hits, last_seen_at, created_at, updated_at, score, score_parts, score_policy_version, scored_at) VALUES ('acme/web', ?, 'because', ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(text, o.status ?? "pending", Math.max(1, prs.length), now, now, now, o.score ?? null, o.parts === undefined ? null : JSON.stringify(o.parts), o.score === undefined ? null : 1, o.score === undefined ? null : now).lastInsertRowid,
  );
  for (const pr of prs) db.prepare("INSERT INTO lesson_sources (lesson_id, pr_number, url, at) VALUES (?, ?, ?, ?)").run(id, pr, `https://github.com/acme/web/pull/${pr}`, now);
  return id;
}

test("a lesson's score parts expand to show each part and the policy version", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  const db = new DatabaseSync(join(s.butlerHome, "app.db"));
  db.prepare("INSERT INTO lesson_repos (slug, local_path, created_at) VALUES (?, ?, ?)").run("acme/web", s.repo, Date.now());
  const id = addLesson(db, "错误信息要说清楚下一步", { score: 0.62, parts: { evidence: { value: 0.8, reason: "2 个 PR" }, clarity: { value: 0.5, reason: "范围有点宽" }, composite: { value: 0.62, reason: "准入线 0.70" } } });
  db.close();
  await page.reload();

  await openLessonsAdvanced(page);
  await page.getByTestId("lessons-repo-acme/web").click();
  await expect(page.getByTestId(`lesson-score-parts-${id}`)).toHaveCount(0);
  await page.getByTestId(`lesson-score-toggle-${id}`).click();
  await expect(page.getByTestId(`lesson-score-part-${id}-evidence`)).toContainText(`${S.scorePartLabel.evidence} 0.80`);
  await expect(page.getByTestId(`lesson-score-part-${id}-clarity`)).toContainText("范围有点宽");
  await expect(page.getByTestId(`lesson-score-part-${id}-composite`)).toContainText("准入线 0.70");
  await expect(page.getByTestId(`lesson-score-policy-${id}`)).toHaveText(S.lessonScorePolicy(1));
  await page.getByTestId(`lesson-score-toggle-${id}`).click();
  await expect(page.getByTestId(`lesson-score-parts-${id}`)).toHaveCount(0);
});

test("the calibration page draws a sample per band and records each mark as a sample", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  const file = join(s.butlerHome, "app.db");
  const db = new DatabaseSync(file);
  db.prepare("INSERT INTO lesson_repos (slug, local_path, created_at) VALUES (?, ?, ?)").run("acme/web", s.repo, Date.now());
  const high = addLesson(db, "高分的规矩", { score: 0.9 });
  const low = addLesson(db, "低分的规矩", { score: 0.1 });
  db.close();
  await page.reload();

  await openLessonsAdvanced(page);
  await page.getByTestId("lessons-page-tab-calibration").click();
  await expect(page.getByTestId("calibration-at")).toHaveText(S.calibrationNever);
  await page.getByTestId("calibration-draw").click();
  await expect(page.getByTestId(`calibration-item-${high}`)).toContainText(S.calibrationBand.high);
  await expect(page.getByTestId(`calibration-item-${low}`)).toContainText(S.calibrationAuto.reject);
  await page.getByTestId(`calibration-mark-${high}-good`).click();
  await expect(page.getByTestId(`calibration-mark-${high}-good`)).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId(`calibration-mark-${low}-good`).click();
  // 改判：同一批里后判的替掉先判的。
  await page.getByTestId(`calibration-mark-${low}-bad`).click();
  await expect(page.getByTestId(`calibration-mark-${low}-bad`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("calibration-band-high")).toContainText("100%");
  await expect(page.getByTestId("calibration-agreement")).toHaveText(S.calibrationAgreement("100%"));
  await page.getByTestId("calibration-mark-calibrated").click();
  await expect(page.getByTestId("calibration-at")).not.toHaveText(S.calibrationNever);

  const after = new DatabaseSync(file);
  const rows = after.prepare("SELECT lesson_id, auto_verdict, human_verdict, source FROM score_calibration ORDER BY lesson_id").all();
  after.close();
  expect(rows).toEqual([
    { lesson_id: high, auto_verdict: "admit", human_verdict: "admit", source: "review" },
    { lesson_id: low, auto_verdict: "reject", human_verdict: "reject", source: "review" },
  ]);
});

test("the setup wizard picks up after a restart, summarises, and its accept is undone as one batch", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const first = await launch(s);
  await completeWizard(first.page, s);
  await first.app.close();

  // 上次关掉时向导正在判规矩。
  const file = join(s.butlerHome, "app.db");
  const db = new DatabaseSync(file);
  const now = Date.now();
  db.prepare("INSERT INTO lesson_repos (slug, local_path, created_at) VALUES (?, ?, ?)").run("acme/web", s.repo, now);
  const a = addLesson(db, "不要在 src 里留 console.log", { prs: [1, 2] });
  const b = addLesson(db, "错误信息要说清楚下一步", { prs: [3, 4] });
  const c = addLesson(db, "这个 helper 改个名", { prs: [5] });
  const runId = Number(db.prepare("INSERT INTO lesson_wizard_runs (scope_kind, repo_slug, state, created_at, updated_at) VALUES ('repo', 'acme/web', 'judging', ?, ?)").run(now, now).lastInsertRowid);
  db.close();

  const { page } = await launch(s);
  await openLessonsAdvanced(page);
  await page.getByTestId("lessons-page-tab-wizard").click();
  await page.getByTestId("wizard-scope").selectOption("repo:acme/web");
  await expect(page.getByTestId("wizard-run")).toHaveAttribute("data-state", "awaiting_accept", { timeout: 30_000 });
  await expect(page.getByTestId("wizard-summary-candidates")).toHaveText(S.wizardSummaryCandidates(3));
  // 文字规矩的线更严（0.80）：b 的 0.79 被搁置，可以拉回来。
  await expect(page.getByTestId("wizard-summary-admitted")).toHaveText(S.wizardSummaryAdmitted(0, 1));
  await expect(page.getByTestId("wizard-summary-not-backtested")).toBeVisible();
  await expect(page.getByTestId("wizard-shelved-generality")).toBeVisible();
  const status = () => {
    const d = new DatabaseSync(file);
    const rows = d.prepare("SELECT id, status FROM lessons ORDER BY id").all() as { id: number; status: string }[];
    const samples = d.prepare("SELECT lesson_id, auto_verdict, human_verdict FROM score_calibration").all();
    d.close();
    return { lessons: rows.map((r) => [r.id, r.status]), samples };
  };
  await page.getByTestId("wizard-shelved-low_score").locator("summary").click();
  await page.getByTestId(`wizard-pull-${b}`).click();
  await expect.poll(() => status().lessons).toEqual([[a, "pending"], [b, "confirmed"], [c, "pending"]]);
  expect(status().samples).toEqual([{ lesson_id: b, auto_verdict: "shelve", human_verdict: "admit" }]);

  await page.getByTestId("wizard-accept").click();
  await expect(page.getByTestId("wizard-run")).toHaveAttribute("data-state", "accepted");
  expect(status().lessons).toEqual([[a, "confirmed"], [b, "confirmed"], [c, "pending"]]);
  expect(runId).toBeGreaterThan(0);

  // 撤销接受只撤这一批：拉回来的 b 不动。
  await page.getByTestId("wizard-undo-accept").click();
  await expect(page.getByTestId("wizard-accepted")).toContainText(S.wizardUndone);
  expect(status().lessons).toEqual([[a, "pending"], [b, "confirmed"], [c, "pending"]]);
});
