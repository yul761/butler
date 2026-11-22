import type { ElectronApplication, Page } from "@playwright/test";
import { S } from "../src/renderer/src/strings";
import { IPC } from "../src/shared/ipc";
import { completeWizard, expect, newButton, openTicketTab, terminalText, test } from "./fixtures";

/** 系统浏览器换成记录：e2e 不能开浏览器，也不能抢焦点。 */
async function stubOpenExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] };
    g.opened = [];
    shell.openExternal = (async (url: string) => void g.opened.push(url)) as typeof shell.openExternal;
  });
}

const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened);

/** 鼠标移到终端里以 text 开头的那一行的开头，等 xterm 认出链接（指针变成手形）。 */
async function hoverLink(page: Page, text: string): Promise<void> {
  const row = page.locator(".terminal-wrap:visible .xterm-rows > div").filter({ hasText: text });
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
}

const pointer = (page: Page) => page.locator(".terminal-wrap:visible .xterm-screen").evaluate((e) => e.classList.contains("xterm-cursor-pointer"));

/**
 * BTL-257：终端里点链接会弹「Do you want to navigate to …?」，点确定后什么都没有（xterm 默认的 window.open 被拒）。
 * 现在 OSC 8 超链接和普通文本里的 URL 都不弹框，经 link:open 交给系统浏览器；主进程只放行 http / https。
 */
test("clicking a link in the terminal opens it in the system browser, without a confirm dialog", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { app, page } = await launch(s);
  await completeWizard(page, s);
  await stubOpenExternal(app);
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });

  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("LINK-1");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "LINK-1", exact: true })).toBeVisible();
  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type("/fake-links");
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain("file-link-text");

  // 1. OSC 8 超链接：打开的是链接的目标，不是显示的文字。
  await hoverLink(page, "osc8-link-text");
  await expect.poll(() => pointer(page)).toBe(true);
  // 显示的文字不是目标：悬停时把目标亮出来。
  await expect(page.locator(".terminal-wrap:visible .terminal-host")).toHaveAttribute("title", "https://example.com/osc8-target?from=fake");
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => opened(app)).toEqual(["https://example.com/osc8-target?from=fake"]);

  // 2. 普通文本里的 URL。
  await hoverLink(page, "https://example.com/plain-url");
  await expect.poll(() => pointer(page)).toBe(true);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => opened(app)).toEqual(["https://example.com/osc8-target?from=fake", "https://example.com/plain-url"]);

  // 3. file: 的 OSC 8 超链接不是链接：点了什么都不开。
  await hoverLink(page, "file-link-text");
  await page.mouse.down();
  await page.mouse.up();
  // 主进程那边：直接发 file: / javascript: 也被拒绝。
  const refuse = (url: string) => page.evaluate(([ch, u]) => (window as unknown as { butler: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).butler.invoke(ch, u), [IPC.linkOpen, url] as const);
  expect(await refuse("file:///etc/passwd")).toEqual({ ok: true, value: { ok: false, reason: "bad_url" } });
  expect(await refuse("javascript:alert(1)")).toEqual({ ok: true, value: { ok: false, reason: "bad_url" } });
  expect(await refuse("https://github.com@evil.example/")).toEqual({ ok: true, value: { ok: false, reason: "bad_url" } });

  // 4. 兜底：漏网的 window.open 也交给系统浏览器（只限 http / https），不开新窗口。
  await page.evaluate(() => {
    window.open("https://example.com/window-open");
    window.open("file:///etc/hosts");
  });
  await expect.poll(() => opened(app)).toEqual(["https://example.com/osc8-target?from=fake", "https://example.com/plain-url", "https://example.com/window-open"]);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  expect(dialogs).toEqual([]);
});
