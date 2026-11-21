import type { Locator } from "@playwright/test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PR_STAGES, type PrStageId } from "../src/shared/pr-stages";
import { S } from "../src/renderer/src/strings";
import { completeWizard, create, expect, FAKE_GH_ORIGIN, makeGitRepo, newTicket, openArchived, openPrStages, openTab, openTicketTab, pageTab, terminalText, test, unsupportedGhCalls, type BranchPrFixture, type PrViewFixture, type Sandbox, newButton } from "./fixtures";

/**
 * PR 进度（设计文档 2026-11-15 第 1 部分）：假 claude 里输入 /fake-skill，走真实的路径：
 * 假 claude → matcher 为 Skill 的 PostToolUse hook → butler-hook → HookInbox → stageEventFromHook → PrStagesService → ticket 页「PR 详情」页签的阶段。
 */
test("a skill call in a session moves the design step to active; the timeline stays collapsed and the page keeps its tab", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);

  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("E2E-1");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-1", exact: true })).toBeVisible();

  // 阶段在「PR 详情」页签（ticket 页默认停在「概况」）。
  await expect(pageTab(page, S.lay.tabPr)).toHaveAttribute("aria-selected", "false");
  await openPrStages(page);
  const design = page.locator(".pr-stages .pr-cell").filter({ hasText: S.prStage.design });
  await expect(design).toHaveClass(/pr-todo/);

  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type("/fake-skill superpowers:brainstorming");
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain("skill superpowers:brainstorming");

  // 设计那一格进行中（还没有 PR，也没有第一次提交）。
  await openPrStages(page);
  await expect(design).toHaveClass(/pr-active/);

  // 时间线：收起后消失；刷新页面后仍然是收起的，页面也还停在「PR 详情」。
  const timeline = page.locator(".pr-timeline");
  await expect(timeline).toBeVisible();
  await page.getByRole("button", { name: S.prTimelineHide, exact: true }).click();
  await expect(timeline).toHaveCount(0);
  await page.reload();
  await page.locator(".sidebar .ticket .key").getByText("E2E-1", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-1", exact: true })).toBeVisible();
  await expect(pageTab(page, S.lay.tabPr)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: S.prTimelineShow, exact: true })).toBeVisible();
  await expect(page.locator(".pr-timeline")).toHaveCount(0);

  // 切到「概况」：阶段不显示；刷新后还停在「概况」（页签不会收起，只会换）。
  await openTicketTab(page, "overview");
  await expect(page.locator(".pr-stages")).toHaveCount(0);
  await page.reload();
  await page.locator(".sidebar .ticket .key").getByText("E2E-1", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-1", exact: true })).toBeVisible();
  await expect(pageTab(page, S.lay.tabOverview)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".pr-stages")).toHaveCount(0);
});

test("a ticket row in the epic's all-tickets tab opens its ticket (mouse and keyboard)", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const shop = join(s.dir, "shop");
  const { page } = await launch(s);
  await completeWizard(page, s);
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));

  await create(page, await newButton(page, "newEpic"), S.epicName, "shop-epic", shop);
  await create(page, page.locator(".epic-page .page-tabs-bar").getByRole("button", { name: `+ ${S.newFeature}`, exact: true }), S.featureName, "pay", shop);
  await newTicket(page, "EP-1", "frontend", "backend");

  // epic 页的「全部 ticket」按 feature 分组；点这一行的哪一格都去 ticket 页。
  const openFromEpic = async (activate: (row: Locator) => Promise<void>) => {
    await page.locator(".sidebar .epic-group > .feature-row .ticket").click();
    await expect(page.getByRole("heading", { name: "shop-epic", exact: true })).toBeVisible();
    await openTab(page, S.lay.tabTickets);
    const table = page.locator(".epic-page .ticket-table");
    await expect(table.locator("tr.group-row")).toHaveText(S.lay.groupHeader("pay", 0, 1));
    await activate(table.locator("tbody tr:not(.group-row)").filter({ hasText: "EP-1" }));
    await expect(page.getByRole("heading", { name: "EP-1", exact: true })).toBeVisible();
  };
  await openFromEpic((row) => row.locator(".key").click());
  await openFromEpic((row) => row.locator("td").last().click());
  // 键盘：ticket 号是按钮，聚焦后按回车。
  await openFromEpic(async (row) => {
    await row.getByRole("button", { name: "EP-1", exact: true }).focus();
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

/**
 * 每个 PR 一行（计划 2026-11-16）：分支 feature/DMS-1 上先后合并了 #1、#2（gh pr list 找到），#3 在另一个分支上、只在 handoff 里报过。
 * ticket 页三行，新的在前、都已合并；feature 页「全部 ticket」这个 ticket 一行，三个 PR 都列着；epic 页概况里这个 feature 有一个 ticket。
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
  await create(page, await newButton(page, "newEpic"), S.epicName, "shop", shop);
  await create(page, page.locator(".epic-page .page-tabs-bar").getByRole("button", { name: `+ ${S.newFeature}`, exact: true }), S.featureName, "app", shop);
  await newTicket(page, "DMS-1", "app", "api");

  // 2. ticket session 里 /handoff：报的 PR 只有 #3。
  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type("/handoff");
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain("next_steps");

  // 3. ticket 页「PR 详情」：三行，新的在前。watcher 每 15 秒一轮，分支上找到的 PR 下一轮才读。
  await openPrStages(page);
  const links = page.locator(".pr-stages .pr-repo .pr-link");
  await expect(links).toHaveText(["#3", "#2", "#1"], { timeout: 60_000 });
  // 三个 PR 都已合并：每行的「合并」一格是 done。
  const merge = page.locator(".pr-stages .pr-repo").locator(".pr-cell").filter({ hasText: S.prStage.merge });
  await expect(merge).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(merge.nth(i)).toHaveClass(/\bpr-done\b/);

  // 4. feature 页「全部 ticket」：这个 ticket 一行，三个 PR 都列着。
  await page.locator(".feature-link").getByRole("button", { name: "app", exact: true }).click();
  await expect(page.getByRole("heading", { name: "app", exact: true })).toBeVisible();
  await openTab(page, S.lay.tabTickets);
  const rows = page.locator(".feature-page .ticket-table tbody tr");
  await expect(rows).toHaveCount(1);
  const row = rows.filter({ hasText: "DMS-1" });
  await expect(row.locator("td").last()).toHaveText("#1 #2 #3");

  // 5. epic 页概况：这个 feature 有一个 ticket。「合了」数的是标成完成的 ticket；session 里的 /handoff 没把它标成完成，
  //    所以是 0/1（PR 合没合看 ticket 的「PR 详情」，上面已经看过）。
  await page.locator(".sidebar .epic-group > .feature-row .ticket").click();
  await expect(page.getByRole("heading", { name: "shop", exact: true })).toBeVisible();
  await openTab(page, S.lay.tabOverview);
  await expect(page.locator(".epic-page .scope-row").filter({ hasText: "app" })).toContainText(S.lay.featureCard(0, 1));
  expect(unsupportedGhCalls(s)).toEqual([]);
});

/**
 * 一次性补链接（计划 2026-11-16）：归档了的老 ticket，下次启动时从 gh pr list 找回它分支上 2025 年合并的 #9（开、合并时间都取自 pr list 那一项）。
 * 归档的 ticket 打不开 ticket 页（feature 页也不再有带归档行的 PR 进度表）：从「已归档」恢复它，在「PR 详情」里看。
 * 合并完成；设计、自我 review 未知（那时 hook 还没在记 skill）。
 */
test("backfill of an old merged ticket", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");
  const s = makeSandbox({ gh: { branches: {}, prs: {} } });
  let launched = await launch(s);
  let page = launched.page;
  await completeWizard(page, s);
  await create(page, await newButton(page, "newFeature"), S.featureName, "legacy", makeShop(s));
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
  await openArchived(page);
  await page.locator(".table tr").filter({ hasText: "OLD-1" }).getByRole("button", { name: S.unarchive, exact: true }).click();
  await expect(page.getByRole("heading", { name: "OLD-1", exact: true })).toBeVisible();
  await openPrStages(page);
  // 只有一个 PR：#9。
  await expect(page.locator(".pr-stages .pr-repo")).toHaveCount(1);
  await expect(page.locator(".pr-stages .pr-link")).toHaveText(["#9"]);
  // 链上 #9 才有它 2025 年的开 PR 时间（pr list 的 createdAt）：在那之前开发开始算 ticket 创建的时候，设计不会是未知。
  const cell = (id: PrStageId) => page.locator(".pr-stages .pr-cell").nth(PR_STAGES.indexOf(id));
  await expect(cell("design")).toHaveClass(/pr-unknown/, { timeout: 60_000 });
  await expect(cell("self_review")).toHaveClass(/pr-unknown/);
  await expect(cell("merge")).toHaveClass(/pr-done/);
  expect(unsupportedGhCalls(s)).toEqual([]);
});
