import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, terminalText, test } from "./fixtures";

/** 设计文档 2026-10-23（多仓库 ticket）第一步：不带仓库建 ticket → 添加两个仓库 → 各自开 session → 总控看得到两个仓库。 */
test("a ticket over two repos: a session per repo and a coordinator that sees both", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  await completeWizard(page, s);

  // 1. 不填仓库建 ticket：只能开总控。
  await page.getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("FULL-1");
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "FULL-1", exact: true })).toBeVisible();
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
  await expect.poll(fakeLog).toContain(`cwd=${s.apiRepo} adddirs=\n`);
  await expect(page.locator(".sessions-bar .session .place")).toHaveText(["api"]);

  // 4. 总控：在工作区目录里，两个仓库都用 --add-dir 加进去。
  await page.getByRole("button", { name: `+ ${S.newCoordinator}`, exact: true }).click();
  const worktree = join(`${s.repo}-worktrees`, "FULL-1");
  const workspace = join(s.butlerHome, "workspaces", "FULL-1");
  await expect.poll(fakeLog).toContain(`cwd=${workspace} adddirs=${worktree}|${s.apiRepo}\n`);
  await expect(page.locator(".sessions-bar .session .place")).toHaveText([S.coordinator, "api"]);
});
