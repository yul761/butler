import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, test } from "./fixtures";

test("first run: the wizard finds claude, installs hooks into the given config dir and lands on the Now page", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  await expect(page.getByRole("heading", { name: S.nowTitle, exact: true })).toBeVisible();
  const settings = readFileSync(join(s.claudeConfigDir, "settings.json"), "utf8");
  expect(settings).toContain("butler-hook");
  expect(readFileSync(join(s.claudeConfigDir, "commands", "handoff.md"), "utf8")).toContain("butler-handoff");
  // hook 程序装进了沙盒的 BUTLER_HOME。
  expect(existsSync(join(s.butlerHome, "bin", process.platform === "win32" ? "butler-hook.exe" : "butler-hook"))).toBe(true);
});

test("the wizard does not let the user continue without a working claude", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await expect(page.getByTestId("wizard")).toBeVisible();
  await page.getByPlaceholder(S.generalPlaceholders.claudePath, { exact: true }).fill(join(s.dir, "no-such-claude"));
  await page.getByRole("button", { name: S.save, exact: true }).click();
  await expect(page.getByText(S.wizardClaudeMissing, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: S.wizardNext, exact: true })).toBeDisabled();
  // 可以跳过整个向导。
  await page.getByRole("button", { name: S.wizardSkip, exact: true }).click();
  await expect(page.getByTestId("wizard")).toHaveCount(0);

  // 跳过之后「现在」页顶上提醒还没设置完：“继续设置”回到向导。
  const banner = page.locator(".now-page .setup-skipped");
  await expect(banner.getByText(S.setupSkipped, { exact: true })).toBeVisible();
  await banner.getByRole("button", { name: S.resumeSetup, exact: true }).click();
  await expect(page.getByTestId("wizard")).toBeVisible();
  await page.getByRole("button", { name: S.wizardSkip, exact: true }).click();
  await expect(page.getByRole("heading", { name: S.nowTitle, exact: true })).toBeVisible();
  // 跳过了第二次，提醒还在；“不再提示”之后消失，刷新、重启都不再出现。
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: S.dismissForever, exact: true }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: S.nowTitle, exact: true })).toBeVisible();
  await expect(banner).toHaveCount(0);
});

// 计划 4 遗留（Ruling P5-PF7）：onboardingDone 写进了数据库，启动时只读一次。
test("after the wizard is finished, a relaunch goes straight to the Now page", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const first = await launch(s);
  await completeWizard(first.page, s);
  await first.app.close();
  const { page } = await launch(s);
  await expect(page.getByRole("heading", { name: S.nowTitle, exact: true })).toBeVisible();
  await expect(page.getByTestId("wizard")).toHaveCount(0);
  // 向导是走完的，不是跳过的：没有“还没设置完”的提醒。
  await expect(page.locator(".setup-skipped")).toHaveCount(0);
});

// 计划 4 遗留（Ruling P5-PF7）：设置页的“重新运行”直接改 App 的向导状态，不用重启。
test("Settings → rerun shows the wizard again at once, with the saved claude path", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  await page.getByRole("button", { name: S.settings, exact: true }).click();
  await page.getByRole("button", { name: S.rerunWizard, exact: true }).click();
  await expect(page.getByTestId("wizard")).toBeVisible();
  await expect(page.getByText(S.wizardStep(1, 4), { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(S.generalPlaceholders.claudePath, { exact: true })).toHaveValue(s.claudePath);
  await page.getByRole("button", { name: S.wizardSkip, exact: true }).click();
  await expect(page.getByTestId("wizard")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: S.nowTitle, exact: true })).toBeVisible();
});
