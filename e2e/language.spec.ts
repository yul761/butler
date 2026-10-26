import { STRINGS } from "../src/renderer/src/strings";
import { expect, test } from "./fixtures";

/**
 * 设计文档 2026-10-26（中英文切换）：不设 BUTLER_LANG 启动，在向导里切到 English → 窗口重新加载，界面是英文；
 * 重启后仍是英文；再切回中文。和系统语言无关：每一步都是显式选的。
 */
test("the language is picked in the wizard, survives a restart and can be switched back", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  s.lang = null;
  const first = await launch(s);
  await expect(first.page.getByTestId("wizard")).toBeVisible();
  await first.page.locator(".language-picker select").selectOption("en");
  await expect(first.page.getByRole("heading", { name: STRINGS.en.wizardTitle, exact: true })).toBeVisible();
  await expect(first.page.getByRole("button", { name: STRINGS.en.wizardNext, exact: true })).toBeVisible();
  await first.app.close();

  const second = await launch(s);
  await expect(second.page.getByRole("heading", { name: STRINGS.en.wizardTitle, exact: true })).toBeVisible();
  await expect(second.page.locator(".language-picker select")).toHaveValue("en");
  await second.page.locator(".language-picker select").selectOption("zh");
  await expect(second.page.getByRole("heading", { name: STRINGS.zh.wizardTitle, exact: true })).toBeVisible();
});
