import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, makeGitRepo, ROOT, terminalText, test, type Sandbox, newButton } from "./fixtures";

/**
 * 首页「运行情况」里的实况窗口（BTL-190 第 7 点）。首页其余部分（轮到你的卡片、小表）在 home.spec.ts。
 * 假 claude 的 /fake-ask 回一句以“？”结尾的问话，需要你的判断认出它。
 */

/** 假 claude 对 /fake-ask 的回复（fake-claude.cjs 的 ASK_REPLY）。 */
const ASK_REPLY = "要把它拆成两个 PR 吗？";

/** 在当前显示的终端里输入一行并回车。 */
async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

/** 建 feature「checkout」（shop/frontend、shop/backend 两个仓库），再在它下面建只用 frontend 的 ticket；建完停在最后一个 ticket 页。 */
async function checkoutFeature(page: Page, s: Sandbox, keys: string[]): Promise<void> {
  const shop = join(s.dir, "shop");
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));
  await (await newButton(page, "newFeature")).click();
  await page.getByLabel(S.featureName, { exact: true }).fill("checkout");
  const dir = page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true });
  await dir.fill(shop);
  await dir.blur();
  await expect(page.getByText(S.subReposFound(2), { exact: true })).toBeVisible();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "checkout", exact: true })).toBeVisible();
  for (const [n, key] of keys.entries()) {
    if (n > 0) await page.locator(".feature-link").getByRole("button", { name: "checkout", exact: true }).click();
    await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
    await page.getByLabel(S.ticketKey, { exact: true }).fill(key);
    await page.locator(".modal").getByRole("checkbox", { name: "frontend", exact: true }).check();
    await page.locator(".modal").getByRole("checkbox", { name: "backend", exact: true }).uncheck();
    await page.getByRole("button", { name: S.create, exact: true }).click();
    await expect(page.getByRole("heading", { name: key, exact: true })).toBeVisible();
  }
}

/** session 栏里当前那个 session 的 id（title 的第二行；第一行是第一句提示，发了话之后会变）。 */
async function activeSessionId(page: Page): Promise<string | undefined> {
  return (await page.locator(".sessions-bar .session.active").getAttribute("title"))?.split("\n")[1];
}

/** 在当前 ticket 页开一个新 session，等假 claude 就绪；返回它的 session id。 */
async function openSession(page: Page): Promise<string> {
  const before = await page.locator(".sessions-bar .session-wrap").count();
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect(page.locator(".sessions-bar .session-wrap")).toHaveCount(before + 1);
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const id = await activeSessionId(page);
  expect(id).toBeTruthy();
  return id!;
}

const ticketPage = (page: Page, key: string) => page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: key }).click();

/** 回首页并展开「运行情况」（展开过的记在本地，下次回来还开着）。 */
async function homeMore(page: Page): Promise<void> {
  await page.locator(".sidebar").getByRole("button", { name: S.home, exact: true }).click();
  const fold = page.locator(".home-more-fold > h3 .section-toggle");
  if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
}

/**
 * 实况窗口（BTL-190 第 7 点）：没人干活时说一句；在干活的、在等你的 session 各一张卡片，停下的不在；
 * 工具调用一推过来就出现在卡片上，写记忆、读记忆沿着虚线走一个光点；窄窗口里排成网格、核心在最上面。
 * 截图存到 test-results/now-page/live-*.png（设了 BUTLER_E2E_SHOTS_DIR 就存到那里）。
 */
test("the live window shows working sessions, their tool calls and memory sparks", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  // tick 调得很长：回到首页以后卡片上的新行只能是 fs.watch 带来的。
  s.env = { BUTLER_ACTIVITY_TICK_MS: "60000" };
  const shots = process.env.BUTLER_E2E_SHOTS_DIR ?? join(ROOT, "test-results", "now-page");
  mkdirSync(shots, { recursive: true });
  const { app, page } = await launch(s);
  await completeWizard(page, s);
  await checkoutFeature(page, s, ["DMS-1", "DMS-2", "DMS-3"]);
  await homeMore(page);
  await expect(page.locator(".live-empty-text")).toHaveText(S.liveEmpty);
  await ticketPage(page, "DMS-3");
  // DMS-3 问了一句话（等你），DMS-2 回了“收到”停下，DMS-1 在干活：读了记忆、看了两处代码。
  await openSession(page);
  await typeLine(page, "/fake-ask");
  await expect.poll(() => terminalText(page)).toContain(ASK_REPLY);
  await ticketPage(page, "DMS-2");
  await openSession(page);
  await typeLine(page, "hello");
  await expect.poll(() => terminalText(page)).toContain("收到：hello");
  await ticketPage(page, "DMS-1");
  await openSession(page);
  await typeLine(page, '/fake-tool mcp__butler-feature__recall {"query":"结账金额"}');
  await typeLine(page, '/fake-tool Read {"file_path":"/w/src/cart.ts"}');
  await typeLine(page, '/fake-tool Grep {"pattern":"totalCents"}');
  await expect.poll(() => terminalText(page)).toContain("tool Grep");
  // 回到首页以后才来的：写一条记忆，再读一次。
  await typeLine(page, '/fake-later 3000 /fake-tool mcp__butler-feature__remember {"text":"金额一律用分"}');
  await typeLine(page, '/fake-later 7000 /fake-tool mcp__butler-feature__facts {"query":"金额"}');

  await homeMore(page);
  const cards = page.locator(".live-card");
  // 要你做事的排在前面。
  await expect(cards.locator(".live-key")).toHaveText(["DMS-3", "DMS-1"]);
  const asking = cards.filter({ hasText: "DMS-3" });
  const working = cards.filter({ hasText: "DMS-1" });
  await expect(asking).toHaveClass(/\bneed\b/);
  await expect(asking.locator(".live-badge")).toHaveText(S.liveNeedsYou(1));
  await expect(asking.locator(".live-pill")).toHaveText(S.liveWaiting);
  await expect(working.locator(".live-pill.work")).toHaveText(S.activity.thinking);
  await expect(working.locator(".live-where")).toHaveText("frontend");
  await expect(working.locator(".live-line")).toHaveText([`${S.liveRead}结账金额`, "Read cart.ts", "Grep totalCents"]);
  await expect(page.locator(".live-core-count strong")).toHaveText("1");
  await expect(page.locator(".live-mem.memory-read .label")).toHaveText(["结账金额"]);
  // 每张卡片一条虚线，在干活的那条在流动。
  await expect(page.locator(".live-wire")).toHaveCount(2);
  await expect(page.locator(".live-wire.work")).toHaveCount(1);
  await page.mouse.move(0, 0);

  // 写记忆：蓝色光点从卡片流向核心，卡片上多一行，核心卡片上记下来。
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator(".live-spark.memory-write")).toHaveCount(1, { timeout: 10_000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(shots, "live-light.png") });
  await expect(working.locator(".live-line")).toHaveText(["Read cart.ts", "Grep totalCents", `${S.liveWrote}金额一律用分`]);
  await expect(page.locator(".live-mem .label")).toHaveText(["结账金额", "金额一律用分"]);
  await expect(page.locator(".live-spark")).toHaveCount(0, { timeout: 5000 });

  // 读记忆：绿色光点从核心流向卡片（深色主题下截图）。
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator(".live-spark.memory-read")).toHaveCount(1, { timeout: 10_000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(shots, "live-dark.png") });

  // 窄窗口：核心在最上面，卡片排成网格，不画线。
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 820));
  await expect(page.locator(".live-wires")).toBeHidden();
  await expect.poll(async () => {
    const core = await page.locator(".live-core").boundingBox();
    const first = await cards.first().boundingBox();
    return core !== null && first !== null && core.y + core.height < first.y;
  }).toBe(true);
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: join(shots, "live-narrow.png") });
});
