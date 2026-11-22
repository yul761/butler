import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { S } from "../src/renderer/src/strings";
import { IPC } from "../src/shared/ipc";
import { completeWizard, expect, openSettingsTab, test } from "./fixtures";

/** 浏览器和 Finder 都换成记录：e2e 不能开浏览器，也不能抢焦点。下载目录换成沙盒里的。 */
async function stubShell(app: ElectronApplication, downloads: string): Promise<void> {
  mkdirSync(downloads, { recursive: true });
  await app.evaluate(({ app: a, shell }, dl) => {
    const g = globalThis as unknown as { opened: string[]; revealed: string[] };
    g.opened = [];
    g.revealed = [];
    a.setPath("downloads", dl);
    shell.openExternal = (async (url: string) => void g.opened.push(url)) as typeof shell.openExternal;
    shell.showItemInFolder = ((p: string) => void g.revealed.push(p)) as typeof shell.showItemInFolder;
  }, downloads);
}

const recorded = (app: ElectronApplication) =>
  app.evaluate(() => {
    const g = globalThis as unknown as { opened: string[]; revealed: string[] };
    return { opened: g.opened, revealed: g.revealed };
  });

/** 菜单「帮助 → 发送反馈…」发的就是这个事件。 */
const showFromMenu = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }, ch) => BrowserWindow.getAllWindows()[0].webContents.send(ch, "sendFeedback"), IPC.appMenu);

test("Help menu has Send Feedback…", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { app, page } = await launch(s);
  await completeWizard(page, s);
  const labels = await app.evaluate(({ Menu }) => {
    const help = Menu.getApplicationMenu()?.items.find((i) => i.role === "help");
    return help?.submenu?.items.map((i) => i.label) ?? [];
  });
  expect(labels).toContain("发送反馈…");
});

test("send feedback opens a prefilled GitHub issue page and sends nothing itself", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { app, page } = await launch(s);
  await completeWizard(page, s);
  await stubShell(app, join(s.dir, "downloads"));

  await showFromMenu(app);
  await expect(page.getByTestId("feedback-dialog")).toBeVisible();
  await expect(page.getByTestId("feedback-attach")).not.toBeChecked();
  await page.getByTestId("feedback-kind-idea").check();
  await page.getByTestId("feedback-title").fill("Group tickets by repo");
  await page.getByTestId("feedback-description").fill("A toggle on the epic page.");
  await page.getByTestId("feedback-submit").click();
  await expect(page.getByTestId("feedback-done")).toBeVisible();

  const { opened, revealed } = await recorded(app);
  expect(opened).toHaveLength(1);
  const u = new URL(opened[0]);
  expect(`${u.origin}${u.pathname}`).toBe("https://github.com/yul761/butler/issues/new");
  expect(u.searchParams.get("template")).toBe("idea.yml");
  expect(u.searchParams.get("title")).toBe("Group tickets by repo");
  expect(u.searchParams.get("description")).toBe("A toggle on the epic page.");
  const envText = u.searchParams.get("environment")!;
  expect(envText).toContain("Claude Code: 2.1.306");
  expect(envText).toMatch(/Butler: \d+\.\d+\.\d+/);
  expect(u.searchParams.has("diagnostics")).toBe(false);
  expect(revealed).toEqual([]);
  await page.getByRole("button", { name: S.feedback.close, exact: true }).click();
  await expect(page.getByTestId("feedback-done")).toHaveCount(0);
});

test("attached diagnostics are redacted, shown first, then saved to Downloads and selected", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { app, page } = await launch(s);
  await completeWizard(page, s);
  const downloads = join(s.dir, "downloads");
  await stubShell(app, downloads);

  // 设置 › 关于里的同一个按钮。
  await openSettingsTab(page, "about");
  await page.getByTestId("feedback-open").click();
  await expect(page.getByTestId("feedback-kind-bug")).toBeChecked();
  await page.getByTestId("feedback-attach").check();
  await page.getByTestId("feedback-submit").click();
  const preview = page.getByTestId("feedback-preview-text");
  await expect(preview).toContainText('"redacted": true');
  const text = (await preview.textContent())!;
  // 沙盒的路径（Butler 的数据目录故意带空格）一个都不能留下。
  for (const leak of [s.dir, s.butlerHome, s.claudeConfigDir]) expect(text).not.toContain(leak);
  // 还没确认：什么都没存。
  expect(readdirSync(downloads)).toEqual([]);

  await page.getByTestId("feedback-save").click();
  await expect(page.getByTestId("feedback-saved")).toBeVisible();
  const files = readdirSync(downloads);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^butler-diagnostics-redacted-.*\.json$/);
  const saved = join(downloads, files[0]);
  expect(readFileSync(saved, "utf8")).toBe(text);
  const { opened, revealed } = await recorded(app);
  expect(revealed).toEqual([saved]);
  expect(opened).toHaveLength(1);
  const u = new URL(opened[0]);
  expect(u.searchParams.get("template")).toBe("bug.yml");
  expect(u.searchParams.get("diagnostics")).toContain(files[0]);
  expect(existsSync(saved)).toBe(true);
});
