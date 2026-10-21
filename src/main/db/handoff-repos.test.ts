import { describe, expect, it } from "vitest";
import type { Followup, Ticket } from "../../shared/types";
import { emptyHandoff } from "../handoff/schema";
import { memDb } from "../test-utils";
import { BriefsRepo } from "./briefs-repo";
import { withTransaction } from "./database";
import { FollowupsRepo } from "./followups-repo";
import { HandoffsRepo } from "./handoffs-repo";
import { JOB_NIGHTLY, JobsRepo } from "./jobs-repo";
import { MarksRepo } from "./marks-repo";
import { MIGRATIONS } from "./migrations";
import { SettingsRepo } from "./settings-repo";
import { TicketsRepo } from "./tickets-repo";

const ticket = (key: string, over: Partial<Ticket> = {}): Ticket => ({
  key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: `feature/${key}`,
  status: "active", statusManual: null, createdAt: 1, archivedAt: null, ...over,
});

const followup = (id: string, over: Partial<Followup> = {}): Followup => ({
  id, ticketKey: "PROJ-1", kind: "config", description: `desc ${id}`, trigger: "after_merge", dueDate: null,
  status: "open", snoozedUntil: null, source: "session", createdAt: 10, doneAt: null, ...over,
});

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  tickets.insert(ticket("PROJ-1"));
  return { db, tickets };
}

describe("migration 2", () => {
  it("brings the schema to the latest version", () => {
    const { db } = setup();
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ["handoffs", "followups", "briefs", "item_marks", "jobs"]) expect(tables).toContain(t);
  });
});

describe("TicketsRepo status times", () => {
  it("moves status_changed_at only when the derived status changes, and records manual changes", () => {
    const { tickets } = setup();
    tickets.setStatus("PROJ-1", "active", 100);
    expect(tickets.statusTimes("PROJ-1").changedAt).toBeNull();
    tickets.setStatus("PROJ-1", "blocked", 200);
    tickets.setStatus("PROJ-1", "blocked", 300);
    expect(tickets.get("PROJ-1")?.status).toBe("blocked");
    expect(tickets.statusTimes("PROJ-1").changedAt).toBe(200);
    tickets.setStatusManual("PROJ-1", "in_review", 400);
    expect(tickets.statusTimes("PROJ-1").manualAt).toBe(400);
    tickets.setStatusManual("PROJ-1", null, 500);
    expect(tickets.statusTimes("PROJ-1")).toEqual({ changedAt: 200, manualAt: null });
  });
});

describe("HandoffsRepo", () => {
  it("appends, finds the latest (valid) one, and ignores a repeated sourceRef", () => {
    const { db } = setup();
    const repo = new HandoffsRepo(db);
    const payload = { ...emptyHandoff("PROJ-1"), next_steps: ["a"] };
    const a = repo.insert({ ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", createdAt: 100, payload, rawText: "{}" });
    const b = repo.insert({ ticketKey: "PROJ-1", sessionId: "s1", trigger: "command", createdAt: 200, payload: null, rawText: "oops", sourceRef: "u1" });
    expect(repo.insert({ ticketKey: "PROJ-1", sessionId: "s1", trigger: "command", createdAt: 300, payload: null, rawText: "oops", sourceRef: "u1" })).toBeNull();
    repo.insert({ ticketKey: "PROJ-1", sessionId: null, trigger: "refresh", createdAt: 400, payload, rawText: null });
    expect(typeof a).toBe("number");
    expect(repo.get(b!)).toMatchObject({ degraded: true, rawText: "oops", sourceRef: "u1", payload: null });
    expect(repo.latest("PROJ-1")?.trigger).toBe("refresh");
    expect(repo.latestValid("PROJ-1")?.createdAt).toBe(400);
    expect(repo.lastCapturedAt("PROJ-1")).toBe(200);
    expect(repo.lastCapturedAt("NOPE-1")).toBeNull();
    expect(repo.listByTicket("PROJ-1").map((h) => h.createdAt)).toEqual([400, 200, 100]);
    expect(repo.listBetween(150, 400).map((h) => h.createdAt)).toEqual([200]);
  });

  it("treats an unreadable payload as degraded", () => {
    const { db } = setup();
    db.prepare(`INSERT INTO handoffs (ticket_key, trigger, created_at, payload, degraded) VALUES ('PROJ-1', 'nightly', 1, '{broken', 0)`).run();
    expect(new HandoffsRepo(db).latest("PROJ-1")).toMatchObject({ payload: null, degraded: true });
  });
});

describe("FollowupsRepo", () => {
  it("inserts, updates, changes status and hides archived tickets", () => {
    const { db, tickets } = setup();
    tickets.insert(ticket("OLD-1"));
    const repo = new FollowupsRepo(db);
    repo.insert(followup("f1"));
    repo.insert(followup("f2", { trigger: "on_date", dueDate: "2026-10-30" }));
    repo.insert(followup("f3", { ticketKey: "OLD-1" }));
    repo.update("f1", { description: "new text", trigger: "none" });
    expect(repo.get("f1")).toMatchObject({ description: "new text", trigger: "none", kind: "config" });
    repo.update("f2", { dueDate: null });
    expect(repo.get("f2")?.dueDate).toBeNull();
    repo.setStatus("f1", "done", 50);
    expect(repo.get("f1")).toMatchObject({ status: "done", doneAt: 50 });
    repo.setStatus("f1", "snoozed", 60, "2026-10-22");
    expect(repo.get("f1")).toMatchObject({ status: "snoozed", doneAt: null, snoozedUntil: "2026-10-22" });
    expect(repo.listByTicket("PROJ-1").map((f) => f.id)).toEqual(["f1", "f2"]);
    tickets.archive("OLD-1", 5);
    expect(repo.listActiveTickets().map((f) => f.id)).toEqual(["f1", "f2"]);
  });
});

describe("BriefsRepo / MarksRepo / JobsRepo / SettingsRepo", () => {
  it("round-trips a brief and returns the latest of a kind", () => {
    const { db } = setup();
    const repo = new BriefsRepo(db);
    const content = { items: [], previousDay: { date: "2026-10-20", entries: [{ ticketKey: "PROJ-1", done: ["x"] }] }, evening: [], notices: { degraded: [], trackerUnavailable: ["PROJ-1"] } };
    repo.insert({ kind: "morning", date: "2026-10-20", createdAt: 1, content, narrative: null, narrativeStatus: "off" });
    const second = repo.insert({ kind: "morning", date: "2026-10-21", createdAt: 2, content, narrative: null, narrativeStatus: "off" });
    expect(repo.latest("morning")).toEqual(second);
    expect(second).toMatchObject({ kind: "morning", date: "2026-10-21", narrative: null, narrativeStatus: "off", notices: { trackerUnavailable: ["PROJ-1"] } });
    expect(repo.latest("evening")).toBeNull();
  });

  it("upserts item marks", () => {
    const repo = new MarksRepo(memDb());
    repo.set("next:PROJ-1:3", "snoozed", "2026-10-22", 1);
    repo.set("next:PROJ-1:3", "done", null, 2);
    expect(repo.all().get("next:PROJ-1:3")).toEqual({ mark: "done", untilDate: null });
  });

  it("records jobs", () => {
    const repo = new JobsRepo(memDb());
    expect(repo.get(JOB_NIGHTLY)).toEqual({ lastRunAt: null, lastStatus: null, lastError: null });
    repo.record(JOB_NIGHTLY, 5, "partial", "429");
    repo.record(JOB_NIGHTLY, 6, "ok", null);
    expect(repo.get(JOB_NIGHTLY)).toEqual({ lastRunAt: 6, lastStatus: "ok", lastError: null });
  });

  it("has schedule defaults and resets overrides", () => {
    const repo = new SettingsRepo(memDb());
    expect(repo.get("nightlyTime")).toBe("16:00");
    expect(repo.get("workingDays")).toBe("1,2,3,4,5");
    repo.set("nightlyTime", "18:30");
    repo.reset("nightlyTime");
    expect(repo.get("nightlyTime")).toBe("16:00");
  });
});

describe("withTransaction", () => {
  it("rolls back everything when the callback throws", () => {
    const { db, tickets } = setup();
    expect(() =>
      withTransaction(db, () => {
        tickets.insert(ticket("PROJ-2"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(tickets.get("PROJ-2")).toBeNull();
    expect(withTransaction(db, () => 7)).toBe(7);
  });

  it("is re-entrant: a nested call (e.g. SessionsRepo.delete) joins the outer transaction", () => {
    const { db, tickets } = setup();
    expect(() =>
      withTransaction(db, () => {
        tickets.insert(ticket("PROJ-3"));
        expect(withTransaction(db, () => 1)).toBe(1);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(tickets.get("PROJ-3")).toBeNull();
  });
});
