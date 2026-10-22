import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { AuditRepo } from "./audit-repo";
import { migrate } from "./database";
import { MemorySyncRepo } from "./memory-sync-repo";
import { MIGRATIONS } from "./migrations";
import { SettingsRepo } from "./settings-repo";
import { TicketsRepo } from "./tickets-repo";

function v3db(withTicket: boolean): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "butler-up4-"));
  const db = new DatabaseSync(join(dir, "v3.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  for (const m of MIGRATIONS.slice(0, 3)) db.exec(m);
  db.exec("PRAGMA user_version = 3");
  if (withTicket) db.exec(`INSERT INTO tickets (key, repo_path, work_mode, branch, created_at) VALUES ('OLD-3', '/r', 'branch', 'b', 1)`);
  db.exec(`INSERT INTO llm_audit (ts, provider, model, level, status) VALUES (1, 'p', 'm', 'metadata', 'sent')`);
  return db;
}

describe("migration 4", () => {
  it("adds the memory sync cursor and the audit source, keeping old audit rows as narrative", () => {
    const db = v3db(true);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBe(4);
    expect(new AuditRepo(db).list()[0]).toMatchObject({ source: "narrative", status: "sent" });
    expect(() => db.exec(`INSERT INTO llm_audit (ts, provider, model, level, status, source) VALUES (1, 'p', 'm', 'full', 'sent', 'other')`)).toThrow();
    db.close();
  });

  it("does not send an existing user through the first-run wizard, but a new one gets it", () => {
    const old = v3db(true);
    migrate(old);
    expect(new SettingsRepo(old).get("onboardingDone")).toBe("1");
    old.close();
    const fresh = v3db(false);
    migrate(fresh);
    expect(new SettingsRepo(fresh).get("onboardingDone")).toBe("0");
    fresh.close();
    expect(new SettingsRepo(memDb()).get("onboardingDone")).toBe("0");
  });
});

describe("MemorySyncRepo", () => {
  it("starts at 0 and only moves forward", () => {
    const db = memDb();
    new TicketsRepo(db).insert({
      key: "PROJ-1", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b",
      status: "active", statusManual: null, createdAt: 1, archivedAt: null,
    });
    const sync = new MemorySyncRepo(db);
    expect(sync.cursor("PROJ-1")).toBe(0);
    sync.setCursor("PROJ-1", 5, 100);
    expect(sync.cursor("PROJ-1")).toBe(5);
    sync.setCursor("PROJ-1", 3, 200);
    expect(sync.cursor("PROJ-1")).toBe(5);
    sync.setCursor("PROJ-1", 9, 300);
    expect(sync.cursor("PROJ-1")).toBe(9);
    expect(sync.cursor("NOPE-1")).toBe(0);
  });
});

describe("AuditRepo source", () => {
  it("records where a call came from", () => {
    const audit = new AuditRepo(memDb());
    audit.insert({ ts: 1, provider: "p", model: "m", level: "metadata", status: "pending", payloadSent: "{}" });
    audit.insert({ ts: 2, provider: "p", model: "m", level: "full", status: "pending", payloadSent: "{}", source: "statecore" });
    expect(audit.list().map((e) => e.source)).toEqual(["statecore", "narrative"]);
  });
});
