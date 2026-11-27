import { describe, expect, it, vi } from "vitest";
import type { Followup } from "../../shared/types";
import { withTransaction } from "../db/database";
import { FollowupsRepo } from "../db/followups-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { insertTicket, memDb } from "../test-utils";
import { closeTicket, reopenTicket, setTicketStatus, type ClosablePr, type LiveSession, type TicketCloseDeps } from "./ticket-close";

const followup = (id: string, o: Partial<Followup> = {}): Followup => ({
  id, ticketKey: "T-1", kind: "doc", description: id, trigger: "none", dueDate: null, status: "open", snoozedUntil: null, source: "session", createdAt: 1, doneAt: null, ...o,
});

function setup(o: { prs?: ClosablePr[]; sessions?: LiveSession[]; closePr?: (pr: ClosablePr) => Promise<void> } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const followups = new FollowupsRepo(db);
  insertTicket(tickets, { key: "T-1", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "blocked", statusManual: null, createdAt: 1, archivedAt: null });
  followups.insert(followup("open"));
  followups.insert(followup("snoozed", { status: "snoozed", snoozedUntil: "2026-12-01" }));
  followups.insert(followup("done", { status: "done", doneAt: 5 }));
  const calls: string[] = [];
  const d: TicketCloseDeps = {
    tickets, followups,
    transaction: (fn) => withTransaction(db, fn),
    openPrs: () => o.prs ?? [],
    closePr: o.closePr ?? (async (pr) => void calls.push(`close ${pr.url}`)),
    liveSessions: () => o.sessions ?? [],
    endSession: (s) => void calls.push(`end ${s.id}`),
    rederive: (k) => void calls.push(`rederive ${k}`),
    refreshPrs: (k) => void calls.push(`refresh ${k}`),
    notify: vi.fn(),
    now: () => 100,
    log: () => {},
  };
  return { d, tickets, followups, calls };
}

describe("closeTicket", () => {
  it("sets the manual status to closed with the reason and source, ignores what is left to do, and notifies", async () => {
    const { d, tickets, followups, calls } = setup();
    const r = await closeTicket(d, "T-1", { reason: "需求变了", source: "coordinator" });
    expect(r).toEqual({ ok: true, ticket: "T-1", ignoredFollowups: 2, closedPrs: [], prErrors: [], endedSessions: [] });
    const t = tickets.get("T-1")!;
    expect(t.statusManual).toBe("closed");
    expect(t.closure).toEqual({ at: 100, reason: "需求变了", source: "coordinator" });
    const byId = Object.fromEntries(followups.listByTicket("T-1").map((f) => [f.id, f]));
    expect(byId.open).toMatchObject({ status: "ignored", resolvedReason: "需求变了", resolvedSource: "coordinator", ignoredByClose: true });
    expect(byId.snoozed).toMatchObject({ status: "ignored", snoozedUntil: null, ignoredByClose: true });
    expect(byId.done).toMatchObject({ status: "done", ignoredByClose: false });
    expect(d.notify).toHaveBeenCalled();
    // 不要求时不关 PR、不结束 session；照样马上重读 PR。
    expect(calls).toEqual(["rederive T-1", "refresh T-1"]);
  });

  it("closes the open PRs and ends the sessions when asked, and reports the PRs it could not close", async () => {
    const prs: ClosablePr[] = [
      { url: "https://github.com/o/r/pull/1", number: 1, slug: "o/r", cwd: "/r" },
      { url: "https://github.com/o/r/pull/2", number: 2, slug: "o/r", cwd: "/r" },
    ];
    const closed: string[] = [];
    const { d, calls } = setup({
      prs,
      sessions: [{ id: "s1", termId: "s1", hibernated: false }, { id: "s2", termId: null, hibernated: true }, { id: "me", termId: "me", hibernated: false }],
      closePr: async (pr) => {
        if (pr.number === 2) throw new Error("gh: not allowed");
        closed.push(pr.url);
      },
    });
    const r = await closeTicket(d, "T-1", { reason: "不做了", source: "user", closePrs: true, endSessions: true, except: "me" });
    expect(r).toMatchObject({ ok: true, closedPrs: ["https://github.com/o/r/pull/1"], prErrors: [{ url: "https://github.com/o/r/pull/2", error: "gh: not allowed" }], endedSessions: ["s1", "s2"] });
    expect(closed).toEqual(["https://github.com/o/r/pull/1"]);
    expect(calls).toEqual(["end s1", "end s2", "rederive T-1", "refresh T-1"]);
  });

  it("refuses an unknown ticket and an empty reason without writing anything", async () => {
    const { d, tickets } = setup();
    expect(await closeTicket(d, "NOPE", { reason: "x", source: "user" })).toEqual({ ok: false, error: "no_ticket" });
    expect(await closeTicket(d, "T-1", { reason: "  ", source: "user" })).toEqual({ ok: false, error: "empty_reason" });
    expect(tickets.get("T-1")?.statusManual).toBeNull();
  });
});

describe("reopenTicket", () => {
  it("undoes the close: back to the automatic status, the followups it ignored come back as they were", async () => {
    const { d, tickets, followups, calls } = setup();
    await closeTicket(d, "T-1", { reason: "需求变了", source: "coordinator" });
    // 关了以后有人手动处理过的那条不还原。
    followups.setStatus("open", "done", 200);
    followups.insert(followup("again"));
    followups.setStatus("again", "ignored", 200);
    calls.length = 0;
    const r = reopenTicket(d, "T-1");
    expect(r).toEqual({ ok: true, ticket: "T-1", restoredFollowups: 1, status: "blocked" });
    const t = tickets.get("T-1")!;
    expect(t.statusManual).toBeNull();
    expect(t.closure).toBeNull();
    const byId = Object.fromEntries(followups.listByTicket("T-1").map((f) => [f.id, f]));
    expect(byId.snoozed).toMatchObject({ status: "snoozed", snoozedUntil: "2026-12-01", ignoredByClose: false, resolvedReason: null });
    expect(byId.open).toMatchObject({ status: "done" });
    expect(byId.again).toMatchObject({ status: "ignored" });
    expect(calls).toEqual(["rederive T-1", "refresh T-1"]);
    expect(d.notify).toHaveBeenCalled();
  });

  it("refuses a ticket that is not closed", () => {
    const { d } = setup();
    expect(reopenTicket(d, "T-1")).toEqual({ ok: false, error: "not_closed" });
    expect(reopenTicket(d, "NOPE")).toEqual({ ok: false, error: "no_ticket" });
  });
});

describe("setTicketStatus (the status menu and set_ticket_status)", () => {
  it("on a closed ticket undoes the close first, then sets the manual status; null only undoes the close", async () => {
    const { d, tickets, followups } = setup();
    await closeTicket(d, "T-1", { reason: "需求变了", source: "user" });
    expect(setTicketStatus(d, "T-1", "in_review")).toEqual({ ok: true, ticket: "T-1", status: "in_review", reopened: true });
    expect(tickets.get("T-1")).toMatchObject({ statusManual: "in_review", closure: null });
    expect(followups.get("open")?.status).toBe("open");
    await closeTicket(d, "T-1", { reason: "又不做了", source: "user" });
    expect(setTicketStatus(d, "T-1", null)).toMatchObject({ ok: true, status: "blocked", reopened: true });
    expect(tickets.get("T-1")?.statusManual).toBeNull();
    expect(setTicketStatus(d, "NOPE", null)).toEqual({ ok: false, error: "no_ticket" });
  });
});
