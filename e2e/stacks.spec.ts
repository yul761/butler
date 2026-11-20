import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, type FakeGhFixture, ghCalls, makeGitRepo, newButton, openAllWorkMore, openSettingsGroup, type PrViewFixture, terminalText, test, unsupportedGhCalls } from "./fixtures";

const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" }).trim();

const URL51 = "https://github.com/acme/app/pull/51";
const URL52 = "https://github.com/acme/app/pull/52";
const B1 = "feature/E2E-1";
const B2 = "feature/E2E-2";

// 时间按运行时算，不能写死：PR watcher 不给「链接时已经合并一天多」的 PR 跑 onMerged（MERGED_RECENT_MS），
// 写死的 mergedAt 过了一天，这条合并就被当成回填的旧 PR，栈不会 rebase。
const CREATED_AT = new Date(Date.now() - 60 * 60_000).toISOString();
const pr = (n: number, url: string, head: string, base: string, sha: string, o: { draft: boolean; mergedAt?: string }): PrViewFixture => ({
  number: n, url, state: o.mergedAt ? "MERGED" : "OPEN", headRefName: head, baseRefName: base, headRefOid: sha, isDraft: o.draft,
  title: head, body: "", labels: [], createdAt: CREATED_AT, mergedAt: o.mergedAt ?? null, closedAt: null,
  reviewDecision: "", author: { login: "dev" }, reviews: [], comments: [], commits: [], statusCheckRollup: [],
});
/** mergedAt 是 #51 合并的时间（ISO），没合并传 null。 */
const fixture = (sha1: string, sha2: string, mergedAt: string | null): FakeGhFixture => {
  const p51 = pr(51, URL51, B1, "main", sha1, { draft: false, mergedAt: mergedAt ?? undefined });
  const p52 = pr(52, URL52, B2, B1, sha2, { draft: true });
  const row = ({ number, url, state, headRefName, createdAt, mergedAt, closedAt }: PrViewFixture) => ({ number, url, state, headRefName, createdAt, mergedAt, closedAt });
  return {
    branches: { [B1]: [row(p51)], [B2]: [row(p52)] },
    prs: { [URL51]: p51, [URL52]: p52 },
    open: mergedAt ? [p52] : [p51, p52],
  };
};

/** 不开 feature，直接建一个 worktree 模式的 ticket（分支 feature/<key> 已经在仓库里了，就用它）。 */
async function newTicket(page: Page, key: string, repo: string): Promise<void> {
  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill(key);
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(repo);
  await page.getByRole("radio", { name: S.worktree, exact: true }).check();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: key, exact: true })).toBeVisible();
}

/** 设置 →「栈」：全局这一层打开 autoRebase，再打开栈要用的对外动作。 */
async function enableStacks(page: Page, external: readonly string[]): Promise<void> {
  await openSettingsGroup(page, "stacks");
  const editor = page.getByTestId("stack-policy-editor");
  await editor.getByTestId("stack-input-autoRebase").selectOption("true");
  await editor.getByTestId("stack-save").click();
  await expect(editor.getByTestId("stack-message")).toHaveText(S.lp.saved);
  for (const kind of external) {
    const box = page.getByTestId(`stack-external-${kind}`);
    await box.check();
    await expect(box).toBeChecked();
  }
}

/**
 * 工作流 K 验收：两层的栈（E2E-1 的 PR 在 main 上，E2E-2 的 draft PR 在 E2E-1 上），Butler 从开着的 PR 自动认出来；
 * 栈底 squash 合并以后，Butler 把 E2E-2 rebase 到新的 main 上、force push，把它的 PR 改到 main 上并标成 ready。
 * 走真实的路径：StackService.tick → detect（gh pr list）→ PrWatcher 看到合并 → onMerged → rebase 引擎 → apply → promoteBottom（gh pr edit / ready）。
 * origin 是沙盒里的裸仓库（fetch、push 都是真的），PR 由假 gh 提供。Windows 上跳过：假 gh 是 sh 包装。
 */
test("when the bottom of a stack merges, the stack is rebased and the next layer's PR is opened for review", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");
  const s = makeSandbox({ gh: { branches: {}, prs: {} } });
  const bare = join(s.dir, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const repo = makeGitRepo(join(s.dir, "proj", "app"), bare);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "checkout", "-q", "-b", B1);
  execFileSync("sh", ["-c", "echo one > a.txt"], { cwd: repo });
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "E2E-1 work");
  git(repo, "checkout", "-q", "-b", B2);
  execFileSync("sh", ["-c", "echo two > b.txt"], { cwd: repo });
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "E2E-2 work");
  git(repo, "push", "-q", "origin", B1, B2);
  git(repo, "checkout", "-q", "main");
  const sha1 = git(repo, "rev-parse", B1);
  const sha2 = git(repo, "rev-parse", B2);
  s.setGh(fixture(sha1, sha2, null));
  s.env = { BUTLER_STACKS_TICK_MS: "2000" };

  const { page } = await launch(s);
  await completeWizard(page, s);
  // 先建 ticket（栈的层要是 Butler 的分支），再开 autoRebase：自动检测只在开了的时候跑。
  await newTicket(page, "E2E-2", repo);
  await newTicket(page, "E2E-1", repo);
  // E2E-1 开一个 session：合并后它一停下，PR watcher 就马上去读它的 PR（不用等 5 分钟一轮）。
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await enableStacks(page, ["force_push", "pr_open"]);

  await openAllWorkMore(page);
  const stacks = page.getByTestId("managed-stacks");
  await expect(stacks.getByTestId(`stack-layer-${B1}-state`)).toHaveText(S.sk.state.ready, { timeout: 60_000 });
  await expect(stacks.getByTestId(`stack-layer-${B2}-state`)).toHaveText(S.sk.state.draft);
  // PR watcher 读过一次开着的 #51，合并才是一次变化。
  await expect.poll(() => ghCalls(s).some((a) => a[0] === "pr" && a[1] === "view" && a[2] === URL51), { timeout: 60_000 }).toBe(true);

  // 在「GitHub」上 squash 合并 #51：另一个 clone 里把 E2E-1 squash 进 main，推回裸仓库。
  const hub = join(s.dir, "hub");
  execFileSync("git", ["clone", "-q", bare, hub]);
  git(hub, "merge", "--squash", `origin/${B1}`);
  git(hub, "commit", "-q", "-m", "E2E-1 work (#51)");
  git(hub, "push", "-q", "origin", "main");
  const main = git(hub, "rev-parse", "HEAD");
  s.setGh(fixture(sha1, sha2, new Date().toISOString()));
  // E2E-1 的 session 说完一轮（跑 Stop hook）。
  await page.locator(".sidebar .ticket .key").getByText("E2E-1", { exact: true }).click();
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type("merged?");
  await page.keyboard.press("Enter");
  await openAllWorkMore(page);

  // E2E-2 rebase 到新的 main 上（只剩自己的一个提交），推上去了。
  await expect.poll(() => git(bare, "rev-parse", `${B2}~1`), { timeout: 60_000 }).toBe(main);
  expect(git(bare, "rev-list", "--count", `main..${B2}`)).toBe("1");
  expect(git(repo, "rev-parse", B2)).toBe(git(bare, "rev-parse", B2));
  // #52 改到 main 上、标成 ready。
  const called = (want: string[]) => ghCalls(s).some((a) => want.every((x, i) => a[i] === x));
  await expect.poll(() => called(["pr", "edit", "52", "--base", "main"]), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => called(["pr", "ready", "52"]), { timeout: 30_000 }).toBe(true);

  await expect(stacks.getByTestId(`stack-layer-${B1}-state`)).toHaveText(S.sk.state.merged);
  await expect(stacks.getByTestId(`stack-layer-${B2}-state`)).toHaveText(S.sk.state.ready);
  expect(unsupportedGhCalls(s)).toEqual([]);
});
