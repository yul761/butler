import { describe, expect, it, vi } from "vitest";
import type { TicketStatusControlOp } from "../../shared/control";
import type { Followup } from "../../shared/types";
import { withTransaction } from "../db/database";
import { FeaturesRepo } from "../db/features-repo";
import { FollowupsRepo } from "../db/followups-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { insertTicket, memDb } from "../test-utils";
import { closeTicket, reopenTicket, setTicketStatus, type TicketCloseDeps } from "../tickets/ticket-close";
import { TicketControl, type TicketControlScope } from "./ticket-control";

const followup = (id: string, ticketKey: string, o: Partial<Followup> = {}): Followup => ({
  id, ticketKey, kind: "doc", description: id, trigger: "none", dueDate: null, status: "open", snoozedUntil: null, source: "session", createdAt: 1, doneAt: null, ...o,
});

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const followups = new FollowupsRepo(db);
  const features = new FeaturesRepo(db);
  const epic = features.insert({ name: "e", workspaceDir: "/w", createdAt: 1 });
  const other = features.insert({ name: "o", workspaceDir: "/o", createdAt: 1 });
  const t = (key: string, featureId: number | null) =>
    insertTicket(tickets, { key, title: key, repoPath: "/r", workMode: "branch", worktreePath: null, branch: key, status: "merged_pending_followup", statusManual: null, createdAt: 1, archivedAt: null, featureId });
  t("A-1", epic);
  t("A-2", epic);
  t("B-1", other);
  followups.insert(followup("a1", "A-1"));
  followups.insert(followup("a1done", "A-1", { status: "done", doneAt: 2 }));
  followups.insert(followup("b1", "B-1"));
  const rederive = vi.fn((key: string) => {
    const open = followups.listByTicket(key).filter((f) => f.status === "open" || f.status === "snoozed").length;
    tickets.setStatus(key, open > 0 ? "merged_pending_followup" : "done", 9);
  });
  const notify = vi.fn();
  const closeDeps: TicketCloseDeps = {
    tickets, followups, transaction: (fn) => withTransaction(db, fn), openPrs: () => [], closePr: async () => {}, liveSessions: () => [],
    endSession: () => {}, rederive, refreshPrs: () => {}, notify, now: () => 5, log: () => {},
  };
  const control = new TicketControl({
    tickets, followups, close: (k, o) => closeTicket(closeDeps, k, o), reopen: (k) => reopenTicket(closeDeps, k),
    setStatus: (k, s) => setTicketStatus(closeDeps, k, s), rederive, notify, now: () => 5,
  });
  const feature: TicketControlScope = { kind: "feature", featureId: epic };
  const run = (req: TicketStatusControlOp, scope: TicketControlScope = feature, canWrite = true) => control.handle(scope, req, { from: "coord", canWrite });
  return { run, tickets, followups, rederive, feature };
}

describe("TicketControl (BTL-270)", () => {
  it("lists the unfinished followups of the epic's tickets only; the Shipherd coordinator sees every ticket", async () => {
    const { run } = setup();
    expect(await run({ op: "list_followups" })).toEqual({
      v: 1, ok: true,
      value: [{ ticket: "A-1", title: "A-1", status: "merged_pending_followup", followups: [expect.objectContaining({ id: "a1", status: "open" })] }],
    });
    const all = await run({ op: "list_followups" }, { kind: "shipherd" });
    expect(all.ok && (all.value as { ticket: string }[]).map((g) => g.ticket)).toEqual(["A-1", "B-1"]);
    const one = await run({ op: "list_followups", ticket: "a-1", all: true });
    expect(one.ok && (one.value as { followups: { id: string }[] }[])[0].followups.map((f) => f.id)).toEqual(["a1", "a1done"]);
  });

  it("resolve_followup marks it, records the reason, and the ticket gets out of merged_pending_followup", async () => {
    const { run, followups, tickets } = setup();
    const r = await run({ op: "resolve_followup", followup: "a1", status: "ignored", reason: "只是约定，不用做" });
    expect(r).toEqual({ v: 1, ok: true, value: { followup: "a1", ticket: "A-1", status: "ignored", ticketStatus: "done" } });
    expect(followups.get("a1")).toMatchObject({ status: "ignored", resolvedReason: "只是约定，不用做", resolvedSource: "coordinator" });
    expect(tickets.get("A-1")?.status).toBe("done");
  });

  it("does not let an epic coordinator touch another epic's ticket or followup", async () => {
    const { run, followups } = setup();
    expect(await run({ op: "resolve_followup", followup: "b1", status: "done", reason: "r" })).toMatchObject({ ok: false });
    expect(await run({ op: "close_ticket", ticket: "B-1", reason: "r" })).toMatchObject({ ok: false });
    expect(followups.get("b1")?.status).toBe("open");
  });

  it("refuses writes when the caller is not an open coordinator, but still lists", async () => {
    const { run, tickets } = setup();
    expect(await run({ op: "close_ticket", ticket: "A-1", reason: "r" }, undefined, false)).toMatchObject({ ok: false });
    expect(await run({ op: "resolve_followup", followup: "a1", status: "done", reason: "r" }, undefined, false)).toMatchObject({ ok: false });
    expect(tickets.get("A-1")?.statusManual).toBeNull();
    expect(await run({ op: "list_followups" }, undefined, false)).toMatchObject({ ok: true });
  });

  it("close_ticket and reopen_ticket from either coordinator", async () => {
    const { run, tickets, followups } = setup();
    expect(await run({ op: "close_ticket", ticket: "A-1", reason: "需求变了" }, { kind: "shipherd" })).toMatchObject({ ok: true, value: { status: "closed", ignoredFollowups: 1 } });
    expect(tickets.get("A-1")?.closure).toEqual({ at: 5, reason: "需求变了", source: "coordinator" });
    expect(await run({ op: "reopen_ticket", ticket: "A-1" })).toMatchObject({ ok: true, value: { restoredFollowups: 1, status: "merged_pending_followup" } });
    expect(followups.get("a1")?.status).toBe("open");
    expect(await run({ op: "reopen_ticket", ticket: "A-1" })).toMatchObject({ ok: false });
  });

  it("set_ticket_status: closed goes through closeTicket, another status on a closed ticket reopens it first, auto clears the manual status", async () => {
    const { run, tickets, followups } = setup();
    await run({ op: "set_ticket_status", ticket: "A-1", status: "closed", reason: "不做了" });
    expect(tickets.get("A-1")).toMatchObject({ statusManual: "closed", closure: { reason: "不做了" } });
    expect(followups.get("a1")?.status).toBe("ignored");
    expect(await run({ op: "set_ticket_status", ticket: "A-1", status: "blocked" })).toMatchObject({ ok: true, value: { status: "blocked", manual: true } });
    expect(tickets.get("A-1")).toMatchObject({ statusManual: "blocked", closure: null });
    expect(followups.get("a1")?.status).toBe("open");
    expect(await run({ op: "set_ticket_status", ticket: "A-1", status: "auto" })).toMatchObject({ ok: true, value: { status: "merged_pending_followup", manual: false } });
    expect(tickets.get("A-1")?.statusManual).toBeNull();
  });
});
