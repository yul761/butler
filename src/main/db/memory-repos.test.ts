import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { insertTicket, memDb } from "../test-utils";
import { migrate } from "./database";
import { MemorySyncRepo } from "./memory-sync-repo";
import { MIGRATIONS } from "./migrations";
import { SettingsRepo } from "./settings-repo";
import { TicketsRepo } from "./tickets-repo";

function v3db(withTicket: boolean): DatabaseSync {
  // 内存库：迁移的结果和磁盘上一样，但磁盘上 90 多次迁移各自 COMMIT（每次建删 journal、fsync），Windows runner
  // 上偶尔要几十秒，撞 30 秒超时（BTL-240）。
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const m of MIGRATIONS.slice(0, 3)) db.exec(m);
  db.exec("PRAGMA user_version = 3");
  if (withTicket) db.exec(`INSERT INTO tickets (key, repo_path, work_mode, branch, created_at) VALUES ('OLD-3', '/r', 'branch', 'b', 1)`);
  db.exec(`INSERT INTO llm_audit (ts, provider, model, level, status) VALUES (1, 'p', 'm', 'metadata', 'sent')`);
  return db;
}

describe("migration 4", () => {
  it("adds the audit source column (the rows themselves are cleared later, BTL-243)", () => {
    const db = v3db(true);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect((db.prepare("PRAGMA table_info(llm_audit)").all() as { name: string }[]).map((c) => c.name)).toContain("source");
    expect((db.prepare("SELECT COUNT(*) AS n FROM llm_audit").get() as { n: number }).n).toBe(0);
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
    insertTicket(new TicketsRepo(db), {
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
