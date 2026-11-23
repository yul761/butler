import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expandLessonsAdvanced, expect, openLessonsAdvanced, terminalText, test, newButton, openTicketTab } from "./fixtures";

/**
 * review 经验（计划 Task 10）：页面上确认 / 驳回 / 停用 → 开 ticket session 时送进 --append-system-prompt-file 的说明文件。
 * 规矩直接插进 DB（后台分析走真 gh，e2e 不碰）；说明文件的路径从假 claude 的运行记录里读。
 */
test("confirmed lessons reach a ticket session's guide file; rejected and disabled ones do not", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);

  // 1. 沙盒仓库带 GitHub remote，建一个用它的 ticket。
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/web.git"], { cwd: s.repo });
  execFileSync("git", ["config", "protocol.https.allow", "never"], { cwd: s.repo });
  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("LES-1");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "LES-1", exact: true })).toBeVisible();

  // 2. 直接插一个仓库和两条待确认的规矩。
  const A = "改 schema 要加迁移";
  const B = "不要在渲染进程调 gh";
  const db = new DatabaseSync(join(s.shipherdHome, "app.db"));
  const now = Date.now();
  db.prepare("INSERT INTO lesson_repos (slug, local_path, created_at) VALUES (?, ?, ?)").run("acme/web", s.repo, now);
  const ins = db.prepare("INSERT INTO lessons (repo_slug, text, why, status, hits, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, 'pending', 1, ?, ?, ?)");
  const idA = Number(ins.run("acme/web", A, "评审里提过", now, now, now).lastInsertRowid);
  const idB = Number(ins.run("acme/web", B, "评审里提过", now, now, now).lastInsertRowid);
  db.close();
  await page.reload();

  // 3. 菜单显示个数；默认视图只有待确认列表（BTL-244），「高级」收着。确认 A、驳回 B 之后个数消失。
  const nav = page.getByTestId("lessons-nav");
  await expect(nav).toHaveText(`${S.lessons} · 2`);
  await nav.click();
  await expect(page.getByTestId(`pending-lesson-scope-${idA}`)).toHaveText("acme/web");
  await expect(page.getByTestId(`pending-lesson-${idB}`)).toContainText(S.lessonsWhy("评审里提过"));
  await expect(page.getByTestId("lessons-advanced").locator(".section-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("lessons-page-tab-lessons")).toHaveCount(0);
  await page.getByTestId(`pending-lesson-confirm-${idA}`).click();
  await page.getByTestId(`pending-lesson-reject-${idB}`).click();
  await expect(nav).toHaveText(S.lessons);
  await expect(page.getByTestId("pending-lessons-none")).toHaveText(S.lessonsNoPending);
  // 已确认的在「高级」里按仓库看。
  await expandLessonsAdvanced(page);
  await page.getByTestId("lessons-repo-acme/web").click();
  const confirmed = page.locator(".lesson.confirmed");
  await expect(confirmed).toHaveCount(1);
  await expect(confirmed).toContainText(A);
  await expect(page.getByText(B)).toHaveCount(0);

  // 4. 在 ticket 页开 session：说明文件含 A 不含 B。
  const guideOf = () => {
    const lines = readFileSync(s.fakeLog, "utf8").split("\n").filter((l) => l.includes(" interactive new "));
    return /guide=(.*)$/.exec(lines[lines.length - 1] ?? "")?.[1] ?? "";
  };
  const openSession = async () => {
    await page.locator(".sidebar .ticket .key").getByText("LES-1", { exact: true }).click();
    await openTicketTab(page, "terminal");
    await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
    await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  };
  await openSession();
  const guide1 = guideOf();
  expect(guide1).not.toBe("");
  const text1 = readFileSync(guide1, "utf8");
  expect(text1).toContain(`- [acme/web] ${A}`);
  expect(text1).not.toContain(B);

  // 5. 停用 A，关掉 session 再打开：新的说明文件不含 A。「高级」上次展开过，还是展开的。
  await openLessonsAdvanced(page);
  await page.getByTestId("lessons-repo-acme/web").click();
  await page.getByTestId(`lesson-toggle-${idA}`).click();
  await expect(page.getByTestId(`lesson-${idA}`)).toHaveClass(/disabled/);
  await page.locator(".sidebar .ticket .key").getByText("LES-1", { exact: true }).click();
  const end = page.getByTitle(S.endSession, { exact: true });
  await end.click();
  await end.click();
  await expect(end).toHaveCount(0);
  await openSession();
  const guide2 = guideOf();
  expect(guide2).not.toBe(guide1);
  expect(guide2 === "" ? "" : readFileSync(guide2, "utf8")).not.toContain(A);
});

/** 默认视图里「编辑后确认」（BTL-244）：改过的文字成为确认的规矩；「高级」默认收着，展开以后按仓库看得到。 */
test("the default lessons view edits and confirms a pending lesson", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);

  const db = new DatabaseSync(join(s.shipherdHome, "app.db"));
  const now = Date.now();
  db.prepare("INSERT INTO lesson_repos (slug, local_path, created_at) VALUES (?, ?, ?)").run("acme/web", s.repo, now);
  const id = Number(
    db.prepare("INSERT INTO lessons (repo_slug, text, why, status, hits, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, 'pending', 1, ?, ?, ?)")
      .run("acme/web", "改接口记得改文档", "", now, now, now).lastInsertRowid,
  );
  db.close();
  await page.reload();

  const nav = page.getByTestId("lessons-nav");
  await expect(nav).toHaveText(`${S.lessons} · 1`);
  await nav.click();
  await page.getByTestId(`pending-lesson-edit-${id}`).click();
  await page.getByTestId(`pending-lesson-text-${id}`).fill("改接口要同时改文档和示例");
  await page.getByTestId(`pending-lesson-save-${id}`).click();
  await expect(nav).toHaveText(S.lessons);
  await expect(page.getByTestId(`pending-lesson-${id}`)).toHaveCount(0);

  await expandLessonsAdvanced(page);
  await page.getByTestId("lessons-repo-acme/web").click();
  await expect(page.locator(".lesson.confirmed")).toHaveText(/改接口要同时改文档和示例/);
});
