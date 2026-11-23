import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { M } from "../src/main/strings";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, terminalText, test, type Sandbox, newButton, openTicketTab, openLessonsAdvanced } from "./fixtures";

/** 在当前显示的终端里输入一行并回车。 */
async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

function db(s: Sandbox): DatabaseSync {
  // Shipherd 也开着这个库：等它的写锁，不直接报 SQLITE_BUSY。
  return new DatabaseSync(join(s.shipherdHome, "app.db"), { timeout: 5000 });
}

type Hit = { file: string; stage: string; mode: string; outcome: string; blocked: number; detail: string };
const hits = (s: Sandbox): Hit[] => {
  const d = db(s);
  try {
    return d.prepare("SELECT file, stage, mode, outcome, blocked, detail FROM check_hits ORDER BY id").all() as Hit[];
  } finally {
    d.close();
  }
};

/** 快照里 acme/web 的检查（Shipherd 合并一小段时间才写）。 */
const snapshotChecks = (s: Sandbox): { name: string; mode: string; type: string }[] => {
  const f = join(s.shipherdHome, "checks", "snapshot.json");
  if (!existsSync(f)) return [];
  try {
    return (JSON.parse(readFileSync(f, "utf8")) as { repos: Record<string, { name: string; mode: string; type: string }[]> }).repos["acme/web"] ?? [];
  } catch {
    return [];
  }
};

/**
 * 确定性检查（工作流 E1，契约 4.5）：从规矩起草一条禁止 console.log( 的检查 → 强制模式下 agent 写进去的那次编辑被 hook 拦下，
 * 拿到「从根上修好」的说明，check_hits 记一行 blocked=1 → 切到试运行，同样的编辑只得到提示，记一行 blocked=0
 * → push 前的命令检查失败时 git push 被拒绝。
 */
test("checks: an enforced pattern blocks the edit and is recorded, shadow only records, a failing push check denies git push", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  const { page } = await launch(s);
  await completeWizard(page, s);

  // 1. 沙盒仓库带 GitHub remote（检查按 slug 找）；push 的地址被改写到一个不存在的本地路径（只改 push，hook 读的 origin 不变）：就算没被拦住也不会连网。
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/web.git"], { cwd: s.repo });
  execFileSync("git", ["config", "protocol.https.allow", "never"], { cwd: s.repo });
  execFileSync("git", ["config", `url.${join(s.dir, "no-such-remote")}/.pushInsteadOf`, "https://github.com/"], { cwd: s.repo });
  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("CHK-1");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "CHK-1", exact: true })).toBeVisible();

  // 2. 一条已确认的规矩：在规矩页上「做成检查」，假 claude 起草，表单预先填好；改成强制再保存。
  const d = db(s);
  const now = Date.now();
  d.prepare("INSERT INTO lesson_repos (slug, local_path, created_at) VALUES (?, ?, ?)").run("acme/web", s.repo, now);
  const lessonId = Number(
    d.prepare("INSERT INTO lessons (repo_slug, text, why, status, hits, last_seen_at, created_at, updated_at) VALUES ('acme/web', ?, 'review', 'confirmed', 1, ?, ?, ?)")
      .run("Do not leave console.log calls in src", now, now, now).lastInsertRowid,
  );
  d.close();
  await page.reload();
  await openLessonsAdvanced(page);
  await page.getByTestId("lessons-repo-acme/web").click();
  await page.getByTestId(`lesson-make-check-${lessonId}`).click();
  await expect(page.getByTestId("check-form")).toBeVisible();
  await expect(page.getByTestId("check-form-pattern")).toHaveValue("console\\.log\\(");
  await expect(page.getByTestId("check-form-mode")).toHaveValue("shadow");
  await expect(page.getByTestId("checks-layer")).toHaveValue("repo:acme/web");
  await page.getByTestId("check-form-mode").selectOption("enforce");
  await page.getByTestId("check-form-save").click();
  await expect(page.getByTestId("check-form")).toHaveCount(0);
  const row = page.locator(".check-row").filter({ hasText: "no console.log" });
  await expect(row).toHaveCount(1);
  await expect(row.getByText(S.checksFromLesson("Do not leave console.log calls in src"))).toBeVisible();
  await expect.poll(() => snapshotChecks(s).find((c) => c.name === "no console.log")?.mode).toBe("enforce");
  {
    const dd = db(s);
    expect((dd.prepare("SELECT checkability FROM lessons WHERE id = ?").get(lessonId) as { checkability: string }).checkability).toBe("converted");
    dd.close();
  }

  // 3. ticket session 里写一个带 console.log( 的文件：hook 拦下，agent 拿到检查的说明和「从根上修好」。
  await page.locator(".sidebar .ticket .key").getByText("CHK-1", { exact: true }).click();
  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await typeLine(page, `/fake-edit src/a.ts ${JSON.stringify('console.log("debug");\n')}`);
  await expect.poll(fakeLog).toContain(" check block ");
  const blockLine = fakeLog().split("\n").find((l) => l.includes(" check block "))!;
  expect(blockLine).toContain("no console.log");
  expect(blockLine).toContain("Use the logger instead.");
  expect(blockLine).toContain(M().checks.snapshot.blockFooter);
  await expect.poll(() => hits(s).length).toBe(1);
  expect(hits(s)[0]).toMatchObject({ file: "src/a.ts", stage: "edit", mode: "enforce", outcome: "fail", blocked: 1 });
  expect(hits(s)[0].detail).toContain('console.log("debug")');

  // 4. 检查页上看到这次命中；切到试运行。
  await openLessonsAdvanced(page);
  await page.getByTestId("lessons-page-tab-checks").click();
  await page.getByTestId("checks-layer").selectOption("repo:acme/web");
  const row2 = page.locator(".check-row").filter({ hasText: "no console.log" });
  await expect(row2.locator("[data-testid^=check-stats-]")).toContainText(S.checksStats({ fails: 1, blocked: 1, resolved: 0, falsePositives: 0 }, "0%"));
  await row2.locator("[data-testid^=check-hits-toggle-]").click();
  await expect(row2.locator(".check-hit")).toHaveCount(1);
  await row2.locator("[data-testid^=check-pick-]").check();
  await page.getByTestId("checks-bulk-shadow").click();
  await expect(row2.locator("[data-testid^=check-mode-]")).toHaveText(S.checksModeLabel.shadow);
  await expect.poll(() => snapshotChecks(s).find((c) => c.name === "no console.log")?.mode).toBe("shadow");

  // 5. 同样的编辑（另一个文件）：只有提示，不拦；check_hits 记一行 blocked=0。
  await page.locator(".sidebar .ticket .key").getByText("CHK-1", { exact: true }).click();
  await typeLine(page, `/fake-edit src/b.ts ${JSON.stringify('console.log("again");\n')}`);
  await expect.poll(fakeLog).toContain(" check note ");
  expect(fakeLog().split("\n").filter((l) => l.includes(" check block "))).toHaveLength(1);
  expect(fakeLog().split("\n").find((l) => l.includes(" check note "))).toContain(M().checks.snapshot.shadowTag);
  await expect.poll(() => hits(s).length).toBe(2);
  expect(hits(s)[1]).toMatchObject({ file: "src/b.ts", mode: "shadow", outcome: "fail", blocked: 0 });

  // 6. push 前的命令检查（全局层，强制）：失败时 git push 被拒绝，理由里有命令的输出。
  // /fake-run 用 Git Bash 执行命令，Windows 上的引号和路径还没验证过（和合并总控的 e2e 一样）。
  if (process.platform === "win32") return;
  await openLessonsAdvanced(page);
  await page.getByTestId("lessons-page-tab-checks").click();
  await page.getByTestId("checks-layer").selectOption("global");
  await page.getByTestId("checks-new").click();
  await page.getByTestId("check-form-name").fill("pre-push tests");
  await page.getByTestId("check-form-type").selectOption("run_command");
  await page.getByTestId("check-form-command").fill("echo push-check-broke; exit 3");
  await page.getByTestId("check-form-stage").selectOption("push");
  await page.getByTestId("check-form-mode").selectOption("enforce");
  await page.getByTestId("check-form-save").click();
  await expect(page.locator(".check-row").filter({ hasText: "pre-push tests" })).toHaveCount(1);
  await expect.poll(() => snapshotChecks(s).some((c) => c.name === "pre-push tests" && c.mode === "enforce")).toBe(true);
  await page.locator(".sidebar .ticket .key").getByText("CHK-1", { exact: true }).click();
  await typeLine(page, "/fake-run git push origin HEAD");
  await expect.poll(fakeLog).toMatch(/ gate deny [\s\S]*push-check-broke/);
  expect(fakeLog().split("\n").find((l) => l.includes(" gate deny "))).toContain(M().checks.snapshot.pushHeader);
  await expect.poll(() => hits(s).some((h) => h.stage === "push" && h.blocked === 1)).toBe(true);
});
