import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defHash } from "../src/main/backtest/evaluate";
import { S } from "../src/renderer/src/strings";
import { pct } from "../src/renderer/src/backtest-view";
import { completeWizard, expect, test, type Sandbox } from "./fixtures";

const DAY = 86_400_000;

function db(s: Sandbox): DatabaseSync {
  // Butler 也开着这个库：等它的写锁，不直接报 SQLITE_BUSY。
  return new DatabaseSync(join(s.butlerHome, "app.db"), { timeout: 5000 });
}

const modeOf = (s: Sandbox, id: number): string => {
  const d = db(s);
  try {
    return (d.prepare("SELECT mode FROM checks WHERE id = ?").get(id) as { mode: string }).mode;
  } finally {
    d.close();
  }
};

/**
 * 回测和自动升级（工作流 F）：一条影子运行的检查回测通过（20 个 PR，召回 100%，误报 0），影子期间失败 3 次、都被改掉、都标成真问题，
 * 自动升级开着 → 每小时的复查把它升为强制，「现在」页提醒，点撤销回到影子模式、提醒消失；检查页上显示回测结果，
 * 被撤销过的检查不再自动升级（标「待复查」）。
 */
test("backtest: a shadow check that passed its backtest is promoted by the review, and undo puts it back", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const first = await launch(s);
  await completeWizard(first.page, s);

  // 1. 库里放好：仓库、一条 30 天前建的影子检查、它的回测结果、影子期间的命中，全局准入策略打开自动升级。
  const now = Date.now();
  const params = { pattern: "console\\.log\\(" };
  const d = db(s);
  d.prepare("INSERT INTO lesson_repos (slug, local_path, created_at) VALUES (?, ?, ?)").run("acme/web", s.repo, now);
  const checkId = Number(
    d.prepare(
      `INSERT INTO checks (key, scope_kind, repo_slug, type, name, params, globs, exclude_globs, severity, mode, enabled, message, created_at, updated_at)
       VALUES ('no-console', 'repo', 'acme/web', 'forbidden_pattern', 'No console.log', ?, '[]', '[]', 'block', 'shadow', 1, 'Remove console.log', ?, ?)`,
    ).run(JSON.stringify(params), now - 30 * DAY, now - 30 * DAY).lastInsertRowid,
  );
  const hash = defHash({ type: "forbidden_pattern", params, globs: [], excludeGlobs: [] });
  d.prepare(
    `INSERT INTO check_backtests (def_hash, check_key, repo_slug, status, prs, hits, matched_hits, false_positives, fp_rate, comments, comments_matched, recall, created_at)
     VALUES (?, 'no-console', 'acme/web', 'done', 20, 2, 2, 0, 0, 2, 2, 1, ?)`,
  ).run(hash, now - 20 * DAY);
  const hit = d.prepare(
    `INSERT INTO check_hits (check_id, check_key, repo_slug, file, line, stage, mode, severity, outcome, blocked, verdict, verdict_at, at, ingest_key)
     VALUES (?, 'no-console', 'acme/web', ?, 1, 'edit', 'shadow', 'block', ?, 0, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 3; i++) {
    const at = now - (10 - i) * DAY;
    hit.run(checkId, `src/f${i}.ts`, "fail", "true_positive", at, at, `e2e-fail-${i}`);
    hit.run(checkId, `src/f${i}.ts`, "resolved", null, null, at + 60_000, `e2e-fixed-${i}`);
  }
  d.prepare("INSERT INTO admission_policies (scope_kind, overrides, updated_at) VALUES ('global', ?, ?)").run(JSON.stringify({ "shadow.autoPromote": true }), now);
  d.close();
  await first.app.close();

  // 2. 复查任务启动时排在 5 分钟后：改成已经到时间，再开 Butler。
  const d2 = db(s);
  const moved = d2.prepare("UPDATE background_jobs SET not_before = 0 WHERE kind = 'backtest' AND dedupe_key = 'review' AND state = 'queued'").run();
  d2.close();
  expect(Number(moved.changes)).toBe(1);
  const { page } = await launch(s);

  // 3. 复查把检查升为强制，「现在」页提醒。
  await expect.poll(() => modeOf(s, checkId), { timeout: 30_000 }).toBe("enforce");
  const notice = page.getByTestId("now-notice-check_promoted");
  await expect(notice).toContainText(S.bt.noticePromoted("No console.log"));

  // 4. 撤销：回到影子模式，提醒消失。
  await page.getByTestId("now-notice-check_promoted-undo").click();
  await expect.poll(() => modeOf(s, checkId)).toBe("shadow");
  await expect(notice).toHaveCount(0);

  // 5. 检查页：回测结果，影子进度里写着被撤销过、要人看。
  await page.getByTestId("lessons-nav").click();
  await page.getByTestId("lessons-page-tab-checks").click();
  await page.getByTestId("checks-layer").selectOption("repo:acme/web");
  const f = page.getByTestId(`check-f-${checkId}`);
  await expect(f).toContainText(S.bt.backtestLine(20, pct(1), pct(0), 2));
  await expect(f).toContainText(S.bt.blocker.needs_review);
});
