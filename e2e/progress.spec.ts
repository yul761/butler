import type { Page } from "@playwright/test";
import { join } from "node:path";
import { EXTERNAL_ACTIONS } from "../src/shared/external";
import { S } from "../src/renderer/src/strings";
import { type BranchPrFixture, completeWizard, create, expect, FAKE_GH_ORIGIN, makeGitRepo, newTicket, openSettingsGroup, openTab, type PrViewFixture, test, unsupportedGhCalls } from "./fixtures";

/** 侧栏的「进度」。 */
const openProgress = async (page: Page) => {
  await page.locator(".sidebar").getByRole("button", { name: S.progressNav, exact: true }).click();
  await expect(page.getByTestId("progress-page")).toBeVisible();
};

/**
 * 进度页（ws-b）：侧栏打开，每一块都在；设置里的「对外动作」十个开关默认全关、改了能存住；审计页有「对外动作」一节；Butler 页有「回复」tab。
 * 不用 gh，Windows 上也跑。
 */
test("the Progress page shows every block, and outward actions are off by default", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  const shop = join(s.dir, "shop");
  makeGitRepo(join(shop, "app"));
  makeGitRepo(join(shop, "api"));
  await create(page, page.locator(".sidebar").getByRole("button", { name: `+ ${S.newFeature}`, exact: true }), S.featureName, "login", shop);
  await newTicket(page, "PG-1", "app", "api");

  await openProgress(page);
  for (const id of ["progress-summary", "progress-stuck-section", "progress-stacks", "progress-prs", "progress-features", "progress-freshness"]) {
    const block = id === "progress-stuck-section" ? page.locator(".progress-stuck-section") : page.getByTestId(id);
    await expect(block, id).toBeVisible();
  }
  await expect(page.getByTestId("progress-summary")).toContainText(S.progress.total(1));
  await expect(page.locator(".progress-stuck-section")).toContainText(S.progress.stuckNone);
  await expect(page.getByTestId("progress-features")).toContainText("login");
  await expect(page.getByTestId("progress-features").getByRole("button", { name: "PG-1", exact: true })).toBeVisible();
  // 各格的定义可以展开。
  await page.getByRole("button", { name: S.progress.definitions, exact: true }).click();
  await expect(page.locator(".progress-defs")).toContainText(S.progress.bucketDefs.in_review);
  // 按 feature 过滤；点 ticket 去 ticket 页。
  await page.getByTestId("progress-feature").selectOption({ label: "login" });
  await expect(page.getByTestId("progress-summary")).toContainText(S.progress.total(1));
  await page.getByTestId("progress-features").getByRole("button", { name: "PG-1", exact: true }).click();
  await expect(page.getByRole("heading", { name: "PG-1", exact: true })).toBeVisible();

  // 设置：十个开关，默认全关；打开一个，重新进设置页还是开着。
  await openSettingsGroup(page, "external");
  const block = page.getByTestId("external-actions");
  await expect(block).toBeVisible();
  for (const kind of EXTERNAL_ACTIONS) await expect(block.getByTestId(`external-${kind}`)).not.toBeChecked();
  await block.getByTestId("external-ci_rerun").click();
  await expect(block.getByTestId("external-ci_rerun")).toBeChecked();
  await openProgress(page);
  await openSettingsGroup(page, "external");
  await expect(page.getByTestId("external-ci_rerun")).toBeChecked();

  // 审计页的「对外动作」一节；Butler 页的「回复」tab。
  await page.locator(".sidebar").getByRole("button", { name: S.audit, exact: true }).click();
  await expect(page.getByTestId("external-audit")).toContainText(S.externalAuditNone);
  await page.locator(".sidebar").getByRole("button", { name: S.butlerNav, exact: true }).click();
  await openTab(page, S.butlerRepliesTab);
  await expect(page.getByText(S.butlerRepliesNone, { exact: true })).toBeVisible();
});

/** 假 gh 的一个开着的 PR：list 和 view 两份。 */
function openPr(number: number, head: string, base: string, extra: Partial<PrViewFixture> = {}): { list: BranchPrFixture; view: PrViewFixture } {
  const url = `https://github.com/acme/app/pull/${number}`;
  const list = { number, url, state: "OPEN" as const, headRefName: head, createdAt: "2026-11-01T08:00:00Z", mergedAt: null, closedAt: null };
  return {
    list,
    view: {
      ...list, isDraft: false, reviewDecision: "REVIEW_REQUIRED", headRefOid: `sha${number}`, statusCheckRollup: [], author: { login: "dev" }, reviews: [], comments: [], commits: [],
      title: `[auth] PR ${number}`, baseRefName: base, labels: [{ name: "ui" }], reviewRequests: [{ login: "alice" }], mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", ...extra,
    },
  };
}

/**
 * 两个 ticket 各一个开着的 PR，PG-2 的 PR 叠在 PG-1 的分支上：进度页有叠放树、两行「在等 reviewer：alice」、按 label 分组的 PR 表；
 * feature 的 PR 进度 tab 顶上有同样的「卡在谁手上」，点「在进度页里看」带着 feature 过滤过去。
 * Windows 上跳过：resolveGh 只认 gh.exe，假 gh 是 sh 包装。
 */
test("open PRs show who they wait on, the stack, and the feature tab's stuck block", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");
  const one = openPr(5, "feature/PG-1", "main");
  const two = openPr(6, "feature/PG-2", "feature/PG-1", { isDraft: true, reviewRequests: [] });
  const s = makeSandbox({
    gh: {
      branches: { "feature/PG-1": [one.list], "feature/PG-2": [two.list] },
      prs: Object.fromEntries([one, two].map((p) => [p.view.url.toLowerCase(), p.view])),
    },
  });
  const { page } = await launch(s);
  await completeWizard(page, s);
  const shop = join(s.dir, "shop");
  makeGitRepo(join(shop, "app"), FAKE_GH_ORIGIN);
  makeGitRepo(join(shop, "api"));
  await create(page, page.locator(".sidebar").getByRole("button", { name: `+ ${S.newFeature}`, exact: true }), S.featureName, "login", shop);
  await newTicket(page, "PG-1", "app", "api");
  await page.locator(".feature-link").getByRole("button", { name: "login", exact: true }).click();
  await newTicket(page, "PG-2", "app", "api");

  // watcher 每 15 秒一轮，分支上找到的 PR 下一轮才读。
  await openProgress(page);
  const stuck = page.getByTestId("progress-stuck");
  await expect(stuck.locator("tbody tr")).toHaveCount(2, { timeout: 60_000 });
  const pg1 = stuck.locator("tbody tr").filter({ has: page.getByRole("button", { name: "PG-1", exact: true }) });
  await expect(pg1).toContainText(S.labelled(S.progress.who.reviewers, "alice"));
  await expect(pg1).toContainText(S.progress.reasons.review_requested);
  const pg2 = stuck.locator("tbody tr").filter({ has: page.getByRole("button", { name: "PG-2", exact: true }) });
  await expect(pg2).toContainText(S.progress.reasons.draft);
  await expect(page.getByTestId("progress-stacks")).toContainText("feature/PG-2 → feature/PG-1");
  await expect(page.getByTestId("progress-prs")).toContainText("ui");
  await page.getByRole("button", { name: S.progress.byPrefix, exact: true }).click();
  await expect(page.locator(".progress-pr-group h4").first()).toContainText("auth");
  await expect(page.getByTestId("progress-summary")).toContainText(`${S.progress.buckets.in_review} 1`);

  // feature 的 PR 进度 tab：同样的「卡在谁手上」。
  await page.locator(".sidebar .ticket.feature").filter({ hasText: "login" }).click();
  await expect(page.getByRole("heading", { name: "login", exact: true })).toBeVisible();
  await openTab(page, S.prStagesTab);
  await expect(page.getByTestId("pr-stuck-block").locator("tbody tr")).toHaveCount(2);
  await page.getByTestId("pr-stuck-block").getByRole("button", { name: S.prStagesOpenProgress, exact: true }).click();
  await expect(page.getByTestId("progress-page")).toBeVisible();
  await expect(page.getByTestId("progress-feature")).toHaveValue(/\d+/);
  expect(unsupportedGhCalls(s)).toEqual([]);
});
