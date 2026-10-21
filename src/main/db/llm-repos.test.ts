import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { PrivacyLevel } from "../../shared/llm";
import { memDb } from "../test-utils";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";
import { AUDIT_TEXT_LIMIT, AuditRepo } from "./audit-repo";
import { SecretsRepo } from "./secrets-repo";
import { TermsRepo } from "./terms-repo";

const base = { provider: "api.example.com", model: "m", level: "metadata" as PrivacyLevel };

describe("migration 3", () => {
  it("creates the audit, sensitive term and secret tables", () => {
    const db = memDb();
    for (const t of ["llm_audit", "sensitive_terms", "secrets"]) {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t), t).toBeTruthy();
    }
  });
});

describe("upgrade from schema v2", () => {
  it("applies migration 3 on top of existing v2 data", () => {
    const dir = mkdtempSync(join(tmpdir(), "butler-up-"));
    const db = new DatabaseSync(join(dir, "v2.db"));
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(MIGRATIONS[0]);
    db.exec(MIGRATIONS[1]);
    db.exec("PRAGMA user_version = 2");
    db.exec(`INSERT INTO tickets (key, repo_path, work_mode, branch, created_at) VALUES ('OLD-2', '/r', 'branch', 'b', 1)`);
    db.exec(`INSERT INTO briefs (kind, date, created_at, items) VALUES ('morning', '2026-10-20', 1, '[]')`);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    expect(db.prepare(`SELECT key FROM tickets WHERE key = 'OLD-2'`).get()).toBeTruthy();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM briefs`).get()).toEqual({ n: 1 });
    const audit = new AuditRepo(db);
    const id = audit.insert({ ...base, ts: 1, status: "pending", payloadSent: "{}" });
    expect(audit.list()[0]).toMatchObject({ id, status: "pending" });
    new SecretsRepo(db).set("k", new Uint8Array([1]), 1);
    expect(new TermsRepo(db).list()).toEqual([]);
    db.close();
  });
});

describe("AuditRepo", () => {
  it("records the request before sending and fills in the result afterwards", () => {
    const audit = new AuditRepo(memDb());
    const id = audit.insert({ ...base, ts: 10, status: "pending", payloadSent: '{"a":1}' });
    audit.finish(id, { status: "sent", response: "{}", tokensIn: 100, tokensOut: 20, costUsd: 0.0002 });
    expect(audit.list()).toEqual([
      { id, ts: 10, ...base, status: "sent", payloadSent: '{"a":1}', response: "{}", tokensIn: 100, tokensOut: 20, costUsd: 0.0002, blockedReason: null, error: null },
    ]);
  });

  it("keeps no payload for a blocked request and stores the masked hits", () => {
    const audit = new AuditRepo(memDb());
    audit.insert({ ...base, ts: 1, status: "blocked", payloadSent: null, blockedReason: [{ rule: "url", sample: "htt…(23)" }] });
    expect(audit.list()[0]).toMatchObject({ status: "blocked", payloadSent: null, blockedReason: [{ rule: "url", sample: "htt…(23)" }] });
  });

  it("replaces the payload when the final request differs from the first attempt", () => {
    const audit = new AuditRepo(memDb());
    const id = audit.insert({ ...base, ts: 1, status: "pending", payloadSent: '{"max_tokens":1}' });
    audit.finish(id, { status: "sent", payloadSent: '{"max_completion_tokens":1}' });
    expect(audit.list()[0].payloadSent).toBe('{"max_completion_tokens":1}');
    audit.finish(id, { status: "failed", error: "x" });
    expect(audit.list()[0].payloadSent).toBe('{"max_completion_tokens":1}');
  });

  it("sums the cost since a time, pages newest first and prunes old rows", () => {
    const audit = new AuditRepo(memDb());
    const a = audit.insert({ ...base, ts: 1, status: "pending", payloadSent: "a" });
    audit.finish(a, { status: "sent", costUsd: 1 });
    const b = audit.insert({ ...base, ts: 100, status: "pending", payloadSent: "b" });
    audit.finish(b, { status: "sent", costUsd: 0.5 });
    const c = audit.insert({ ...base, ts: 200, status: "budget", payloadSent: null, error: "超过预算" });
    expect(audit.costSince(50)).toBe(0.5);
    expect(audit.costSince(0)).toBe(1.5);
    expect(audit.list(2).map((e) => e.id)).toEqual([c, b]);
    expect(audit.list(2, b).map((e) => e.id)).toEqual([a]);
    expect(audit.prune(150)).toBe(2);
    expect(audit.list().map((e) => e.id)).toEqual([c]);
  });

  it("rejects an unknown level or status and caps oversized text", () => {
    const audit = new AuditRepo(memDb());
    expect(() => audit.insert({ ...base, level: "bogus" as PrivacyLevel, ts: 1, status: "pending", payloadSent: null })).toThrow();
    const id = audit.insert({ ...base, ts: 1, status: "pending", payloadSent: null });
    audit.finish(id, { status: "sent", response: "x".repeat(AUDIT_TEXT_LIMIT + 10) });
    expect(audit.list()[0].response).toHaveLength(AUDIT_TEXT_LIMIT);
  });
});

describe("TermsRepo", () => {
  it("replaces the whole list and treats terms case-insensitively", () => {
    const terms = new TermsRepo(memDb());
    terms.replaceAll([{ term: "张三", category: "person" }, { term: "Project Falcon", category: "term" }, { term: "project falcon", category: "term" }]);
    expect(terms.list()).toEqual([{ term: "张三", category: "person" }, { term: "Project Falcon", category: "term" }]);
    terms.replaceAll([]);
    expect(terms.list()).toEqual([]);
  });
});

describe("SecretsRepo", () => {
  it("stores bytes as they are", () => {
    const secrets = new SecretsRepo(memDb());
    expect(secrets.get("k")).toBeNull();
    secrets.set("k", new Uint8Array([0, 1, 255]), 1);
    secrets.set("k", new Uint8Array([9, 8]), 2);
    expect([...secrets.get("k")!]).toEqual([9, 8]);
    secrets.delete("k");
    expect(secrets.get("k")).toBeNull();
  });
});
