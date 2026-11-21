import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CI_ONLY_REPO, JS_REPO, type FixtureRepo } from "../src/main/baselines/__fixtures__/repos";
import { M } from "../src/main/strings";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, makeGitRepo, terminalText, test, type Sandbox, newButton, openTicketTab, openLessonsAdvanced } from "./fixtures";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

/**
 * 把一组文件提交进仓库，挂上 GitHub 样子的 origin（Butler 按 slug 认仓库）。
 * https 协议在这个仓库里关掉：导出时的 `git fetch origin` 立刻失败，不会连网；推送也一样到不了任何地方。
 */
function seedRepo(root: string, files: FixtureRepo, slug: string): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, "config", "user.name", "e2e");
  git(root, "config", "user.email", "e2e@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "protocol.https.allow", "never");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  git(root, "remote", "add", "origin", `https://github.com/${slug}.git`);
}

function registerRepos(s: Sandbox, repos: [string, string][]): void {
  const d = new DatabaseSync(join(s.butlerHome, "app.db"), { timeout: 5000 });
  try {
    for (const [slug, path] of repos) d.prepare("INSERT INTO lesson_repos (slug, local_path, created_at) VALUES (?, ?, ?)").run(slug, path, Date.now());
  } finally {
    d.close();
  }
}

/**
 * 仓库现状（工作流 E2）：扫描一个 JS 仓库 → 表里有它自己的测试命令，建议和可直接用的检查都在 → 建一条复用仓库 ESLint 命令的检查（试运行）
 * → ticket session 的说明里有这个仓库的档案和正确的测试命令，别的仓库不在里面
 * → 只有 CI 的仓库靠模型补全（假 claude），低置信的要逐条确认才建
 * → 一条禁止 debugger; 的检查扫存量得到「存量 2 处」和明细
 * → 导出成仓库的规则：在 Butler 的 worktree 里新分支上提交就停，对外开关关着时推送被拒绝并记录，用户的 checkout 不动。
 */
test("baselines: scan, adopt, profile in the ticket guide, inferred fallback, legacy count and export with push refused", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  seedRepo(s.repo, { ...JS_REPO, "src/legacy-a.ts": "debugger;\n", "src/legacy-b.ts": "const a = 1;\ndebugger;\n" }, "acme/web");
  const ciRepo = makeGitRepo(join(s.dir, "repos", "ci"));
  seedRepo(ciRepo, CI_ONLY_REPO, "acme/ci");
  const { page } = await launch(s);
  await completeWizard(page, s);
  registerRepos(s, [["acme/web", s.repo], ["acme/ci", ciRepo]]);
  await page.reload();

  // 1. 扫描 JS 仓库：现有检查表、建议、可直接用的检查。
  await openLessonsAdvanced(page);
  await page.getByTestId("lessons-page-tab-baselines").click();
  const web = page.getByTestId("baseline-repo-acme-web");
  await expect(web).toContainText(S.bl.never);
  await web.getByTestId("baseline-scan-acme-web").click();
  await expect(web.getByTestId("baseline-status-acme-web")).toHaveText(S.bl.status.ok);
  await expect(web.getByTestId("baseline-check-|test|vitest")).toContainText("pnpm test");
  await expect(web.getByTestId("baseline-check-|test|vitest")).toContainText(S.bl.confidence.high);
  await expect(web.getByTestId("baseline-check-|lint|eslint")).toBeVisible();
  await web.getByTestId("baseline-profile-toggle-acme-web").click();
  await expect(web.getByTestId("baseline-profile-acme-web")).toContainText("`pnpm test`");

  // 2. 建一条复用仓库 ESLint 的检查（只给 lint / 格式 / 类型检查起草，测试不起草）：试运行。
  await expect(web.getByTestId("baseline-draft-|test|vitest")).toHaveCount(0);
  await web.getByTestId("baseline-draft-|lint|eslint").check();
  await web.getByTestId("baseline-adopt-acme-web").click();
  await expect(web.getByTestId("baseline-msg-acme-web")).toHaveText(S.bl.adopted(1));
  await expect(web.getByTestId("baseline-draft-|lint|eslint")).toBeDisabled();

  // 3. 只有 CI 的仓库：假 claude 补全，结果是低置信的推断；不确认就建不了。
  const ci = page.getByTestId("baseline-repo-acme-ci");
  await ci.getByTestId("baseline-scan-acme-ci").click();
  await expect(ci.getByTestId("baseline-status-acme-ci")).toHaveText(S.bl.status.ok);
  await expect.poll(fakeLog).toContain("repo scan infer");
  await expect(ci.getByText(S.bl.inferred.ran, { exact: true })).toBeVisible();
  const inferred = ci.locator("tr").filter({ hasText: "./tools/check.sh" });
  await expect(inferred).toContainText(S.bl.source.inferred);
  await expect(inferred).toContainText(S.bl.confidence.low);
  await expect(ci.getByText(S.bl.lowNote)).toBeVisible();
  const lowDraft = ci.locator("[data-testid^=baseline-draft-]").first();
  await lowDraft.check();
  await expect(ci.getByTestId("baseline-adopt-acme-ci")).toBeDisabled();
  await ci.locator("[data-testid^=baseline-confirm-]").first().check();
  await expect(ci.getByTestId("baseline-adopt-acme-ci")).toBeEnabled();
  await ci.getByTestId("baseline-adopt-acme-ci").click();
  await expect(ci.getByTestId("baseline-msg-acme-ci")).toHaveText(S.bl.adopted(1));

  // 4. ticket session（只在 acme/web 上）：说明里有 acme/web 的档案和测试命令，没有 acme/ci。
  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("BAS-1");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "BAS-1", exact: true })).toBeVisible();
  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const launchLine = fakeLog().split("\n").find((l) => l.includes("interactive new"))!;
  const guide = /guide=(.*)$/.exec(launchLine)?.[1] ?? "";
  expect(guide).not.toBe("");
  const guideText = readFileSync(guide, "utf8");
  expect(guideText).toContain("acme/web");
  expect(guideText).toContain("`pnpm test`");
  expect(guideText).toContain("`pnpm exec vitest run {test}`");
  expect(guideText).not.toContain("acme/ci");
  expect(guideText).not.toContain("./tools/check.sh");

  // 5. 一条禁止 debugger; 的检查（acme/web 这一层），扫存量：2 处，有明细。
  await openLessonsAdvanced(page);
  await page.getByTestId("lessons-page-tab-checks").click();
  await page.getByTestId("checks-layer").selectOption("repo:acme/web");
  await page.getByTestId("checks-new").click();
  await page.getByTestId("check-form-name").fill("no debugger");
  await page.getByTestId("check-form-type").selectOption("forbidden_pattern");
  await page.getByTestId("check-form-pattern").fill("debugger;");
  await page.getByTestId("check-form-save").click();
  await expect(page.getByTestId("check-form")).toHaveCount(0);
  const row = page.locator(".check-row").filter({ hasText: "no debugger" });
  await row.locator("[data-testid^=check-tools-toggle-]").click();
  await expect(row.locator("select[data-testid^=check-repo-]")).toHaveValue("acme/web");
  await row.locator("[data-testid^=legacy-run-]").click();
  await expect(row.locator("[data-testid^=legacy-count-]")).toHaveText(S.legacy.count(2));
  await row.locator("[data-testid^=legacy-detail-]").click();
  await expect(row.locator("[data-testid^=legacy-violations-] .check-hit")).toHaveCount(2);
  await expect(row.locator("[data-testid^=legacy-violations-]")).toContainText("src/legacy-b.ts:2");

  // 6. 导出成仓库的规则：worktree 里的新分支，本地提交；推送被对外开关拒绝，分支没离开本机；用户的 checkout 不动。
  const head = git(s.repo, "rev-parse", "HEAD");
  await row.locator("[data-testid^=export-run-]").click();
  const exportRow = row.locator("[data-testid^=export-]").filter({ has: page.locator("[data-testid^=export-status-]") }).first();
  await expect(exportRow.locator("[data-testid^=export-status-]")).toHaveText(S.lintExport.status.ready);
  await expect(exportRow).toContainText(S.lintExport.committed);
  await expect(exportRow).toContainText("scripts/butler-checks/no-debugger.mjs");
  const branch = git(s.repo, "branch", "--list", "butler/*", "--format=%(refname:short)");
  expect(branch).toMatch(/^butler\/check-no-debugger-[0-9a-f]{6}$/);
  expect(git(s.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(s.repo, "rev-parse", "HEAD")).toBe(head);
  expect(git(s.repo, "status", "--porcelain")).toBe("");
  const worktree = join(s.butlerHome, "exports");
  expect(existsSync(worktree)).toBe(true);
  expect(git(s.repo, "log", "-1", "--format=%s", branch)).toBe('chore: add Butler check "no debugger" as a repo rule');

  await exportRow.locator("[data-testid^=export-diff-]").first().click();
  await expect(exportRow.locator("[data-testid^=export-diff-text-]")).toContainText("no-debugger");
  await exportRow.locator("[data-testid^=export-push-]").click();
  await expect(row.locator("[data-testid^=check-repo-msg-]")).toHaveText(M().lintExport.pushOff);
  await expect(exportRow.locator("[data-testid^=export-status-]")).toHaveText(S.lintExport.status.ready);
  expect(git(s.repo, "branch", "-r")).toBe("");
  // 拒绝的推送记进对外动作的审计（B 的 ExternalActions），标成 skipped。
  const d = new DatabaseSync(join(s.butlerHome, "app.db"), { timeout: 5000 });
  try {
    const rows = d.prepare("SELECT kind, outcome, repo_slug AS slug, target FROM external_action_audit").all();
    expect(rows).toEqual([expect.objectContaining({ kind: "branch_push", outcome: "skipped", slug: "acme/web", target: branch })]);
  } finally {
    d.close();
  }
});
