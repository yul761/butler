import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, test } from "./fixtures";

/**
 * 批量操作（契约 4.4）：按筛选一步确认 → 整批撤销；接受全部推荐；勾选几条拒绝；在批次历史里撤销。
 * 规矩直接插进 DB（后台分析走真 gh，e2e 不碰）。
 */
test("pending lessons are confirmed by filter in one action and the batch is undone", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);

  const db = new DatabaseSync(join(s.butlerHome, "app.db"));
  const now = Date.now();
  db.prepare("INSERT INTO lesson_repos (slug, local_path, created_at) VALUES (?, ?, ?)").run("acme/web", s.repo, now);
  const ins = db.prepare("INSERT INTO lessons (repo_slug, text, why, status, admission, hits, last_seen_at, created_at, updated_at) VALUES ('acme/web', ?, '', ?, ?, 1, ?, ?, ?)");
  const ids = [
    ["改 schema 要加迁移", "pending", "auto"],
    ["IPC 参数都要校验", "pending", "auto"],
    ["日志里不能有令牌", "pending", "pending"],
    ["别在渲染进程调 gh", "confirmed", "manual"],
  ].map(([text, status, admission]) => Number(ins.run(text, status, admission, now, now, now).lastInsertRowid));
  db.close();
  await page.reload();

  await page.getByTestId("lessons-nav").click();
  await page.getByTestId("lessons-repo-acme/web").click();
  const pending = page.locator(".lesson.pending");
  const confirmed = page.locator(".lesson.confirmed");
  await expect(pending).toHaveCount(3);
  await expect(confirmed).toHaveCount(1);

  // 1. 筛「准入：推荐」→ 全部确认（2）→ 一步确认两条。
  await page.getByTestId("bulk-admission-auto").check();
  await expect(page.getByTestId("bulk-matched")).toHaveText(S.bulkMatched(2));
  await expect(page.getByTestId("bulk-confirm")).toHaveText(S.bulkVerb.confirm(2));
  await page.getByTestId("bulk-confirm").click();
  await expect(page.getByTestId("lessons-notice-text")).toHaveText(S.bulkDone.confirm(2));
  await expect(confirmed).toHaveCount(3);
  await expect(pending).toHaveCount(1);

  // 2. 撤销整批：回到原样。
  await page.getByTestId("lessons-notice-undo").click();
  await expect(page.getByTestId("lessons-notice-text")).toHaveText(S.bulkUndone(2, 0));
  await expect(confirmed).toHaveCount(1);
  await expect(pending).toHaveCount(3);

  // 3. 接受全部推荐（2）：清掉筛选也只确认推荐的两条。
  await page.getByTestId("bulk-clear").click();
  await expect(page.getByTestId("bulk-accept_recommended")).toHaveText(S.bulkAcceptRecommended(2));
  await page.getByTestId("bulk-accept_recommended").click();
  await expect(confirmed).toHaveCount(3);
  await expect(page.getByTestId(`lesson-${ids[2]}`)).toHaveClass(/pending/);

  // 4. 勾选剩下那条，拒绝选中的。
  await page.getByTestId(`lesson-pick-${ids[2]}`).check();
  await page.getByTestId("pending-reject-selected").click();
  await expect(pending).toHaveCount(0);
  await expect(page.getByTestId("lessons-notice-text")).toHaveText(S.bulkDone.reject(1));

  // 5. 批次历史：最新的是拒绝，打开它撤销；再回规矩页，那条又回到待确认。
  await page.getByTestId("lessons-page-tab-batches").click();
  const rows = page.locator("[data-testid^='batch-open-']");
  await expect(rows.first()).toContainText(S.batchKind.reject);
  await rows.first().click();
  await expect(page.getByTestId("batch-detail")).toContainText("日志里不能有令牌");
  await page.getByTestId("batch-undo").click();
  await expect(page.getByTestId("batch-undo")).toHaveText(S.batchUndoArmed);
  await page.getByTestId("batch-undo").click();
  await expect(page.getByTestId("batch-message")).toHaveText(S.bulkUndone(1, 0));
  await expect(page.getByTestId("batch-undo")).toHaveCount(0);
  await page.getByTestId("lessons-page-tab-lessons").click();
  await expect(pending).toHaveCount(1);
  await expect(page.getByTestId(`lesson-${ids[2]}`)).toBeVisible();

  // 6. 已确认的勾两条，停用选中的。
  await page.getByTestId(`lesson-check-${ids[0]}`).check();
  await page.getByTestId(`lesson-check-${ids[3]}`).check();
  await page.getByTestId("confirmed-disable-selected").click();
  await expect(page.getByTestId("lessons-notice-text")).toHaveText(S.bulkDone.disable(2));
  await expect(page.getByTestId(`lesson-${ids[0]}`)).toHaveClass(/disabled/);
  await expect(page.getByTestId(`lesson-${ids[3]}`)).toHaveClass(/disabled/);
});
