import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { CAT } from "../src/main/assess/readiness";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, FAKE_GH_ORIGIN, type FakeGhFixture, makeGitRepo, newButton, openAllWorkMore, openSettingsGroup, type Sandbox, terminalText, test, unsupportedGhCalls, openTicketTab, openTab } from "./fixtures";

const BRANCH = "feature/E2E-7";
const url = "https://github.com/acme/app/pull/51";
const BODY = [
  "## What changed",
  "Adds a greeting helper so the app can say hello to the signed-in user.",
  "## Why",
  "The home page had no greeting.",
  "## How verified",
  "Unit test for the helper.",
].join("\n");

const fixture = (sha: string): FakeGhFixture => ({
  branches: { [BRANCH]: [{ number: 51, url, state: "OPEN", headRefName: BRANCH, createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null }] },
  prs: {
    [url]: {
      number: 51, url, state: "OPEN", headRefName: BRANCH, baseRefName: "main", createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null,
      isDraft: false, reviewDecision: "", headRefOid: sha, author: { login: "dev" }, reviews: [], comments: [], commits: [],
      title: "Greet the user", body: BODY, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
      statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme/app/actions/runs/5/job/1" }],
    },
  },
});

const fakeLog = (s: Sandbox) => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");

async function callTool(page: Page, s: Sandbox, tool: string, args: unknown): Promise<{ error: boolean; text: string }> {
  const calls = () => [...fakeLog(s).matchAll(/ mcp result (.+)/g)].map((m) => JSON.parse(m[1]) as { isError?: boolean; content: { text: string }[] });
  const before = calls().length;
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type(`/fake-mcp ${tool} ${JSON.stringify(args)}`);
  await page.keyboard.press("Enter");
  await expect.poll(() => calls().length).toBe(before + 1);
  const r = calls()[before];
  return { error: r.isError === true, text: r.content[0].text };
}

/**
 * 工作流 G 验收：设置里开预审 → 开发 session 交证据（MCP submit_evidence）→ 后台预审（假 claude 回没有违规、核对一致、简报摘要）
 * → ticket 页 Review 标签显示就绪条件、风险、简报。先只交验收条件：缺测试输出、没就绪；再补上测试：就绪。
 * 进度页有「待 review」，效果页有「Review 效果」区块。走真实路径：PrWatcher → PreReviewService → 后台队列 → 假 gh / 假 claude。
 * Windows 上跳过：假 gh 是 sh 包装，resolveGh 只认 gh.exe。
 */
test("evidence goes through pre-review into readiness, risk and a review brief", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");
  const s = makeSandbox({ gh: { branches: {}, prs: {} } });
  const repo = makeGitRepo(join(s.dir, "proj", "app"), FAKE_GH_ORIGIN);
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf8" });
  git("checkout", "-q", "-b", BRANCH);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "greet.ts"), 'export const greet = (name: string): string => `Hello, ${name}`;\n');
  writeFileSync(join(repo, "src", "greet.test.ts"), 'import { greet } from "./greet";\nif (greet("a") !== "Hello, a") throw new Error("bad");\n');
  git("add", ".");
  git("commit", "-q", "-m", "greet the user");
  const sha = git("rev-parse", "HEAD").trim();
  s.setGh(fixture(sha));
  // 第一次预审先卡在假 claude 里：看「预审中」的徽标、侧栏指示和队列页（BTL-271）。
  const gate = join(s.dir, "prereview-gate");
  writeFileSync(gate, "");
  s.env.FAKE_CLAUDE_PREREVIEW_GATE = gate;

  const { page } = await launch(s);
  await completeWizard(page, s);
  // 设置 →「预审和就绪」：打开预审。
  await openSettingsGroup(page, "review");
  const enabled = page.getByTestId("review-enabled");
  await enabled.check();
  await expect(enabled).toBeChecked();
  await expect(page.getByTestId("review-row-evidence.require.test")).toBeVisible();
  // 并发数是个设置（BTL-271）：改成 3，队列页上写着。
  await page.getByTestId("review-concurrency").selectOption("3");
  await expect(page.getByTestId("review-concurrency")).toHaveValue("3");

  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("E2E-7");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(repo);
  await page.getByRole("radio", { name: S.branch, exact: true }).check();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-7", exact: true })).toBeVisible();
  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");

  // 1. 只交验收条件：预审做完，证据缺测试输出 → 没就绪。
  const first = await callTool(page, s, "submit_evidence", { acceptance: [{ criterion: "greets the user", how: "src/greet.ts returns Hello, <name>" }] });
  expect(first.error, first.text).toBe(false);
  // 预审卡着（BTL-271）：ticket 页头和 session 条上都是「预审中」（和「等 CI」分得开），侧栏有「预审 1 个进行中」。
  await expect.poll(() => fakeLog(s), { timeout: 90_000 }).toContain("pre-review held");
  await expect(page.locator(".ticket-header [data-testid=prereview-chip]")).toHaveAttribute("data-state", "running", { timeout: 30_000 });
  await expect(page.locator(".sessions-bar [data-testid=prereview-chip]")).toHaveAttribute("data-state", "running");
  const nav = page.getByTestId("nav-prereview");
  await expect(nav).toContainText(S.prq.sidebar(1, 0));
  // 点进去：队列页列出在跑的那个（ticket、怎么触发的），写着并发数。
  await nav.click();
  const running = page.getByTestId("prereview-running");
  await expect(running).toContainText("E2E-7");
  await expect(running).toContainText(S.prq.trigger.evidence);
  await expect(page.getByTestId("prereview-queue-page")).toContainText(S.prq.concurrency(3));
  // 放行：队列空了，回 ticket 页。
  rmSync(gate);
  await expect(page.getByTestId("prereview-queue-empty")).toBeVisible({ timeout: 90_000 });
  await page.locator(".sidebar").getByRole("button", { name: /^E2E-7/ }).click();
  await expect(page.getByRole("heading", { name: "E2E-7", exact: true })).toBeVisible();
  await openTicketTab(page, "pr");
  const card = page.getByTestId("review-pr-51");
  await expect(card.getByTestId("review-prereview")).toHaveAttribute("data-status", "done", { timeout: 90_000 });
  const evidenceCond = card.getByTestId("review-conditions").locator('li[data-state]').filter({ hasText: S.rv.cond.evidence });
  await expect(evidenceCond).toHaveAttribute("data-state", "fail", { timeout: 90_000 });
  await expect(evidenceCond).toContainText(new RegExp(`${CAT.zh.test}|${CAT.en.test}`));
  await expect(card.getByTestId("review-ready-badge")).toHaveText(S.rv.notReady);
  await expect(card.getByTestId("review-gaps")).toBeVisible();
  // 做完了：页头的徽标是「预审通过」（假 claude 没找到违规）。
  await expect(page.locator(".ticket-header [data-testid=prereview-chip]")).toHaveAttribute("data-state", "clean");

  // 2. 补上测试输出：核对一致 → 六个条件都满足，就绪；有风险等级和简报。工具在「终端」页签的 session 里调，结果回「PR 详情」看。
  await openTicketTab(page, "terminal");
  const second = await callTool(page, s, "submit_evidence", {
    checks: [{ name: "unit tests", category: "test", command: "node src/greet.test.ts", result: "pass", output: "1 passed" }],
    acceptance: [{ criterion: "greets the user", how: "src/greet.ts returns Hello, <name>" }],
  });
  expect(second.error, second.text).toBe(false);
  await openTicketTab(page, "pr");
  await expect(card.getByTestId("review-ready-badge")).toHaveText(S.rv.ready, { timeout: 90_000 });
  await expect(card.getByTestId("review-conditions").locator('li[data-state="fail"], li[data-state="unknown"]')).toHaveCount(0);
  await expect(card.getByTestId("review-evidence").locator('tr[data-verified="consistent"]')).toHaveCount(2);
  await expect(card.getByTestId("review-risk-badge")).toBeVisible();
  await expect(card.getByTestId("review-brief")).toContainText("Fake brief: adds a greeting to the app.");
  expect(fakeLog(s)).toMatch(/ pre-review files=\d+/);

  // 「待 review」队列：原来在进度页上，现在在全部工作页的「更多」里。
  await openAllWorkMore(page);
  const queued = page.getByTestId("review-queue").getByTestId("review-queue-51");
  await expect(queued).toBeVisible();
  await expect(queued).toContainText(S.rv.ready);
  await expect(queued).toContainText("E2E-7");

  // 效果页：Review 效果区块在。
  await page.locator(".sidebar").getByRole("button", { name: S.effectNav, exact: true }).click();
  // 评论与 CI、Review、intake 的效果在「自动化的效果」页签里。
  await openTab(page, S.lay.effectTabs.automation);
  await expect(page.getByTestId("effect-review")).toBeVisible();
  await expect(page.getByTestId("effect-review-groups")).toBeVisible();
  expect(unsupportedGhCalls(s)).toEqual([]);
});
