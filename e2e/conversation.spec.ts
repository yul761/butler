import type { Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resetClock } from "../src/renderer/src/availability-view";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, newButton, openTicketTab, type Sandbox, terminalText, test } from "./fixtures";

/**
 * 对话 tab 和分叉讨论（UI 重做第 5 层）：假 claude 把 -p 不带 --json-schema 的调用当分叉讨论，
 * 运行记录里写 fork-run <参数> 和 fork-session <回的 id>，回「分叉回答：<最后一行>」；要结论时回「结论：把 X 改成 Y」；
 * FAKE_CLAUDE_FORK=limit:<秒级时间戳> 时撞额度。开发 session 收到的每条输入按假 claude 记下的 prompt 行核对。
 */

/** 用量扫描、活动 tick、打字之后不自动输入、刚打开的终端不自动换新的间隔（同 refresh.spec.ts）。 */
const FAST = { BUTLER_ACTIVITY_TICK_MS: "200", BUTLER_USAGE_SCAN_MS: "200", BUTLER_GATE_TYPING_QUIET_MS: "1000", BUTLER_REFRESH_OPEN_QUIET_MS: "1000" };
/** 换新的最后一步输入的那句话的开头（src/main/strings.ts 的 refreshResume）。 */
const RESUME = "上下文已由 Butler 换新。先用 recall 调出";
/** 假 claude 回的结论（fake-claude.cjs 的 FORK_CONCLUSION）里要开发 session 做的事。 */
const CONCLUSION = "把 X 改成 Y";

const fakeLog = (s: Sandbox) => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
/** 开发 session 按顺序收到的每条输入。 */
const prompts = (s: Sandbox) => [...fakeLog(s).matchAll(/ prompt (.+)$/gm)].map((m) => JSON.parse(m[1]) as string);
/** 每次分叉讨论的命令行参数。 */
const forkRuns = (s: Sandbox) => [...fakeLog(s).matchAll(/ fork-run (.+)$/gm)].map((m) => JSON.parse(m[1]) as string[]);
/** 每次分叉讨论回的 session id。 */
const forkSessions = (s: Sandbox) => [...fakeLog(s).matchAll(/ fork-session (\S+)$/gm)].map((m) => m[1]);
/** 「--resume」后面那个值；没有就是 null。 */
const resumeOf = (argv: string[]) => (argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : null);

async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

/** 新建一个单独的 ticket（worktree 方式），建完停在 ticket 页。 */
async function newTicket(page: Page, s: Sandbox, key: string): Promise<void> {
  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill(key);
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: key, exact: true })).toBeVisible();
}

/** 当前 session 旁边的 ↻（同 refresh.spec.ts）：可访问名里带着 session 的名字，只按前后缀认。 */
function refreshButton(page: Page) {
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const [before, after] = S.refreshSessionNamed("\0").split("\0").map(escape);
  return page
    .locator(".sessions-bar .session-wrap")
    .filter({ has: page.locator(".session.active") })
    .getByRole("button", { name: new RegExp(`^${before}.+${after}$`) });
}

/** 对话 tab 底下的输入框：选「发给」，填一句话；返回「发送」按钮（连点的步骤要自己点）。 */
async function draftTo(page: Page, target: "dev" | "fork", text: string) {
  const bar = page.locator(".conv-input");
  const radio = bar.getByRole("radio", { name: target === "dev" ? S.conv.toDev : S.conv.toFork, exact: true });
  await radio.click();
  await expect(radio).toHaveAttribute("aria-checked", "true");
  await bar.locator("textarea").fill(text);
  return bar.getByRole("button", { name: S.conv.send, exact: true });
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

test("a forked discussion answers, continues, sends its conclusion, is remembered, and survives a refresh and a usage limit", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  s.env = FAST;
  const first = await launch(s);
  let page = first.page;
  await withLogs(s, async () => {
    await completeWizard(page, s);
    await newTicket(page, s, "E2E-7");
    await openTicketTab(page, "terminal");
    await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
    await expect.poll(() => terminalText(page)).toContain("fake claude ready");
    await typeLine(page, "hello");
    await expect.poll(() => terminalText(page)).toContain("收到：hello");

    // 对话 tab：这一轮已经记进来了。
    await openTicketTab(page, "conversation");
    const conv = page.locator(".conv");
    await expect(conv.locator(".feed .msg-u")).toContainText([`${S.conv.you}hello`]);
    await expect(conv.locator(".feed .msg-a")).toContainText(["收到：hello"]);
    const boxes = conv.locator(".fork");

    // 1. 分叉：「只问不改」问「为什么？」。黄框里有回答和这一轮的花费；参数是分叉的那套（不带 headless 的两样，权限是 dontAsk）。
    await (await draftTo(page, "fork", "为什么？")).click();
    await expect(boxes).toHaveCount(1);
    const box = boxes.first();
    await expect(box.locator(".h")).toHaveText(S.conv.forkHead);
    await expect(box.locator(".msg-u")).toHaveText([`${S.conv.you}为什么？`]);
    await expect(box.locator(".msg-a")).toHaveText(["分叉回答：为什么？"]);
    expect(forkRuns(s)).toHaveLength(1);
    const run1 = forkRuns(s)[0];
    // 花费：CLI 的 total_cost_usd 是累计的。精简的第一轮是全新 session，就是这一轮的 0.02；完整的（--fork-session）带着开发 session
    // 以前的花费（假 claude 当它花过 1.00），只能按用量估，e2e 的价格表里没有这个模型 → 费用未知。绝不能显示成 $1.02。
    const full = run1.includes("--fork-session");
    await expect(box.locator(".conv-mode")).toContainText(full ? S.conv.costUnknown : "$0.02");
    expect(run1).not.toContain("--no-session-persistence");
    expect(run1).not.toContain("--json-schema");
    expect(run1).toContain("dontAsk");
    // 主流对话里没有这段讨论。
    await expect(conv.locator(".feed > .msg-u")).toHaveText([`${S.conv.you}hello`]);

    // 2. 接着问：回答进了同一个框；接着上一轮分叉出来的那个 session，不再分叉。
    await box.getByRole("button", { name: S.conv.actFollowUp, exact: true }).click();
    await box.locator(".fork-ask textarea").fill("还有呢？");
    await box.locator(".fork-ask").getByRole("button", { name: S.conv.send, exact: true }).click();
    await expect(box.locator(".msg-a")).toHaveText(["分叉回答：为什么？", "分叉回答：还有呢？"]);
    // 接着问只加这一轮的 0.02（跟上次见到的累计取差），不是 CLI 报的累计。
    await expect(box.locator(".conv-mode")).toContainText(full ? S.conv.costAtLeast("$0.02") : "$0.04");
    await expect(boxes).toHaveCount(1);
    expect(forkRuns(s)).toHaveLength(2);
    const run2 = forkRuns(s)[1];
    expect(resumeOf(run2)).toBe(forkSessions(s)[0]);
    expect(run2).not.toContain("--fork-session");

    // 3. 按这个改：先在讨论里要一句结论，再把它发给开发 session。
    await box.getByRole("button", { name: S.conv.actSend, exact: true }).click();
    await expect(box.locator(".fork-sent")).toContainText(S.conv.sentAt(""));
    await expect.poll(() => prompts(s).some((p) => p.includes(CONCLUSION))).toBe(true);
    await expect(box.locator(".msg-a").last()).toHaveText(`结论：${CONCLUSION}`);

    // 4. 记进记忆：e2e 的记忆是开着的（设置的默认值），结论真的写进了这个 ticket 的记忆。
    const remember = box.getByRole("button", { name: S.conv.actRemember, exact: true });
    await expect(remember).toBeEnabled();
    await remember.click();
    await expect(box.locator(".fork-notice")).toHaveText(S.conv.remembered);

    // 6. 发给开发 session：「继续」进了终端。
    const devPrompts = prompts(s).length;
    await (await draftTo(page, "dev", "继续")).click();
    await expect.poll(() => prompts(s).slice(devPrompts)).toContain("继续");
    await expect(page.locator(".conv-input textarea")).toHaveValue("");
    await expect(page.locator(".conv-input .conv-notice")).toHaveCount(0);

    // 7. 连点发送：只开一个新的讨论，只跑一次。
    const runsBefore = forkRuns(s).length;
    await (await draftTo(page, "fork", "第三个问题")).dblclick();
    await expect(boxes).toHaveCount(2);
    await expect(boxes.nth(1).locator(".msg-a")).toHaveText(["分叉回答：第三个问题"]);
    // 这一轮跑完了（回了 session id）之后也没有第二次起跑。
    await expect.poll(() => forkSessions(s).length).toBe(runsBefore + 1);
    expect(forkRuns(s)).toHaveLength(runsBefore + 1);
    await expect(boxes).toHaveCount(2);
    // 对话长到超出一屏以后，滚到底，输入框整个在窗口里。
    const fit = await page.locator(".conv-input").evaluate((input) => {
      let scroller = input.parentElement;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      const el = scroller ?? document.scrollingElement!;
      const overflowed = el.scrollHeight > el.clientHeight;
      el.scrollTop = el.scrollHeight;
      const r = input.getBoundingClientRect();
      return { overflowed, top: r.top, bottom: r.bottom, viewport: window.innerHeight };
    });
    expect(fit.overflowed).toBe(true);
    expect(fit.top).toBeGreaterThanOrEqual(0);
    expect(fit.bottom).toBeLessThanOrEqual(fit.viewport);

    // 并排显示终端：对话和这个 session 的终端左右排开；收起后回到只有对话。
    await conv.getByRole("button", { name: S.conv.sideTerminal, exact: true }).click();
    const split = page.locator(".conv-split");
    await expect(split).toBeVisible();
    await expect.poll(() => split.locator(".conv-term .xterm-rows").innerText()).toContain("收到：继续");
    await split.getByRole("button", { name: S.conv.hideTerminal, exact: true }).click();
    await expect(split).toHaveCount(0);

    // 换新上下文：对话里多一条分隔线，两个黄框都还在。
    await openTicketTab(page, "terminal");
    const button = refreshButton(page);
    await expect(async () => {
      await button.click();
      await expect.poll(() => prompts(s), { timeout: 2000 }).toContain("/handoff");
    }).toPass({ timeout: 30_000 });
    await expect.poll(() => prompts(s).some((p) => p.startsWith(RESUME)), { timeout: 90_000 }).toBe(true);
    await expect.poll(() => terminalText(page)).toContain(`收到：${RESUME}`);
    await openTicketTab(page, "conversation");
    await expect(conv.locator(".feed .sep")).toHaveCount(1);
    await expect(boxes).toHaveCount(2);
    await expect(boxes.first().locator(".msg-a").first()).toHaveText("分叉回答：为什么？");
    // 换新后 Butler 自己输入的那句（refreshResume）不算用户说的话，对话里没有它的「你：」（第 4 层）。
    expect((await conv.locator(".feed .msg-u").allInnerTexts()).filter((t) => t.startsWith(`${S.conv.you}${RESUME}`))).toEqual([]);

    // 5. 撞限额：带着 FAKE_CLAUDE_FORK 重启，再分叉一次。框里说撞了限额、几点恢复；用户的问题还在。
    // 重启后马上问：启动健康检查还没做完时也不能报「找不到 claude」（fork-handlers 等 healthReady）。
    const resetAt = Math.floor(Date.now() / 1000) + 2 * 3600;
    await first.app.close();
    s.env = { ...FAST, FAKE_CLAUDE_FORK: `limit:${resetAt}` };
    page = (await launch(s)).page;
    await page.locator(".sidebar .ticket").filter({ hasText: "E2E-7" }).click();
    await expect(page.getByRole("heading", { name: "E2E-7", exact: true })).toBeVisible();
    await openTicketTab(page, "conversation");
    const after = page.locator(".conv .fork");
    await expect(after).toHaveCount(2);
    const runsBeforeLimit = forkRuns(s).length;
    await (await draftTo(page, "fork", "撞了吗？")).click();
    await expect(after).toHaveCount(3);
    const limited = after.nth(2);
    await expect(limited.locator(".error")).toHaveText(S.conv.error.rate_limited(resetClock(resetAt * 1000, Date.now())));
    await expect(limited.locator(".msg-u")).toHaveText([`${S.conv.you}撞了吗？`]);
    await expect(limited.locator(".msg-a")).toHaveCount(0);
    await expect(limited.getByRole("button", { name: S.conv.actRetry, exact: true })).toBeVisible();
    expect(forkRuns(s)).toHaveLength(runsBeforeLimit + 1);
  });
});
