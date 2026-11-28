import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";
import { SessionMessagesRepo } from "./session-messages-repo";

/** BTL-279 的迁移：session_messages 记试着送了几次、最后一次什么时候、结果是什么（诊断导出、消息列表里看得到）。 */
const M = MIGRATIONS.findIndex((m) => m.includes("session_messages ADD COLUMN attempts"));

const cols = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe("mailbox attempts migration (BTL-279)", () => {
  it("is the last migration and upgrades the database before it without touching its rows", () => {
    // 4.3.0 的迁移顺序：BTL-279 排在最后，rebase 时挪到数组末尾。
    expect(M).toBe(MIGRATIONS.length - 1);
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (let i = 0; i < M; i++) db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${M}`);
    db.prepare(`INSERT INTO session_messages (id, kind, from_session, to_session, feature_id, body, status, queued_at, blocked_reason, blocked_since)
      VALUES ('m1', 'instruction', 'coord', 's1', 1, 'do it', 'queued', 5, 'turn', 6)`).run();

    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(cols(db, "session_messages")).toEqual(expect.arrayContaining(["attempts", "last_attempt_at", "last_attempt"]));
    expect(db.prepare("SELECT id, body, status, queued_at, blocked_reason, blocked_since, attempts, last_attempt_at, last_attempt FROM session_messages").all())
      .toEqual([{ id: "m1", body: "do it", status: "queued", queued_at: 5, blocked_reason: "turn", blocked_since: 6, attempts: 0, last_attempt_at: null, last_attempt: null }]);
    // 升级上来的旧行照样能记尝试。
    const repo = new SessionMessagesRepo(db);
    repo.attempted(["m1"], 10, "turn");
    expect(repo.get("m1")).toMatchObject({ attempts: 1, lastAttemptAt: 10, lastAttempt: "turn" });
  });
});
