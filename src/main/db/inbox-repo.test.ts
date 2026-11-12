import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { migrate } from "./database";
import { InboxRepo } from "./inbox-repo";
import { MIGRATIONS } from "./migrations";
import { SessionsRepo } from "./sessions-repo";

const owner = (sessionId: string, o: { ticketKey?: string | null; featureId?: number | null; epicId?: number | null } = {}) => ({
  sessionId, ticketKey: o.ticketKey ?? null, featureId: o.featureId ?? null, epicId: o.epicId ?? null,
});

describe("InboxRepo (BTL-190 2+3)", () => {
  it("is created by the latest migration", () => {
    const db = memDb();
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'inbox_items'`).get()).toBeTruthy();
  });

  it("stores a decision with options and context, records an answer without resolving, then resolves once", () => {
    const repo = new InboxRepo(memDb());
    const id = repo.addDecision({ ...owner("s1", { ticketKey: "BTL-1", featureId: 3, epicId: 2 }), question: "Which?", options: ["A", "B"], context: "ctx", createdAt: 10 });
    expect(repo.get(id)).toMatchObject({
      kind: "decision", sessionId: "s1", ticketKey: "BTL-1", featureId: 3, epicId: 2, text: "Which?", options: ["A", "B"], context: "ctx",
      reportKind: null, status: "pending", answer: null, createdAt: 10, resolvedAt: null,
    });
    expect(repo.setAnswer(id, "A")).toBe(true);
    expect(repo.get(id)).toMatchObject({ status: "pending", answer: "A" });
    expect(repo.pendingDecisions().map((d) => d.id)).toEqual([id]);
    expect(repo.resolve(id, "answered", 20)).toBe(true);
    expect(repo.get(id)).toMatchObject({ status: "answered", answer: "A", resolvedAt: 20 });
    // 已经结束的不再改。
    expect(repo.resolve(id, "dismissed", 30)).toBe(false);
    expect(repo.setAnswer(id, "B")).toBe(false);
    expect(repo.get(id)).toMatchObject({ status: "answered", answer: "A", resolvedAt: 20 });
    expect(repo.pendingDecisions()).toEqual([]);
  });

  it("filters decisions and reports by feature or epic; recent reports are newest first and limited", () => {
    const repo = new InboxRepo(memDb());
    const a = repo.addDecision({ ...owner("s1", { featureId: 3, epicId: 2 }), question: "a", options: [], context: null, createdAt: 1 });
    const b = repo.addDecision({ ...owner("s2", { featureId: 4, epicId: 2 }), question: "b", options: [], context: null, createdAt: 2 });
    const c = repo.addDecision({ ...owner("s3", { ticketKey: "X-1" }), question: "c", options: [], context: null, createdAt: 3 });
    expect(repo.get(a)?.options).toEqual([]);
    expect(repo.pendingDecisions({ featureId: 3 }).map((d) => d.id)).toEqual([a]);
    expect(repo.pendingDecisions({ epicId: 2 }).map((d) => d.id)).toEqual([a, b]);
    expect(repo.pendingDecisions().map((d) => d.id)).toEqual([a, b, c]);

    const r1 = repo.addReport({ ...owner("s1", { featureId: 3, epicId: 2 }), text: "p", kind: "progress", status: "dismissed", createdAt: 5 });
    const r2 = repo.addReport({ ...owner("s1", { featureId: 3, epicId: 2 }), text: "d", kind: "done", status: "pending", createdAt: 6 });
    const r3 = repo.addReport({ ...owner("s2", { featureId: 4, epicId: 2 }), text: "b", kind: "blocked", status: "pending", createdAt: 7 });
    expect(repo.get(r1)).toMatchObject({ kind: "report", reportKind: "progress", status: "dismissed", resolvedAt: 5 });
    expect(repo.get(r2)).toMatchObject({ reportKind: "done", status: "pending", resolvedAt: null });
    expect(repo.recentReports({ featureId: 3 }, 10).map((r) => r.id)).toEqual([r2, r1]);
    expect(repo.recentReports({ epicId: 2 }, 2).map((r) => r.id)).toEqual([r3, r2]);
    expect(repo.recentReports(null, 10).map((r) => r.id)).toEqual([r3, r2, r1]);
    expect(repo.pendingReports().map((r) => r.id)).toEqual([r2, r3]);
    // 汇报不算「待你决定」。
    expect(repo.pendingDecisions({ featureId: 3 }).map((d) => d.id)).toEqual([a]);
  });

  it("deleting a session chain removes its items (and only its items)", () => {
    const db = memDb();
    const sessions = new SessionsRepo(db);
    const repo = new InboxRepo(db);
    for (const id of ["a", "b", "other"]) sessions.insertIfAbsent({ id, ticketKey: null, cwd: "/w", origin: "butler", createdAt: 1, lastActivityAt: null });
    sessions.setReplacedBy("a", "b", "clear");
    repo.addDecision({ ...owner("a"), question: "old", options: [], context: null, createdAt: 1 });
    repo.addReport({ ...owner("b"), text: "r", kind: "done", status: "pending", createdAt: 2 });
    const keep = repo.addDecision({ ...owner("other"), question: "keep", options: [], context: null, createdAt: 3 });
    sessions.deleteChain("b");
    expect(repo.pendingDecisions().map((d) => d.id)).toEqual([keep]);
    expect(repo.recentReports(null, 10)).toEqual([]);
  });
});
