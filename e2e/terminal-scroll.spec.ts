import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, makeGitRepo, terminalText, test } from "./fixtures";

async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

/**
 * claude 的全屏界面只在启动（和改尺寸）时打开鼠标上报。输出超过回放缓冲后切到别的页面再回来，新建的终端也要照样把滚轮交给 claude
 * （以前要缩一下概览、让终端改尺寸才能滚）。
 */
test("the coordinator terminal still scrolls after its output outgrows the replay buffer and the page is reopened", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  const { page } = await launch(s);
  await completeWizard(page, s);
  const shop = join(s.dir, "shop");
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));
  await page.getByRole("button", { name: `+ ${S.newFeature}`, exact: true }).click();
  await page.getByLabel(S.featureName, { exact: true }).fill("checkout");
  const dir = page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true });
  await dir.fill(shop);
  await dir.blur();
  await expect(page.getByText(S.subReposFound(2), { exact: true })).toBeVisible();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "checkout", exact: true })).toBeVisible();
  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("DMS-1");
  await page.locator(".modal").getByRole("checkbox", { name: "backend", exact: true }).uncheck();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "DMS-1", exact: true })).toBeVisible();
  await page.locator(".feature-link").getByRole("button", { name: "checkout", exact: true }).click();

  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newCoordinator}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await typeLine(page, "/fake-fullscreen");
  // 超过 256 KB 的输出：打开鼠标上报的那几个字节被截出回放缓冲。
  // 终端已经有焦点：不再点它（鼠标上报开着，点击会变成输入）。
  await page.keyboard.type("/fake-flood 4000");
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain("flood line 4000");

  const wheels = () => fakeLog().split("\n").filter((l) => l.includes("mouse wheel up")).length;
  // 假 claude 的终端是按行交付输入的：滚完按一下回车，滚轮的上报才到。
  const scrollUp = async () => {
    const box = (await page.locator(".terminal-wrap:visible .xterm").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -300);
    await page.keyboard.press("Enter");
  };
  await scrollUp();
  await expect.poll(wheels).toBe(1);

  await page.locator(".feature-page .ticket-table").getByRole("button", { name: "DMS-1", exact: true }).click();
  await expect(page.getByRole("heading", { name: "DMS-1", exact: true })).toBeVisible();
  await page.locator(".feature-link").getByRole("button", { name: "checkout", exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("flood line 4000");
  await scrollUp();
  await expect.poll(wheels).toBe(2);
});
