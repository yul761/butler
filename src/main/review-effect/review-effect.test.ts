import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { ReviewEffectRepo } from "../db/review-effect-repo";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { ReviewEffectCollector, countRounds } from "./collector";
import { lessonCommentTrend, reviewEffect, weekStart } from "./stats";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 18, 12);

function setup() {
  const db = memDb();
  new TicketsRepo(db).insert({ key: "T-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  db.prepare(`INSERT INTO lesson_repos (slug, local_path, created_at) VALUES ('a/b', '/r', 1)`).run();
  const prs = new TicketPrsRepo(db);
  const repo = new ReviewEffectRepo(db);
  const files = new Map<number, string[]>();
  const collector = new ReviewEffectCollector({ db, repo, files: async (p) => files.get(p.number) ?? null, now: () => NOW, log: () => {} });
  const pr = (number: number, o: { opened: number; merged: number | null; butler?: boolean; author?: string; files?: string[] }) => {
    const id = prs.link({
      ticketKey: "T-1", url: `https://github.com/a/b/pull/${number}`, slug: "a/b", repoId: null, number, headBranch: `b${number}`, state: "open",
      source: "branch", linkedAt: 1,
    }).pr.id;
    db.prepare(`UPDATE ticket_prs SET state = ?, opened_at = ?, merged_at = ?, butler_made = ?, author = ? WHERE id = ?`).run(
      o.merged === null ? "open" : "merged", o.opened, o.merged, o.butler ? 1 : 0, o.author ?? "me", id,
    );
    files.set(number, o.files ?? ["src/x.ts"]);
    return id;
  };
  let seq = 0;
  const stage = (prId: number, kind: string, at: number, data: Record<string, unknown>) =>
    db.prepare(`INSERT INTO pr_stage_events (dedupe_key, ticket_key, pr_id, kind, at, data) VALUES (?, 'T-1', ?, ?, ?, ?)`).run(`k${++seq}`, prId, kind, at, JSON.stringify(data));
  const lesson = (o: { confirmedAt?: number | null; globs?: string[]; mergedInto?: number } = {}) => {
    const id = Number(
      db
        .prepare(`INSERT INTO lessons (repo_slug, text, why, status, hits, last_seen_at, created_at, updated_at, scope_globs, confirmed_at) VALUES ('a/b', 'use x', 'w', 'confirmed', 1, 1, 1, 1, ?, ?)`)
        .run(JSON.stringify(o.globs ?? []), o.confirmedAt ?? null).lastInsertRowid,
    );
    if (o.mergedInto) db.prepare(`UPDATE lessons SET merged_into = ? WHERE id = ?`).run(o.mergedInto, id);
    return id;
  };
  const source = (lessonId: number, number: number, at: number, reviewer: string | null = "alice") =>
    db.prepare(`INSERT INTO lesson_sources (lesson_id, pr_number, url, at, repo_slug, reviewer, path) VALUES (?, ?, ?, ?, 'a/b', ?, 'src/x.ts')`).run(lessonId, number, `u${++seq}`, at, reviewer);
  const retro = (number: number, findings: unknown[]) =>
    db.prepare(`INSERT INTO lesson_runs (repo_slug, pr_number, origin, status, findings_json, started_at) VALUES ('a/b', ?, 'merged', 'done', ?, 1)`).run(number, JSON.stringify(findings));
  return { db, repo, collector, pr, stage, lesson, source, retro };
}

describe("review effect collector (ws-g §11.1)", () => {
  it("counts rounds split by pushes", () => {
    expect(countRounds([], [5])).toBe(0);
    expect(countRounds([10, 20], [])).toBe(1);
    expect(countRounds([10, 30, 50], [20, 25])).toBe(2);
    expect(countRounds([10, 30, 50], [20, 40])).toBe(3);
  });

  it("collects comments, rounds, waits, avoidable and lesson attribution for a merged PR", async () => {
    const s = setup();
    const id = s.pr(7, { opened: 1000, merged: 9000, butler: true, author: "me" });
    s.stage(id, "review", 2000, { who: "human", id: "r1", body: "fix this" });
    s.stage(id, "review", 2100, { who: "human", id: "r1", body: "fix this" }); // 同一个 review 换了状态
    s.stage(id, "review", 2200, { who: "human", id: "r2", body: "" }); // 只有 approve，不算评论
    s.stage(id, "comment", 2300, { who: "copilot", body: "nit" });
    s.stage(id, "comment", 2400, { who: "bot", body: "deploy" });
    s.db.prepare(`INSERT INTO pr_stage_events (dedupe_key, ticket_key, pr_id, kind, at, data) VALUES ('p1', 'T-1', ?, 'push', 3000, '{}')`).run(id);
    s.stage(id, "review", 4000, { who: "human", id: "r3", body: "ok now" });
    s.retro(7, [{ avoidable: true }, { avoidable: false }, { avoidable: true }]);
    const old = s.lesson({ confirmedAt: 500 });
    const fresh = s.lesson({ confirmedAt: 5000 });
    const merged = s.lesson({ confirmedAt: 100, mergedInto: old });
    s.source(old, 7, 2000);
    s.source(fresh, 7, 2050, "copilot-pull-request-reviewer[bot]");
    s.source(merged, 7, 2060);
    s.source(old, 7, 2070, "me"); // 作者自己的不算
    await s.collector.collect(id);
    const got = s.repo.get(id)!;
    expect(got).toMatchObject({
      butler: true, commentsHuman: 2, commentsCopilot: 1, avoidable: 2, rounds: 2, firstReviewMs: 1000, submitToMergeMs: 8000,
      retroDone: true, briefPosted: false, files: ["src/x.ts"],
    });
    const cs = s.repo.commentsOf([id]);
    expect(cs.map((c) => [c.lessonId, c.who, c.lessonConfirmedBefore])).toEqual([
      [old, "human", true],
      [fresh, "copilot", false],
      [old, "human", true],
    ]);
  });

  it("skips open PRs and backfills merged ones and ones whose retro finished later", async () => {
    const s = setup();
    const open = s.pr(1, { opened: 1, merged: null });
    const merged = s.pr(2, { opened: 1, merged: 5 });
    await s.collector.collect(open);
    expect(s.repo.get(open)).toBeNull();
    expect(await s.collector.backfill()).toBe(1);
    expect(s.repo.get(merged)?.retroDone).toBe(false);
    s.retro(2, []);
    expect(await s.collector.backfill()).toBe(1);
    expect(s.repo.get(merged)?.retroDone).toBe(true);
    expect(await s.collector.backfill()).toBe(0);
  });
});

describe("lesson comment trend for F (ws-g §11.2)", () => {
  it("takes the nearest window of in-scope, retro-done PRs on each side and counts the lesson's comments", async () => {
    const s = setup();
    const l = s.lesson({ confirmedAt: 50_000, globs: ["src/**"] });
    const check = Number(
      s.db.prepare(`INSERT INTO checks (key, scope_kind, repo_slug, type, lesson_id, severity, mode, created_at, updated_at) VALUES ('c', 'repo', 'a/b', 'forbidden_pattern', ?, 'warn', 'shadow', 1, 1)`).run(l).lastInsertRowid,
    );
    const make = async (n: number, merged: number, comments: number, files = ["src/x.ts"], retro = true) => {
      const id = s.pr(n, { opened: merged - 100, merged, files });
      for (let i = 0; i < comments; i++) s.source(l, n, merged - 50 + i, i % 2 ? "copilot" : "alice");
      if (retro) s.retro(n, []);
      await s.collector.collect(id);
    };
    await make(1, 10_000, 3);
    await make(2, 20_000, 2);
    await make(3, 30_000, 5, ["docs/readme.md"]); // 不在 scope
    await make(4, 40_000, 4, ["src/y.ts"], false); // 没复盘
    await make(5, 60_000, 1);
    await make(6, 70_000, 0);
    const t = lessonCommentTrend(s.db, { lessonId: l, since: 50_000 })!;
    expect(t.before).toEqual({ prs: 2, comments: 5, perPr: 2.5, byWho: { human: 3, copilot: 2 } });
    expect(t.after).toMatchObject({ prs: 2, comments: 1, perPr: 0.5 });
    expect(lessonCommentTrend(s.db, { lessonId: l, since: 50_000, window: 1 })!.before.prs).toBe(1);
    expect(lessonCommentTrend(s.db, { checkId: check, since: 50_000 })!.lessonId).toBe(l);
    expect(lessonCommentTrend(s.db, { lessonId: l, since: 50_000, repo: "x/y" })!.before.prs).toBe(0);
    expect(lessonCommentTrend(s.db, { lessonId: 9999, since: 1 })).toBeNull();
  });
});

describe("review effect view (ws-g §11.3)", () => {
  it("groups Butler and other PRs, brief vs none, weekly avoidable and comment landing", async () => {
    const s = setup();
    const a = s.pr(1, { opened: NOW - 3 * DAY, merged: NOW - 2 * DAY, butler: true });
    const b = s.pr(2, { opened: NOW - 3 * DAY, merged: NOW - DAY, butler: false });
    s.stage(a, "comment", NOW - 2.5 * DAY, { who: "human", body: "x" });
    s.stage(b, "comment", NOW - 2.5 * DAY, { who: "human", body: "x" });
    s.stage(b, "comment", NOW - 2.4 * DAY, { who: "human", body: "y" });
    s.retro(1, [{ avoidable: true }]);
    const l = s.lesson({ confirmedAt: NOW - 10 * DAY });
    s.source(l, 1, NOW - 2.5 * DAY);
    s.db.prepare(`INSERT INTO pr_briefs (pr_id, repo_slug, branch, head_sha, markdown, created_at, posted_at) VALUES (?, 'a/b', 'b1', 's', 'm', 1, 2)`).run(a);
    await s.collector.collect(a);
    await s.collector.collect(b);
    const v = reviewEffect(s.db, 30, NOW);
    expect(v.weeks).toHaveLength(12);
    expect(v.weeks.at(-1)!.weekStart).toBe(weekStart(NOW));
    expect(v.weeks.reduce((n, w) => n + w.prs, 0)).toBe(1);
    expect(v.weeks.find((w) => w.prs)!.perPr).toBe(1);
    expect(v.butler).toMatchObject({ prs: 1, humanComments: 1 });
    expect(v.others).toMatchObject({ prs: 1, humanComments: 2 });
    expect(v.withBrief.prs).toBe(1);
    expect(v.withoutBrief.prs).toBe(0);
    expect(v.landing).toEqual({ confirmedBefore: 1, notYet: 0, unattributed: 2 });
    expect(new Date(weekStart(NOW)).getUTCDay()).toBe(1);
  });
});
