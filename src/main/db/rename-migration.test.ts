// BTL-260：升级前（user_version 56）的库里 butler 的列名、表名、取值，迁移后都换成 shipherd。
// 用例里的 butler 是要被迁移掉的旧名字，不能改名。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";
import { LEGACY_ORIGIN, SessionsRepo } from "./sessions-repo";
import { SettingsRepo } from "./settings-repo";

/** 改名前最后一个已发布的迁移。 */
const PRE = 56;

function preRename(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const m of MIGRATIONS.slice(0, PRE)) db.exec(m);
  db.exec(`PRAGMA user_version = ${PRE}`);
  return db;
}

const cols = (db: DatabaseSync, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

describe("rename migration (BTL-260)", () => {
  it("is the migration right after the last shipped one", () => {
    expect(MIGRATIONS.length).toBe(PRE + 1);
  });

  it("renames butler columns and tables and keeps their values", () => {
    const db = preRename();
    db.exec(`INSERT INTO tickets (key, repo_path, work_mode, branch, created_at) VALUES ('T-1', '/r', 'branch', 'b', 1)`);
    db.exec(`INSERT INTO sessions (id, cwd, origin, created_at, butler) VALUES ('c', '/w', 'butler', 1, 1), ('d', '/w', 'discovered', 2, 0)`);
    db.exec(`INSERT INTO ticket_prs (ticket_key, url, slug, number, state, source, linked_at, butler_made) VALUES ('T-1', 'https://x/pull/1', 'o/r', 1, 'merged', 'branch', 1, 1)`);
    db.exec(`INSERT INTO metrics_daily (day, group_kind, group_key, butler, metric, n, total) VALUES ('2026-01-01', 'all', '', 1, 'm', 2, 3)`);
    db.exec(`INSERT INTO review_effect_prs (pr_id, repo_slug, number, butler, computed_at) VALUES (1, 'o/r', 1, 1, 1)`);
    db.exec(`INSERT INTO butler_messages (id, from_session, text, status, queued_at) VALUES ('m1', 'c', 'hi', 'replied', 1)`);
    expect(migrate(db)).toBe(PRE + 1);

    expect(cols(db, "sessions")).toContain("shipherd");
    expect(cols(db, "sessions")).not.toContain("butler");
    expect(db.prepare(`SELECT id, shipherd FROM sessions ORDER BY id`).all().map((r) => [r.id, Number(r.shipherd)])).toEqual([["c", 1], ["d", 0]]);
    expect(Number((db.prepare(`SELECT shipherd_made FROM ticket_prs`).get() as { shipherd_made: number }).shipherd_made)).toBe(1);
    expect(Number((db.prepare(`SELECT shipherd FROM metrics_daily`).get() as { shipherd: number }).shipherd)).toBe(1);
    expect(Number((db.prepare(`SELECT shipherd FROM review_effect_prs`).get() as { shipherd: number }).shipherd)).toBe(1);
    expect(db.prepare(`SELECT id, text FROM shipherd_messages`).all()).toEqual([{ id: "m1", text: "hi" }]);
    const names = (db.prepare(`SELECT name FROM sqlite_master`).all() as { name: string }[]).map((r) => r.name);
    expect(names.filter((n) => /butler/i.test(n))).toEqual([]);
    expect(names).toContain("idx_shipherd_messages_status");
  });

  it("rebuilds session_messages and memory_samples with 'shipherd' in place of 'butler', keeping every row and index", () => {
    const db = preRename();
    const msg = db.prepare(`INSERT INTO session_messages (id, kind, to_session, body, ref, status, queued_at) VALUES (?, ?, 's', 'b', ?, ?, ?)`);
    msg.run("a", "butler", "r1", "queued", 1);
    msg.run("b", "ci", null, "delivered", 2);
    db.exec(`INSERT INTO memory_samples (at, kind, total_kb, detail) VALUES (1, 'butler', 10, '{"mcp_butler":3,"electron":7}'), (2, 'session', 5, NULL)`);
    migrate(db);
    expect(db.prepare(`SELECT id, kind, status FROM session_messages ORDER BY id`).all()).toEqual([
      { id: "a", kind: "shipherd", status: "queued" },
      { id: "b", kind: "ci", status: "delivered" },
    ]);
    expect(() => msg.run("c", "butler", null, "queued", 3)).toThrow(/CHECK/);
    msg.run("c", "shipherd", null, "queued", 3);
    // 「同一个 ref 只能排一条」的唯一索引还在。
    expect(() => msg.run("d", "ci", "r1", "queued", 4)).toThrow(/UNIQUE/);
    expect(db.prepare(`SELECT kind, detail FROM memory_samples ORDER BY at`).all()).toEqual([
      { kind: "shipherd", detail: '{"mcp_shipherd":3,"electron":7}' },
      { kind: "session", detail: null },
    ]);
    const idx = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('session_messages','memory_samples')`).all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(["session_messages_status", "session_messages_queued_at", "session_messages_queued_ref", "memory_samples_at"]));
  });

  it("renames the patrol setting and job, without overwriting a value that already uses the new name", () => {
    const db = preRename();
    db.exec(`INSERT INTO settings (key, value) VALUES ('butlerPatrolTime', '"09:30"')`);
    db.exec(`INSERT INTO jobs (name, last_run_at) VALUES ('butler_patrol', 42)`);
    migrate(db);
    expect(new SettingsRepo(db).get("shipherdPatrolTime")).toBe('"09:30"');
    expect(db.prepare(`SELECT name, last_run_at FROM jobs`).all().map((r) => [r.name, Number(r.last_run_at)])).toEqual([["shipherd_patrol", 42]]);

    const both = preRename();
    both.exec(`INSERT INTO settings (key, value) VALUES ('butlerPatrolTime', '"09:30"'), ('shipherdPatrolTime', '"10:00"')`);
    migrate(both);
    expect(both.prepare(`SELECT key, value FROM settings WHERE key LIKE '%PatrolTime'`).all()).toEqual([{ key: "shipherdPatrolTime", value: '"10:00"' }]);
  });

  it("renames butlerStage inside the stored repo baselines", () => {
    const db = preRename();
    const checks = JSON.stringify([{ name: "lint", butlerStage: "edit" }, { name: "test", butlerStage: "push" }]);
    db.prepare(`INSERT INTO repo_baselines (repo_slug, scanned_at, status, checks, infer_detail) VALUES ('o/r', 1, 'ok', ?, ?)`).run(checks, JSON.stringify({ butlerStage: "edit" }));
    migrate(db);
    const r = db.prepare(`SELECT checks, infer_detail FROM repo_baselines`).get() as { checks: string; infer_detail: string };
    expect(JSON.parse(r.checks)).toEqual([{ name: "lint", shipherdStage: "edit" }, { name: "test", shipherdStage: "push" }]);
    expect(JSON.parse(r.infer_detail)).toEqual({ shipherdStage: "edit" });
  });
});

describe("sessions.origin (kept as the pre-rename value in the table)", () => {
  it("reads old rows as shipherd and writes shipherd as the stored legacy value", () => {
    const db = preRename();
    db.exec(`INSERT INTO sessions (id, cwd, origin, created_at) VALUES ('old', '/w', 'butler', 1)`);
    migrate(db);
    const repo = new SessionsRepo(db);
    expect(repo.get("old")?.origin).toBe("shipherd");
    repo.insertIfAbsent({ id: "new", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 2 });
    repo.insertIfAbsent({ id: "found", ticketKey: null, cwd: "/w", origin: "discovered", createdAt: 3 });
    repo.setOrigin("found", "shipherd");
    const stored = db.prepare(`SELECT id, origin FROM sessions ORDER BY id`).all();
    expect(stored).toEqual([{ id: "found", origin: LEGACY_ORIGIN }, { id: "new", origin: LEGACY_ORIGIN }, { id: "old", origin: LEGACY_ORIGIN }]);
    expect(["found", "new", "old"].map((id) => repo.get(id)?.origin)).toEqual(["shipherd", "shipherd", "shipherd"]);
  });
});
