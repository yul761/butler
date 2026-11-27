import { REASON_LIMIT } from "../src/shared/control";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, test, newButton } from "./fixtures";

// BTL-270：ticket 不做了就关掉，和「完成」分开；原因必填，关了以后横幅写着原因，能重新打开。
test("close a ticket with a reason, see why it is closed, then reopen it", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("E2E-9");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-9", exact: true })).toBeVisible();

  // 状态下拉框里「已关闭」不能直接选（要原因），「待决定」不出现（只能自动得出）。
  const select = page.locator(".ticket-header select").first();
  await expect(select.locator("option", { hasText: "已关闭" })).toBeDisabled();
  await expect(select.locator("option", { hasText: "待决定" })).toHaveCount(0);

  await page.getByRole("button", { name: S.tc.close, exact: true }).click();
  const dialog = page.locator("form.close-ticket");
  await expect(dialog.getByRole("heading", { name: S.tc.title("E2E-9") })).toBeVisible();
  // 原因没填不能关。
  await expect(dialog.getByRole("button", { name: S.tc.confirm, exact: true })).toBeDisabled();
  // 超长的不截断：原文都在框里，提示超了，不让提交。
  const long = "长".repeat(REASON_LIMIT + 1);
  await dialog.getByRole("textbox").fill(long);
  await expect(dialog.getByRole("textbox")).toHaveValue(long);
  await expect(dialog.getByText(S.tc.reasonTooLong(REASON_LIMIT))).toBeVisible();
  await expect(dialog.getByRole("button", { name: S.tc.confirm, exact: true })).toBeDisabled();
  await dialog.getByRole("textbox").fill("需求变了，这个不做了");
  await dialog.getByRole("button", { name: S.tc.confirm, exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await expect(page.locator(".ticket-closed-banner")).toContainText(S.tc.banner("需求变了，这个不做了"));
  await expect(page.locator(".ticket-closed-banner")).toContainText(S.tc.by.user);
  await expect(select).toHaveValue("closed");

  await page.getByRole("button", { name: S.tc.reopen, exact: true }).click();
  await expect(page.locator(".ticket-closed-banner")).toHaveCount(0);
  await expect(select).toHaveValue("auto");
  await expect(page.getByRole("button", { name: S.tc.close, exact: true })).toBeVisible();
});
