import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";

/** UI 重做第 1 层的两个迁移：接在第 4 层对话另存（conv_turns）后面，旧库升级和新库都要有。 */
const D = MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN delivered_at"));
const C = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE conv_turns"));

const cols = (db: DatabaseSync, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
const hasTable = (db: DatabaseSync, t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;

describe("turn migrations (UI redesign layer 1)", () => {
  it("sit right after the layer-4 conversation store", () => {
    expect(C).toBeGreaterThan(0);
    expect(D).toBe(C + 1);
    expect(MIGRATIONS[D + 1]).toContain("CREATE TABLE review_requests");
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(D + 2);
  });

  it("upgrade a database that stopped at the conversation store", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (let i = 0; i < D; i++) db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${D}`);
    expect(cols(db, "ticket_prs")).not.toContain("delivered_at");
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(cols(db, "ticket_prs")).toEqual(expect.arrayContaining(["delivered_at", "delivered_to"]));
    expect(hasTable(db, "review_requests")).toBe(true);
    expect(hasTable(db, "conv_turns")).toBe(true);
  });

  it("build a fresh database with both", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(cols(db, "ticket_prs")).toEqual(expect.arrayContaining(["delivered_at", "delivered_to"]));
    expect(hasTable(db, "review_requests")).toBe(true);
    expect(hasTable(db, "conv_messages")).toBe(true);
  });
});
