import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { M } from "../src/main/strings";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, FAKE_GH_ORIGIN, makeGitRepo, terminalText, test, unsupportedGhCalls } from "./fixtures";

/**
 * 工作流 W：session 在自己的 worktree 里推了一个不是 ticket 分支的分支、开了 PR，CI 的结论递回这个 session。
 * 走真实的路径：假 claude 的 /fake-run → matcher 为 Bash 的 PostToolUse hook → butler-hook（只为 git push / gh pr create 写信封）
 * → BranchOwnership 记下分支是谁的、按 gh pr create 打出来的链接链接 PR（以前漏链接的就是这种 PR）→ PrWatcher 读到 CI 通过
 * → CiDelivery 按归属递给这个 session（以前因为分支不是 ticket 分支，一直不递）。
 * Windows 上跳过：假 gh 是 sh 包装，resolveGh 只认 gh.exe。
 */
test("a PR opened from a worktree branch gets its CI result delivered to the session that pushed it", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");
  const url = "https://github.com/acme/app/pull/34";
  const s = makeSandbox({
    gh: {
      branches: {},
      prs: {
        [url]: {
          number: 34, url, state: "OPEN", headRefName: "feat/wt", createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null,
          isDraft: false, reviewDecision: "", headRefOid: "abcdef1234567", author: { login: "dev" }, reviews: [], comments: [], commits: [],
          statusCheckRollup: [{ __typename: "StatusContext", context: "test", state: "SUCCESS", targetUrl: "" }],
        },
      },
      created: url,
    },
  });
  // ticket 的仓库（origin 是假 gh 认的 acme/app），一个本地的 bare 仓库给 git push 用（不联网），和一个 feat/wt 的 worktree。
  const repo = makeGitRepo(join(s.dir, "proj", "app"), FAKE_GH_ORIGIN);
  const remote = join(s.dir, "remote.git");
  const wt = join(s.dir, "wt");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["-C", repo, "remote", "add", "local", remote]);
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "feat/wt", wt]);
  // 共享检出已经在 ticket 的分支上（开 session 时不问要不要切换）。
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "feature/E2E-7"]);

  const { page } = await launch(s);
  await completeWizard(page, s);
  await page.getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("E2E-7");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(repo);
  // 和出问题的场景一样：ticket 在原目录用分支，子 session 在别的 worktree 里推自己的分支。
  await page.getByRole("radio", { name: S.branch, exact: true }).check();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-7", exact: true })).toBeVisible();

  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type(`/fake-run cd ${wt} && git push -q local feat/wt && gh pr create --fill`);
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain(url);

  // watcher 每 15 秒一轮：链接上的 PR 下一轮读到 CI 通过，session 停着，递进去。
  // 只比一小段：整条通知在终端里会折行（假 claude 回“收到：<输入>”）。
  const passed = M().ciPassedNotice(M().ciWherePr(34), "abcdef1");
  await expect.poll(() => terminalText(page), { timeout: 60_000 }).toContain(passed.slice(passed.indexOf("PR #34"), passed.indexOf("abcdef1") + 7));
  expect(unsupportedGhCalls(s)).toEqual([]);
});
