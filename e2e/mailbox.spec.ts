import type { Locator, Page } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, makeGitRepo, openTab, terminalText, test, type Sandbox, newButton } from "./fixtures";

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fakeLog = (s: Sandbox) => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
const sessionsIn = (s: Sandbox, cwd: string) => [...fakeLog(s).matchAll(new RegExp(`interactive new (\\S+) mcp=\\S* cwd=${escapeRe(cwd)} `, "g"))].map((m) => m[1]);
/** 一个目录里每个 session（transcript 文件名）收到的用户输入。 */
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
const contexts = (s: Sandbox) => [...fakeLog(s).matchAll(/ additional-context (.+)/g)].map((m) => m[1]);

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

/**
 * 信箱（BTL-245）：Butler 总控给一个正在干活的 feature 总控发消息，不再被「对方在忙，稍后再试」挡回来；
 * 消息排进它的信箱，它下一次调用工具时由 PostToolUse hook 作为 additionalContext 带进去，两条合成一次。界面上的消息列表记成已送达。
 */
test("a busy coordinator gets queued messages at its next tool call, merged into one", async ({ makeSandbox, launch }) => {
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
  // 总控在干活：调了一个工具，这一轮没结束。信箱是空的，hook 什么都不带。
  await typeLine(page, '/fake-tool Read {"file_path":"a.ts"}');
  await expect.poll(() => terminalText(page)).toContain("tool Read");
  expect(contexts(s)).toEqual([]);

  await side.getByRole("button", { name: S.butlerNav, exact: true }).click();
  await page.locator(".butler-page").getByRole("button", { name: `+ ${S.newButlerSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await page.waitForTimeout(1500);
  for (const text of ["接口改成 v2 了", "先别合 PR"]) {
    const sent = await callTool(page, s, "send_message", { feature: "payment", text });
    expect(sent.error).toBe(false);
    expect(JSON.parse(sent.text)).toMatchObject({ queued: true, sessionId: coordinator, state: "busy" });
  }
  // 「消息」里两条都在排队。
  await page.locator(".messages-box > summary").click();
  const list = page.getByTestId("message-list");
  await expect(list.locator('[data-status="queued"]')).toHaveCount(2);

  // 总控下一次调用工具：两条合成一次 additionalContext 送进去。
  await side.getByRole("button", { name: "payment", exact: true }).click();
  await openTab(page, S.lay.tabControl);
  await typeLine(page, '/fake-tool Grep {"pattern":"total"}');
  await expect.poll(() => contexts(s).length).toBe(1);
  const [ctx] = contexts(s);
  expect(ctx).toContain("接口改成 v2 了");
  expect(ctx).toContain("先别合 PR");
  expect(ctx).toContain("Butler 信箱送来 2 条消息");
  // 再调一次工具：信箱空了，不再带。
  await typeLine(page, '/fake-tool Read {"file_path":"b.ts"}');
  await expect.poll(() => terminalText(page)).toContain("tool Read");
  await page.waitForTimeout(500);
  expect(contexts(s)).toHaveLength(1);

  // feature 页「总控」tab 也列着这两条，记成已送达（工具调用的间隙送到）。
  const featureList = page.locator(".feature-page .messages-box");
  await featureList.locator("> summary").click();
  await expect(featureList.locator('[data-status="delivered"]')).toHaveCount(2);
  await expect(featureList).toContainText(S.messageVia.hook);
});

/**
 * feature 总控的 send_message 只发给自己管的 session（BTL-245）；总控存进 feature 记忆的约定推给同一个 feature 里别的 session，不推给自己。
 * 子 session 停着：两条都经安全输入送进去。
 */
test("a coordinator messages its ticket session, and its convention reaches the session but not itself", async ({ makeSandbox, launch }) => {
  test.setTimeout(180_000);
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200", BUTLER_GATE_TYPING_QUIET_MS: "1000" };
  const shop = join(s.dir, "shop");
  const { page } = await launch(s);
  await completeWizard(page, s);
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));
  await create(page, await newButton(page, "newFeature"), S.featureName, "payment", shop);
  const workspace = join(s.dir, "shop-features", "payment");
  // feature 下建一个 ticket（只用 frontend）。
  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("PAY-1");
  await page.locator(".modal").getByRole("checkbox", { name: "backend", exact: true }).uncheck();
  await page.locator(".modal").getByRole("checkbox", { name: "frontend", exact: true }).check();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "PAY-1", exact: true })).toBeVisible();
  await page.locator(".feature-link").getByRole("button", { name: "payment", exact: true }).click();
  await openTab(page, S.lay.tabControl);
  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newCoordinator}`, exact: true }).click();
  await expect.poll(() => sessionsIn(s, workspace).length).toBe(1);
  const [coordinator] = sessionsIn(s, workspace);
  await expect.poll(() => terminalText(page)).toContain(`fake claude ready (${coordinator.slice(0, 8)})`);
  await page.waitForTimeout(1500);

  const started = await callTool(page, s, "start_session", { ticket: "PAY-1", task: "build-the-form" });
  expect(started.error).toBe(false);
  const { sessionId: child } = JSON.parse(started.text) as { sessionId: string };
  const worktree = join(workspace, "frontend-pay-1");
  const childGot = () => (messagesIn(s, worktree)[child] ?? []).join("\n");
  await expect.poll(childGot, { timeout: 30_000 }).toContain("build-the-form");

  // 不是自己管的：Butler 总控的 session 不行。
  const refused = await callTool(page, s, "send_message", { session: coordinator, text: "x" });
  expect(refused.error).toBe(true);
  const sent = await callTool(page, s, "send_message", { session: child, text: "表单用 v2 接口" });
  expect(sent.error).toBe(false);
  expect(JSON.parse(sent.text)).toMatchObject({ queued: true, sessionId: child });
  await expect.poll(childGot, { timeout: 30_000 }).toContain("表单用 v2 接口");

  // 总控存一条约定：推给子 session，自己的下一次工具调用不带。
  await typeLine(page, '/fake-tool mcp__butler-feature__remember {"text":"金额一律用分"}');
  await expect.poll(childGot, { timeout: 30_000 }).toContain("金额一律用分");
  expect(childGot()).toContain("【约定 · feature payment 的总控】");
  await typeLine(page, '/fake-tool Read {"file_path":"a.ts"}');
  await expect.poll(() => terminalText(page)).toContain("tool Read");
  await page.waitForTimeout(800);
  expect(contexts(s).join("\n")).not.toContain("金额一律用分");
});
