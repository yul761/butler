import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, openSettingsGroup, type Sandbox, test } from "./fixtures";

const sidebar = (page: Page, name: string) => page.locator(".sidebar").getByRole("button", { name, exact: true });

/** 假 claude 每次交互启动带的 --model（没带是 "-"），按顺序。 */
function interactiveModels(s: Sandbox): string[] {
  if (!existsSync(s.fakeLog)) return [];
  return readFileSync(s.fakeLog, "utf8").split("\n").flatMap((l) => {
    const m = / interactive-model \S+ (\S+)$/.exec(l);
    return m ? [m[1]!] : [];
  });
}

/**
 * 工作流 N 验收：设置页「自动接活」配一个 JSON 文件来源、仓库映射（总开关关着时什么都不发生），再在全局一层打开总开关、最多同时 1 个；预审打开。
 * 文件里三个 ticket，规则就能分完（不调模型）：
 * - E2E-31 文档类、信息全 → 小、低风险，自动开 session；
 * - E2E-32 功能、没写验收标准 → 只提醒（「现在」页一条），不开 session；
 * - E2E-33 文档类、信息全，但名额满了 → 排着队。
 * 登记了中、高两档模型：小 ticket 映射到中档，session 带着中档的 --model 开。
 * 然后在队列里把 E2E-33 的规模改成「中」，关掉 E2E-31 的 session，名额空出来 E2E-33 自动开工；效果页的「你改了分类」记上一个。
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

  // 1. 登记两个模型（档位映射到哪个模型由路由决定），预审打开（自动开工要它）。
  await openSettingsGroup(page, "routing");
  for (const [name, tier] of [["claude-fake-high", "high"], ["claude-fake-mid", "mid"]] as const) {
    await page.getByTestId("new-model-name").fill(name);
    await page.getByTestId("new-model-tier").selectOption(tier);
    await page.getByRole("button", { name: S.rt.addModel, exact: true }).click();
    await expect(page.getByTestId("registry-row").filter({ hasText: name })).toHaveCount(1);
  }
  await openSettingsGroup(page, "review");
  await page.getByTestId("review-enabled").check();
  await expect(page.getByTestId("review-enabled")).toBeChecked();

  // 2. 「自动接活」：先配来源和仓库映射，总开关还关着——什么都不拉、不开 session、进度页没有队列（工作流 R）。
  await openSettingsGroup(page, "intake");
  await expect(page.getByTestId("intake-policy")).toBeVisible();
  await expect(page.getByTestId("intake-effective-enabled")).toHaveText(S.policyBool(false));
  const map = page.getByTestId("setting-intakeRepoMap");
  await map.fill(`* => ${s.repo}`);
  await map.blur();
  await page.getByTestId("setting-intakeSource").selectOption("file");
  const path = page.getByTestId("setting-intakeFilePath");
  await path.fill(file);
  await path.blur();
  await expect(page.getByTestId("intake-setting-error")).toHaveCount(0);
  // 改设置后 1 秒会试着拉一次（总开关关着就不拉）；多等一会儿再看。
  await page.waitForTimeout(3000);
  await sidebar(page, S.progressNav).click();
  await expect(page.getByTestId("progress-intake")).toHaveCount(0);
  expect(interactiveModels(s)).toEqual([]);

  // 3. 再打开总开关（全局，最多 1 个）：一保存就拉一次。
  await openSettingsGroup(page, "intake");
  await page.getByTestId("intake-input-enabled").selectOption("true");
  await page.getByTestId("intake-input-maxParallel").fill("1");
  await page.getByTestId("intake-policy-save").click();
  await expect(page.getByTestId("intake-policy-message")).toHaveText(S.policySaved);
  await expect(page.getByTestId("intake-effective-enabled")).toHaveText(S.policyBool(true));

  // 4. 进度页的队列：E2E-31 开工了，E2E-32 缺信息，E2E-33 等名额。
  await sidebar(page, S.progressNav).click();
  const queue = page.getByTestId("intake-queue");
  await expect(queue).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("intake-row-E2E-31")).toHaveAttribute("data-state", "started", { timeout: 20_000 });
  await expect(page.getByTestId("intake-row-E2E-32")).toHaveAttribute("data-state", "needs_clarification");
  await expect(page.getByTestId("intake-row-E2E-33")).toHaveAttribute("data-state", "waiting");
  await expect(page.getByTestId("intake-state-E2E-33")).toHaveText(`${S.ik.state.waiting} · ${S.ik.reason.parallel}`);
  await expect(page.getByTestId("intake-size-E2E-31")).toHaveValue("small");
  await expect(page.getByTestId("intake-risk-E2E-31")).toHaveValue("low");
  await expect(page.getByTestId("intake-row-E2E-31")).toContainText("mid · claude-fake-mid");
  await expect.poll(() => interactiveModels(s)).toEqual(["claude-fake-mid"]);

  // 5. 「现在」页只为 E2E-32 提醒（缺验收标准）；E2E-33 只是在排队，不提醒。
  await sidebar(page, S.nowTitle).click();
  const notice = page.getByTestId("now-notice-intake");
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("E2E-32");
  await expect(notice).toContainText(S.ik.missing.acceptance_criteria!);

  // 6. 改 E2E-33 的规模：记成一次改分类，状态不变（还是等名额）。
  await sidebar(page, S.progressNav).click();
  await page.getByTestId("intake-size-E2E-33").selectOption("medium");
  await expect(page.getByTestId("intake-row-E2E-33")).toContainText(S.ik.edited);
  await expect(page.getByTestId("intake-row-E2E-33")).toHaveAttribute("data-state", "waiting");

  // 7. 关掉 E2E-31 的 session：名额空了，E2E-33 自动开工（中等规模 → 中档）。
  await page.locator(".sidebar .ticket .key").getByText("E2E-31", { exact: true }).click();
  const end = page.getByTitle(S.endSession, { exact: true });
  await end.click();
  await end.click();
  await expect(end).toHaveCount(0);
  await sidebar(page, S.progressNav).click();
  await expect(page.getByTestId("intake-row-E2E-33")).toHaveAttribute("data-state", "started", { timeout: 20_000 });
  await expect.poll(() => interactiveModels(s)).toEqual(["claude-fake-mid", "claude-fake-mid"]);
  // E2E-32 一直没开 session。
  await expect(page.getByTestId("intake-row-E2E-32")).toHaveAttribute("data-state", "needs_clarification");

  // 8. 效果页：分类 3 个，自动开工 2 个，改了 1 个（33%）。
  await sidebar(page, S.effectNav).click();
  const card = page.getByTestId("effect-intake");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("effect-intake-classified")).toContainText("3");
  await expect(page.getByTestId("effect-intake-started")).toContainText("2");
  await expect(page.getByTestId("effect-intake-override")).toContainText("33%");
});
