import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, test } from "./fixtures";

const sidebar = (page: Page, name: string) => page.locator(".sidebar").getByRole("button", { name, exact: true });

/**
 * 工作流 N 验收：设置页「自动接活」配一个 JSON 文件来源、仓库映射，全局一层打开总开关、最多同时 1 个；预审打开。
 * 文件里三个 ticket，规则就能分完（不调模型）：
 * - E2E-31 文档类、信息全 → 小、低风险，自动开 session；
 * - E2E-32 功能、没写验收标准 → 只提醒（「现在」页一条），不开 session；
 * - E2E-33 文档类、信息全，但名额满了 → 排着队。
 * 然后在队列里把 E2E-33 的规模改成「中」，效果页的「你改了分类」记上一个。
 */
test("intake: a file source is sorted, a complete ticket starts, a missing one only alerts, the rest queue", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const file = join(s.dir, "intake.json");
  writeFileSync(file, JSON.stringify({
    tickets: [
      { key: "E2E-31", title: "Fix the greeting doc", type: "docs", description: "The greeting in docs/greet.md still says Hi; change it to Hello everywhere in that page." },
      { key: "E2E-32", title: "Add a dark theme", type: "Story", labels: ["small"], description: "Users want a dark theme. Describe it in docs/theme.md first, then wire it into the settings page." },
      { key: "E2E-33", title: "Tidy the install doc", type: "docs", description: "docs/install.md has two duplicate sections about the first launch; merge them into one." },
    ],
  }));
  const { page } = await launch(s);
  await completeWizard(page, s);

  // 1. 预审打开（自动开工要它）。
  await sidebar(page, S.settings).click();
  await page.getByTestId("settings-tab-review").click();
  await page.getByTestId("review-enabled").check();
  await expect(page.getByTestId("review-enabled")).toBeChecked();

  // 2. 「自动接活」：策略先开（全局，最多 1 个），再配来源；来源一配好就拉一次。
  await page.getByTestId("settings-tab-intake").click();
  await expect(page.getByTestId("intake-policy")).toBeVisible();
  await expect(page.getByTestId("intake-effective-enabled")).toHaveText(S.policyBool(false));
  await page.getByTestId("intake-input-enabled").selectOption("true");
  await page.getByTestId("intake-input-maxParallel").fill("1");
  await page.getByTestId("intake-policy-save").click();
  await expect(page.getByTestId("intake-policy-message")).toHaveText(S.policySaved);
  await expect(page.getByTestId("intake-effective-enabled")).toHaveText(S.policyBool(true));

  const map = page.getByTestId("setting-intakeRepoMap");
  await map.fill(`* => ${s.repo}`);
  await map.blur();
  await page.getByTestId("setting-intakeSource").selectOption("file");
  const path = page.getByTestId("setting-intakeFilePath");
  await path.fill(file);
  await path.blur();
  await expect(page.getByTestId("intake-setting-error")).toHaveCount(0);

  // 3. 进度页的队列：E2E-31 开工了，E2E-32 缺信息，E2E-33 等名额。
  await sidebar(page, S.progressNav).click();
  const queue = page.getByTestId("intake-queue");
  await expect(queue).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("intake-row-E2E-31")).toHaveAttribute("data-state", "started", { timeout: 20_000 });
  await expect(page.getByTestId("intake-row-E2E-32")).toHaveAttribute("data-state", "needs_clarification");
  await expect(page.getByTestId("intake-row-E2E-33")).toHaveAttribute("data-state", "waiting");
  await expect(page.getByTestId("intake-state-E2E-33")).toHaveText(`${S.ik.state.waiting} · ${S.ik.reason.parallel}`);
  await expect(page.getByTestId("intake-size-E2E-31")).toHaveValue("small");
  await expect(page.getByTestId("intake-risk-E2E-31")).toHaveValue("low");

  // 4. 「现在」页只为 E2E-32 提醒（缺验收标准）；E2E-33 只是在排队，不提醒。
  await sidebar(page, S.nowTitle).click();
  const notice = page.getByTestId("now-notice-intake");
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("E2E-32");
  await expect(notice).toContainText(S.ik.missing.acceptance_criteria!);

  // 5. 改 E2E-33 的规模：记成一次改分类，状态不变（还是等名额）。
  await sidebar(page, S.progressNav).click();
  await page.getByTestId("intake-size-E2E-33").selectOption("medium");
  await expect(page.getByTestId("intake-row-E2E-33")).toContainText(S.ik.edited);
  await expect(page.getByTestId("intake-row-E2E-33")).toHaveAttribute("data-state", "waiting");

  // 6. 效果页：分类 3 个，自动开工 1 个，改了 1 个（33%）。
  await sidebar(page, S.effectNav).click();
  const card = page.getByTestId("effect-intake");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("effect-intake-classified")).toContainText("3");
  await expect(page.getByTestId("effect-intake-started")).toContainText("1");
  await expect(page.getByTestId("effect-intake-override")).toContainText("33%");
});
