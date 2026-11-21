import type { Locator, Page } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, makeGitRepo, openTab, terminalText, test, type Sandbox, newButton } from "./fixtures";

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fakeLog = (s: Sandbox) => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
const sessionsIn = (s: Sandbox, cwd: string) => [...fakeLog(s).matchAll(new RegExp(`interactive new (\\S+) mcp=\\S* cwd=${escapeRe(cwd)} `, "g"))].map((m) => m[1]);

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

async function create(page: Page, open: Locator, label: string, name: string, dir: string): Promise<void> {
  await open.click();
  await page.getByLabel(label, { exact: true }).fill(name);
  const box = page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true });
  await box.fill(dir);
  await box.blur();
  await expect(page.getByText(S.subReposFound(2), { exact: true })).toBeVisible();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

/** Windows 的终端把粘贴进去的换行变成空格：比较前把空白合成一个空格。 */
const flat = (m: string | undefined): string => (m ?? "").replace(/\s+/g, " ");

/** 这个目录里每个 session 收到的用户消息（session id → 消息）。 */
function messagesIn(s: Sandbox, cwd: string): Record<string, string[]> {
  const dir = join(s.claudeConfigDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => {
      const entries = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; message: { content: unknown } });
      return [f.replace(/\.jsonl$/, ""), entries.filter((e) => e.type === "user" && typeof e.message.content === "string").map((e) => e.message.content as string)];
    }),
  );
}

/**
 * Butler 总控给 feature 总控发消息：终端开着时直接发；终端关了（闲置时自动关掉、Butler 重启过）时 list_sessions 里没有它，
 * 但 send_message 按 feature 名字照样能发：Butler 接着它最近的对话打开，再把消息交进去。
 */
test("Butler control messages a feature coordinator by name, reopening it when its terminal was closed", async ({ makeSandbox, launch }) => {
  test.setTimeout(180_000);
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200", BUTLER_GATE_TYPING_QUIET_MS: "1000" };
  const shop = join(s.dir, "shop");
  const { page } = await launch(s);
  await completeWizard(page, s);
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));
  const side = page.locator(".sidebar");
  await create(page, await newButton(page, "newFeature"), S.featureName, "payment", shop);
  const workspace = join(s.dir, "shop-features", "payment");
  await openTab(page, S.lay.tabControl);
  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newCoordinator}`, exact: true }).click();
  await expect.poll(() => sessionsIn(s, workspace).length).toBe(1);
  const [coordinator] = sessionsIn(s, workspace);
  await expect.poll(() => terminalText(page)).toContain(`fake claude ready (${coordinator.slice(0, 8)})`);
  // 说过话的 session 才留得下来。然后退出：session 还在列表里，终端关了。
  await typeLine(page, "hello");
  await expect.poll(() => terminalText(page)).toContain("收到：hello");
  await typeLine(page, "exit");
  await expect(page.locator(".terminal-wrap:visible .exited")).toBeVisible();

  await side.getByRole("button", { name: S.butlerNav, exact: true }).click();
  await page.locator(".butler-page").getByRole("button", { name: `+ ${S.newButlerSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");

  // 关着的总控不在 list_sessions 里，list_epics 也说它没在跑。
  expect(JSON.parse((await callTool(page, s, "list_sessions")).text)).toEqual([]);
  expect(JSON.parse((await callTool(page, s, "list_epics")).text)).toMatchObject([{ name: "payment", coordinatorRunning: false, coordinatorSession: null, features: [] }]);

  // 按 feature 名字发：接着原来的总控打开，消息交进去。
  const sent = await callTool(page, s, "send_message", { epic: "payment", text: "去看一下 PR" });
  expect(sent.error).toBe(false);
  expect(JSON.parse(sent.text)).toMatchObject({ queued: true, sessionId: coordinator, opened: "resumed" });
  await expect.poll(() => fakeLog(s)).toContain(`interactive resume ${coordinator} `);
  await expect.poll(() => flat(messagesIn(s, workspace)[coordinator]?.at(-1))).toContain("Butler 总控发来的消息（你这一轮做完时的最后一段回复会转给它）： 去看一下 PR");
  expect(sessionsIn(s, workspace)).toEqual([coordinator]);

  // 现在开着：list_epics 给出它的 id，按 id 发直接发进去，不再开新的。
  await expect.poll(async () => JSON.parse((await callTool(page, s, "list_epics")).text)[0].coordinatorSession).toBe(coordinator);
  await page.waitForTimeout(1500);
  const again = await callTool(page, s, "send_message", { session: coordinator, text: "再看一下" });
  expect(JSON.parse(again.text)).toMatchObject({ queued: true, sessionId: coordinator });
  expect(JSON.parse(again.text).opened).toBeUndefined();
  await expect.poll(() => flat(messagesIn(s, workspace)[coordinator]?.at(-1))).toContain("Butler 总控发来的消息（你这一轮做完时的最后一段回复会转给它）： 再看一下");
  expect(fakeLog(s).match(new RegExp(`interactive resume ${coordinator} `, "g"))).toHaveLength(1);
});

/**
 * 刚开的 feature 总控没人打过字：claude 停在空输入框上，不会有 Stop。Butler 总控给它发消息不能被当成“忙”挡回来（BTL-190 follow-up D）。
 */
test("Butler control messages an open feature coordinator nobody has typed into", async ({ makeSandbox, launch }) => {
  test.setTimeout(180_000);
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200", BUTLER_GATE_TYPING_QUIET_MS: "1000" };
  const shop = join(s.dir, "shop");
  const { page } = await launch(s);
  await completeWizard(page, s);
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));
  const side = page.locator(".sidebar");
  await create(page, await newButton(page, "newFeature"), S.featureName, "checkout-revamp", shop);
  const workspace = join(s.dir, "shop-features", "checkout-revamp");
  await openTab(page, S.lay.tabControl);
  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newCoordinator}`, exact: true }).click();
  await expect.poll(() => sessionsIn(s, workspace).length).toBe(1);
  const [coordinator] = sessionsIn(s, workspace);
  await expect.poll(() => terminalText(page)).toContain(`fake claude ready (${coordinator.slice(0, 8)})`);
  // 什么都不输入：直接去 Butler 总控那里发。
  await side.getByRole("button", { name: S.butlerNav, exact: true }).click();
  await page.locator(".butler-page").getByRole("button", { name: `+ ${S.newButlerSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await page.waitForTimeout(1500);

  const sent = await callTool(page, s, "send_message", { epic: "checkout-revamp", text: "先看一下规划" });
  expect(sent.error).toBe(false);
  expect(JSON.parse(sent.text)).toMatchObject({ queued: true, sessionId: coordinator });
  expect(JSON.parse(sent.text).opened).toBeUndefined();
  await expect.poll(() => flat(messagesIn(s, workspace)[coordinator]?.at(-1))).toContain("Butler 总控发来的消息（你这一轮做完时的最后一段回复会转给它）： 先看一下规划");
  expect(sessionsIn(s, workspace)).toEqual([coordinator]);

  // 回复回流（ws-b）：epic 总控这一轮做完，它最后一段回复带着 requestId 经信箱送回 Butler 总控；「消息」里记着已回复（BTL-245）。
  const { requestId } = JSON.parse(sent.text) as { requestId: string };
  expect(requestId).toMatch(/\S/);
  const butlerWorkspace = join(s.butlerHome, "workspaces", "_butler");
  const back = () => Object.values(messagesIn(s, butlerWorkspace)).flat().map(flat).find((m) => m.includes("【回复】"));
  await expect.poll(back, { timeout: 30_000 }).toContain(requestId);
  expect(back()).toContain("收到：");
  await page.locator(".messages-box > summary").click();
  await expect(page.getByTestId("message-list")).toContainText(S.messageStatus.replied);
});
