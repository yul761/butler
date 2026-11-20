import { join } from "node:path";
import type { Page } from "@playwright/test";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, makeGitRepo, terminalText, test, newButton, openTicketTab } from "./fixtures";

async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

/**
 * WS-M D：渲染进程只给看得见的那个终端建 xterm（一个 xterm 带着几千行回滚就是几十 MB），
 * 切走就拆掉，切回来从主进程的快照重建，之前的输出还在。
 */
test("only the visible terminal keeps an xterm, switching back rebuilds it from the snapshot, and the Now page shows each session's memory", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  const shop = join(s.dir, "shop");
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));
  await (await newButton(page, "newFeature")).click();
  await page.getByLabel(S.featureName, { exact: true }).fill("checkout");
  const dir = page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true });
  await dir.fill(shop);
  await dir.blur();
  await expect(page.getByText(S.subReposFound(2), { exact: true })).toBeVisible();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("DMS-1");
  await page.locator(".modal").getByRole("checkbox", { name: "frontend", exact: true }).check();
  await page.locator(".modal").getByRole("checkbox", { name: "backend", exact: true }).uncheck();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "DMS-1", exact: true })).toBeVisible();
  await page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: "DMS-1" }).click();
  await expect(page.locator(".ticket-page")).toBeVisible();

  const xterms = page.locator(".terminals .xterm");
  await openTicketTab(page, "terminal");
  await page.locator(".ticket-page").getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await typeLine(page, "first terminal says hello");
  await expect.poll(() => terminalText(page)).toContain("收到：first terminal says hello");

  await openTicketTab(page, "terminal");
  await page.locator(".ticket-page").getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect(page.locator(".terminals .terminal-wrap")).toHaveCount(2);
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await expect.poll(() => terminalText(page)).not.toContain("first terminal says hello");
  // 两个终端都开着，只有看得见的那个有 xterm。
  await expect(xterms).toHaveCount(1);

  // 切回第一个：从快照重建，之前的输出还在，还是只有一个 xterm。
  // 列表的顺序跟最近活动走，按标题找第一个 session（它的标题来自第一句话）。
  await page.locator(".ticket-page .session-wrap .session").filter({ hasText: "first terminal says" }).click();
  await expect.poll(() => terminalText(page)).toContain("收到：first terminal says hello");
  await expect(xterms).toHaveCount(1);
  // 重建出来的终端照样能打字。
  await typeLine(page, "after rebuild");
  await expect.poll(() => terminalText(page)).toContain("收到：after rebuild");

  // WS-M A：两个 session 的整棵进程树都被量到：首页「运行情况」里有内存那一行（UI 重做第 2 层起没有逐行的读数）。
  await page.locator(".sidebar").getByRole("button", { name: S.home, exact: true }).click();
  await page.locator(".home-more-fold > h3 .section-toggle").click();
  await expect(page.locator(".now-mem-card")).toContainText(S.perf.memTitle, { timeout: 30_000 });
  await expect(page.locator(".now-mem-card")).toContainText("×2");
  await expect(page.locator(".now-mem-card")).toContainText(/\d+ (MB|GB)/);
});
