import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, terminalText, test, newButton, openTicketTab } from "./fixtures";

/**
 * 设计文档 2026-10-23（多仓库 ticket）：不带仓库建 ticket → 添加两个仓库 → 各自开 session，按钮上标着仓库名。
 * ticket 总控在 BTL-246 去掉了：派 session 的是 feature 总控（features.spec）。
 */
test("a ticket over two repos: a session per repo, and no ticket coordinator", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  await completeWizard(page, s);

  // 1. 不填仓库建 ticket：什么都开不了。
  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("FULL-1");
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "FULL-1", exact: true })).toBeVisible();
  // 仓库条和 session 条在「终端」页签里（ticket 页默认停在「概况」）。
  await openTicketTab(page, "terminal");
  await expect(page.getByText(S.noRepos, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `+ ${S.newSession}`, exact: true })).toHaveCount(0);

  // 2. 添加两个仓库：前端用 worktree，后端用分支。
  const addRepo = async (path: string, mode: string) => {
    await page.getByRole("button", { name: `+ ${S.addRepo}`, exact: true }).click();
    await page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true }).fill(path);
    await page.getByRole("radio", { name: mode, exact: true }).check();
    await page.getByRole("button", { name: S.add, exact: true }).click();
    await expect(page.locator(".modal")).toHaveCount(0);
  };
  await addRepo(s.repo, S.worktree);
  await addRepo(s.apiRepo, S.branch);
  await expect(page.locator(".repos-bar .repo .name")).toHaveText(["repo", "api"]);

  // 3. 在 api 仓库开 session（分支模式：先切到 ticket 的分支），session 按钮上标着仓库名。
  await page.getByRole("combobox", { name: S.pickRepo }).selectOption({ label: "api" });
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await page.getByRole("button", { name: S.switchAndOpen, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await expect.poll(fakeLog).toContain(`cwd=${s.apiRepo} adddirs= guide=`);
  await expect(page.locator(".sessions-bar .session .place")).toHaveText(["api"]);

  // 4. ticket 没有总控了（BTL-246）：页面上没有开总控的按钮；在 repo 仓库也开一个 session（worktree）。
  await expect(page.getByRole("button", { name: `+ ${S.newCoordinator}`, exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: S.pickRepo }).selectOption({ label: "repo" });
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(fakeLog).toContain(`cwd=${join(`${s.repo}-worktrees`, "FULL-1")} adddirs= guide=`);
  await expect(page.locator(".sessions-bar .session .place")).toHaveText(["repo", "api"]);

  // 6. 多余的 session 可以从列表里隐藏（终端先退出），之后还能恢复。
  const apiButton = page.locator(".sessions-bar .session-wrap").filter({ has: page.locator(".place", { hasText: /^api$/ }) });
  await apiButton.locator(".session").click();
  await page.locator(".terminal-wrap:visible .xterm").click();
  // 一句话都没说过的 session 退出时会被当成空 session 自动删掉：先说一句。
  await page.keyboard.type("api work");
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain("收到：api work");
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect(page.locator(".terminal-wrap:visible .exited")).toBeVisible();
  await apiButton.getByRole("button", { name: /^隐藏 / }).click();
  await expect(apiButton).toHaveCount(0);
  await page.getByRole("button", { name: S.hiddenSessions(1), exact: true }).click();
  await page.locator(".hidden-sessions").getByRole("button", { name: S.unhideSession, exact: true }).click();
  await expect(apiButton).toHaveCount(1);
  await expect(page.getByRole("button", { name: S.hiddenSessions(1), exact: true })).toHaveCount(0);
});
