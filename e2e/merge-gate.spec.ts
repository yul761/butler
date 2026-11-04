import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { M } from "../src/main/strings";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, makeGitRepo, terminalText, test, type Sandbox } from "./fixtures";

/** 在当前显示的终端里输入一行并回车。 */
async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

/** 在当前打开的 feature 页上建一个只用 backend 的 ticket（worktree 方式）；建完停在 ticket 页。 */
async function newBackendTicket(page: Page, key: string): Promise<void> {
  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill(key);
  await page.locator(".modal").getByRole("checkbox", { name: "frontend", exact: true }).uncheck();
  await page.locator(".modal").getByRole("checkbox", { name: "backend", exact: true }).check();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: key, exact: true })).toBeVisible();
}

const git = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "commit.gpgsign=false", "-C", dir, ...a], { encoding: "utf8" }).trim();

function db(s: Sandbox): DatabaseSync {
  // Butler 也开着这个库：等它的写锁，不直接报 SQLITE_BUSY。
  return new DatabaseSync(join(s.butlerHome, "app.db"), { timeout: 5000 });
}

/** 终端会折行：比较时去掉所有空白。 */
const squash = (t: string) => t.replace(/\s+/g, "");

/**
 * 设计文档 2026-11-04（合并总控）：两个 ticket 在同一个仓库里改了同一行 → DMS-2 占着合并 → DMS-1 合并被 gate 拦下（等 DMS-2）
 * → 首页“合并协调”有这条 → DMS-2 真的合进 main 后，停着的 DMS-1 收到“已经合完” → 再合是 rebase 提醒
 * → 不审核的命令不发请求 → Butler 不在时立即放行。
 */
test("merge coordinator: a conflicting merge waits for the holder, is told when it merges, then is asked to rebase", async ({ makeSandbox, launch }) => {
  // /fake-run 用 Git Bash 执行带 Windows 路径的命令、gate 的引号解析和 Git Bash 的不一样：Windows 上还没验证过。
  test.skip(process.platform === "win32", "not verified on Windows yet: /fake-run passes Windows paths through Git Bash and the gate's command parser");
  const s = makeSandbox();
  // 刚在 DMS-1 的终端里打过字：通知默认要等用户 30 秒没打字才贴，这里调短。
  s.env = { BUTLER_GATE_CHECK_MS: "500", BUTLER_GATE_TYPING_QUIET_MS: "1000" };
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  const gateDir = join(s.butlerHome, "gate");
  const requests = join(gateDir, "requests");
  const { page } = await launch(s);
  await completeWizard(page, s);

  // 1. feature 下两个只用 backend 的 ticket（worktree 方式）。
  const shop = join(s.dir, "shop");
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));
  await page.getByRole("button", { name: `+ ${S.newFeature}`, exact: true }).click();
  await page.getByLabel(S.featureName, { exact: true }).fill("checkout");
  const dir = page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true });
  await dir.fill(shop);
  await dir.blur();
  await expect(page.getByText(S.subReposFound(2), { exact: true })).toBeVisible();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "checkout", exact: true })).toBeVisible();
  await newBackendTicket(page, "DMS-1");
  await page.locator(".feature-link").getByRole("button", { name: "checkout", exact: true }).click();
  await newBackendTicket(page, "DMS-2");

  const d = db(s);
  const repos = d.prepare("SELECT ticket_key, repo_path, branch, worktree_path FROM ticket_repos ORDER BY ticket_key").all() as {
    ticket_key: string; repo_path: string; branch: string; worktree_path: string;
  }[];
  expect(repos.map((r) => r.ticket_key)).toEqual(["DMS-1", "DMS-2"]);
  const [one, two] = repos;
  const backend = one.repo_path;
  expect(two.repo_path).toBe(backend);

  // 2. 两个 worktree 改 README.md 的同一行并提交。
  for (const r of repos) {
    writeFileSync(join(r.worktree_path, "README.md"), `${r.ticket_key} was here\n`);
    git(r.worktree_path, "commit", "-q", "-am", `${r.ticket_key} edits the readme`);
  }

  // 3. DMS-2 拿着合并占位（本地合并进 main）。
  d.prepare("INSERT INTO merge_holds (repo_path, branch, target, kind, pr_url, session_id, ticket_key, created_at) VALUES (?, ?, 'main', 'local', NULL, NULL, 'DMS-2', ?)")
    .run(backend, two.branch, Date.now());
  d.close();

  // 4. DMS-1 的 session 里合并：被拦下，理由说等 DMS-2，main 没动。
  await page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: "DMS-1" }).click();
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const mainBefore = git(backend, "rev-parse", "main");
  const merge = `git -C ${backend} merge ${one.branch}`;
  await typeLine(page, `/fake-run ${merge}`);
  await expect.poll(fakeLog).toMatch(/ gate deny .*DMS-2/);
  await expect.poll(() => terminalText(page)).toContain("denied:");
  expect(git(backend, "rev-parse", "main")).toBe(mainBefore);

  // 5. 首页的“合并协调”一节有这一行。
  await page.getByRole("button", { name: S.home, exact: true }).click();
  const section = page.locator("section.merge-events");
  await expect(section.getByRole("heading", { name: S.mergeEventsTitle, exact: true })).toBeVisible();
  await expect(section.locator(".merge-event").filter({ hasText: "DMS-1" }).filter({ hasText: "DMS-2" })).toHaveCount(1);

  // 6. DMS-2 真的合进 main：停着等输入的 DMS-1 收到“已经合完”。
  await page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: "DMS-1" }).click();
  await expect.poll(() => terminalText(page)).toContain("denied:");
  git(backend, "merge", "-q", "--ff-only", two.branch);
  // 通知是作为输入交给 claude 的：等它这一轮结束（回了“收到”）再输入下一条。
  await expect.poll(async () => squash(await terminalText(page))).toContain(squash(`收到：${M().gateMergedNotice("DMS-2（checkout）")}`));

  // 7. 再合并：这次是 rebase 提醒。同时看着请求目录：审核的命令会写请求文件（第 8 步的对照）。
  const denies = () => fakeLog().split("\n").filter((l) => l.includes(" gate deny "));
  const seen: string[] = [];
  const watcher = watch(requests, (_e, name) => seen.push(String(name)));
  try {
    await typeLine(page, `/fake-run ${merge}`);
    await expect.poll(() => denies().length).toBe(2);
    expect(denies()[1]).toContain("rebase");
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    // 等 Butler 删掉这次的请求文件、watcher 送完它的事件，再清空。
    await expect.poll(() => readdirSync(requests)).toEqual([]);
    await page.waitForTimeout(500);

    // 8. 不审核的命令：没有 gate 请求。
    seen.length = 0;
    await typeLine(page, "/fake-run git status");
    await expect.poll(fakeLog).toContain(" gate allow git status\n");
    // 给 watcher 一点时间送达事件。
    await page.waitForTimeout(500);
  } finally {
    watcher.close();
  }
  expect(seen).toEqual([]);
  expect(readdirSync(requests)).toEqual([]);

  // 9. Butler 不在（没有 alive.json）：立即放行。
  rmSync(join(gateDir, "alive.json"));
  await typeLine(page, `/fake-run ${merge}`);
  await expect.poll(fakeLog).toContain(` gate allow ${merge}\n`);
  const at = (prefix: string) => {
    const l = fakeLog().split("\n").filter((x) => x.includes(prefix)).at(-1)!;
    return Date.parse(l.split(" ")[0]);
  };
  expect(at(` gate allow ${merge}`) - at(` fake-run ${merge}`)).toBeLessThan(2000);
});
