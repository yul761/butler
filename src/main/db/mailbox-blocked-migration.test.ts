import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";

/** BTL-269 的迁移：session_messages 记挡住的原因和回执时间，inbox_items 记总控代答。 */
const M = MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN blocked_reason"));

const cols = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe("mailbox blocked-reason migration (BTL-269)", () => {
  it("is migration 62, right after BTL-271's 61, and upgrades a database at 61 without touching its rows", () => {
    // 合并顺序：#104（BTL-274）占 60，#103（BTL-271）占 61，这一条排在它们后面。
    expect(M).toBe(61);
    expect(MIGRATIONS[M - 1]).toContain("'preReviewConcurrency'");
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (let i = 0; i < M; i++) db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${M}`);
    db.prepare(`INSERT INTO session_messages (id, kind, from_session, to_session, feature_id, body, status, queued_at)
      VALUES ('m1', 'instruction', 'coord', 's1', 1, 'do it', 'queued', 5)`).run();
    db.prepare(`INSERT INTO inbox_items (kind, session_id, text, status, answer, created_at)
      VALUES ('decision', 's1', 'which?', 'answered', 'A', 7)`).run();

    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(cols(db, "session_messages")).toEqual(expect.arrayContaining(["blocked_reason", "blocked_since", "stuck_receipt_at"]));
    expect(cols(db, "inbox_items")).toEqual(expect.arrayContaining(["behalf_by", "behalf_seen_at"]));
    expect(db.prepare("SELECT id, body, status, queued_at, blocked_reason, blocked_since, stuck_receipt_at FROM session_messages").all())
      .toEqual([{ id: "m1", body: "do it", status: "queued", queued_at: 5, blocked_reason: null, blocked_since: null, stuck_receipt_at: null }]);
    expect(db.prepare("SELECT text, status, answer, created_at, behalf_by, behalf_seen_at FROM inbox_items").all())
      .toEqual([{ text: "which?", status: "answered", answer: "A", created_at: 7, behalf_by: null, behalf_seen_at: null }]);
  });
});
