import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, terminalText, test } from "./fixtures";

/**
 * 真机反馈（2026-10-23，Windows）：
 * 1. 建 ticket 时选错了工作方式，建好后要能改；
 * 2. 归档的 ticket 找不到，同一个号也建不了：要能在“已归档”里找到并恢复；
 * 3. 终端里粘贴不进去：Windows 上 Ctrl+V / 右键粘贴外面复制的文字（macOS 用系统菜单的 Cmd+V，不在这里测）。
 */
test("edit the work mode, archive and restore the ticket, paste into the terminal", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { app, page } = await launch(s);
  await completeWizard(page, s);

  // 1. 建成 worktree 模式（默认），再改成分支模式。
  await page.getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("E2E-2");
  await page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("button", { name: S.create, exact: true }).click();
  const header = page.locator(".ticket-header .muted");
  await expect(header).toContainText("-worktrees");

  await page.getByRole("button", { name: S.edit, exact: true }).click();
  await page.getByRole("radio", { name: S.branch, exact: true }).check();
  await expect(page.getByText(S.editModeHint.toBranch, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: S.save, exact: true }).click();
  await expect(header).toHaveText(/ @ feature\/E2E-2$/);

  // 2. 归档后同一个号建不了，但可以直接恢复；“已归档”页里也找得到。
  await page.getByRole("button", { name: S.archive, exact: true }).click();
  await expect(page.locator(".sidebar .ticket .key")).toHaveCount(0);
  await page.getByRole("button", { name: S.archived, exact: true }).click();
  await expect(page.locator(".table td").getByText("E2E-2", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("e2e-2");
  await page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByText(S.createErrors.archived, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: S.restoreArchived("E2E-2"), exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-2", exact: true })).toBeVisible();
  await expect(page.locator(".sidebar .ticket .key")).toHaveText(["E2E-2"]);

  // 3. 粘贴（Windows / Linux）。分支模式：仓库还在 main 上，先切到 ticket 的分支。
  if (process.platform === "darwin") return;
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await page.getByRole("button", { name: S.switchAndOpen, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const xterm = page.locator(".terminal-wrap:visible .xterm");
  await xterm.click();

  await app.evaluate(({ clipboard }) => clipboard.writeText("pasted-with-ctrl-v"));
  await page.keyboard.press("Control+V");
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain("收到：pasted-with-ctrl-v");
  // 只粘贴一次：菜单里的粘贴快捷键没有再触发一遍。
  expect(await terminalText(page)).not.toContain("pasted-with-ctrl-vpasted-with-ctrl-v");

  await app.evaluate(({ clipboard }) => clipboard.writeText("pasted-with-right-click"));
  await xterm.click({ button: "right" });
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain("收到：pasted-with-right-click");
});
