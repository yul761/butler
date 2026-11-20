import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { STRINGS } from "../src/renderer/src/strings";
import { EXTERNAL_ACTIONS } from "../src/shared/external";
import { FEATURE_IDS } from "../src/shared/feature-rows";
import { completeWizard, expect, openSettingsGroup, openSettingsTab, test, type Sandbox } from "./fixtures";

/**
 * UI 重做第 6 层：新装时「设置 › 功能」每一行都关着；打开一行只写那一行的开关（不连带对外动作），
 * 重新加载、切语言后读回来还是开；老用户只开了一部分的行显示成「部分开」。
 * 首页空状态的 e2e 依赖首页接线，由接线的那一层补；这一层用 render 测试覆盖组件。
 */

const row = (page: Page, id: string) => page.getByTestId(`feature-row-${id}`);

function settingValues(s: Sandbox, keys: string[]): Record<string, string | null> {
  const db = new DatabaseSync(join(s.butlerHome, "app.db"));
  try {
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = (db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null;
    return out;
  } finally {
    db.close();
  }
}

test("a fresh install has every feature off", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  await openSettingsTab(page, "features");
  await expect(page.locator('[data-testid^="feature-row-"]')).toHaveCount(FEATURE_IDS.length);
  for (const id of FEATURE_IDS) await expect(row(page, id)).toHaveAttribute("data-state", "off");
});

test("turning on a feature writes the setting, leaves outward actions off, and survives a language switch", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { app, page } = await launch(s);
  await completeWizard(page, s);
  await openSettingsTab(page, "features");

  await page.getByTestId("feature-toggle-hibernate").click();
  await expect(row(page, "hibernate")).toHaveAttribute("data-state", "on");
  await page.reload();
  await openSettingsTab(page, "features");
  await expect(row(page, "hibernate")).toHaveAttribute("data-state", "on");
  expect(settingValues(s, ["hibernateEnabled"])).toEqual({ hibernateEnabled: "1" });

  // 打开「PR 评论转给 session」：对外动作一个都不跟着开。
  await page.getByTestId("feature-toggle-review_comments").click();
  await expect(row(page, "review_comments")).toHaveAttribute("data-state", "on");
  await openSettingsGroup(page, "external");
  const block = page.getByTestId("external-actions");
  for (const kind of EXTERNAL_ACTIONS) await expect(block.getByTestId(`external-${kind}`)).not.toBeChecked();

  // 切到英文（同 language.spec：不设 BUTLER_LANG 重启，在「基本」里选 English，整窗重新加载）：同一行还是开着，标题是英文。
  await app.close();
  s.lang = null;
  const en = (await launch(s)).page;
  const nav = (name: RegExp) => en.locator(".sidebar button.nav").filter({ hasText: name });
  await nav(new RegExp(`^(${STRINGS.zh.settings}|${STRINGS.en.settings})$`)).click();
  await en.getByTestId("settings-tab-basic").click();
  await en.locator(".language-picker select").selectOption("en");
  await expect(nav(new RegExp(`^${STRINGS.en.settings}$`))).toBeVisible();
  await nav(new RegExp(`^${STRINGS.en.settings}$`)).click();
  await en.getByTestId("settings-tab-features").click();
  await expect(row(en, "hibernate")).toHaveAttribute("data-state", "on");
  await expect(row(en, "hibernate")).toContainText(STRINGS.en.set.feat.hibernate.title);
  await expect(row(en, "review_comments")).toHaveAttribute("data-state", "on");
});

test("a half-enabled row is shown as partial", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  const db = new DatabaseSync(join(s.butlerHome, "app.db"));
  db.prepare("INSERT INTO settings (key, value) VALUES ('lessonsAutoAdmit', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  db.close();
  await page.reload();

  await openSettingsTab(page, "features");
  const lessons = row(page, "lessons_auto");
  await expect(lessons).toHaveAttribute("data-state", "partial");
  await expect(lessons).toContainText("1/3");
  await expect(page.getByTestId("feature-toggle-lessons_auto")).toHaveCount(0);
  await page.getByTestId("feature-all-on-lessons_auto").click();
  await expect(lessons).toHaveAttribute("data-state", "on");
  expect(settingValues(s, ["lessonsAutoAdmit", "lessonsPrinciples", "lessonsCoreGuide"])).toEqual({ lessonsAutoAdmit: "1", lessonsPrinciples: "1", lessonsCoreGuide: "1" });
});
