import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, create, expect, makeGitRepo, newButton, newTicket, openTicketTab, test } from "./fixtures";

/**
 * BTL-242：终端默认用 WebGL 画（别的 e2e 为了读 .xterm-rows 用 DOM）。这里用默认的：画得出来（WebGL 的画布，
 * 或者机器上建不了 WebGL 时退回的 DOM 行），打的字照样到 claude。
 */
test("the terminal works with the default renderer (WebGL, or the DOM fallback)", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  s.env = { SHIPHERD_TERMINAL_RENDERER: "webgl" };
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  const { page } = await launch(s);
  await completeWizard(page, s);
  const shop = join(s.dir, "shop");
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));
  await create(page, await newButton(page, "newFeature"), S.featureName, "checkout", shop);
  await newTicket(page, "GL-1", "frontend", "backend");
  await page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: "GL-1" }).click();
  await openTicketTab(page, "terminal");
  await page.locator(".ticket-page").getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();

  const screen = page.locator(".terminal-wrap:visible .xterm-screen");
  await expect(screen).toBeVisible();
  await expect.poll(async () => (await screen.locator("canvas").count()) + (await screen.locator(".xterm-rows").count())).toBeGreaterThan(0);
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type("drawn by webgl");
  await page.keyboard.press("Enter");
  await expect.poll(fakeLog).toContain("drawn by webgl");
});
