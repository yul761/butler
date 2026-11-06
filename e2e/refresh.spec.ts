import type { Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, terminalText, test, type Sandbox } from "./fixtures";

/**
 * 上下文换新（计划 16 任务 7）：假 claude 的每条回复都带 usage（上下文是 FAKE_CLAUDE_CONTEXT_TOKENS，/clear 之后从头算），
 * 认 /handoff（输出 butler-handoff 代码块）和 /clear（换新的 session id，SessionStart 的 source 是 clear，没有 Stop）。
 * 活动 tick、用量扫描和"刚打过字"的间隔都调短；终端里早已滚走的输入按假 claude 记下的 prompt 行核对。
 */

/** 用量扫描、活动 tick、打字之后不自动输入、刚打开的终端不自动换新的间隔（e2e 专用的环境变量，只在后台窗口模式下算数）。 */
const FAST = { BUTLER_ACTIVITY_TICK_MS: "200", BUTLER_USAGE_SCAN_MS: "200", BUTLER_GATE_TYPING_QUIET_MS: "1000", BUTLER_REFRESH_OPEN_QUIET_MS: "1000" };
/** 换新的最后一步输入的那句话的开头（src/main/strings.ts 的 refreshResume）。 */
const RESUME = "上下文已由 Butler 换新。先用 recall 调出";
/** 假 claude 的 /handoff 输出（fake-claude.cjs 的 COMMAND_HANDOFF）里做完的事。 */
const HANDOFF_DONE = "结账页写完";

const fakeLog = (s: Sandbox) => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
/** 假 claude 按顺序收到的每条输入。 */
const prompts = (s: Sandbox) => [...fakeLog(s).matchAll(/ prompt (.+)$/gm)].map((m) => JSON.parse(m[1]) as string);
/** /clear 换出来的新 session id。 */
const clearedIds = (s: Sandbox) => [...fakeLog(s).matchAll(/ clear (\S+)$/gm)].map((m) => m[1]);
/** 输入按种类归一：换新的那句话只留 "resume"，其余原样（/clear 也是一条输入）。 */
const steps = (s: Sandbox) => prompts(s).map((p) => (p.startsWith(RESUME) ? "resume" : p));

/** 在当前显示的终端里输入一行并回车。 */
async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

/** 新建一个单独的 ticket（worktree 方式），建完停在 ticket 页。 */
async function newTicket(page: Page, s: Sandbox, key: string): Promise<void> {
  await page.getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill(key);
  // 这个 label 里还包着“选择…”按钮，输入框的可访问名是两段文字连起来。
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: key, exact: true })).toBeVisible();
}

/** session 栏里当前那个 session 的 id（title 的第二行）。换新以后是链上新的 head。 */
async function activeSessionId(page: Page): Promise<string | undefined> {
  return (await page.locator(".sessions-bar .session.active").getAttribute("title"))?.split("\n")[1];
}

/** 在当前 ticket 页开一个新 session，等假 claude 就绪；返回它的 session id。 */
async function openSession(page: Page): Promise<string> {
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const id = await activeSessionId(page);
  expect(id).toBeTruthy();
  return id!;
}

/** 当前 session 旁边的 ↻。可访问名里带着 session 的名字（第一句话），换新以后会变，所以只按前后缀认。 */
function refreshButton(page: Page) {
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const [before, after] = S.refreshSessionNamed("\0").split("\0").map(escape);
  return page
    .locator(".sessions-bar .session-wrap")
    .filter({ has: page.locator(".session.active") })
    .getByRole("button", { name: new RegExp(`^${before}.+${after}$`) });
}

/** 设置 → 常规：自动换新的阈值。 */
async function setThreshold(page: Page, tokens: string): Promise<void> {
  await page.getByRole("button", { name: S.settings, exact: true }).click();
  const input = page.locator(".field").filter({ hasText: S.refreshThreshold }).locator("input");
  await input.fill(tokens);
  await input.blur();
  // 存下来以后草稿清掉，显示的就是存下的值；重新打开设置页还是它。
  await page.reload();
  await page.getByRole("button", { name: S.settings, exact: true }).click();
  await expect(page.locator(".field").filter({ hasText: S.refreshThreshold }).locator("input")).toHaveValue(tokens);
}

/** 换新完成之后：ticket 页的 handoff 历史里多了一条 /handoff 的，记忆里有这份交接。 */
async function expectHandoffStored(page: Page): Promise<void> {
  await page.getByRole("button", { name: S.historyTab(1), exact: true }).click();
  const entry = page.locator(".handoff-entry");
  await expect(entry).toHaveCount(1);
  await expect(entry.locator(".muted").first()).toHaveText(S.handoffTrigger.command);
  await expect(entry).toContainText(HANDOFF_DONE);
  await page.getByRole("button", { name: S.memoryTab, exact: true }).click();
  await expect(page.locator(".memory-handoff pre")).toContainText(HANDOFF_DONE);
}

/** 失败时把假 claude 的记录和 Butler 的日志打出来（沙盒也会留下）。 */
async function withLogs(s: Sandbox, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (e) {
    for (const f of [s.fakeLog, join(s.butlerHome, "logs", "main.log")]) if (existsSync(f)) console.log(`--- ${f}\n${readFileSync(f, "utf8")}`);
    throw e;
  }
}

/**
 * 自动换新：judgeDelayMs 是「需要你」判断要花的时间。R33：/handoff 那条回复停下来以后判断还没出结论，
 * 换新不能因此停在 /clear 之前（判断真说需要你才停）。
 */
for (const { title, judgeDelayMs } of [
  { title: "a long session is refreshed automatically and resumes from memory", judgeDelayMs: 0 },
  { title: "an automatic refresh waits out a slow needs-you judge instead of stopping", judgeDelayMs: 3000 },
]) test(title, async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  // 换新之前的每条回复都说上下文有 5000，超过阈值 1000；/clear 之后回到 500，不会再换一次。
  s.env = { ...FAST, FAKE_CLAUDE_CONTEXT_TOKENS: "5000", FAKE_CLAUDE_JUDGE_DELAY_MS: String(judgeDelayMs) };
  const { page } = await launch(s);
  await withLogs(s, async () => {
    await completeWizard(page, s);
    await setThreshold(page, "1000");
    await newTicket(page, s, "RF-1");
    const first = await openSession(page);

    // 1. 回一句话停下：用量扫描读到 5000 的上下文，Butler 自己开始换新。
    await typeLine(page, "hello");
    await expect.poll(() => terminalText(page)).toContain("收到：hello");

    // 2. /handoff → 收进来 → /clear → 新 id 接上 → 接着做的话，按这个顺序，各一次。
    await expect.poll(() => steps(s), { timeout: 90_000 }).toEqual(["hello", "/handoff", "/clear", "resume"]);
    const cleared = clearedIds(s);
    expect(cleared).toHaveLength(1);
    // 接着做的那句话点名这个 ticket。
    expect(prompts(s)[3]).toContain("RF-1");
    // 终端还是同一个，session 栏里当前的 session 换成了新 id；它回了话。
    await expect.poll(() => activeSessionId(page)).toBe(cleared[0]);
    expect(cleared[0]).not.toBe(first);
    await expect.poll(() => terminalText(page)).toContain(`收到：${RESUME}`);
    await expect(page.locator(".terminal-wrap")).toHaveCount(1);

    // 3. ticket 页：handoff 历史里多了一条 /handoff 的；记忆里有它（新 session 就是从这里接上的）。
    await expectHandoffStored(page);
    // 新的一段上下文没过阈值：不会再换一次。
    await page.waitForTimeout(2000);
    expect(steps(s)).toEqual(["hello", "/handoff", "/clear", "resume"]);
  });
});

test("the refresh button works and a draft blocks it", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  // 默认阈值（15 万）远高于假 claude 的上下文：不会自动换新，只有按钮。
  s.env = FAST;
  const { page } = await launch(s);
  await withLogs(s, async () => {
    await completeWizard(page, s);
    await newTicket(page, s, "RF-2");
    const first = await openSession(page);
    await typeLine(page, "hello");
    await expect.poll(() => terminalText(page)).toContain("收到：hello");

    // 1. 输入框里留了几个字没回车：等"刚打过字"的 1 秒过去，草稿照样挡着，按钮上显示"在忙"，什么都没输入。
    await page.locator(".terminal-wrap:visible .xterm").click();
    await page.keyboard.type("half");
    await page.waitForTimeout(1500);
    const button = refreshButton(page);
    await button.click();
    await expect(button).toHaveText(S.refreshRefused.busy);
    await expect(button).toHaveAttribute("title", S.refreshRefused.busy);
    expect(steps(s)).toEqual(["hello"]);

    // 2. 回车把草稿发出去，再点：这次开始换新，三步都输入了。
    await page.locator(".terminal-wrap:visible .xterm").click();
    await page.keyboard.press("Enter");
    await expect.poll(() => terminalText(page)).toContain("收到：half");
    // 刚回车、它还在回话时点会是"在忙"：点到开始为止。开始以后再点是"正在换新"，不会再起一次。
    await expect(async () => {
      await button.click();
      await expect.poll(() => steps(s), { timeout: 2000 }).toContain("/handoff");
    }).toPass({ timeout: 30_000 });
    await expect.poll(() => steps(s), { timeout: 90_000 }).toEqual(["hello", "half", "/handoff", "/clear", "resume"]);
    const cleared = clearedIds(s);
    expect(cleared).toHaveLength(1);
    await expect.poll(() => activeSessionId(page)).toBe(cleared[0]);
    expect(cleared[0]).not.toBe(first);
    await expect.poll(() => terminalText(page)).toContain(`收到：${RESUME}`);
    // 做完以后按钮回到 ↻。
    await expect(refreshButton(page)).toHaveText("↻");

    // 3. handoff 历史里多了一条 /handoff 的，记忆里也有。
    await expectHandoffStored(page);
  });
});
