import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ElectronApplication } from "@playwright/test";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, test } from "./fixtures";

/** 文件选择框换成固定的路径（主进程里开的系统对话框 e2e 点不到，也不能抢焦点）。 */
async function stubDialogs(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: f })) as unknown as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as unknown as typeof dialog.showOpenDialog;
  }, file);
}

/**
 * 导入导出（契约 4.3）：从一个 BUTLER_HOME 导出，导入到另一个，先看预览（新增 / 冲突），再合并，最后整批撤销。
 */
test("an export imports into another BUTLER_HOME with a diff preview, and the import can be undone", async ({ makeSandbox, launch }) => {
  // 1. 第一个 Butler：一条已确认、一条待确认的规矩，全局准入策略改一个键（走设置页的编辑器）。
  const a = makeSandbox();
  const first = await launch(a);
  await completeWizard(first.page, a);
  let db = new DatabaseSync(join(a.butlerHome, "app.db"));
  const now = Date.now();
  db.prepare("INSERT INTO lesson_repos (slug, local_path, created_at) VALUES (?, ?, ?)").run("acme/web", a.repo, now);
  const ins = db.prepare("INSERT INTO lessons (repo_slug, text, why, status, admission, hits, last_seen_at, created_at, updated_at) VALUES ('acme/web', ?, '评审里提过', ?, 'manual', 2, ?, ?, ?)");
  ins.run("改 schema 要加迁移", "confirmed", now, now, now);
  ins.run("IPC 参数都要校验", "pending", now, now, now);
  db.close();
  await first.page.reload();

  await first.page.getByRole("button", { name: S.settings, exact: true }).click();
  const editor = first.page.getByTestId("policy-editor");
  await expect(editor.getByTestId("policy-uncalibrated")).toBeVisible();
  await editor.getByTestId("policy-input-score.admitLine").fill("0.8");
  await editor.getByTestId("policy-save").click();
  await expect(editor.getByTestId("policy-message")).toHaveText(S.policySaved);
  await expect(editor.getByTestId("policy-effective-score.admitLine")).toHaveText("0.8");

  const file = join(a.dir, "butler-export.json");
  await stubDialogs(first.app, file);
  await first.page.getByTestId("lessons-nav").click();
  await first.page.getByTestId("lessons-page-tab-io").click();
  await first.page.getByTestId("io-export").click();
  await expect(first.page.getByTestId("io-export-message")).toHaveText(S.ioExported(file));
  const exported = readFileSync(file, "utf8");
  expect(JSON.parse(exported)).toMatchObject({ format: "butler-config", formatVersion: 1 });
  // 默认不带本地路径和出处链接。
  expect(exported).not.toContain(a.repo);
  await first.app.close();

  // 2. 第二个 Butler：本地已有同一条规矩但还是待确认（和文件冲突）。
  const b = makeSandbox();
  const second = await launch(b);
  await completeWizard(second.page, b);
  db = new DatabaseSync(join(b.butlerHome, "app.db"));
  db.prepare("INSERT INTO lesson_repos (slug, local_path, created_at) VALUES (?, ?, ?)").run("acme/web", b.repo, now);
  db.prepare("INSERT INTO lessons (repo_slug, text, why, status, hits, last_seen_at, created_at, updated_at) VALUES ('acme/web', '改 schema 要加迁移', '', 'pending', 1, ?, ?, ?)").run(now, now, now);
  db.close();
  await second.page.reload();
  await stubDialogs(second.app, file);
  const page = second.page;
  await page.getByTestId("lessons-nav").click();
  await page.getByTestId("lessons-page-tab-io").click();
  await page.getByTestId("io-choose").click();

  // 3. 预览：规矩 新增 1 · 冲突 1；准入策略 新增 1。
  const preview = page.getByTestId("io-preview");
  await expect(preview).toBeVisible();
  await expect(page.getByTestId("io-counts-lessons")).toHaveText(`${S.ioCount(S.previewStatus.added, 1)} · ${S.ioCount(S.previewStatus.conflicting, 1)}`);
  await expect(page.getByTestId("io-counts-policies")).toHaveText(S.ioCount(S.previewStatus.added, 1));
  const conflict = page.locator("[data-testid^='io-row-lessons-']").filter({ hasText: "改 schema 要加迁移" });
  await expect(conflict).toContainText(S.previewStatus.conflicting);
  await expect(conflict).toContainText(S.ioDiffField.status);

  // 4. 冲突那条选「用导入的」，合并导入。
  await conflict.locator("[data-testid^='io-pick-imported-']").check();
  await page.getByTestId("io-apply").click();
  await expect(page.getByTestId("io-result")).toBeVisible();
  await expect(page.getByTestId("lessons-notice-text")).toHaveText(S.ioApplied);

  // 新增的那条是待确认，冲突那条按文件改成已确认；策略也到了。
  db = new DatabaseSync(join(b.butlerHome, "app.db"));
  const rows = db.prepare("SELECT text, status FROM lessons ORDER BY text").all() as { text: string; status: string }[];
  expect(rows).toEqual([{ text: "IPC 参数都要校验", status: "pending" }, { text: "改 schema 要加迁移", status: "confirmed" }]);
  expect(db.prepare("SELECT overrides FROM admission_policies WHERE scope_kind = 'global'").get()).toEqual({ overrides: JSON.stringify({ "score.admitLine": 0.8 }) });
  db.close();

  // 5. 整批撤销：回到导入前。
  await page.getByTestId("lessons-notice-undo").click();
  await expect(page.getByTestId("lessons-notice-undo")).toHaveCount(0);
  db = new DatabaseSync(join(b.butlerHome, "app.db"));
  expect(db.prepare("SELECT text, status FROM lessons").all()).toEqual([{ text: "改 schema 要加迁移", status: "pending" }]);
  db.close();
  expect(existsSync(file)).toBe(true);
});
