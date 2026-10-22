import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { cleanup, completeWizard, launch, makeSandbox } from "./fixtures";

test.afterEach(cleanup);

test("first run: the wizard finds claude, installs hooks into the given config dir and lands on the brief", async () => {
  const s = makeSandbox();
  const { app, page } = await launch(s);
  try {
    await completeWizard(page, s);
    await expect(page.getByRole("button", { name: S.regenerate, exact: true })).toBeVisible();
    const settings = readFileSync(join(s.claudeConfigDir, "settings.json"), "utf8");
    expect(settings).toContain("butler-hook");
    expect(readFileSync(join(s.claudeConfigDir, "commands", "handoff.md"), "utf8")).toContain("butler-handoff");
    // hook 程序装进了沙盒的 BUTLER_HOME。
    expect(existsSync(join(s.butlerHome, "bin", process.platform === "win32" ? "butler-hook.exe" : "butler-hook"))).toBe(true);
  } finally {
    await app.close();
  }
});

test("the wizard does not let the user continue without a working claude", async () => {
  const s = makeSandbox();
  const { app, page } = await launch(s);
  try {
    await expect(page.getByTestId("wizard")).toBeVisible();
    await page.getByPlaceholder(S.generalPlaceholders.claudePath, { exact: true }).fill(join(s.dir, "no-such-claude"));
    await page.getByRole("button", { name: S.save, exact: true }).click();
    await expect(page.getByText(S.wizardClaudeMissing, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: S.wizardNext, exact: true })).toBeDisabled();
    // 可以跳过整个向导。
    await page.getByRole("button", { name: S.wizardSkip, exact: true }).click();
    await expect(page.getByTestId("wizard")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

// 计划 4 遗留（Ruling P5-PF7）：onboardingDone 写进了数据库，启动时只读一次。
test("after the wizard is finished, a relaunch goes straight to the brief", async () => {
  const s = makeSandbox();
  const first = await launch(s);
  try {
    await completeWizard(first.page, s);
  } finally {
    await first.app.close();
  }
  const { app, page } = await launch(s);
  try {
    await expect(page.getByRole("button", { name: S.regenerate, exact: true })).toBeVisible();
    await expect(page.getByTestId("wizard")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

// 计划 4 遗留（Ruling P5-PF7）：设置页的“重新运行”直接改 App 的向导状态，不用重启。
test("Settings → rerun shows the wizard again at once, with the saved claude path", async () => {
  const s = makeSandbox();
  const { app, page } = await launch(s);
  try {
    await completeWizard(page, s);
    await page.getByRole("button", { name: S.settings, exact: true }).click();
    await page.getByRole("button", { name: S.rerunWizard, exact: true }).click();
    await expect(page.getByTestId("wizard")).toBeVisible();
    await expect(page.getByText(S.wizardStep(1, 4), { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder(S.generalPlaceholders.claudePath, { exact: true })).toHaveValue(s.claudePath);
    await page.getByRole("button", { name: S.wizardSkip, exact: true }).click();
    await expect(page.getByTestId("wizard")).toHaveCount(0);
    await expect(page.getByRole("button", { name: S.regenerate, exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});
