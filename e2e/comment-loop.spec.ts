import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, FAKE_GH_ORIGIN, ghCalls, makeGitRepo, setLoopPolicy, terminalText, test, unsupportedGhCalls, type FakeGhFixture, type PrViewFixture, newButton, openTicketTab, openTab } from "./fixtures";

const url = "https://github.com/acme/app/pull/41";
const view = (sha: string): PrViewFixture => ({
  number: 41, url, state: "OPEN", headRefName: "feature/E2E-8", createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null,
  isDraft: false, reviewDecision: "", headRefOid: sha, author: { login: "dev" }, reviews: [], comments: [], commits: [], statusCheckRollup: [],
});
const thread = (outdated: boolean) => ({
  id: "PRRT_1", isResolved: false, isOutdated: outdated, path: "src/a.ts", line: outdated ? null : 3, originalLine: 3,
  comments: {
    nodes: [{
      databaseId: 501, author: { __typename: "Bot", login: "Copilot" }, body: "Prefer a const here.\n```suggestion\nconst total = 1;\n```",
      createdAt: "2026-11-18T08:05:00Z", url: `${url}#discussion_r501`, path: "src/a.ts", line: outdated ? null : 3, originalLine: 3, commit: { oid: "aaaa1111aaaa" },
    }],
  },
});
const fixture = (sha: string, outdated: boolean): FakeGhFixture => ({
  branches: { "feature/E2E-8": [{ number: 41, url, state: "OPEN", headRefName: "feature/E2E-8", createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null }] },
  prs: { [url]: view(sha) },
  threads: { "41": [thread(outdated)] },
});

/**
 * 工作流 I 验收：Copilot 的行内评论（带修改建议，规则判成「要改」）自动送进停着的 session；
 * push 之后评论位置过时了（GitHub 标 outdated），Butler 判定已处理，以 gh 回复并 resolve 这个 thread（两个对外动作开关都开着）。
 * 走真实的路径：PrWatcher 读 PR → CommentLoop.observe → gh api graphql 拉 thread → 规则分类 → delivery-guard + pty.deliver。
 * Windows 上跳过：假 gh 是 sh 包装，resolveGh 只认 gh.exe。
 */
test("a Copilot comment reaches the session, and after the push it is replied to and resolved", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");
  const s = makeSandbox({ gh: fixture("aaaa1111aaaa", false) });
  const repo = makeGitRepo(join(s.dir, "proj", "app"), FAKE_GH_ORIGIN);
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "feature/E2E-8"]);

  const { page } = await launch(s);
  await completeWizard(page, s);
  await setLoopPolicy(page, { "comments.enabled": "true" }, ["comment_reply", "comment_resolve"]);

  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("E2E-8");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(repo);
  await page.getByRole("radio", { name: S.branch, exact: true }).check();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-8", exact: true })).toBeVisible();

  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");

  // watcher 每 15 秒一轮：先从分支找到 PR，下一轮读它、拉评论、送进 session。
  await expect.poll(() => terminalText(page), { timeout: 90_000 }).toContain("Prefer a const here.");
  expect(await terminalText(page)).toContain("src/a.ts:3");
  await openTicketTab(page, "pr");
  await expect(page.getByTestId("comment-row").getByTestId("comment-state")).toContainText(S.lp.state.delivered);

  // session「push 了」：新的 head，评论位置过时。下一轮核对：已处理，回复并 resolve。
  s.setGh(fixture("bbbb2222bbbb", true));
  const replied = (): boolean => ghCalls(s).some((a) => a[0] === "api" && a[1] === "repos/{owner}/{repo}/pulls/41/comments/501/replies");
  const resolved = (): boolean => ghCalls(s).some((a) => a[0] === "api" && a[1] === "graphql" && a.includes("id=PRRT_1"));
  await expect.poll(replied, { timeout: 60_000 }).toBe(true);
  await expect.poll(resolved, { timeout: 30_000 }).toBe(true);
  const reply = ghCalls(s).find((a) => a[1] === "repos/{owner}/{repo}/pulls/41/comments/501/replies")!;
  expect(reply.find((x) => x.startsWith("body="))).toContain("bbbb222");
  await expect(page.getByTestId("comment-row").getByTestId("comment-state")).toContainText(S.lp.state.addressed);
  await expect(page.getByTestId("comment-row").getByTestId("comment-state")).toContainText(S.lp.replied);
  // 「效果」页的评论与 CI：自动处理 1 条（Copilot），回复 1 条、resolve 1 条。
  await page.locator(".sidebar").getByRole("button", { name: S.effectNav, exact: true }).click();
  // 评论与 CI、Review、intake 的效果在「自动化的效果」页签里。
  await openTab(page, S.lay.effectTabs.automation);
  const handled = page.getByTestId("effect-loop-handled");
  await expect(handled).toContainText(S.effect.loopHandledSub(1, 0));
  await expect(handled).toContainText(S.effect.loopReplied(1, 1));
  expect(unsupportedGhCalls(s)).toEqual([]);
});
