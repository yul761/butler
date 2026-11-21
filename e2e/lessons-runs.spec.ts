import type { Locator, Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RESUME_SLACK_MS } from "../src/main/claude/availability";
import { limitLine, resetClock } from "../src/renderer/src/availability-view";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, type FakeGhFixture, type Launched, openSettingsTab, type PrViewFixture, type Sandbox, terminalText, test, unsupportedGhCalls, openLessonsAdvanced } from "./fixtures";

/**
 * 复盘的分析记录和 Claude 限额（计划 2026-11-16 lessons-visibility 任务 13）：
 * 假 claude 的 lessons 模式（FAKE_CLAUDE_LESSONS_FILE：ok / fail / limit:<秒>）让后台分析失败、撞额度；
 * 交互 session 里的 /fake-limit 写一条 Claude Code 合成的限额报错。
 */

const SLUG = "acme/app";
const skipOnWindows = () => test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");

/** 假 gh 的一个已合并 PR：标题 PR <n>，带一条 alice 的评审评论（分析至少要有一条人的评论才会交给 claude）。 */
function lessonPr(n: number): PrViewFixture {
  const url = `https://github.com/${SLUG}/pull/${n}`;
  return {
    number: n, url, state: "MERGED", headRefName: `feature/pr-${n}`,
    createdAt: "2026-11-10T08:00:00Z", mergedAt: "2026-11-12T08:00:00Z", closedAt: "2026-11-12T08:00:00Z",
    isDraft: false, reviewDecision: "APPROVED", headRefOid: `sha${n}`, statusCheckRollup: [], author: { login: "dev" }, reviews: [],
    comments: [{ id: `IC_${n}`, author: { login: "alice" }, body: "Schema changes need a migration.", createdAt: "2026-11-11T08:00:00Z", url: `${url}#issuecomment-${n}` }],
    commits: [], title: `PR ${n}`, body: `Body of PR ${n}`,
  };
}

const ghFor = (prs: number[]): FakeGhFixture => ({ branches: {}, prs: Object.fromEntries(prs.map((n) => [`https://github.com/${SLUG}/pull/${n}`, lessonPr(n)])) });

/** 在 app.db 里登记 acme/app（本地路径是沙盒仓库，已补录过）和这些 PR 的排队项（已合并、排队中）。返回 PR 号 → 队列 id。 */
function seedLessonQueue(s: Sandbox, prs: number[]): Map<number, number> {
  const db = new DatabaseSync(join(s.butlerHome, "app.db"));
  const now = Date.now();
  db.prepare("INSERT INTO lesson_repos (slug, local_path, backfilled_at, created_at) VALUES (?, ?, ?, ?)").run(SLUG, s.repo, now, now);
  const ins = db.prepare("INSERT INTO lesson_queue (repo_slug, pr_number, origin, status, enqueued_at) VALUES (?, ?, 'merged', 'queued', ?)");
  const ids = new Map(prs.map((n, i) => [n, Number(ins.run(SLUG, n, now + i).lastInsertRowid)]));
  db.close();
  return ids;
}

/** 走完向导再关掉，插入排队项，重新启动：复盘队列在启动时开跑，排队项要在那之前就在库里。 */
async function launchSeeded(s: Sandbox, launch: (s: Sandbox) => Promise<Launched>, prs: number[]): Promise<{ page: Page; ids: Map<number, number> }> {
  const first = await launch(s);
  await completeWizard(first.page, s);
  await first.app.close();
  const ids = seedLessonQueue(s, prs);
  const { page } = await launch(s);
  return { page, ids };
}

/** 假 claude 每次复盘分析记的模式（运行记录里的 lessons <模式> 行），按调用顺序。 */
function lessonsCalls(s: Sandbox): string[] {
  if (!existsSync(s.fakeLog)) return [];
  return readFileSync(s.fakeLog, "utf8").split("\n").flatMap((l) => {
    const m = / lessons (\S+)$/.exec(l);
    return m ? [m[1]] : [];
  });
}

const homeButton = (page: Page) => page.getByRole("button", { name: S.home, exact: true });

async function openRuns(page: Page): Promise<void> {
  await openLessonsAdvanced(page);
  await page.getByTestId(`lessons-repo-${SLUG}`).click();
  await page.getByTestId("lessons-tab-runs").click();
  await expect(page.getByTestId("lesson-runs")).toBeVisible();
}

const runRow = (page: Page, queueId: number) => page.getByTestId(`lesson-run-${queueId}`);
const runPill = (page: Page, queueId: number) => runRow(page, queueId).locator(".pill");

/** 键值表（dl.kv）里名字正好是 term 的那一行的值。 */
const kv = (scope: Locator, term: string) =>
  scope.locator("dt").filter({ hasText: new RegExp(`^${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).locator("xpath=following-sibling::dd[1]");

/** 展开详情里的一段日志（<details>），返回它的正文。 */
async function openLog(detail: Locator, testid: string): Promise<Locator> {
  const block = detail.getByTestId(testid);
  await block.locator("summary").click();
  const body = block.locator("pre");
  await expect(body).toBeVisible();
  return body;
}

test("a failed run shows its reason and log, and retry succeeds", async ({ makeSandbox, launch }) => {
  skipOnWindows();
  const s = makeSandbox({ gh: ghFor([7]) });
  s.lessonsMode("fail");
  const { page, ids } = await launchSeeded(s, launch, [7]);
  const q7 = ids.get(7)!;

  // 1. 分析记录：#7 失败，原因是 Claude 返回错误；行上有重试，表头有“重试全部失败（1）”。
  await openRuns(page);
  await expect(runPill(page, q7)).toHaveText(S.lessonRunStatus.failed);
  await expect(runRow(page, q7)).toContainText(S.lessonRunReason.claude_error);
  await expect(runRow(page, q7)).toContainText("#7 PR 7");
  const retryAll = page.getByTestId("lesson-runs-retry-failed");
  await expect(retryAll).toHaveText(S.lessonRunRetryFailed(1));
  const rowRetry = page.getByTestId(`lesson-run-retry-${q7}`);
  await expect(rowRetry).toBeVisible();

  // 2. 详情：状态和原因、费用、错误信息、标准错误、发给 Claude 的材料；详情里的重试也能点。
  await page.getByTestId(`lesson-run-select-${q7}`).click();
  const detail = page.getByTestId("lesson-run-detail");
  const facts = detail.getByTestId("lesson-run-detail-facts");
  await expect(kv(facts, S.lessonRunFact.status)).toHaveText(`${S.lessonRunStatus.failed} · ${S.lessonRunReason.claude_error}`);
  await expect(kv(facts, S.lessonRunFact.cost)).toHaveText("$0.0042");
  await expect(detail.getByTestId("lesson-run-detail-message")).toHaveText("boom");
  await expect(await openLog(detail, "lesson-run-detail-stderr")).toContainText("fake lessons stderr: boom");
  await expect(await openLog(detail, "lesson-run-detail-material")).toContainText("PR 7");
  await expect(detail.getByTestId("lesson-run-detail-retry")).toBeEnabled();

  // 3. 换成正常回答，点行上的重试：完成，“重试全部失败”消失；假 claude 一共被调了两次。
  s.lessonsMode("ok");
  await rowRetry.click();
  await expect(runPill(page, q7)).toHaveText(S.lessonRunStatus.done);
  await expect(retryAll).toHaveCount(0);
  await expect(page.getByTestId(`lesson-run-retry-${q7}`)).toHaveCount(0);
  expect(lessonsCalls(s)).toEqual(["fail", "ok"]);
  expect(unsupportedGhCalls(s)).toEqual([]);
});

test("a usage-limit run pauses the queue and shows the Now notice", async ({ makeSandbox, launch }) => {
  skipOnWindows();
  const s = makeSandbox({ gh: ghFor([7, 8]) });
  const resetSec = Math.floor(Date.now() / 1000) + 3 * 3600;
  s.lessonsMode(`limit:${resetSec}`);
  const { page, ids } = await launchSeeded(s, launch, [7, 8]);
  const [q7, q8] = [ids.get(7)!, ids.get(8)!];

  // 1. 「现在」页：用量已达上限、几点恢复、复盘已暂停。
  await homeButton(page).click();
  const notice = page.getByTestId("now-notice-claude_limited");
  const hit = { kind: "usage_limit", resetsAt: resetSec * 1000, message: "" } as const;
  await expect(notice.locator("p")).toHaveText(S.noticeLimited(limitLine(hit, S, Date.now()), true));

  // 2. 复盘页：先等两行都不在“分析中”（受限或排队）。开始时两个是同时取走的（LESSON_CONCURRENCY），
  //    提醒出现时 #8 的假 claude 可能还没读完输入、没写日志；两行都停下来，起过的分析就都已经记进日志了。
  await openRuns(page);
  const stopped = new RegExp(`^(${S.lessonRunStatus.limited}|${S.lessonRunStatus.queued})$`);
  await expect(runPill(page, q7)).toHaveText(stopped);
  await expect(runPill(page, q8)).toHaveText(stopped);
  // 队列条写着暂停到几点（恢复时间加一分钟余量），#7 受限。
  await expect(page.getByTestId("lessons-queue-text")).toContainText(S.lessonQueuePausedUntil(resetClock(resetSec * 1000 + RESUME_SLACK_MS, Date.now()), null));
  await expect(runPill(page, q7)).toHaveText(S.lessonRunStatus.limited);
  await expect(runRow(page, q7)).toContainText(S.lessonRunReason.usage_limit);

  // 3. 暂停之后不再起新的分析：最多是开始时同时取走的两个，3 秒后还是这么多。
  const calls = lessonsCalls(s);
  expect(calls.length).toBeGreaterThanOrEqual(1);
  expect(calls.length).toBeLessThanOrEqual(2);
  expect(calls.every((c) => c === `limit:${resetSec}`)).toBe(true);
  await page.waitForTimeout(3000);
  expect(lessonsCalls(s)).toEqual(calls);

  // 4. 换成正常回答，在「现在」页点恢复：提醒消失，两个都分析完。
  s.lessonsMode("ok");
  await homeButton(page).click();
  await notice.getByRole("button", { name: S.noticeResume, exact: true }).click();
  await expect(notice).toHaveCount(0);
  await openRuns(page);
  await expect(runPill(page, q7)).toHaveText(S.lessonRunStatus.done);
  await expect(runPill(page, q8)).toHaveText(S.lessonRunStatus.done);
  expect(lessonsCalls(s).slice(calls.length)).toEqual(["ok", "ok"]);
  expect(unsupportedGhCalls(s)).toEqual([]);
});

test("a session that hits a limit shows the badge, the notice and the Health entry", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200" };
  const { page } = await launch(s);
  await completeWizard(page, s);

  // 1. Butler 总控 session 撞了用量上限（Claude Code 合成的报错，这一轮没有 Stop）。
  await page.locator(".sidebar").getByRole("button", { name: S.butlerNav, exact: true }).click();
  const butler = page.locator(".butler-page");
  await butler.getByRole("button", { name: `+ ${S.newButlerSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type("/fake-limit You've hit your limit · resets 3pm (UTC)");
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain("hit your limit");

  // 2. 首页：一张「Butler 要你点一下」的卡片，是这个 session 的用量提醒，点“打开会话”回到它。
  await homeButton(page).click();
  const card = page.getByTestId("turn-card").filter({ has: page.getByTestId("now-notice-session_limited") });
  await expect(card.locator(".turn-tag")).toHaveText(S.hm.kind.butler);
  const sessionNotice = page.getByTestId("now-notice-session_limited");
  await expect(sessionNotice).toContainText(S.limitKind.usage_limit);
  await sessionNotice.getByRole("button", { name: S.noticeOpen, exact: true }).click();
  await expect(butler).toBeVisible();
  await expect(butler.locator(".terminal-wrap:visible")).toHaveCount(1);
  await expect.poll(() => terminalText(page)).toContain("hit your limit");

  // 3. 账号受限的提醒（session_limited 只有“打开会话”）点“查看状态”：跳到设置 › 健康检查（可用性一块在这个 tab 里，
  //    不用滚就看得到），状态受限，来源是会话。先从侧栏进一次「基本」：上次停在别的 tab 也要跳到健康检查。
  const block = page.getByTestId("claude-availability");
  await openSettingsTab(page, "basic");
  await expect(block).toHaveCount(0);
  await homeButton(page).click();
  await page.getByTestId("now-notice-claude_limited").getByRole("button", { name: S.noticeHealth, exact: true }).click();
  await expect(page.getByTestId("settings-tab-health")).toHaveAttribute("aria-selected", "true");
  await expect(block).toBeInViewport();
  await expect(block.locator("h3")).toHaveText(S.availabilityTitle);
  await expect(kv(block, S.availabilityStateLabel)).toHaveText(S.availabilityState.limited);
  await expect(kv(block, S.availabilityCurrent)).toContainText(S.availabilitySource("session", null));
});
