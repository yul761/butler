import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { S } from "../src/renderer/src/strings";
import { expect, kvValue, newButton, terminalText, test } from "./fixtures";

/** 假 claude 对 /fake-ask 的回复（fake-claude.cjs 的 ASK_REPLY）。 */
const ASK_REPLY = "要把它拆成两个 PR 吗？";
const isWin = process.platform === "win32";
const goHome = (page: Page) => page.locator(".sidebar").getByRole("button", { name: S.home, exact: true }).click();

/**
 * BTL-249「全新环境第一次使用」：一台从没装过 Shipherd 的机器，一个照着界面点的新用户，走到首页「轮到你」出现第一张卡片。
 * - claude 不在登录 shell 的 PATH 里，装在 ~/.local/bin（官方安装脚本的位置）：向导自己找到，不用手填路径（Windows 上照旧在 PATH 里）。
 * - 这台机器上 claude 还没登录过：向导提示，但不拦；登录以后「重新检查」提示消失。
 * - gh 装了但没登录（Windows 上没有假 gh：没装）：向导里写出来，也不拦。
 * - hook 那一步的主按钮是「安装并继续」，向导只有两步再加完成页。
 * - 新建 ticket 不填仓库：概况提示先添加仓库；加上以后「开第一个 session」直接开起来。
 */
test("first run on a fresh machine: wizard, a ticket with no repo, the first session and the first Your turn card", async ({ makeSandbox, launch }) => {
  const s = makeSandbox(isWin ? { claudeOffPath: true } : { claudeOffPath: true, gh: { branches: {}, prs: {}, loggedOut: true } });
  s.env = { SHIPHERD_ACTIVITY_TICK_MS: "200" };
  const { page } = await launch(s);

  // 1. 向导第 1 步：不手填路径，claude 已经找到了（PATH 里没有时看 ~/.local/bin）。
  await expect(page.getByTestId("wizard")).toBeVisible();
  await expect(page.getByText(S.wizardStep(1, 2), { exact: true })).toBeVisible();
  await expect(kvValue(page, S.claudePath)).toHaveText(s.claudePath);
  await expect(kvValue(page, S.claudeVersion)).toHaveText("2.1.306");
  expect(s.claudeOnPath).toBe(isWin);
  await expect(page.getByTestId("wizard-gh")).toHaveText(isWin ? S.set.health.ghMissing : S.set.health.ghLoggedOut);
  await expect(page.getByText(S.wizardGhHelp, { exact: true })).toBeVisible();

  // 2. 没登录过：有提示，「下一步」照样能点。登录（Claude Code 在配置目录的 .claude.json 里记下账号）之后重新检查，提示消失。
  const login = page.getByTestId("wizard-claude-login");
  await expect(login).toHaveText(S.wizardClaudeLoginMissing);
  const next = page.getByRole("button", { name: S.wizardNext, exact: true });
  await expect(next).toBeEnabled();
  writeFileSync(join(s.claudeConfigDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "someone@example.com" } }));
  const recheck = page.getByRole("button", { name: S.recheck, exact: true });
  await recheck.click();
  // 检测中提示也是藏着的：等检测做完（按钮重新能点；点下去的那一下 React 已经同步把它设成了不能点）再看提示还在不在。
  await expect(recheck).toBeEnabled();
  await expect(login).toHaveCount(0);
  await expect(kvValue(page, S.claudePath)).toHaveText(s.claudePath);
  await next.click();

  // 3. 第 2 步：hook 还没装，主按钮是「安装并继续」，装好直接到完成页（tracker、权限档案不在第一次的向导里）。
  await expect(page.getByText(S.wizardStep(2, 2), { exact: true })).toBeVisible();
  await expect(page.getByText(S.wizardHooksHelp(s.shipherdHome), { exact: true })).toBeVisible();
  await page.getByRole("button", { name: S.wizardHooksInstallNext, exact: true }).click();
  await expect(page.getByRole("heading", { name: S.wizardDoneTitle, exact: true })).toBeVisible();
  await expect(page.getByText(S.wizardDoneHelp, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: S.wizardFinish, exact: true }).click();
  await expect(page.getByTestId("wizard")).toHaveCount(0);
  await expect(page.getByTestId("first-run-home")).toBeVisible();

  // 4. 新建 ticket，不填仓库：概况提示先添加仓库，主按钮是「添加仓库」。
  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("NEW-1");
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "NEW-1", exact: true })).toBeVisible();
  const first = page.getByTestId("ticket-first-session");
  await expect(first.getByText(S.lay.firstSessionNoRepo, { exact: true })).toBeVisible();
  await first.getByRole("button", { name: `+ ${S.lay.addRepoFirst}`, exact: true }).click();
  await page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("button", { name: S.add, exact: true }).click();
  await expect(page.locator(".modal")).toHaveCount(0);

  // 5. 有了仓库：「开第一个 session」，切到终端页签，假 claude 起来。
  await expect(first.getByText(S.lay.firstSessionHint, { exact: true })).toBeVisible();
  await first.getByRole("button", { name: S.lay.startFirstSession, exact: true }).click();
  await expect.poll(() => terminalText(page), { timeout: 20_000 }).toContain("fake claude ready");

  // 6. 让它停下来问一句：首页「轮到你」出现一张要你回答的卡片。
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type("/fake-ask");
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain(ASK_REPLY);
  await goHome(page);
  const card = page.getByTestId("turn-card");
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await expect(card).toHaveAttribute("data-kind", "answer", { timeout: 20_000 });
  await expect(card).toContainText("NEW-1");
});
