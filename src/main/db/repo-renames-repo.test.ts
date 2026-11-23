import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import type { Db } from "./database";
import { RepoRenamesRepo, rewriteSlugText } from "./repo-renames-repo";
import { TicketPrsRepo } from "./ticket-prs-repo";
import { TicketsRepo } from "./tickets-repo";

const OLD = "o/old";
const NEW = "o/new";
const u = (slug: string, n: number) => `https://github.com/${slug}/pull/${n}`;

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  for (const key of ["T-1", "T-2"]) tickets.insert({ key, title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const repoId = tickets.addRepo({ ticketKey: "T-1", repoPath: "/r", workMode: "branch", worktreePath: null, branch: "feat", createdAt: 1 });
  const prs = new TicketPrsRepo(db);
  const link = (ticketKey: string, slug: string, n: number, o: { checkedAt?: number; state?: "open" | "merged" } = {}) => {
    const p = prs.link({ ticketKey, url: u(slug, n), slug, repoId, number: n, headBranch: "feat", state: o.state ?? "merged", source: "branch", linkedAt: 1 }).pr;
    if (o.checkedAt !== undefined) prs.update(p.id, { checkedAt: o.checkedAt });
    return p.id;
  };
  return { db, prs, link, repo: new RepoRenamesRepo(db) };
}

const all = (db: Db, sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as Record<string, unknown>[];
const one = (db: Db, sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as Record<string, unknown> | undefined;

describe("rewriteSlugText", () => {
  it("rewrites links and exact slug strings, case-insensitively, and leaves repos with the same prefix alone", () => {
    const text = JSON.stringify({
      prs: [{ url: "https://github.com/O/Old/pull/3" }, { url: "https://github.com/o/old-web/pull/4" }],
      slug: "o/old", other: "o/old-web", note: "see github.com/o/old and https://github.com/o/old#readme, not github.com/o/older",
    });
    const out = JSON.parse(rewriteSlugText(text, OLD, NEW));
    expect(out.prs.map((p: { url: string }) => p.url)).toEqual(["https://github.com/o/new/pull/3", "https://github.com/o/old-web/pull/4"]);
    expect(out.slug).toBe("o/new");
    expect(out.other).toBe("o/old-web");
    expect(out.note).toBe("see github.com/o/new and https://github.com/o/new#readme, not github.com/o/older");
  });

  it("handles slugs on other hosts", () => {
    expect(rewriteSlugText("https://ghe.acme.io/t/a/pull/1", "ghe.acme.io/t/a", "ghe.acme.io/t/b")).toBe("https://ghe.acme.io/t/b/pull/1");
    expect(rewriteSlugText("https://github.com/t/a/pull/1", "ghe.acme.io/t/a", "ghe.acme.io/t/b")).toBe("https://github.com/t/a/pull/1");
  });
});

describe("RepoRenamesRepo.record", () => {
  it("records a rename, chains later renames, and drops one that was renamed back", () => {
    const { repo } = setup();
    expect(repo.record("O/Old", NEW, "scan", 1)).toBe(true);
    expect(repo.record(OLD, NEW, "scan", 2)).toBe(false);
    expect(repo.canonical("o/OLD")).toBe(NEW);
    expect(repo.canonical("x/y")).toBe("x/y");
    // new 又改成了 newer：old 也指向 newer。
    repo.record(NEW, "o/newer", "watcher", 3);
    expect(repo.canonical(OLD)).toBe("o/newer");
    expect(repo.canonical(NEW)).toBe("o/newer");
    // 改回 old：old 不再是旧名字。
    repo.record("o/newer", OLD, "watcher", 4);
    expect(repo.canonical(OLD)).toBe(OLD);
    expect(repo.all().map((r) => [r.oldSlug, r.newSlug]).sort()).toEqual([[NEW, OLD], ["o/newer", OLD]]);
    expect(repo.record(OLD, OLD, "scan", 5)).toBe(false);
  });
});

describe("RepoRenamesRepo.apply", () => {
  it("merges a PR linked under both names into the old row, moving and de-duplicating its children (BTL-261)", () => {
    const { db, prs, link, repo } = setup();
    const o = link("T-1", OLD, 25, { checkedAt: 10 });
    const n = link("T-1", NEW, 25, { checkedAt: 20 });
    prs.update(o, { title: "old title" });
    prs.setMergedHandled(o, 5);
    prs.update(n, { title: "new title" });
    const lone = link("T-1", OLD, 26); // 只有旧名字下的一行
    const other = link("T-2", NEW, 25); // 别的 ticket 的同一个 PR：不合并
    db.exec(`
      INSERT INTO pr_stage_events (dedupe_key, ticket_key, kind, at, pr_id) VALUES ('1:ci:x', 'T-1', 'ci', 1, ${n});
      INSERT INTO review_effect_prs (pr_id, repo_slug, number, computed_at) VALUES (${o}, '${OLD}', 25, 1), (${n}, '${NEW}', 25, 2);
      INSERT INTO review_effect_comments (pr_id, source_id, who, created_at) VALUES (${n}, 1, 'human', 1);
      INSERT INTO pr_readiness (pr_id, ready, computed_at) VALUES (${n}, 1, 3);
      INSERT INTO metrics_events (kind, at, pr_id, repo_slug, dedupe_key) VALUES
        ('agent_merge', 1, ${o}, '${OLD}', 'merge:${o}'), ('manual_merge', 2, ${n}, '${NEW}', 'merge:${n}'), ('pr_ready', 3, ${n}, '${NEW}', 'ready:${n}:abc');
      INSERT INTO pr_comment_items (pr_id, comment_key, kind, author, who, body, first_seen, state, updated_at) VALUES
        (${o}, 'c1', 'issue', 'a', 'human', 'x', 1, 'pending', 1), (${n}, 'c1', 'issue', 'a', 'human', 'x', 1, 'pending', 1), (${n}, 'c2', 'issue', 'a', 'human', 'y', 1, 'pending', 1);
      INSERT INTO ci_triage (item_kind, item_id, head_sha, run_id, state, first_failed_at, updated_at) VALUES ('pr', ${n}, 's', 1, 'passed', 1, 1);
    `);
    repo.record(OLD, NEW, "scan", 1);
    const c = repo.applyAll(100);
    expect(c["ticket_prs merged"]).toBe(1);

    expect(prs.get(n)).toBeNull();
    // 后读到的（新行）状态为准；旧行处理过合并的标记留着。
    expect(prs.get(o)).toMatchObject({ url: u(NEW, 25), slug: NEW, checkedAt: 20, title: "new title", mergedHandledAt: 5 });
    expect(prs.get(lone)).toMatchObject({ url: u(NEW, 26), slug: NEW });
    expect(prs.get(other)).toMatchObject({ ticketKey: "T-2", url: u(NEW, 25) });
    expect(all(db, `SELECT pr_id FROM pr_stage_events`)).toEqual([{ pr_id: o }]);
    expect(all(db, `SELECT pr_id, repo_slug, computed_at FROM review_effect_prs ORDER BY pr_id`)).toEqual([
      { pr_id: o, repo_slug: NEW, computed_at: 1 },
    ]);
    expect(all(db, `SELECT pr_id FROM review_effect_comments`)).toEqual([]);
    expect(all(db, `SELECT pr_id FROM pr_readiness`)).toEqual([{ pr_id: o }]);
    expect(all(db, `SELECT kind, pr_id, repo_slug, dedupe_key FROM metrics_events ORDER BY id`)).toEqual([
      { kind: "agent_merge", pr_id: o, repo_slug: NEW, dedupe_key: `merge:${o}` },
      { kind: "pr_ready", pr_id: o, repo_slug: NEW, dedupe_key: `ready:${o}:abc` },
    ]);
    expect(all(db, `SELECT pr_id, comment_key FROM pr_comment_items ORDER BY comment_key`)).toEqual([{ pr_id: o, comment_key: "c1" }, { pr_id: o, comment_key: "c2" }]);
    expect(all(db, `SELECT item_id FROM ci_triage`)).toEqual([{ item_id: o }]);
    expect(all(db, `PRAGMA foreign_key_check`)).toEqual([]);
    // 幂等：再跑一遍什么也不动。
    expect(repo.applyAll(200)).toEqual({});
    expect(repo.all()[0]).toMatchObject({ appliedAt: 200 });
  });

  it("moves a lesson repo to the new name with its lessons, queue and runs; merges into an existing new-name repo", () => {
    const { db, repo } = setup();
    db.exec(`
      INSERT INTO lesson_products (id, name, created_at) VALUES (1, 'p', 1);
      INSERT INTO lesson_repos (slug, local_path, analyzed_count, created_at) VALUES ('${OLD}', '/r', 3, 5);
      INSERT INTO lesson_product_repos (product_id, repo_slug) VALUES (1, '${OLD}');
      INSERT INTO lessons (repo_slug, text, why, status, last_seen_at, created_at, updated_at) VALUES ('${OLD}', 't', 'w', 'confirmed', 1, 1, 1);
      INSERT INTO lesson_queue (repo_slug, pr_number, origin, status, enqueued_at) VALUES ('${OLD}', 1, 'merged', 'done', 1), ('${OLD}', 2, 'merged', 'done', 1);
      INSERT INTO lesson_runs (repo_slug, pr_number, pr_url, origin, started_at, status) VALUES ('${OLD}', 1, '${u(OLD, 1)}', 'merged', 1, 'done');
    `);
    repo.record(OLD, NEW, "scan", 1);
    repo.applyAll(10);
    expect(all(db, `SELECT slug, local_path, analyzed_count FROM lesson_repos`)).toEqual([{ slug: NEW, local_path: "/r", analyzed_count: 3 }]);
    for (const t of ["lessons", "lesson_queue", "lesson_runs", "lesson_product_repos"]) expect(one(db, `SELECT count(*) AS c FROM ${t} WHERE repo_slug = ?`, NEW)).toEqual({ c: t === "lesson_queue" ? 2 : 1 });
    expect(one(db, `SELECT pr_url FROM lesson_runs`)).toEqual({ pr_url: u(NEW, 1) });
    expect(all(db, `PRAGMA foreign_key_check`)).toEqual([]);

    // 两个名字都有：新名字的那行留下，旧的并进去；同一个 PR 的队列项留新的。
    db.exec(`
      INSERT INTO lesson_repos (slug, local_path, analyzed_count, created_at) VALUES ('o/older', '/r', 4, 2);
      INSERT INTO lesson_queue (repo_slug, pr_number, origin, status, enqueued_at) VALUES ('o/older', 2, 'merged', 'failed', 1), ('o/older', 3, 'merged', 'done', 1);
      INSERT INTO lessons (repo_slug, text, why, status, last_seen_at, created_at, updated_at) VALUES ('o/older', 't2', 'w', 'confirmed', 1, 1, 1);
    `);
    repo.record("o/older", NEW, "scan", 2);
    repo.applyAll(20);
    expect(all(db, `SELECT slug, analyzed_count, created_at FROM lesson_repos`)).toEqual([{ slug: NEW, analyzed_count: 7, created_at: 2 }]);
    expect(all(db, `SELECT pr_number, status FROM lesson_queue ORDER BY pr_number`)).toEqual([
      { pr_number: 1, status: "done" }, { pr_number: 2, status: "done" }, { pr_number: 3, status: "done" },
    ]);
    expect(one(db, `SELECT count(*) AS c FROM lessons WHERE repo_slug = ?`, NEW)).toEqual({ c: 2 });
    expect(all(db, `PRAGMA foreign_key_check`)).toEqual([]);
  });

  it("renames plain slug columns, keeps the new row on a unique clash, sums daily rollups, and rewrites JSON text and stage keys", () => {
    const { db, repo } = setup();
    db.exec(`
      INSERT INTO checks (key, scope_kind, repo_slug, type, severity, mode, created_at, updated_at) VALUES
        ('k', 'repo', '${OLD}', 'forbidden_pattern', 'block', 'enforce', 1, 1), ('k', 'repo', '${NEW}', 'forbidden_pattern', 'warn', 'enforce', 1, 1),
        ('j', 'repo', '${OLD}', 'forbidden_pattern', 'block', 'enforce', 1, 1);
      INSERT INTO metrics_daily (day, group_kind, group_key, shipherd, metric, n, total) VALUES
        ('2026-11-01', 'repo', '${OLD}', 1, 'merged', 2, 2), ('2026-11-01', 'repo', '${NEW}', 1, 'merged', 1, 1), ('2026-11-02', 'repo', '${OLD}', 1, 'merged', 1, 1),
        ('2026-11-01', 'all', '', 1, 'merged', 3, 3);
      INSERT INTO handoffs (ticket_key, trigger, created_at, payload) VALUES
        ('T-1', 'manual', 1, '{"prs":[{"url":"https://github.com/o/old/pull/3"},{"url":"https://github.com/o/old-web/pull/1"}]}');
      INSERT INTO pr_stage_events (dedupe_key, ticket_key, kind, at, data) VALUES
        ('T-1@${OLD}:ci:b:1', 'T-1', 'ci', 1, '{"url":"https://github.com/o/old/pull/3#c"}'), ('T-1@${NEW}:ci:b:2', 'T-1', 'ci', 2, '{}'), ('T-1@${OLD}:ci:b:2', 'T-1', 'ci', 2, '{}');
      INSERT INTO merge_holds (repo_path, branch, target, kind, pr_url, created_at) VALUES ('/r', 'b', 'main', 'pr', 'https://github.com/O/Old/pull/3', 1);
    `);
    repo.record(OLD, NEW, "scan", 1);
    repo.applyAll(10);
    expect(all(db, `SELECT key, repo_slug, severity FROM checks WHERE repo_slug IS NOT NULL ORDER BY key`)).toEqual([
      { key: "j", repo_slug: NEW, severity: "block" }, { key: "k", repo_slug: NEW, severity: "warn" },
    ]);
    expect(all(db, `SELECT day, group_kind, group_key, n FROM metrics_daily ORDER BY day, group_kind`)).toEqual([
      { day: "2026-11-01", group_kind: "all", group_key: "", n: 3 }, { day: "2026-11-01", group_kind: "repo", group_key: NEW, n: 3 },
      { day: "2026-11-02", group_kind: "repo", group_key: NEW, n: 1 },
    ]);
    expect(JSON.parse(String(one(db, `SELECT payload FROM handoffs`)?.payload)).prs.map((p: { url: string }) => p.url)).toEqual([
      "https://github.com/o/new/pull/3", "https://github.com/o/old-web/pull/1",
    ]);
    expect(all(db, `SELECT dedupe_key, data FROM pr_stage_events ORDER BY dedupe_key`)).toEqual([
      { dedupe_key: `T-1@${NEW}:ci:b:1`, data: '{"url":"https://github.com/o/new/pull/3#c"}' }, { dedupe_key: `T-1@${NEW}:ci:b:2`, data: "{}" },
    ]);
    expect(one(db, `SELECT pr_url FROM merge_holds`)).toEqual({ pr_url: "https://github.com/o/new/pull/3" });
  });

  it("a rewritten PR row starts reading afresh: failures, give-up and gone from the old link are cleared (BTL-261)", () => {
    const { db, prs, link, repo } = setup();
    const id = link("T-1", OLD, 7, { checkedAt: 5, state: "open" });
    prs.update(id, { readFailures: 4, readFailingSince: 2, readRetryAt: 9, readNotFound: 3, readNotFoundSince: 2, readGoneAt: 8 });
    repo.record(OLD, NEW, "scan", 1);
    repo.applyAll(10);
    expect(prs.get(id)).toMatchObject({
      slug: NEW, url: u(NEW, 7), readFailures: 0, readFailingSince: null, readRetryAt: null, readNotFound: 0, readNotFoundSince: null, readGoneAt: null,
    });
    expect(prs.needingRead(10).map((p) => p.id)).toEqual([id]);
    void db;
  });

  it("applyAll goes on with the other renames when one fails, and leaves the failed one unapplied (BTL-261)", () => {
    const { db, link, repo } = setup();
    const a = link("T-1", "o/a", 1);
    const b = link("T-1", "o/b", 2);
    repo.record("o/a", "o/a2", "scan", 1);
    repo.record("o/b", "o/b2", "scan", 2);
    // 让 o/a 那条改写失败：ticket_prs 上一个只对它触发的触发器。
    db.exec(`CREATE TRIGGER boom BEFORE UPDATE OF slug ON ticket_prs WHEN NEW.slug = 'o/a2' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const errors: string[] = [];
    const c = repo.applyAll(10, (r) => errors.push(r.oldSlug));
    expect(errors).toEqual(["o/a"]);
    expect(c.ticket_prs).toBe(1);
    expect(one(db, `SELECT slug FROM ticket_prs WHERE id = ?`, a)).toEqual({ slug: "o/a" });
    expect(one(db, `SELECT slug FROM ticket_prs WHERE id = ?`, b)).toEqual({ slug: "o/b2" });
    expect(repo.all().map((r) => [r.oldSlug, r.appliedAt])).toEqual([["o/a", null], ["o/b", 10]]);
    // 不给 onError：照旧抛出来。
    expect(() => repo.applyAll(11)).toThrow(/boom/);
  });
});
