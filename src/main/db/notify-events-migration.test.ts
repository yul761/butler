import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";

/** 工作流 R 的迁移：存过「推哪些事件」的用户，也收到后来加的 intake_decision。 */
const R = MIGRATIONS.findIndex((m) => m.includes("'notifyEvents'") && m.includes("intake_decision"));

function before(value: string | null): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (let i = 0; i < R; i++) db.exec(MIGRATIONS[i]);
  db.exec(`PRAGMA user_version = ${R}`);
  if (value !== null) db.prepare("INSERT INTO settings (key, value) VALUES ('notifyEvents', ?)").run(value);
  return db;
}

const stored = (db: DatabaseSync) => (db.prepare("SELECT value FROM settings WHERE key = 'notifyEvents'").get() as { value: string } | undefined)?.value ?? null;

describe("notify events migration (workstream R)", () => {
  it("adds intake_decision to a saved list that predates it", () => {
    expect(R).toBeGreaterThan(0);
    const db = before("decision_needed,pr_ready");
    migrate(db);
    expect(stored(db)).toBe("decision_needed,pr_ready,intake_decision");
  });

  it("leaves a list that already has it, an empty list (nothing wanted) and no saved list alone", () => {
    const has = before("intake_decision,pr_ready");
    migrate(has);
    expect(stored(has)).toBe("intake_decision,pr_ready");
    const none = before("");
    migrate(none);
    expect(stored(none)).toBe("");
    const unsaved = before(null);
    migrate(unsaved);
    expect(stored(unsaved)).toBeNull();
  });
});
