import type { Locator, Page } from "@playwright/test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PR_STAGES, type PrStageId } from "../src/shared/pr-stages";
import { S } from "../src/renderer/src/strings";
import { completeWizard, create, expect, FAKE_GH_ORIGIN, makeGitRepo, newTicket, openTab, pageTab, terminalText, test, unsupportedGhCalls, type BranchPrFixture, type PrViewFixture, type Sandbox } from "./fixtures";

/**
 * PR 进度（设计文档 2026-11-15 第 1 部分）：假 claude 里输入 /fake-skill，走真实的路径：
 * 假 claude → matcher 为 Skill 的 PostToolUse hook → butler-hook → HookInbox → stageEventFromHook → PrStagesService → ticket 页的「PR 进度」tab。
 */
test("a skill call in a session moves the design step to active; tab and timeline collapse and stay collapsed", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);

  await page.getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("E2E-1");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-1", exact: true })).toBeVisible();

  // tab 默认收起，先展开。
  const tab = pageTab(page, S.prStagesTab);
  await expect(tab).toHaveAttribute("aria-selected", "false");
  await openTab(page, S.prStagesTab);
  const design = page.locator(".pr-stages .pr-cell").filter({ hasText: S.prStage.design });
  await expect(design).toHaveClass(/pr-todo/);

  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type("/fake-skill superpowers:brainstorming");
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain("skill superpowers:brainstorming");

  // 设计那一格进行中（还没有 PR，也没有第一次提交）。
  await expect(design).toHaveClass(/pr-active/);

  // 时间线：收起后消失；刷新页面后仍然是收起的。
  const timeline = page.locator(".pr-timeline");
  await expect(timeline).toBeVisible();
  await page.getByRole("button", { name: S.prTimelineHide, exact: true }).click();
  await expect(timeline).toHaveCount(0);
  await page.reload();
  await page.locator(".sidebar .ticket .key").getByText("E2E-1", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: S.prTimelineShow, exact: true })).toBeVisible();
  await expect(page.locator(".pr-timeline")).toHaveCount(0);

  // 点 tab 收起整个面板；刷新后仍然是收起的。
  await tab.click();
  await expect(page.locator(".pr-stages")).toHaveCount(0);
  await page.reload();
  await page.locator(".sidebar .ticket .key").getByText("E2E-1", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-1", exact: true })).toBeVisible();
  await expect(pageTab(page, S.prStagesTab)).toHaveAttribute("aria-selected", "false");
  await expect(page.locator(".pr-stages")).toHaveCount(0);
});

test("an expanded feature in the epic's stages tab opens its ticket (mouse and keyboard)", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const shop = join(s.dir, "shop");
  const { page } = await launch(s);
  await completeWizard(page, s);
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));

  await create(page, page.locator(".sidebar").getByRole("button", { name: `+ ${S.newEpic}`, exact: true }), S.epicName, "shop-epic", shop);
  await create(page, page.locator(".epic-page .page-tabs-bar").getByRole("button", { name: `+ ${S.newFeature}`, exact: true }), S.featureName, "pay", shop);
  await newTicket(page, "EP-1", "frontend", "backend");

  const openFromEpic = async (activate: (chip: Locator) => Promise<void>) => {
    await page.locator(".sidebar .epic-group > .feature-row .ticket").click();
    await expect(page.getByRole("heading", { name: "shop-epic", exact: true })).toBeVisible();
    const tab = pageTab(page, S.prStagesTab);
    if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
    await page.locator(".pr-epic").getByRole("button", { name: "pay", exact: true }).click();
    await activate(page.locator(".pr-table").getByRole("button", { name: "EP-1", exact: true }));
    await expect(page.getByRole("heading", { name: "EP-1", exact: true })).toBeVisible();
  };
  await openFromEpic((chip) => chip.click());
  await openFromEpic((chip) => chip.locator("xpath=ancestor::tr").locator("td").last().click());
  await openFromEpic(async (chip) => {
    await chip.focus();
    await page.keyboard.press("Enter");
  });
});

/** 假 gh 的一个 PR：已合并，CI、review 都没有。pr list 的那一份（list）和 pr view 的那一份（view）。 */
function mergedPr(number: number, headRefName: string, createdAt: string, mergedAt: string): { list: BranchPrFixture; view: PrViewFixture } {
  const url = `https://github.com/acme/app/pull/${number}`;
  const list = { number, url, state: "MERGED" as const, headRefName, createdAt, mergedAt, closedAt: mergedAt };
  return {
    list,
    view: { ...list, isDraft: false, reviewDecision: "", headRefOid: `sha${number}`, statusCheckRollup: [], author: { login: "dev" }, reviews: [], comments: [], commits: [] },
  };
}

/** 上层目录 shop：app 的 origin 是 acme/app（假 gh 的 PR 都在这里），api 没有 remote。返回 shop 的路径。 */
function makeShop(s: Sandbox): string {
  const shop = join(s.dir, "shop");
  makeGitRepo(join(shop, "app"), FAKE_GH_ORIGIN);
  makeGitRepo(join(shop, "api"));
  return shop;
}

/** feature 的 PR 进度表里这个 ticket 的那一行，和这一行里某一步的格子（列的顺序同 PR_STAGES，第一列是 ticket）。 */
const featureRow = (page: Page, key: string) => page.locator(".pr-table tbody tr").filter({ has: page.getByRole("button", { name: key, exact: true }) });
const stageCell = (row: Locator, id: PrStageId) => row.locator("td").nth(PR_STAGES.indexOf(id) + 1).locator(".pr-cell");

/**
 * 每个 PR 一行（计划 2026-11-16）：分支 feature/DMS-1 上先后合并了 #1、#2（gh pr list 找到），#3 在另一个分支上、只在 handoff 里报过。
 * ticket 页三行，新的在前；feature 页这个 ticket 一行，写着 3 个 PR、已合并；epic 页 1/1 已合并。
 * Windows 上跳过：resolveGh 只认 gh.exe，假 gh 是 sh 包装。
 */
test("three PRs: two sequential on the branch and one on another branch linked by handoff", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");
  // 合并时间必须比现在早超过 MERGED_RECENT_MS（24 小时）：链接时早就合并了的 PR 不排复盘分析。
  const one = mergedPr(1, "feature/DMS-1", "2026-10-20T08:00:00Z", "2026-10-21T08:00:00Z");
  const two = mergedPr(2, "feature/DMS-1", "2026-10-22T08:00:00Z", "2026-10-23T08:00:00Z");
  const three = mergedPr(3, "other", "2026-10-24T08:00:00Z", "2026-10-25T08:00:00Z");
  const s = makeSandbox({
    gh: {
      branches: { "feature/DMS-1": [one.list, two.list] },
      prs: Object.fromEntries([one, two, three].map((p) => [p.view.url.toLowerCase(), p.view])),
    },
  });
  s.env = { FAKE_HANDOFF_PRS: JSON.stringify([{ number: 3, url: three.view.url, state: "merged", review: "approved" }]) };
  const { page } = await launch(s);
  await completeWizard(page, s);

  // 1. epic 和它下面的 feature 用 shop 的两个仓库；ticket DMS-1 只用 app。
  const shop = makeShop(s);
  await create(page, page.locator(".sidebar").getByRole("button", { name: `+ ${S.newEpic}`, exact: true }), S.epicName, "shop", shop);
  await create(page, page.locator(".epic-page .page-tabs-bar").getByRole("button", { name: `+ ${S.newFeature}`, exact: true }), S.featureName, "app", shop);
  await newTicket(page, "DMS-1", "app", "api");

  // 2. ticket session 里 /handoff：报的 PR 只有 #3。
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type("/handoff");
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain("next_steps");

  // 3. ticket 页：三行，新的在前。watcher 每 15 秒一轮，分支上找到的 PR 下一轮才读。
  await openTab(page, S.prStagesTab);
  const links = page.locator(".pr-stages .pr-repo .pr-link");
  await expect(links).toHaveText(["#3", "#2", "#1"], { timeout: 60_000 });

  // 4. feature 页：这个 ticket 一行，3 个 PR、已合并。
  await page.locator(".feature-link").getByRole("button", { name: "app", exact: true }).click();
  await expect(page.getByRole("heading", { name: "app", exact: true })).toBeVisible();
  await openTab(page, S.prStagesTab);
  const row = featureRow(page, "DMS-1");
  await expect(page.locator(".pr-table tbody tr")).toHaveCount(1);
  await expect(row).toContainText(S.prCount(3));
  await expect(row.locator(".pill.merged")).toHaveText(S.prPill.merged);

  // 5. epic 页：这个 feature 1/1 已合并。
  await page.locator(".sidebar .epic-group > .feature-row .ticket").click();
  await expect(page.getByRole("heading", { name: "shop", exact: true })).toBeVisible();
  await openTab(page, S.prStagesTab);
  await expect(page.locator(".pr-epic-row").filter({ hasText: "app" })).toContainText(S.prMergedOf(1, 1));
  expect(unsupportedGhCalls(s)).toEqual([]);
});

/**
 * 一次性补链接（计划 2026-11-16）：归档了的老 ticket，下次启动时从 gh pr list 找回它分支上 2025 年合并的 #9（开、合并时间都取自 pr list 那一项）。
 * 归档的 ticket 打不开 ticket 页：在 feature 的 PR 进度表里看它那一行。合并完成；设计、自我 review 未知（那时 hook 还没在记 skill），带“已归档”。
 */
test("backfill of an old merged ticket", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");
  const s = makeSandbox({ gh: { branches: {}, prs: {} } });
  let launched = await launch(s);
  let page = launched.page;
  await completeWizard(page, s);
  await create(page, page.locator(".sidebar").getByRole("button", { name: `+ ${S.newFeature}`, exact: true }), S.featureName, "legacy", makeShop(s));
  await newTicket(page, "OLD-1", "app", "api");
  await page.getByRole("button", { name: S.archive, exact: true }).click();
  await expect(page.locator(".sidebar .ticket .key").getByText("OLD-1", { exact: true })).toHaveCount(0);
  await launched.app.close();

  // 补链接已经在第一次启动时跑完（当时 gh 什么都没有）：删掉记录，下次启动重跑。
  const old = mergedPr(9, "feature/OLD-1", "2025-03-01T08:00:00Z", "2025-03-02T08:00:00Z");
  s.setGh({ branches: { "feature/OLD-1": [old.list] }, prs: { [old.view.url.toLowerCase()]: old.view } });
  const db = new DatabaseSync(join(s.butlerHome, "app.db"));
  db.prepare("DELETE FROM jobs WHERE name = 'pr_backfill'").run();
  db.close();

  launched = await launch(s);
  page = launched.page;
  await page.locator(".sidebar .ticket.feature").filter({ hasText: "legacy" }).click();
  await expect(page.getByRole("heading", { name: "legacy", exact: true })).toBeVisible();
  await openTab(page, S.prStagesTab);
  const row = featureRow(page, "OLD-1");
  await expect(page.locator(".pr-table tbody tr")).toHaveCount(1);
  await expect(row.locator(".pr-archived")).toHaveText(S.prArchived);
  // 链上 #9 才有它 2025 年的开 PR 时间（pr list 的 createdAt）：在那之前开发开始算 ticket 创建的时候，设计不会是未知。
  await expect(stageCell(row, "design")).toHaveClass(/pr-unknown/, { timeout: 60_000 });
  await expect(stageCell(row, "self_review")).toHaveClass(/pr-unknown/);
  await expect(stageCell(row, "merge")).toHaveClass(/pr-done/);
  // 只有一个 PR：多于一个时 ticket 号后面才写“n 个 PR”。
  await expect(row.locator(".pr-row-name .muted")).toHaveCount(0);
  await expect(row.locator(".pill.merged")).toHaveText(S.prPill.merged);
  expect(unsupportedGhCalls(s)).toEqual([]);
});
