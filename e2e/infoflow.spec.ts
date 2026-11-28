import type { Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { S } from "../src/renderer/src/strings";
import { MAIN_STRINGS } from "../src/main/strings";
import { completeWizard, expect, newButton, openSettingsTab, openTicketTab, type Sandbox, terminalText, test } from "./fixtures";

/**
 * 信息流转（BTL-272）：ticket session 里用户说「E2E-9 不做了」，这一轮结束后 Shipherd 问低档模型（假 claude 按
 * FAKE_CLAUDE_FLOW_FILE 回一条 close_ticket），把要点记下来、用 BTL-270 的 closeTicket 替你把 ticket 关掉（来源记 routing），
 * 首页「告诉你一声」里显示「已替你同步：……」，点撤销 ticket 回来；信息流转里能看到这一条和那一轮的原话。
 */

const FAST = {
  SHIPHERD_ACTIVITY_TICK_MS: "200", SHIPHERD_USAGE_SCAN_MS: "200", SHIPHERD_GATE_TYPING_QUIET_MS: "1000",
  SHIPHERD_FLOW_SETTLE_MS: "300", SHIPHERD_FLOW_TICK_MS: "300",
};
const KEY = "E2E-9";
const SAID = `${KEY} 不做了，客户取消了这个需求，以后都不用再做`;

/** ticket 现在的关闭状态（BTL-270：手动状态 closed，记下来源；不归档）。Shipherd 也开着这个库：等它的写锁。 */
function closeState(s: Sandbox, key: string): string {
  const d = new DatabaseSync(join(s.shipherdHome, "app.db"), { timeout: 5000 });
  try {
    const row = d.prepare("SELECT status_manual, closed_source, archived_at FROM tickets WHERE key = ?").get(key) as
      | { status_manual: string | null; closed_source: string | null; archived_at: number | null }
      | undefined;
    if (!row) return "missing";
    if (row.archived_at != null) return "archived";
    return row.status_manual === "closed" ? `closed:${row.closed_source}` : "open";
  } finally {
    d.close();
  }
}

const fakeLog = (s: Sandbox) => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");

async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function withLogs(s: Sandbox, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (e) {
    for (const f of [s.fakeLog, join(s.shipherdHome, "logs", "main.log")]) if (existsSync(f)) console.log(`--- ${f}\n${readFileSync(f, "utf8")}`);
    throw e;
  }
}

test("a state change the user said in a session is synced, shown with undo, and the info flow shows where it came from", async ({ makeSandbox, launch }) => {
  test.setTimeout(180_000);
  const s = makeSandbox();
  const flowFile = join(s.dir, "flow.json");
  s.env = { ...FAST, FAKE_CLAUDE_FLOW_FILE: flowFile };
  writeFileSync(flowFile, JSON.stringify({
    items: [{
      text: `${KEY} 不做了：客户取消了这个需求`, kind: "state_change", speaker: "user", quote: `${KEY} 不做了`, targets: [`ticket:${KEY}`],
      importance: "high", confidence: 0.95, change: { op: "close_ticket", ticket: KEY, reason: "客户取消了" },
    }],
  }));
  const { page } = await launch(s);
  await withLogs(s, async () => {
    await completeWizard(page, s);
    await (await newButton(page, "newTicket")).click();
    await page.getByLabel(S.ticketKey, { exact: true }).fill(KEY);
    await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(s.repo);
    await page.getByRole("button", { name: S.create, exact: true }).click();
    await expect(page.getByRole("heading", { name: KEY, exact: true })).toBeVisible();
    await openTicketTab(page, "terminal");
    await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
    await expect.poll(() => terminalText(page)).toContain("fake claude ready");
    await typeLine(page, SAID);
    await expect.poll(() => terminalText(page)).toContain(`收到：${SAID}`);

    // 这一轮结束后问了一次模型，状态变化直接同步（用户说的、把握大、能撤销）。
    await expect.poll(() => fakeLog(s), { timeout: 30_000 }).toContain("infoflow extract 1");
    await expect.poll(() => closeState(s, KEY), { timeout: 30_000 }).toBe("closed:routing");
    const label = MAIN_STRINGS.zh.infoflow.closeTicket(KEY, "客户取消了");
    await page.locator(".sidebar").getByRole("button", { name: S.home, exact: true }).click();
    // 「已替你同步」只是告诉你一声：在首页「运行情况」里。
    const more = page.locator(".home-more-fold > h3 .section-toggle");
    if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
    const synced = page.getByTestId("now-notice-flow_synced");
    await expect(synced).toContainText(S.infoflow.synced(label), { timeout: 30_000 });

    // 撤销：ticket 回来了，提醒消失。
    await synced.getByTestId("now-notice-flow_synced-undo").click();
    await expect(synced).toHaveCount(0);
    await expect.poll(() => closeState(s, KEY)).toBe("open");

    // 全局总控页对话下面的「信息流转」：这一条、记进了 ticket 的记忆、同步过又撤销了；点开能看原话。
    await page.locator(".sidebar").getByRole("button", { name: S.shipherdNav, exact: true }).click();
    const box = page.getByTestId("flow-summary");
    await box.locator("summary").click();
    const item = box.getByTestId("flow-item").first();
    await expect(item).toContainText(`${KEY} 不做了：客户取消了这个需求`);
    await expect(item.getByTestId("flow-action")).toHaveAttribute("data-state", "undone");
    await item.getByTestId("flow-original-toggle").click();
    await expect(item.getByTestId("flow-original")).toContainText(SAID);
  });
});

test("the daily cap on model asks is a setting, and at the cap Now says so and until when", async ({ makeSandbox, launch }) => {
  test.setTimeout(180_000);
  const s = makeSandbox();
  const flowFile = join(s.dir, "flow.json");
  s.env = { ...FAST, FAKE_CLAUDE_FLOW_FILE: flowFile };
  writeFileSync(flowFile, JSON.stringify({ items: [] }));
  const { page } = await launch(s);
  await withLogs(s, async () => {
    await completeWizard(page, s);
    // 设置 → 常规：默认 300；改成 1，重新打开还是 1。
    await openSettingsTab(page, "basic");
    const field = () => page.getByTestId("setting-flowDailyAsks");
    await expect(field()).toHaveValue("300");
    await field().fill("1");
    await field().blur();
    await page.reload();
    await openSettingsTab(page, "basic");
    await expect(field()).toHaveValue("1");
    const shots = process.env.SHIPHERD_E2E_SHOTS_DIR;
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await page.locator(".field").filter({ has: field() }).screenshot({ path: join(shots, "flow-daily-asks-setting.png") });
    }

    await (await newButton(page, "newTicket")).click();
    await page.getByLabel(S.ticketKey, { exact: true }).fill(KEY);
    await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(s.repo);
    await page.getByRole("button", { name: S.create, exact: true }).click();
    await expect(page.getByRole("heading", { name: KEY, exact: true })).toBeVisible();
    await openTicketTab(page, "terminal");
    await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
    await expect.poll(() => terminalText(page)).toContain("fake claude ready");
    await typeLine(page, "以后提交前一律跑 e2e，这是规定");
    // 假 claude 记的是这次回了几条（这里是 0 条）。
    await expect.poll(() => fakeLog(s), { timeout: 30_000 }).toContain("infoflow extract 0");

    // 问了一次就到上限：「运行情况」里说一声（没有按钮）。之后的轮等着不问，由 infoflow-service.test.ts 管。
    await page.locator(".sidebar").getByRole("button", { name: S.home, exact: true }).click();
    const more = page.locator(".home-more-fold > h3 .section-toggle");
    if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
    const capped = page.getByTestId("now-notice-flow_capped");
    await expect(capped).toContainText("上限 1", { timeout: 30_000 });
    await expect(capped.locator("button")).toHaveCount(0);
    if (shots) await capped.screenshot({ path: join(shots, "flow-capped-notice.png") });
  });
});
