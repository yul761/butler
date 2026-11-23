import { join } from "node:path";
import { EXTERNAL_ACTIONS } from "../src/shared/external";
import { S } from "../src/renderer/src/strings";
import { type BranchPrFixture, completeWizard, create, expect, FAKE_GH_ORIGIN, makeGitRepo, newButton, newTicket, openAllWork, openSettingsGroup, openTab, type PrViewFixture, test, unsupportedGhCalls } from "./fixtures";

/**
 * 设置里的「对外动作」十个开关默认全关、改了能存住；审计页有「对外动作」一节；全局总控页右栏有折起的「消息」。
 * 进度页在 UI 重做第 2 层拆掉了：原来这里对它每一块的断言一起删掉（PR 表、feature 分组由第 3 层并进 feature 页）。
 * 不用 gh，Windows 上也跑。
 */
test("outward actions are off by default; the audit page and Shipherd replies are there", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);

  // 设置：十个开关，默认全关；打开一个，离开再回到设置页还是开着。
  await openSettingsGroup(page, "external");
  const block = page.getByTestId("external-actions");
  await expect(block).toBeVisible();
  for (const kind of EXTERNAL_ACTIONS) await expect(block.getByTestId(`external-${kind}`)).not.toBeChecked();
  await block.getByTestId("external-ci_rerun").click();
  await expect(block.getByTestId("external-ci_rerun")).toBeChecked();
  await openAllWork(page);
  await openSettingsGroup(page, "external");
  await expect(page.getByTestId("external-ci_rerun")).toBeChecked();

  // 审计页的「对外动作」一节；Shipherd 页右栏折起的「消息」。
  await page.locator(".sidebar").getByRole("button", { name: S.audit, exact: true }).click();
  await expect(page.getByTestId("external-audit")).toContainText(S.externalAuditNone);
  await page.locator(".sidebar").getByRole("button", { name: S.shipherdNav, exact: true }).click();
  await page.locator(".messages-box > summary").click();
  await expect(page.getByText(S.messagesNone, { exact: true })).toBeVisible();
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
 * 两个 ticket 各一个开着的 PR，PG-2 的 PR 叠在 PG-1 的分支上：feature「全部 ticket」里两行都写着在等谁（UI 重做第 3 层，
 * 原来的「卡在谁手上」小节并进了这张表）：PG-1 在等 reviewer alice，PG-2 是草稿、轮到你。
 * Windows 上跳过：resolveGh 只认 gh.exe，假 gh 是 sh 包装。
 */
test("open PRs show who they wait on in the feature's all-tickets tab", async ({ makeSandbox, launch }) => {
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
  await create(page, await newButton(page, "newFeature"), S.featureName, "login", shop);
  await newTicket(page, "PG-1", "app", "api");
  await page.locator(".feature-link").getByRole("button", { name: "login", exact: true }).click();
  await newTicket(page, "PG-2", "app", "api");

  // watcher 每 15 秒一轮，分支上找到的 PR 下一轮才读。
  await page.locator(".sidebar .ticket.feature").filter({ hasText: "login" }).click();
  await expect(page.getByRole("heading", { name: "login", exact: true })).toBeVisible();
  await openTab(page, S.lay.tabTickets);
  const row = (key: string) => page.locator(".feature-page .ticket-table tbody tr").filter({ has: page.locator(".key", { hasText: new RegExp(`^${key}$`) }) });
  await expect(row("PG-1").locator("td").last()).toHaveText("#5", { timeout: 60_000 });
  await expect(row("PG-2").locator("td").last()).toHaveText("#6", { timeout: 60_000 });
  await expect(row("PG-1").locator(".who")).toHaveText("alice");
  await expect(row("PG-1").locator("td").nth(2)).toHaveText(S.turn.external.awaitingReview(["alice"]));
  await expect(row("PG-2").locator(".who")).toHaveText(S.lay.whoYou);
  await expect(row("PG-2").locator("td").nth(2)).toHaveText(S.turn.unattended.draft);
  expect(unsupportedGhCalls(s)).toEqual([]);
});
