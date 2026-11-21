import { existsSync, readFileSync } from "node:fs";
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
 * WS-M D：页面上只挂着看得见的那个终端的 xterm；BTL-242 起切走只是摘下来（最近看过的 4 个留着），
 * 切回来挂回同一个 xterm，不从快照重建，之前的输出还在。
 */
test("only the visible terminal is on the page, switching back re-attaches the kept xterm, and the Now page shows each session's memory", async ({ makeSandbox, launch }) => {
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
  // 摘下来以后才到的输出：挂回来时只补这一段（pty:since），不整份重放。
  await typeLine(page, "/fake-later 1500 while you were away");
  // 给这个 xterm 做个记号：切回来还是它（没有重建）。
  await page.locator(".terminals .xterm").evaluate((el) => ((el as HTMLElement).dataset.e2eMark = "first"));

  await openTicketTab(page, "terminal");
  await page.locator(".ticket-page").getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect(page.locator(".terminals .terminal-wrap")).toHaveCount(2);
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await expect.poll(() => terminalText(page)).not.toContain("first terminal says hello");
  // 等第一个终端在后台把那一行打出来（假 claude 记下了这条输入）。
  // 运行记录里那句出现两次：一次是 /fake-later 本身，一次是过后它当成输入的那一行。
  await expect.poll(() => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8").split("while you were away").length - 1 : 0)).toBeGreaterThanOrEqual(2);
  // 两个终端都开着，只有看得见的那个有 xterm。
  await expect(xterms).toHaveCount(1);

  // 切回第一个：挂回原来那个 xterm（记号还在），之前的输出还在，页面上还是只有一个 xterm。
  // 列表的顺序跟最近活动走，按标题找第一个 session（它的标题来自第一句话）。
  await page.locator(".ticket-page .session-wrap .session").filter({ hasText: "first terminal says" }).click();
  await expect.poll(() => terminalText(page)).toContain("收到：first terminal says hello");
  await expect(xterms).toHaveCount(1);
  await expect(page.locator(".terminals .xterm")).toHaveAttribute("data-e2e-mark", "first");
  await expect.poll(() => terminalText(page)).toContain("收到：while you were away");
  // 挂回来的终端照样能打字。
  await typeLine(page, "after reattach");
  await expect.poll(() => terminalText(page)).toContain("收到：after reattach");

  // WS-M A：两个 session 的整棵进程树都被量到：首页「运行情况」里有内存那一行（UI 重做第 2 层起没有逐行的读数）。
  await page.locator(".sidebar").getByRole("button", { name: S.home, exact: true }).click();
  await page.locator(".home-more-fold > h3 .section-toggle").click();
  await expect(page.locator(".now-mem-card")).toContainText(S.perf.memTitle, { timeout: 30_000 });
  await expect(page.locator(".now-mem-card")).toContainText("×2");
  await expect(page.locator(".now-mem-card")).toContainText(/\d+ (MB|GB)/);
});
