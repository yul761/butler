import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { BlocksRepo } from "./blocks-repo";
import { migrate } from "./database";
import { EpicArchiveRepo } from "./epic-archive-repo";
import { FeaturesRepo } from "./features-repo";
import { MIGRATIONS } from "./migrations";
import { TicketsRepo } from "./tickets-repo";

/** BTL-246 的迁移：先停在它前面，造一个旧 epic，再迁到底。 */
const A = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE blocks"));

function before(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (let i = 0; i < A; i++) db.exec(MIGRATIONS[i]);
  db.exec(`PRAGMA user_version = ${A}`);
  return db;
}

describe("hierarchy A′ migration (BTL-246)", () => {
  it("comes right before BTL-247's features.automation_level", () => {
    // 后面的工作项接着追加迁移，所以只钉住它后面紧跟的那条。
    expect(MIGRATIONS[A + 1]).toContain("ADD COLUMN automation_level");
  });

  it("turns an old epic's features into independent epics: plan into the brief, epic archived, epic and ticket-coordinator sessions hidden", () => {
    const db = before();
    db.prepare("INSERT INTO epics (id, name, workspace_dir, created_at, plan) VALUES (1, 'Big', '/w/big', 1, 'do A then B')").run();
    db.prepare("INSERT INTO epics (id, name, workspace_dir, created_at) VALUES (2, 'Empty', '/w/empty', 1)").run();
    db.prepare("INSERT INTO features (id, name, workspace_dir, created_at, epic_id, brief) VALUES (10, 'f1', '/w/f1', 1, 1, 'f1 brief')").run();
    db.prepare("INSERT INTO features (id, name, workspace_dir, created_at, epic_id) VALUES (11, 'f2', '/w/f2', 1, 1)").run();
    db.prepare("INSERT INTO features (id, name, workspace_dir, created_at, epic_id) VALUES (12, 'f3', '/w/f3', 1, 2)").run();
    db.prepare("INSERT INTO features (id, name, workspace_dir, created_at) VALUES (13, 'loose', '/w/loose', 1)").run();
    db.prepare(`INSERT INTO tickets (key, title, repo_path, work_mode, branch, status, created_at) VALUES ('T-1', NULL, '', 'branch', '', 'active', 1)`).run();
    // 'butler'：sessions.origin 在库里的值沿用改名前的（改 CHECK 要重建 sessions 表，没改），见 LEGACY_ORIGIN。
    const session = db.prepare("INSERT INTO sessions (id, ticket_key, cwd, origin, created_at, coordinator, epic_id, feature_id) VALUES (?, ?, '/c', 'butler', 1, ?, ?, ?)");
    session.run("epic-s", null, 0, 1, null);
    session.run("ticket-coord", "T-1", 1, null, null);
    session.run("ticket-s", "T-1", 0, null, null);
    session.run("feature-coord", null, 1, null, 10);
    const item = db.prepare("INSERT INTO inbox_items (kind, session_id, epic_id, text, report_kind, created_at) VALUES (?, ?, ?, 'x', ?, 1)");
    item.run("report", "feature-coord", 1, "done");
    item.run("report", "ticket-coord", null, "done");
    item.run("report", "ticket-s", null, "done");
    item.run("decision", "epic-s", 1, null);
    // epic 里 ticket session 的汇报也带着 epic_id（InboxService.owner 填的），它还要送给 epic 总控。
    session.run("ticket-in-epic", "T-1", 0, null, 10);
    item.run("report", "ticket-in-epic", 1, "blocked");
    item.run("decision", "ticket-coord", null, null);
    session.run("loose-coord", null, 1, null, 13);
    item.run("report", "loose-coord", null, "done");

    migrate(db);

    const brief = (id: number) => (db.prepare("SELECT brief FROM features WHERE id = ?").get(id) as { brief: string | null }).brief;
    expect(brief(10)).toBe("f1 brief\n\n[Big]\ndo A then B");
    expect(brief(11)).toBe("[Big]\ndo A then B");
    expect(brief(12)).toBeNull();
    expect(brief(13)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM epics WHERE archived_at IS NULL").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM features WHERE archived_at IS NOT NULL").get()).toEqual({ n: 0 });
    const hidden = db.prepare("SELECT id FROM sessions WHERE dismissed = 1 ORDER BY id").all() as { id: string }[];
    expect(hidden.map((r) => r.id)).toEqual(["epic-s", "ticket-coord"]);
    // ticket 总控没有了：以前的总控 session 以后按普通 ticket session 恢复。
    expect(db.prepare("SELECT id FROM sessions WHERE coordinator = 1 ORDER BY id").all()).toEqual([{ id: "feature-coord" }, { id: "loose-coord" }]);
    const items = db.prepare("SELECT kind, session_id, status FROM inbox_items ORDER BY id").all();
    expect(items).toEqual([
      { kind: "report", session_id: "feature-coord", status: "dismissed" },
      { kind: "report", session_id: "ticket-coord", status: "dismissed" },
      { kind: "report", session_id: "ticket-s", status: "pending" },
      // 旧 epic session 的提问没有终端能收到回答了：收掉。
      { kind: "decision", session_id: "epic-s", status: "dismissed" },
      { kind: "report", session_id: "ticket-in-epic", status: "pending" },
      // ticket 总控按普通 ticket session 恢复，它的提问留着。
      { kind: "decision", session_id: "ticket-coord", status: "pending" },
      // 不在旧 epic 里的 feature 总控：汇报不动（现在只存，迁移不管）。
      { kind: "report", session_id: "loose-coord", status: "pending" },
    ]);
  });
});

describe("BlocksRepo", () => {
  it("keeps the order, inserts before another block, and reorders", () => {
    const db = memDb();
    const features = new FeaturesRepo(db);
    const f = features.insert({ name: "e", workspaceDir: "/w/e", createdAt: 1 });
    const blocks = new BlocksRepo(db);
    const a = blocks.insert({ featureId: f, name: "A", description: null, createdAt: 1 });
    const c = blocks.insert({ featureId: f, name: "C", description: "last", createdAt: 2 });
    const b = blocks.insert({ featureId: f, name: "B", description: null, createdAt: 3, before: c });
    expect(blocks.list(f).map((x) => [x.name, x.position])).toEqual([["A", 0], ["B", 1], ["C", 2]]);
    expect(blocks.byName(f, " b ")?.id).toBe(b);
    blocks.reorder([c, a, b]);
    expect(blocks.list(f).map((x) => x.name)).toEqual(["C", "A", "B"]);
    expect(() => blocks.insert({ featureId: f, name: "A", description: null, createdAt: 4 })).toThrow();
  });

  it("moves a ticket into a block and out again; changing the epic clears the block", () => {
    const db = memDb();
    const features = new FeaturesRepo(db);
    const f = features.insert({ name: "e", workspaceDir: "/w/e", createdAt: 1 });
    const blocks = new BlocksRepo(db);
    const a = blocks.insert({ featureId: f, name: "A", description: null, createdAt: 1 });
    const tickets = new TicketsRepo(db);
    tickets.insert({ key: "T-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null, featureId: f, blockId: a });
    expect(tickets.get("T-1")?.blockId).toBe(a);
    tickets.setBlock("T-1", null);
    expect(tickets.get("T-1")?.blockId).toBeNull();
    tickets.setBlock("T-1", a);
    expect(tickets.get("T-1")?.blockId).toBe(a);
  });
});

describe("FeaturesRepo Jira epic key", () => {
  it("finds the open epic by Jira key; an archived one frees the key, and unarchiving it then drops its key", () => {
    const db = memDb();
    const features = new FeaturesRepo(db);
    const old = features.insert({ name: "x", workspaceDir: "/w/x", createdAt: 1 });
    features.setJiraEpic(old, "EP-1");
    expect(features.byJiraEpic("EP-1")?.id).toBe(old);
    features.archive(old, 2);
    expect(features.byJiraEpic("EP-1")).toBeNull();
    const fresh = features.insert({ name: "y", workspaceDir: "/w/y", createdAt: 3 });
    features.setJiraEpic(fresh, "EP-1");
    features.unarchive(old);
    expect(features.get(old)?.jiraEpicKey).toBeNull();
    expect(features.byJiraEpic("EP-1")?.id).toBe(fresh);
  });
});

describe("EpicArchiveRepo", () => {
  it("lists oldest first, hides markers, and trims to the newest", () => {
    const db = memDb();
    const f = new FeaturesRepo(db).insert({ name: "e", workspaceDir: "/w/e", createdAt: 1 });
    const archive = new EpicArchiveRepo(db);
    archive.add({ featureId: f, text: "b", source: "notes", notedAt: 2, archivedAt: 9 });
    archive.add({ featureId: f, text: "a", source: "notes", notedAt: 1, archivedAt: 9 });
    archive.add({ featureId: f, text: "", source: "epic:3", notedAt: 0, archivedAt: 9 });
    archive.add({ featureId: f, text: "c", source: "notes", notedAt: 3, archivedAt: 9 });
    expect(archive.list(f).map((e) => e.text)).toEqual(["a", "b", "c"]);
    expect(archive.has(f, "epic:3")).toBe(true);
    expect(archive.trim(f, 2).map((e) => e.text)).toEqual(["a"]);
    expect(archive.list(f).map((e) => e.text)).toEqual(["b", "c"]);
  });
});
