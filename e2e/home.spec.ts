import type { Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, makeGitRepo, newButton, openAllWork, ROOT, terminalText, test, type Sandbox, openTicketTab, pageTab } from "./fixtures";

/**
 * 首页「轮到你」和「全部工作」（UI 重做第 2 层）。状态来自第 1 层的 turn:board：
 * ask_user 的提问是「要你回答」，假 claude 的 /fake-ask 经需要你的判断也是「要你回答」（没有选项），在跑 /fake-bash 的 session 是 agent 在做。
 */

/** 假 claude 对 /fake-ask 的回复（fake-claude.cjs 的 ASK_REPLY）。 */
const ASK_REPLY = "要把它拆成两个 PR 吗？";
const QUESTION = "要不要先回测？";

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

/** 建 feature「checkout」（两个仓库），再在它下面建只用 frontend 的 ticket；建完停在最后一个 ticket 页。 */
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

async function activeSessionId(page: Page): Promise<string | undefined> {
  return (await page.locator(".sessions-bar .session.active").getAttribute("title"))?.split("\n")[1];
}

/** 在当前 ticket 页开一个新 session，等假 claude 就绪；返回它的 session id。 */
async function openSession(page: Page): Promise<string> {
  const before = await page.locator(".sessions-bar .session-wrap").count();
  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect(page.locator(".sessions-bar .session-wrap")).toHaveCount(before + 1);
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const id = await activeSessionId(page);
  expect(id).toBeTruthy();
  return id!;
}

const goHome = (page: Page) => page.locator(".sidebar").getByRole("button", { name: S.home, exact: true }).click();
const title = (page: Page) => page.locator(".home-top h2");

test("a question for you is a card that opens its conversation and takes an answer", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200" };
  const { page } = await launch(s);
  await completeWizard(page, s);
  await newTicket(page, s, "HOME-1");
  await openSession(page);
  await typeLine(page, `/fake-mcp ask_user ${JSON.stringify({ question: QUESTION, options: ["可以", "不行，先回测"] })}`);
  // 第二个 session 是当前的终端：「去看看」要切回问话的那个。
  await openSession(page);

  await goHome(page);
  await expect(title(page)).toHaveText(S.hm.title(1), { timeout: 20_000 });
  const card = page.getByTestId("turn-card");
  await expect(card).toHaveCount(1);
  await expect(card.locator(".turn-tag")).toHaveText(S.hm.kind.answer);
  await expect(card.locator(".sentence")).toContainText(QUESTION);
  await expect(card.locator(".where .path")).toHaveText("HOME-1");
  const home = page.locator(".sidebar .nav.home");
  await expect(home.locator(".needs-you-badge")).toHaveText("1");
  await expect(home).toHaveAccessibleName(S.home);
  await expect(home).toHaveAccessibleDescription(S.nowNeedsYouBadge(1));
  await expect(page.locator(".sidebar .ticket").filter({ hasText: "HOME-1" }).locator(".turn-dot")).toHaveClass(/\bturn-ask\b/);

  // 「去看看」：落到 ticket 页的「对话」tab，切换条上选中的是问话的那个 session（落在对话 tab 时不动终端的当前 session）。
  await card.getByRole("button", { name: S.hm.act.look, exact: true }).click();
  await expect(page.getByRole("heading", { name: "HOME-1", exact: true })).toBeVisible();
  await expect(pageTab(page, S.lay.tabConversation)).toHaveAttribute("aria-selected", "true");
  const pressed = page.locator(".conv .conv-switch button[aria-pressed=\"true\"]");
  await expect(page.locator(".conv .conv-switch button")).toHaveCount(2);
  await expect(pressed).toHaveCount(1);
  await expect(pressed).toContainText("/fake-mcp ask_user");

  // 回到首页点选项：卡片说已回答。
  await goHome(page);
  await card.getByRole("button", { name: "可以", exact: true }).click();
  await expect(card).toContainText(S.hm.act.answered("可以"));
});

test("a question answered on the ticket page stays answered after switching tabs", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200" };
  const { page } = await launch(s);
  await completeWizard(page, s);
  await newTicket(page, s, "HOME-4");
  // session A 问完就结束：它的提问成了孤儿提问，回答只能存下来，等它恢复以后再送。
  const a = await openSession(page);
  await typeLine(page, `/fake-mcp ask_user ${JSON.stringify({ question: "先问的？", options: ["甲", "乙"] })}`);
  await expect.poll(() => terminalText(page)).toContain("工具返回：ask_user");
  const wrapA = page.locator(".sessions-bar .session-wrap").filter({ has: page.locator(`.session[title*="${a}"]`) });
  const end = wrapA.getByRole("button", { name: /^结束 / });
  await end.click();
  await expect(end).toHaveText(S.endSessionConfirm);
  await end.click();
  await expect(wrapA.locator(".session .action")).toHaveText(S.open);
  // session B 再问一个，占着 ticket 的主行；A 的提问在下面的提问行上。
  await openSession(page);
  await typeLine(page, `/fake-mcp ask_user ${JSON.stringify({ question: "后问的？", options: ["丙", "丁"] })}`);
  await expect.poll(() => terminalText(page)).toContain("工具返回：ask_user");
  await openTicketTab(page, "overview");
  const asks = page.locator(".ticket-home-asks");
  await expect(asks.getByRole("button", { name: "甲", exact: true })).toBeVisible({ timeout: 20_000 });
  await asks.getByRole("button", { name: "甲", exact: true }).click();
  await expect(asks).toContainText(S.hm.act.answered("甲"));
  // 切到终端再回来：还写着已回答，不会再给选项（再点会悄悄换掉答案）。
  await openTicketTab(page, "terminal");
  await openTicketTab(page, "overview");
  await expect(asks).toContainText(S.hm.act.answered("甲"));
  await expect(asks.getByRole("button", { name: "乙", exact: true })).toHaveCount(0);
});

test("with nothing for you the title says so and the scope table still lists the feature", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  // 空工作区：首页整页是首次使用首页（FirstRunHome）；「去 设置 › 功能」落在设置的「功能」tab。
  const firstRun = page.getByTestId("first-run-home");
  await expect(firstRun).toContainText(S.firstRun.title);
  await expect(firstRun.getByTestId("first-run-new-ticket")).toBeVisible();
  await firstRun.getByTestId("first-run-settings-link").click();
  await expect(page.getByTestId("settings-tab-features")).toHaveAttribute("aria-selected", "true");

  await checkoutFeature(page, s, ["HOME-2"]);
  await goHome(page);
  await expect(title(page)).toHaveText(S.hm.titleZero);
  await expect(page.getByTestId("turn-card")).toHaveCount(0);
  const home = page.locator(".sidebar .nav.home");
  await expect(home.locator(".needs-you-badge")).toHaveCount(0);
  await expect(home).not.toHaveAttribute("aria-describedby");
  await expect(page.locator(".home-scopes")).toContainText(S.hm.scopesHeading);
  await expect(page.locator(".home-scope .name")).toHaveText(["checkout"]);
  await page.locator(".home-scope").getByRole("button", { name: "checkout", exact: true }).click();
  await expect(page.getByRole("heading", { name: "checkout", exact: true })).toBeVisible();
});

test("the All work page has the create buttons, the entries and every piece of work", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  await openAllWork(page);
  const all = page.locator(".all-work");
  for (const name of [`+ ${S.newTicket}`, `+ ${S.newFeature}`, S.archived]) {
    await expect(all.getByRole("button", { name, exact: true })).toBeVisible();
  }
  // 「显示 Butler 之外开的 session」默认关：没有未认领入口（BTL-244）。
  await expect(all.getByRole("button", { name: S.hm.all.unclaimedBtn(0), exact: true })).toHaveCount(0);
  await expect(all).toContainText(S.hm.all.empty);

  await newTicket(page, s, "HOME-4");
  await openAllWork(page);
  await expect(page.getByTestId("all-work-row-ticket-HOME-4")).toBeVisible();
  await all.getByRole("button", { name: S.archived, exact: true }).click();
  await expect(page.getByRole("heading", { name: S.archived, exact: true })).toBeVisible();
});

/** 一个元素的文字色和它实际的底色（往上找到不透明为止，半透明的叠起来），算对比度。在页面里用 canvas 换算任何 CSS 颜色。 */
async function contrastOf(el: Locator): Promise<{ ratio: number; color: string; background: string }> {
  return el.evaluate((node) => {
    // 脱离页面的节点 getComputedStyle 全是空串：直接说清楚是重挂了，别报成颜色换算不了。
    if (!node.isConnected) throw new Error("element was detached (re-rendered) before its contrast was read");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const pixel = () => [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    /** 换算不了的颜色（canvas 不认）会被静默忽略：先填一个记号色，没变就报错，免得算出假的对比度。 */
    const fill = (color: string) => {
      ctx.fillStyle = "#010203";
      ctx.fillStyle = color;
      if (ctx.fillStyle === "#010203" && color !== "rgb(1, 2, 3)") throw new Error(`canvas cannot paint ${color}`);
      ctx.fillRect(0, 0, 1, 1);
    };
    const chain: Element[] = [];
    for (let e: Element | null = node; e; e = e.parentElement) chain.unshift(e);
    fill("#fff");
    for (const e of chain) fill(getComputedStyle(e).backgroundColor);
    const bg = pixel();
    fill(getComputedStyle(node).color);
    const fg = pixel();
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return { ratio: (hi + 0.05) / (lo + 0.05), color: `rgb(${fg.join(",")})`, background: `rgb(${bg.join(",")})` };
  });
}

/**
 * 浅色和深色主题都看得清：标题、卡片的标签、一句话、位置、小表、进行中的一行、侧栏的数字，对比度都至少 4.5。
 * 截图存到 test-results/home-page（设了 BUTLER_E2E_SHOTS_DIR 就存到那里）。
 */
test("the home page is readable in light and dark", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200" };
  const shots = process.env.BUTLER_E2E_SHOTS_DIR ?? join(ROOT, "test-results", "home-page");
  mkdirSync(shots, { recursive: true });
  const { page } = await launch(s);
  await completeWizard(page, s);
  await checkoutFeature(page, s, ["DMS-1", "DMS-2"]);
  // DMS-2 在跑测试（agent 在做），DMS-1 问了一句话（要你回答）。
  await openSession(page);
  await typeLine(page, "/fake-bash pnpm test");
  await expect.poll(() => terminalText(page)).toContain("running");
  await page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: "DMS-1" }).click();
  await openSession(page);
  await typeLine(page, "/fake-ask");
  await expect.poll(() => terminalText(page)).toContain(ASK_REPLY);

  await goHome(page);
  await expect(page.getByTestId("turn-card")).toHaveCount(1, { timeout: 20_000 });
  // DMS-1 停下以后先是「没人推进」，需要你的判断回来才变成「要你回答」；kind 在卡片的 key 里，一变整张卡重挂，
  // 量到一半的旧节点就脱离了页面。等它变成 answer 再量。
  await expect(page.getByTestId("turn-card")).toHaveAttribute("data-kind", "answer", { timeout: 20_000 });
  const running = page.locator(".home-running > h3 .section-toggle");
  if ((await running.getAttribute("aria-expanded")) !== "true") await running.click();
  await expect(page.locator(".home-run")).toHaveCount(1);
  await page.mouse.move(0, 0);

  const texts: Record<string, Locator> = {
    title: page.locator(".home-top h2"),
    lede: page.locator(".home-top p"),
    cardTag: page.locator(".turn-card .turn-tag"),
    cardSentence: page.locator(".turn-card .sentence"),
    cardWhere: page.locator(".turn-card .where .path"),
    cardAge: page.locator(".turn-card .where .age"),
    scopesHeading: page.locator(".home-scopes h3"),
    scopeName: page.locator(".home-scope .name").first(),
    scopeLine: page.locator(".home-scope .line").first(),
    scopeWho: page.locator(".home-scope .turn-tag").first(),
    runningToggle: running,
    runKey: page.locator(".home-run .key"),
    runWho: page.locator(".home-run .turn-tag"),
    runSentence: page.locator(".home-run .sentence"),
    moreToggle: page.locator(".home-more-fold > h3 .section-toggle"),
    badge: page.locator(".sidebar .needs-you-badge"),
    dotCount: page.locator(".sidebar .cnt").first(),
  };
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect.poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(scheme === "dark");
    const low: string[] = [];
    for (const [name, el] of Object.entries(texts)) {
      await expect(el, name).toBeVisible();
      await expect(el, name).not.toHaveText("");
      const c = await contrastOf(el);
      if (c.ratio < 4.5) low.push(`${name}: ${c.ratio.toFixed(2)} (${c.color} on ${c.background})`);
    }
    await page.screenshot({ path: join(shots, `home-${scheme}.png`) });
    expect(low, `${scheme}: text below 4.5:1`).toEqual([]);
  }
});
