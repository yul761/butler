import type { Page } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, openSettingsGroup, type Sandbox, terminalText, test } from "./fixtures";

const fakeLog = (s: Sandbox) => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");

async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function callTool(page: Page, s: Sandbox, tool: string, args: unknown = {}): Promise<{ error: boolean; text: string }> {
  const calls = () => [...fakeLog(s).matchAll(/ mcp result (.+)/g)].map((m) => JSON.parse(m[1]) as { isError?: boolean; content: { text: string }[] });
  const before = calls().length;
  await typeLine(page, `/fake-mcp ${tool} ${JSON.stringify(args)}`);
  await expect.poll(() => calls().length).toBe(before + 1);
  const r = calls()[before];
  return { error: r.isError === true, text: r.content[0].text };
}

/**
 * 共享 MCP（WS-M H）：打开设置后新开的 session 拿到的是 hub 上的 URL（每个终端一份配置），butler-sessions 的工具经 hub 照样能用；
 * 终端退出后它的配置文件跟着删掉。
 */
test("with the shared MCP on, a new session reaches butler-sessions through the hub", async ({ makeSandbox, launch }) => {
  test.setTimeout(180_000);
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200", BUTLER_GATE_TYPING_QUIET_MS: "1000" };
  const { page } = await launch(s);
  await completeWizard(page, s);

  await openSettingsGroup(page, "sessions");
  const box = page.getByLabel(S.perf.sharedMcp, { exact: true });
  await expect(box).not.toBeChecked();
  await box.click();
  await expect(box).toBeChecked();
  // hub 在后台启动；起来之前开的 session 用 stdio（这里要的是 hub 那条路）。
  await page.waitForTimeout(5000);

  const side = page.locator(".sidebar");
  await side.getByRole("button", { name: S.butlerNav, exact: true }).click();
  await page.locator(".butler-page").getByRole("button", { name: `+ ${S.newButlerSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await expect.poll(() => fakeLog(s)).toContain("mcp transport http");

  const terms = join(s.butlerHome, "mcp", "terms");
  const files = readdirSync(terms).filter((f) => f.endsWith(".json"));
  expect(files).toHaveLength(1);
  const config = JSON.parse(readFileSync(join(terms, files[0]), "utf8")) as { mcpServers: Record<string, { type: string; url: string }> };
  expect(Object.keys(config.mcpServers)).toEqual(["butler-workspace", "butler-sessions"]);
  for (const spec of Object.values(config.mcpServers)) expect(spec.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]{43}$/);

  const listed = await callTool(page, s, "list_sessions");
  expect(listed.error).toBe(false);
  expect(JSON.parse(listed.text)).toEqual([]);
  expect(JSON.parse((await callTool(page, s, "list_epics")).text)).toEqual([]);
  expect(JSON.parse((await callTool(page, s, "list_features")).text)).toEqual([]);

  // 终端退出：它的配置文件删掉（路由也撤了）。
  await typeLine(page, "exit");
  await expect(page.locator(".terminal-wrap:visible .exited")).toBeVisible();
  await expect.poll(() => readdirSync(terms).filter((f) => f.endsWith(".json"))).toEqual([]);
});
