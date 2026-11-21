import type { Page } from "@playwright/test";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, create, expandPrStages, expect, FAKE_GH_ORIGIN, makeGitRepo, newButton, openTab, openTicketTab, pageTab, terminalText, test, type FakeGhFixture, type Sandbox } from "./fixtures";

/**
 * UI 重做第 3 层：ticket、feature 页分成页签。ticket 页默认停在「概况」、记着上次停在哪个页签；
 * 从首页「轮到你」的卡片进来时落在要你动手的那个页签；feature 的「总控」页签左边终端、右边对话。
 */

const goHome = (page: Page) => page.locator(".sidebar").getByRole("button", { name: S.home, exact: true }).click();

/** 新建一个单独的 ticket（worktree 方式，仓库是 repo），建完停在 ticket 页。 */
async function newTicket(page: Page, key: string, repo: string): Promise<void> {
  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill(key);
  // 这个 label 里还包着“选择…”按钮，输入框的可访问名是两段文字连起来。
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(repo);
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: key, exact: true })).toBeVisible();
}

const sidebarTicket = (page: Page, key: string) => page.locator(".sidebar .ticket").filter({ has: page.locator(".key", { hasText: new RegExp(`^${key}$`) }) });

test("a new ticket without a PR opens on its overview and remembers the terminal tab", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  await newTicket(page, "E2E-1", s.repo);

  // 默认停在「概况」：还没开 PR，没有「打开 PR」的按钮。
  await expect(pageTab(page, S.lay.tabOverview)).toHaveAttribute("aria-selected", "true");
  const panel = page.locator(".ticket-page .page-tabs-panel");
  await expect(panel).toContainText(S.lay.noPrYet);
  await expect(panel).not.toContainText(S.hm.act.openPr);
  await expect(page.getByRole("button", { name: S.hm.act.openPr, exact: true })).toHaveCount(0);

  // 「终端」页签能开 session。
  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");

  // 离开再回来还是「终端」，终端还在。
  await goHome(page);
  await sidebarTicket(page, "E2E-1").click();
  await expect(page.getByRole("heading", { name: "E2E-1", exact: true })).toBeVisible();
  await expect(pageTab(page, S.lay.tabTerminal)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".terminal-wrap")).toHaveCount(1);
});

const PR_URL = "https://github.com/acme/app/pull/52";
/** E2E-2 的分支上有一个开着的 PR，CI 挂了，没有 session 在修：轮到你（没人推进）。 */
const failingCi: FakeGhFixture = {
  branches: { "feature/E2E-2": [{ number: 52, url: PR_URL, state: "OPEN", headRefName: "feature/E2E-2", createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null }] },
  prs: {
    [PR_URL]: {
      number: 52, url: PR_URL, state: "OPEN", headRefName: "feature/E2E-2", createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null,
      isDraft: false, reviewDecision: "", headRefOid: "eeee5555eeee", author: { login: "dev" }, reviews: [], comments: [], commits: [],
      statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/app/actions/runs/91/job/1" }],
    },
  },
  runs: {
    "91": {
      attempt: 1, status: "completed", conclusion: "failure",
      jobs: [{ name: "test", status: "completed", conclusion: "failure", startedAt: "2026-11-18T08:00:00Z", completedAt: "2026-11-18T08:03:00Z", steps: [{ name: "Run tests", conclusion: "failure", number: 4 }] }],
    },
  },
  logs: { "91": "FAIL src/a.test.ts\n  expected 1 to be 2" },
};

test("a ticket whose CI failed opens from its home card on the PR tab", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");
  const s: Sandbox = makeSandbox({ gh: failingCi });
  const repo = makeGitRepo(join(s.dir, "proj", "app"), FAKE_GH_ORIGIN);
  const { page } = await launch(s);
  await completeWizard(page, s);
  await newTicket(page, "E2E-2", repo);
  // 进 ticket 页时停在「概况」；去首页，等 PR 读到、卡片出来。
  await expect(pageTab(page, S.lay.tabOverview)).toHaveAttribute("aria-selected", "true");
  await goHome(page);
  const card = page.getByTestId("turn-card").filter({ has: page.locator(".where .key", { hasText: /^E2E-2$/ }) });
  await expect(card).toHaveAttribute("data-kind", "unattended", { timeout: 60_000 });
  await expect(card.locator(".sentence")).toHaveText(S.turn.unattended.ci_failing);

  // 「去看看」：直接落在「PR 详情」，看得到这个 PR。
  await card.getByRole("button", { name: S.hm.act.look, exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-2", exact: true })).toBeVisible();
  await expect(pageTab(page, S.lay.tabPr)).toHaveAttribute("aria-selected", "true");
  await expandPrStages(page);
  await expect(page.locator(".ticket-pr-stages .pr-link")).toHaveText(["#52"]);
});

test("the feature's control tab: the terminal on the left, the conversation on the right, inside the tab", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const shop = join(s.dir, "shop");
  makeGitRepo(join(shop, "backend"));
  makeGitRepo(join(shop, "frontend"));
  const { page } = await launch(s);
  await completeWizard(page, s);
  await create(page, await newButton(page, "newFeature"), S.featureName, "feature-a", shop);

  // 「概况」里没有终端；点「总控」才有。
  await expect(page.locator(".feature-page .control-split")).toHaveCount(0);
  await openTab(page, S.lay.tabControl);
  const split = page.locator(".feature-page .page-tabs-panel.tab-panel-control .control-split");
  await expect(split).toHaveCount(1);
  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newCoordinator}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const left = split.locator(".control-left");
  const right = split.locator(".control-right");
  await expect(left.locator(".terminal-wrap:visible")).toHaveCount(1);
  await expect(right.locator(".control-feed")).toContainText(S.lay.ctlEmpty);

  // 并排：终端在左栏、对话在右栏，顶部对齐；终端不在页面底部（不在页签内容的下面）。
  const box = await page.evaluate(() => {
    const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const term = r(".feature-page .control-left .terminal-wrap");
    const panel = r(".feature-page .page-tabs-panel");
    return { left: r(".feature-page .control-left"), right: r(".feature-page .control-right"), term, panel, window: window.innerHeight };
  });
  const info = JSON.stringify(box);
  expect(box.left.right, info).toBeLessThanOrEqual(box.right.left + 1);
  expect(Math.abs(box.left.top - box.right.top), info).toBeLessThanOrEqual(1);
  expect(box.term.top, info).toBeGreaterThanOrEqual(box.panel.top - 1);
  expect(box.term.bottom, info).toBeLessThanOrEqual(box.panel.bottom + 1);
  expect(box.term.top, info).toBeLessThan(box.window / 2);
});
