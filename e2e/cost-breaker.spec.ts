import type { Page } from "@playwright/test";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, terminalText, test } from "./fixtures";

/**
 * 成本熔断（工作流 L）：在设置页「花费与后台」给 session 设一个很小的 token 上限；
 * Butler 总控 session 跑一轮就超了。没有登记模型（没有更低一档可换），所以直接暂停：
 * 「现在」页和 session 行上出现提醒；点「继续并提高上限」解除暂停，提醒变成「快到上限」（没有按钮）。
 */

const sidebar = (page: Page, name: string) => page.locator(".sidebar").getByRole("button", { name, exact: true });

test("cost breaker: a session over its cap is paused, and continue-and-raise clears it", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200", BUTLER_USAGE_SCAN_MS: "200" };
  const { page } = await launch(s);
  await completeWizard(page, s);

  // 1. 设置 → 花费与后台：全局一层，每个 session 100 token。
  await sidebar(page, S.settings).click();
  await page.getByTestId("settings-tab-cost").click();
  await expect(page.getByTestId("cost-caps")).toBeVisible();
  await page.getByTestId("cost-input-sessionCap").fill("100");
  await page.getByTestId("cost-input-unit").selectOption("tokens");
  await page.getByTestId("cost-save").click();
  await expect(page.getByTestId("cost-message")).toHaveText(S.policySaved);
  await expect(page.getByTestId("cost-effective-sessionCap")).toHaveText("100");
  // 后台任务那一节也在，默认随时跑。
  await expect(page.getByTestId("setting-bgWindow")).toHaveValue("anytime");

  // 2. 开一个 Butler 总控 session，跑一轮：假 claude 的回复带 500 多个 token 的用量。
  await sidebar(page, S.butlerNav).click();
  const butler = page.locator(".butler-page");
  await butler.getByRole("button", { name: `+ ${S.newButlerSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type("hello");
  await page.keyboard.press("Enter");

  // 3. session 行上：已暂停，有「继续并提高上限」。
  const row = butler.getByTestId("session-cost");
  await expect(row).toBeVisible();
  await expect(row).toContainText(S.cs.state.paused);
  await expect(row.getByTestId("session-cost-raise")).toHaveText(S.cs.raise);

  // 4. 「现在」页：暂停的提醒，点「继续并提高上限」。
  await sidebar(page, S.nowTitle).click();
  const notice = page.getByTestId("now-notice-cost");
  await expect(notice).toBeVisible();
  await notice.getByTestId("now-notice-cost-raise").click();

  // 5. 解除了：提醒还在（新上限的 70% 已经用掉），但只是「快到上限」，没有按钮了。
  await expect(notice.getByTestId("now-notice-cost-raise")).toHaveCount(0);
  await expect(notice).toBeVisible();

  // 6. 设置页的「最近的记录」里有暂停和解除。
  await sidebar(page, S.settings).click();
  await page.getByTestId("settings-tab-cost").click();
  await expect(page.getByTestId("cost-events")).toContainText(S.cs.event.pause!);
  await expect(page.getByTestId("cost-events")).toContainText(S.cs.event.resume!);
});
