import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, test } from "./fixtures";

/**
 * 「效果」页（ws-h）：侧栏打开，四张卡和打断原因都在；还没有基线时卡上写 "之前 —"；换时间范围重新取数。
 * 不用 gh，Windows 上也跑。
 */
test("the Effect page shows the four cards and why sessions stopped", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);

  await page.locator(".sidebar").getByRole("button", { name: S.effectNav, exact: true }).click();
  await expect(page.getByTestId("effect-page")).toBeVisible();
  for (const id of ["effect-card-cycle", "effect-card-comments", "effect-card-interventions", "effect-card-cost", "effect-interrupts", "effect-trend"]) {
    await expect(page.getByTestId(id), id).toBeVisible();
  }
  await expect(page.getByTestId("effect-card-cycle")).toContainText(S.effect.noBaseline);
  await expect(page.getByTestId("effect-interrupts")).toContainText(S.effect.interruptNames.permission);
  await expect(page.getByTestId("effect-interrupts")).toContainText(S.effect.autoResolved(0));
  await expect(page.getByTestId("effect-page")).toContainText(S.effect.empty);
  // 评论与 CI（工作流 I）：两个闭环都没开，数字都是 0。
  await expect(page.getByTestId("effect-loop")).toContainText(S.effect.loop);
  await expect(page.getByTestId("effect-loop-handled")).toContainText(S.effect.loopHandledSub(0, 0));
  await expect(page.getByTestId("effect-loop-flaky")).toContainText(S.effect.loopFlakySub(0));

  const week = page.getByRole("button", { name: S.effect.days(7), exact: true });
  await week.click();
  await expect(week).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("effect-card-cycle")).toBeVisible();
  await page.getByRole("button", { name: S.effect.byMonth, exact: true }).click();
  await expect(page.getByRole("button", { name: S.effect.byMonth, exact: true })).toHaveAttribute("aria-pressed", "true");
});
