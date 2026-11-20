import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, openTab, pageTab, test } from "./fixtures";

/**
 * 「效果」页（ws-h）：侧栏打开，四张卡在上面，打断原因、趋势、闭环按页签分开；还没有基线时卡上写 "之前 —"；换时间范围重新取数。
 * 不用 gh，Windows 上也跑。
 */
test("the Effect page shows the four cards and why sessions stopped", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);

  await page.locator(".sidebar").getByRole("button", { name: S.effectNav, exact: true }).click();
  await expect(page.getByTestId("effect-page")).toBeVisible();
  // 四张卡在页签上面，停在哪个页签都在；默认停在「概况」：还没有基线、还没有 PR 的说明。
  await expect(pageTab(page, S.lay.effectTabs.overview)).toHaveAttribute("aria-selected", "true");
  for (const id of ["effect-card-cycle", "effect-card-comments", "effect-card-interventions", "effect-card-cost"]) {
    await expect(page.getByTestId(id), id).toBeVisible();
  }
  await expect(page.getByTestId("effect-card-cycle")).toContainText(S.effect.noBaseline);
  await expect(page.getByTestId("effect-page")).toContainText(S.effect.empty);
  // 打断原因和趋势在「趋势」页签。
  await openTab(page, S.lay.effectTabs.trend);
  for (const id of ["effect-interrupts", "effect-trend"]) await expect(page.getByTestId(id), id).toBeVisible();
  await expect(page.getByTestId("effect-interrupts")).toContainText(S.effect.interruptNames.permission);
  await expect(page.getByTestId("effect-interrupts")).toContainText(S.effect.autoResolved(0));
  await expect(page.getByTestId("effect-card-cycle")).toBeVisible();
  // 评论与 CI（工作流 I）在「自动化的效果」页签：两个闭环都没开，数字都是 0。
  await openTab(page, S.lay.effectTabs.automation);
  await expect(page.getByTestId("effect-loop")).toContainText(S.effect.loop);
  await expect(page.getByTestId("effect-loop-handled")).toContainText(S.effect.loopHandledSub(0, 0));
  await expect(page.getByTestId("effect-loop-flaky")).toContainText(S.effect.loopFlakySub(0));

  const week = page.getByRole("button", { name: S.effect.days(7), exact: true });
  await week.click();
  await expect(week).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("effect-card-cycle")).toBeVisible();
  // 按月看在「趋势」页签。
  await openTab(page, S.lay.effectTabs.trend);
  await page.getByRole("button", { name: S.effect.byMonth, exact: true }).click();
  await expect(page.getByRole("button", { name: S.effect.byMonth, exact: true })).toHaveAttribute("aria-pressed", "true");

  // 离开再回来：还是上次停的「趋势」。
  await page.locator(".sidebar").getByRole("button", { name: S.home, exact: true }).click();
  await page.locator(".sidebar").getByRole("button", { name: S.effectNav, exact: true }).click();
  await expect(pageTab(page, S.lay.effectTabs.trend)).toHaveAttribute("aria-selected", "true");
});
