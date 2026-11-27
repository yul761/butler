import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, openLessonsAdvanced, test } from "./fixtures";

/**
 * 规矩一条都不丢（BTL-274）：规矩页说每个仓库的规矩怎么送进 session，不再说「送不进去」；
 * 「找相似的规矩」交给假 claude 出合并建议，点「合并 N 条相似规矩」→「合并」记成一个批次；「转成检查」起草检查。
 */
test("the lessons page shows how each lesson reaches a session, merges similar ones and turns one into a check", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);

  const file = join(s.shipherdHome, "app.db");
  const db = new DatabaseSync(file);
  const now = Date.now();
  db.prepare("INSERT INTO lesson_repos (slug, local_path, created_at) VALUES (?, ?, ?)").run("acme/web", s.repo, now);
  const ins = db.prepare("INSERT INTO lessons (repo_slug, text, why, status, hits, last_seen_at, created_at, updated_at, checkability) VALUES ('acme/web', ?, '', 'confirmed', ?, ?, ?, ?, ?)");
  const a = Number(ins.run("re-read the row inside the write transaction before saving", 1, now, now, now, null).lastInsertRowid);
  const b = Number(ins.run("re-read the row inside the write transaction before writing back", 3, now, now, now, null).lastInsertRowid);
  const c = Number(ins.run("never leave console.log in src", 1, now, now, now, "checkable").lastInsertRowid);
  db.close();
  await page.reload();

  await page.getByTestId("lessons-nav").click();
  const row = page.getByTestId("lessons-delivery-acme/web");
  await expect(row).toContainText(S.lessonsDeliveryLine({ full: 3, principle: 0, index: 0, drip: 0, check: 0 }));
  await expect(page.getByText(/送不进去|can't be sent/)).toHaveCount(0);

  // 找相似的：a、b 字面相似，c 不像；建议出来以后按钮上是 2 条。
  await page.getByTestId("lessons-merge-find").click();
  const mergeBtn = page.getByTestId("lessons-merge-similar");
  await expect(mergeBtn).toHaveText(S.lessonsMergeSimilar(2));
  await mergeBtn.click();
  const proposal = page.locator("[data-testid^='lessons-merge-proposal-']");
  await expect(proposal).toHaveCount(1);
  await expect(proposal).toContainText("合并：re-read the row inside the write transaction before saving");
  await proposal.locator("[data-testid^='lessons-merge-accept-']").click();
  await expect(mergeBtn).toHaveCount(0);
  await expect(row).toContainText(S.lessonsDeliveryLine({ full: 2, principle: 0, index: 0, drip: 0, check: 0 }));

  const after = new DatabaseSync(file);
  const rows = after.prepare("SELECT id, text, merged_into FROM lessons ORDER BY id").all() as { id: number; text: string; merged_into: number | null }[];
  const batch = after.prepare("SELECT kind, origin FROM admission_batches ORDER BY id DESC LIMIT 1").get() as { kind: string; origin: string };
  after.close();
  // 保留出现次数多的 b，a 合进去。
  expect(rows.find((r) => r.id === a)?.merged_into).toBe(b);
  expect(rows.find((r) => r.id === b)?.text).toBe("合并：re-read the row inside the write transaction before saving");
  expect(batch.kind).toBe("merge_similar");

  // 每条规矩上标着怎么送到。
  await openLessonsAdvanced(page);
  await page.getByTestId("lessons-repo-acme/web").click();
  await expect(page.getByTestId(`lesson-delivery-${b}`)).toHaveText(S.lessonDelivery.full);
  await expect(page.getByTestId(`lesson-delivery-${c}`)).toHaveText(S.lessonDelivery.full);

  // 转成检查：c 能写成检查，起草以后到检查标签页。
  await page.getByTestId("lessons-to-check").click();
  await expect(page.getByTestId(`lessons-to-check-${a}`)).toHaveCount(0);
  await page.getByTestId(`lessons-to-check-make-${c}`).click();
  await expect(page.getByTestId("lessons-page-tab-checks")).toHaveAttribute("aria-selected", "true");
});
