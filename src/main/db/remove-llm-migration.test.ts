import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";

/** BTL-243：拿掉个人 LLM API 以后，清掉存下的 key、设置、敏感词和 LLM 审计；表留着，webhook 的密文不动。 */
const R = MIGRATIONS.findIndex((m) => m.includes("DELETE FROM secrets WHERE name = 'llm_api_key'"));

const LLM_SETTINGS = ["llmLevel", "llmBaseUrl", "llmModel", "llmMonthlyBudgetUsd", "llmPrices", "llmConfirm"];
const hasTable = (db: DatabaseSync, t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
const count = (db: DatabaseSync, sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe("remove-LLM migration (BTL-243)", () => {
  it("is appended after everything that was there before", () => {
    expect(R).toBeGreaterThan(0);
    expect(R).toBe(MIGRATIONS.length - 1);
  });

  it("deletes the API key, the LLM settings, the terms and the LLM audit, and keeps the rest", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (let i = 0; i < R; i++) db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${R}`);
    const put = db.prepare("INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, 1)");
    put.run("llm_api_key", new Uint8Array([1, 2, 3]));
    put.run("notify_webhook_url", new Uint8Array([4, 5, 6]));
    const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    for (const k of LLM_SETTINGS) set.run(k, "x");
    set.run("auditRetentionDays", "30");
    set.run("nightlyTime", "21:00");
    db.prepare("INSERT INTO sensitive_terms (term, category) VALUES ('someone', 'person')").run();
    db.prepare("INSERT INTO llm_audit (ts, provider, model, level, status, payload_sent) VALUES (1, 'h', 'm', 'full', 'sent', 'body')").run();

    expect(migrate(db)).toBe(MIGRATIONS.length);

    expect((db.prepare("SELECT name FROM secrets").all() as { name: string }[]).map((r) => r.name)).toEqual(["notify_webhook_url"]);
    expect((db.prepare("SELECT key FROM settings ORDER BY key").all() as { key: string }[]).map((r) => r.key)).toEqual(["auditRetentionDays", "nightlyTime"]);
    expect(count(db, "SELECT COUNT(*) AS n FROM sensitive_terms")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM llm_audit")).toBe(0);
    for (const t of ["secrets", "sensitive_terms", "llm_audit"]) expect(hasTable(db, t), t).toBe(true);
  });
});
