import type { Page } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, openSettingsGroup, type Sandbox, terminalText, test } from "./fixtures";

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fakeLog = (s: Sandbox) => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");

async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

/** 这个目录里某个 session 收到的用户消息。 */
function messagesOf(s: Sandbox, cwd: string, id: string): string[] {
  const dir = join(s.claudeConfigDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  const file = join(dir, `${id}.jsonl`);
  if (!existsSync(dir) || !readdirSync(dir).includes(`${id}.jsonl`)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; isMeta?: boolean; message: { content: unknown } })
    .filter((e) => e.type === "user" && !e.isMeta && typeof e.message.content === "string").map((e) => e.message.content as string);
}

/**
 * 休眠（WS-M B）：停着、看不见的总控被结束掉，只留下对话记录；子 session 给它的汇报把它唤醒（claude --resume），
 * 汇报送进去，休眠前的对话还在。
 */
test("a hibernated coordinator wakes for a report, gets it, and still has its conversation", async ({ makeSandbox, launch }) => {
  test.setTimeout(180_000);
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200", BUTLER_GATE_TYPING_QUIET_MS: "1000", BUTLER_HIBERNATE_AFTER_MS: "3000" };
  const { page } = await launch(s);
  await completeWizard(page, s);

  // 设置 → 常规：打开休眠；存下来以后重新打开还是开着。
  await openSettingsGroup(page, "sessions");
  // 开关跟着存下的值走：点完等它存好。
  await page.getByLabel(S.hib.settings.enabled, { exact: true }).click();
  await expect(page.getByLabel(S.hib.settings.enabled, { exact: true })).toBeChecked();
  await expect(page.getByLabel(S.hib.settings.pressure, { exact: true })).not.toBeChecked();
  await page.reload();
  await openSettingsGroup(page, "sessions");
  await expect(page.getByLabel(S.hib.settings.enabled, { exact: true })).toBeChecked();

  // ticket 带一个 worktree 仓库：一个总控、一个普通 session。
  await page.getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("HIB-1");
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "HIB-1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `+ ${S.addRepo}`, exact: true }).click();
  await page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("radio", { name: S.worktree, exact: true }).check();
  await page.getByRole("button", { name: S.add, exact: true }).click();
  await expect(page.locator(".modal")).toHaveCount(0);

  await page.getByRole("button", { name: `+ ${S.newCoordinator}`, exact: true }).click();
  const workspace = join(s.butlerHome, "workspaces", "HIB-1");
  const coordinatorLine = new RegExp(`interactive new (\\S+) mcp=\\S* cwd=${escapeRe(workspace)} `);
  await expect.poll(() => fakeLog(s)).toMatch(coordinatorLine);
  const coordinator = coordinatorLine.exec(fakeLog(s))![1];
  await expect.poll(() => terminalText(page)).toContain(`fake claude ready (${coordinator.slice(0, 8)})`);
  await typeLine(page, "remember-me-42");
  await expect.poll(() => terminalText(page)).toContain("收到：remember-me-42");

  // 开一个普通 session：总控的终端看不见了，停够了就休眠。
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const coordinatorButton = page.locator(".sessions-bar .session-wrap").filter({ has: page.locator(".place", { hasText: new RegExp(`^${escapeRe(S.coordinator)}$`) }) });
  await expect(coordinatorButton.locator(".hib-badge")).toHaveText(S.hib.badge, { timeout: 30_000 });
  await expect(coordinatorButton.locator(".session .action")).toHaveText(S.hib.open);
  await expect(coordinatorButton.getByRole("button", { name: new RegExp(`^${escapeRe(S.hib.pinNamed(""))}`) })).toBeVisible();

  // 普通 session 给总控汇报：总控醒来（--resume 同一个 session），汇报送进去。
  const mcpResults = () => [...fakeLog(s).matchAll(/ mcp result (.+)/g)].length;
  await typeLine(page, `/fake-mcp report ${JSON.stringify({ text: "child-done-7", kind: "done" })}`);
  await expect.poll(mcpResults).toBe(1);
  await expect.poll(() => fakeLog(s), { timeout: 30_000 }).toContain(`interactive resume ${coordinator} `);
  await expect.poll(() => messagesOf(s, workspace, coordinator).at(-1) ?? "", { timeout: 30_000 }).toContain("child-done-7");

  // 切过去（它要是又睡了，切过去也会唤醒）：原来的对话还在。
  await coordinatorButton.locator(".session").click();
  await expect(coordinatorButton.locator(".hib-badge")).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain(`fake claude ready (${coordinator.slice(0, 8)})`);
  await typeLine(page, "/fake-recall");
  await expect.poll(() => fakeLog(s)).toMatch(/fake-recall \[.*"remember-me-42".*child-done-7.*\]/);
  // 从头到尾就开过这一个总控：醒来都是 --resume，没有新开。
  expect(fakeLog(s).match(new RegExp(coordinatorLine.source, "g"))).toHaveLength(1);
});
