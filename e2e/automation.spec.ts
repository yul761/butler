import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { S } from "../src/renderer/src/strings";
import { completeWizard, create, expect, makeGitRepo, newButton, openAllWork, openAutomationAdvanced, openSettingsTab, test, type Sandbox } from "./fixtures";

/**
 * BTL-247：设置 › 自动化的档位。新装是「手动」；选「半自动」把受管的开关写成预设；
 * 在「高级」里动了受管的开关，档位显示「自定义」，再点一次「半自动」恢复预设。epic 页标题旁边能单独选档位。
 */

function read<T>(s: Sandbox, sql: string): T | undefined {
  const db = new DatabaseSync(join(s.shipherdHome, "app.db"), { readOnly: true });
  try {
    return db.prepare(sql).get() as T | undefined;
  } finally {
    db.close();
  }
}
const setting = (s: Sandbox, key: string) => read<{ value: string }>(s, `SELECT value FROM settings WHERE key = '${key}'`)?.value ?? null;
const loopGlobal = (s: Sandbox): Record<string, unknown> =>
  JSON.parse(read<{ overrides: string }>(s, "SELECT overrides FROM loop_policies WHERE scope_kind = 'global'")?.overrides ?? "{}") as Record<string, unknown>;

test("manual by default; semi writes its preset; touching a managed switch shows custom until semi is picked again", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  await openSettingsTab(page, "features");
  const level = page.getByTestId("automation-level");
  await expect(level).toHaveAttribute("data-display", "manual");
  await expect(page.getByTestId("automation-manual").locator("input")).toBeChecked();
  await expect(page.getByTestId("automation-full").locator("input")).toBeDisabled();
  // 「高级」默认收起。
  await expect(page.getByTestId("automation-advanced")).not.toHaveAttribute("open", "");

  await page.getByTestId("automation-semi").locator("input").click();
  await expect(level).toHaveAttribute("data-display", "semi");
  expect(setting(s, "automationLevel")).toBe("semi");
  expect(setting(s, "preReviewEnabled")).toBe("1");
  expect(setting(s, "externalForcePush")).toBe("1");
  expect(setting(s, "externalCommentReply")).not.toBe("1");
  expect(loopGlobal(s)).toMatchObject({ "comments.enabled": true, "comments.reply": false, "ci.enabled": true, "ci.maxReruns": 1 });
  // 半自动但还没选接活来源：提示一句。
  await expect(page.getByTestId("automation-no-source")).toBeVisible();

  await openAutomationAdvanced(page);
  await expect(page.getByTestId("feature-row-prereview")).toHaveAttribute("data-state", "on");
  await page.getByTestId("feature-toggle-prereview").click();
  await expect(level).toHaveAttribute("data-display", "custom");
  await expect(page.getByTestId("automation-custom")).toContainText(S.set.auto.customHint(1));
  // 不受档位管的开关不算。
  await page.getByTestId("feature-toggle-hibernate").click();
  await expect(page.getByTestId("automation-custom")).toContainText(S.set.auto.customHint(1));

  await page.getByTestId("automation-semi").locator("input").click();
  await expect(level).toHaveAttribute("data-display", "semi");
  expect(setting(s, "preReviewEnabled")).toBe("1");

  await page.getByTestId("automation-manual").locator("input").click();
  await expect(level).toHaveAttribute("data-display", "manual");
  expect(setting(s, "externalForcePush")).toBe("0");
  expect(loopGlobal(s)).not.toHaveProperty("comments.enabled");
});

test("an epic's own level is picked in its page header and survives a reload", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  const shop = join(s.dir, "shop");
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));
  await create(page, await newButton(page, "newFeature"), S.featureName, "checkout", shop);

  const select = page.getByTestId("epic-level-select");
  await expect(select).toHaveValue("");
  await expect(select.locator('option[value=""]')).toHaveText(S.set.auto.epicFollow(S.set.auto.levels.manual.label));
  await select.selectOption("semi");
  await expect.poll(() => read<{ automation_level: string | null }>(s, "SELECT automation_level FROM features WHERE name = 'checkout'")?.automation_level).toBe("semi");
  await page.reload();
  await openAllWork(page);
  await page.locator('[data-testid^="all-work-row-feature-"]').locator(".row-name").click();
  await expect(page.getByTestId("epic-level-select")).toHaveValue("semi");
  await page.getByTestId("epic-level-select").selectOption("");
  await expect.poll(() => read<{ automation_level: string | null }>(s, "SELECT automation_level FROM features WHERE name = 'checkout'")?.automation_level).toBeNull();
});
