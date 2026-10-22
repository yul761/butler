import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { PrivacyLevel } from "../../shared/llm";
import { stalePendingCost } from "../gateway/budget";
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
      { id, ts: 10, ...base, source: "narrative", status: "sent", payloadSent: '{"a":1}', response: "{}", tokensIn: 100, tokensOut: 20, costUsd: 0.0002, blockedReason: null, error: null },
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

  it("fails rows left pending by a previous run and keeps their payload", () => {
    const audit = new AuditRepo(memDb());
    const stale = audit.insert({ ...base, ts: 1, status: "pending", payloadSent: '{"a":1}' });
    const sent = audit.insert({ ...base, ts: 2, status: "pending", payloadSent: '{"b":2}' });
    audit.finish(sent, { status: "sent", costUsd: 0.1 });
    const blocked = audit.insert({ ...base, ts: 3, status: "blocked", payloadSent: null });
    expect(audit.failStalePending("quit while sending")).toBe(1);
    const byId = new Map(audit.list().map((e) => [e.id, e]));
    expect(byId.get(stale)).toMatchObject({ status: "failed", payloadSent: '{"a":1}', error: "quit while sending" });
    expect(byId.get(sent)).toMatchObject({ status: "sent", costUsd: 0.1, error: null });
    expect(byId.get(blocked)).toMatchObject({ status: "blocked", error: null });
    expect(audit.failStalePending("again")).toBe(0);
  });

  it("charges a stale pending row with a body a conservative estimate; one without a body stays free", () => {
    const audit = new AuditRepo(memDb());
    const withBody = audit.insert({ ...base, ts: 1, status: "pending", payloadSent: '{"a":1}' });
    const noBody = audit.insert({ ...base, ts: 2, status: "pending", payloadSent: null });
    const unpriced = audit.insert({ ...base, model: "unknown", ts: 3, status: "pending", payloadSent: '{"c":3}' });
    const seen: { model: string; payloadSent: string; source: string }[] = [];
    const estimate = (row: { model: string; payloadSent: string; source: string }) => {
      seen.push(row);
      return row.model === "m" ? { tokensIn: 7, tokensOut: 800, costUsd: 0.25 } : null;
    };
    expect(audit.failStalePending("quit while sending", estimate)).toBe(3);
    expect(seen).toEqual([
      { model: "m", payloadSent: '{"a":1}', source: "narrative" },
      { model: "unknown", payloadSent: '{"c":3}', source: "narrative" },
    ]);
    const byId = new Map(audit.list().map((e) => [e.id, e]));
    expect(byId.get(withBody)).toMatchObject({ status: "failed", payloadSent: '{"a":1}', tokensIn: 7, tokensOut: 800, costUsd: 0.25 });
    expect(byId.get(noBody)).toMatchObject({ status: "failed", payloadSent: null, costUsd: null });
    expect(byId.get(unpriced)).toMatchObject({ status: "failed", costUsd: null });
    expect(audit.costSince(0)).toBe(0.25);
  });

  it("charges a stale StateCore pending row at StateCore's output cap, keeping its source", () => {
    const audit = new AuditRepo(memDb());
    const body = '{"model":"m","messages":[],"max_tokens":8192}';
    const sc = audit.insert({ ...base, level: "full", source: "statecore", ts: 1, status: "pending", payloadSent: body });
    const nr = audit.insert({ ...base, ts: 2, status: "pending", payloadSent: body });
    expect(audit.failStalePending("quit while sending", stalePendingCost([{ pattern: "*", inputPerMTok: 1, outputPerMTok: 2 }]))).toBe(2);
    const byId = new Map(audit.list().map((e) => [e.id, e]));
    expect(byId.get(sc)).toMatchObject({ source: "statecore", status: "failed", tokensOut: 8192 });
    expect(byId.get(nr)).toMatchObject({ source: "narrative", status: "failed", tokensOut: 800 });
  });

  it("clears the pending payload when a failed request never left the machine", () => {
    const audit = new AuditRepo(memDb());
    const id = audit.insert({ ...base, ts: 1, status: "pending", payloadSent: '{"max_tokens":1}' });
    audit.finish(id, { status: "failed", payloadSent: null, error: "connect refused" });
    expect(audit.list()[0]).toMatchObject({ status: "failed", payloadSent: null, error: "connect refused" });
  });

  it("only lets failed or declined clear the payload", () => {
    const audit = new AuditRepo(memDb());
    const id = audit.insert({ ...base, ts: 1, status: "pending", payloadSent: "body" });
    // @ts-expect-error a sent request always has a body
    expect(() => audit.finish(id, { status: "sent", payloadSent: null })).toThrow();
    expect(audit.list()[0]).toMatchObject({ status: "pending", payloadSent: "body" });
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

describe("fix round 1: audit payload rules", () => {
  it("never stores a payload or response for blocked, budget or declined rows", () => {
    const audit = new AuditRepo(memDb());
    // @ts-expect-error a blocked row cannot carry a payload
    audit.insert({ ...base, ts: 1, status: "blocked", payloadSent: "secret-body" });
    // @ts-expect-error a budget row cannot carry a payload
    audit.insert({ ...base, ts: 2, status: "budget", payloadSent: "secret-body" });
    // @ts-expect-error a declined row cannot carry a payload
    audit.insert({ ...base, ts: 3, status: "declined", payloadSent: "secret-body" });
    const rows = audit.list();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.payloadSent).toBeNull();
      expect(r.response).toBeNull();
    }
  });

  it("clears the payload and response when a request is declined after it was recorded", () => {
    const audit = new AuditRepo(memDb());
    const id = audit.insert({ ...base, ts: 1, status: "pending", payloadSent: '{"a":1}' });
    audit.finish(id, { status: "declined", response: "r" });
    expect(audit.list()[0]).toMatchObject({ status: "declined", payloadSent: null, response: null });
  });

  it("keeps the recorded cost and tokens when a later finish omits them", () => {
    const audit = new AuditRepo(memDb());
    const id = audit.insert({ ...base, ts: 1, status: "pending", payloadSent: "a" });
    audit.finish(id, { status: "sent", response: "{}", tokensIn: 5, tokensOut: 2, costUsd: 0.5 });
    audit.finish(id, { status: "failed", error: "x" });
    expect(audit.costSince(0)).toBe(0.5);
    expect(audit.list()[0]).toMatchObject({ status: "failed", response: "{}", tokensIn: 5, tokensOut: 2, costUsd: 0.5 });
  });

  it("clamps the page size to 1..500", () => {
    const audit = new AuditRepo(memDb());
    for (let i = 0; i < 501; i++) audit.insert({ ...base, ts: i, status: "pending", payloadSent: null });
    expect(audit.list(0)).toHaveLength(1);
    expect(audit.list(-5)).toHaveLength(1);
    expect(audit.list(10_000)).toHaveLength(500);
  });

  it("cuts oversized text without splitting a surrogate pair", () => {
    const audit = new AuditRepo(memDb());
    const id = audit.insert({ ...base, ts: 1, status: "pending", payloadSent: null });
    audit.finish(id, { status: "sent", response: "a".repeat(AUDIT_TEXT_LIMIT - 1) + "😀" });
    const r = audit.list()[0].response!;
    expect(r).toHaveLength(AUDIT_TEXT_LIMIT - 1);
    expect(r.endsWith("a")).toBe(true);
  });
});

describe("fix round 1: sensitive terms", () => {
  it("normalises NFKC, drops blanks and dedupes case-insensitively", () => {
    const terms = new TermsRepo(memDb());
    terms.replaceAll([
      { term: "ＰＲＯＪ", category: "term" },
      { term: "PROJ", category: "term" },
      { term: "  ", category: "term" },
      { term: "", category: "term" },
      { term: "　张三　", category: "person" },
    ]);
    expect(terms.list()).toEqual([
      { term: "张三", category: "person" },
      { term: "PROJ", category: "term" },
    ]);
  });
});
