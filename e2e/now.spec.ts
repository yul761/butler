import type { Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, makeGitRepo, ROOT, terminalText, test, type Sandbox } from "./fixtures";

/**
 * 首页「现在」（计划 14 任务 6）。假 claude 的 /fake-ask 回一句以“？”结尾的问话；e2e 里需要你的判断（headless）总是失败，
 * Butler 走问号退路，所以这句问话就是“需要你”。活动 tick 调短，停下来之后很快就能看到。
 */

/** 假 claude 对 /fake-ask 的回复（fake-claude.cjs 的 ASK_REPLY）。 */
const ASK_REPLY = "要把它拆成两个 PR 吗？";

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

/** 建 feature「checkout」（shop/frontend、shop/backend 两个仓库），再在它下面建只用 frontend 的 ticket；建完停在最后一个 ticket 页。 */
async function checkoutFeature(page: Page, s: Sandbox, keys: string[]): Promise<void> {
  const shop = join(s.dir, "shop");
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));
  await page.getByRole("button", { name: `+ ${S.newFeature}`, exact: true }).click();
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
const homeButton = (page: Page) => page.getByRole("button", { name: S.home, exact: true });

test("a session that asks a question shows up under 需要你 and opens its terminal", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200" };
  const { page } = await launch(s);
  await completeWizard(page, s);
  await newTicket(page, s, "NOW-1");

  // 1. 第一个 session 问了一句话停下；第二个 session 只是回了“收到”，它是当前的终端。
  const asking = await openSession(page);
  await typeLine(page, "/fake-ask");
  await expect.poll(() => terminalText(page)).toContain(ASK_REPLY);
  const other = await openSession(page);
  expect(other).not.toBe(asking);
  await typeLine(page, "hello");
  await expect.poll(() => terminalText(page)).toContain("收到：hello");

  // 2. 「现在」页：需要你里只有这一条，写着 ticket 号和问话；侧栏的“现在”后面有红点和 1，按钮的名字还是“现在”。
  await homeButton(page).click();
  const needs = page.locator(".now-needs");
  await expect(needs.getByRole("heading")).toHaveText(`${S.nowNeedsYou}1`);
  const need = needs.locator(".now-need");
  await expect(need).toHaveCount(1);
  await expect(need.locator(".now-key")).toHaveText("NOW-1");
  await expect(need.locator(".why")).toHaveText(ASK_REPLY);
  const badge = page.locator(".sidebar .nav.home .needs-you-badge");
  await expect(badge).toHaveText("1");
  await expect(badge).toHaveAttribute("title", S.nowNeedsYouBadge(1));
  await expect(page.locator(".sidebar .nav.home")).toHaveAccessibleName(S.home);
  // 分组里也有这一行，标着“等你”。
  await expect(page.locator(".now-row.danger .main")).toHaveText(S.nowWaitingFor(ASK_REPLY));

  // 3. 点“打开 →”：进入 ticket 页，当前终端换成问话的那个 session。
  await need.locator(".go").click();
  await expect(page.getByRole("heading", { name: "NOW-1", exact: true })).toBeVisible();
  await expect.poll(() => activeSessionId(page)).toBe(asking);
  await expect.poll(() => terminalText(page)).toContain(ASK_REPLY);
  await expect(page.locator(".terminal-wrap")).toHaveCount(2);

  // 4. 回答之后它就不需要你了：需要你一节和侧栏的红点都消失。
  await typeLine(page, "keep it as one PR");
  await expect.poll(() => terminalText(page)).toContain("收到：keep it as one PR");
  await homeButton(page).click();
  await expect(page.locator(".now-top")).toBeVisible();
  await expect(needs).toHaveCount(0);
  await expect(badge).toHaveCount(0);
});

test("groups collapse and stay collapsed after a refresh", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200" };
  const { page } = await launch(s);
  await completeWizard(page, s);
  await checkoutFeature(page, s, ["DMS-1"]);
  await openSession(page);
  await typeLine(page, "/fake-bash pnpm test");
  await expect.poll(() => terminalText(page)).toContain("running");

  await homeButton(page).click();
  const epic = page.locator(".now-epic");
  const feature = epic.locator(".now-feature").filter({ has: page.locator("h4 .name", { hasText: /^checkout$/ }) });
  const featureToggle = feature.locator("h4 .section-toggle");
  const epicToggle = epic.locator(":scope > h3 .section-toggle");
  await expect(epic.locator(":scope > h3 .name")).toHaveText(S.nowNoEpic);
  await expect(feature.locator(".now-row .now-key")).toHaveText(["DMS-1"]);
  await expect(feature.locator(".now-row .main")).toHaveText(S.activity.test);

  // 1. 收起 feature：行不见了，标题还在，后面的汇总照样显示。刷新页面之后还是收起的。
  await featureToggle.click();
  await expect(featureToggle).toHaveAttribute("aria-expanded", "false");
  await expect(feature.locator(".now-row")).toHaveCount(0);
  await expect(feature.locator(".now-summary")).toHaveText(S.nowActive(1));
  await page.reload();
  await expect(featureToggle).toHaveAttribute("aria-expanded", "false");
  await expect(feature.locator(".now-row")).toHaveCount(0);

  // 2. 收起 epic：feature 也看不到了。刷新之后还是收起的；展开 epic，feature 仍然是收起的。
  await epicToggle.click();
  await expect(epicToggle).toHaveAttribute("aria-expanded", "false");
  await expect(epic.locator(".now-feature")).toHaveCount(0);
  await page.reload();
  await expect(epicToggle).toHaveAttribute("aria-expanded", "false");
  await expect(epic.locator(".now-feature")).toHaveCount(0);
  await epicToggle.click();
  await expect(featureToggle).toHaveAttribute("aria-expanded", "false");

  // 3. 再展开 feature：行回来了。
  await featureToggle.click();
  await expect(feature.locator(".now-row .now-key")).toHaveText(["DMS-1"]);
  await page.reload();
  await expect(feature.locator(".now-row .now-key")).toHaveText(["DMS-1"]);
});

/** 一个元素的文字色和它实际的底色（往上找到不透明为止，半透明的叠起来），算对比度。在页面里用 canvas 换算任何 CSS 颜色。 */
async function contrastOf(el: Locator): Promise<{ ratio: number; color: string; background: string }> {
  return el.evaluate((node) => {
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
    // 最底下是窗口的白底，再从最外层往里一层层叠背景。
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
 * 浅色和深色主题都看得清（计划 14 约束）：需要你的一行、一个 feature 分组、展开的空闲行、侧栏红点，
 * 每种文字的对比度都至少 4.5。截图存到 test-results/now-page（设了 BUTLER_E2E_SHOTS_DIR 就存到那里）。
 */
test("the Now page is readable in light and dark", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200" };
  const shots = process.env.BUTLER_E2E_SHOTS_DIR ?? join(ROOT, "test-results", "now-page");
  mkdirSync(shots, { recursive: true });
  const { page } = await launch(s);
  await completeWizard(page, s);
  await checkoutFeature(page, s, ["DMS-1", "DMS-2", "DMS-3"]);
  // DMS-3 在跑测试，DMS-2 回了“收到”停下（空闲），DMS-1 问了一句话（需要你）。
  await openSession(page);
  await typeLine(page, "/fake-bash pnpm test");
  await ticketPage(page, "DMS-2");
  await openSession(page);
  await typeLine(page, "hello");
  await expect.poll(() => terminalText(page)).toContain("收到：hello");
  await ticketPage(page, "DMS-1");
  await openSession(page);
  await typeLine(page, "/fake-ask");
  await expect.poll(() => terminalText(page)).toContain(ASK_REPLY);

  await homeButton(page).click();
  await expect(page.locator(".now-need")).toHaveCount(1);
  const idle = page.locator(".now-idle");
  await expect(idle.locator(":scope > .section-toggle")).toContainText(S.nowIdle(1));
  await idle.locator(":scope > .section-toggle").click();
  await expect(idle.locator(".now-row .now-key")).toHaveText(["DMS-2"]);
  await expect(page.locator(".now-feature .now-row.ok .main")).toHaveText(S.activity.test);
  // 鼠标移开，不让悬停的底色混进来。
  await page.mouse.move(0, 0);

  const texts: Record<string, Locator> = {
    title: page.locator(".now-top h2"),
    running: page.locator(".now-top .muted"),
    needsHeading: page.locator(".now-needs h3"),
    needKey: page.locator(".now-need .now-key"),
    needFeature: page.locator(".now-need .name"),
    needReason: page.locator(".now-need .why"),
    needSince: page.locator(".now-need .since"),
    needOpen: page.locator(".now-need .go"),
    epicName: page.locator(".now-epic > h3 .name"),
    featureName: page.locator(".now-feature > h4 .name").first(),
    featureSummary: page.locator(".now-feature > h4 .now-summary").first(),
    rowKey: page.locator(".now-row .now-key").first(),
    waitingRow: page.locator(".now-row.danger .main"),
    busyRow: page.locator(".now-row.ok .main"),
    busySub: page.locator(".now-row.ok .now-what small"),
    since: page.locator(".now-row .now-since").first(),
    idleToggle: page.locator(".now-idle > .section-toggle"),
    idleRow: page.locator(".now-idle .now-row .main"),
    usage: page.locator(".now-usage > .section-toggle"),
    badge: page.locator(".sidebar .needs-you-badge"),
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
    await page.screenshot({ path: join(shots, `now-${scheme}.png`) });
    expect(low, `${scheme}: text below 4.5:1`).toEqual([]);
  }
});
