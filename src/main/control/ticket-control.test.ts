import { describe, expect, it, vi } from "vitest";
import type { TicketStatusControlOp } from "../../shared/control";
import type { Followup } from "../../shared/types";
import { withTransaction } from "../db/database";
import { FeaturesRepo } from "../db/features-repo";
import { FollowupsRepo } from "../db/followups-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { M } from "../strings";
import { insertTicket, memDb } from "../test-utils";
import { closeTicket, reopenTicket, setTicketStatus, type OpenPrs, type TicketCloseDeps } from "../tickets/ticket-close";
import { TicketControl, type TicketControlScope } from "./ticket-control";

const followup = (id: string, ticketKey: string, o: Partial<Followup> = {}): Followup => ({
  id, ticketKey, kind: "doc", description: id, trigger: "none", dueDate: null, status: "open", snoozedUntil: null, source: "session", createdAt: 1, doneAt: null, ...o,
});

function setup(o: { openPrs?: () => OpenPrs; closePr?: TicketCloseDeps["closePr"] } = {}) {
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
  const refreshSources: string[] = [];
  const closeDeps: TicketCloseDeps = {
    tickets, followups, transaction: (fn) => withTransaction(db, fn), openPrs: async () => (o.openPrs ? o.openPrs() : { closable: [], unclosable: [] }), closePr: o.closePr ?? (async () => "closed"), liveSessions: () => [],
    endSession: () => ({ ok: true }), rederive, refreshPrs: (_k, source) => void refreshSources.push(source), notify, now: () => 5, log: () => {},
  };
  const control = new TicketControl({
    tickets, followups, close: (k, o) => closeTicket(closeDeps, k, o), reopen: (k, source) => reopenTicket(closeDeps, k, source),
    setStatus: (k, s, source) => setTicketStatus(closeDeps, k, s, source), rederive, notify, now: () => 5,
  });
  const feature: TicketControlScope = { kind: "feature", featureId: epic };
  const run = (req: TicketStatusControlOp, scope: TicketControlScope = feature, canWrite = true) => control.handle(scope, req, { from: "coord", canWrite });
  return { run, tickets, followups, rederive, feature, refreshSources };
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
    expect(await run({ op: "list_followups", all: true })).toMatchObject({ ok: false });
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

  it("close_ticket on a ticket that is already closed is refused and keeps the first close (BTL-270 review)", async () => {
    const { run, tickets } = setup();
    await run({ op: "close_ticket", ticket: "A-1", reason: "需求变了" });
    // 没要求关 PR（没读）：不说「没有剩下能关的 PR」，说怎么去关。
    expect(await run({ op: "close_ticket", ticket: "A-1", reason: "又关一次" })).toEqual({ v: 1, ok: false, error: M().ctlTicketAlreadyClosedUnchecked("A-1") });
    expect(await run({ op: "set_ticket_status", ticket: "A-1", status: "closed", reason: "再关" })).toEqual({ v: 1, ok: false, error: M().ctlTicketAlreadyClosedUnchecked("A-1") });
    expect(M().ctlTicketAlreadyClosedUnchecked("A-1")).toContain("close_prs");
    expect(M().ctlTicketAlreadyClosedUnchecked("A-1")).not.toContain("没有剩下能关的 PR");
    expect(tickets.get("A-1")?.closure).toEqual({ at: 5, reason: "需求变了", source: "coordinator" });
  });

  it("close_ticket with close_prs on a closed ticket lists the PRs left to name, then closes the named ones and says alreadyClosed (BTL-270 review)", async () => {
    const pr1 = { url: "https://github.com/o/r/pull/1", number: 1, slug: "o/r", cwd: "/r" };
    let left = [pr1];
    const closed: string[] = [];
    const { run, tickets } = setup({
      openPrs: () => ({ closable: left, unclosable: [] }),
      closePr: async (p) => (closed.push(p.url), (left = []), "closed"),
    });
    await run({ op: "close_ticket", ticket: "A-1", reason: "需求变了" });
    expect(await run({ op: "close_ticket", ticket: "A-1", reason: "x", close_prs: true })).toMatchObject({
      ok: true, value: { closed: true, closablePrs: [{ url: pr1.url, number: 1 }], note: M().ctlClosePickPrs(1, 0, true) },
    });
    expect(closed).toEqual([]);
    expect(await run({ op: "close_ticket", ticket: "A-1", reason: "x", close_prs: true, pr_urls: [pr1.url] })).toMatchObject({
      ok: true, value: { status: "closed", alreadyClosed: true, closedPrs: [pr1.url], prErrors: [] },
    });
    expect(closed).toEqual([pr1.url]);
    expect(tickets.get("A-1")?.closure).toMatchObject({ reason: "需求变了" });
    // 没剩下的了：already_closed。
    expect(await run({ op: "close_ticket", ticket: "A-1", reason: "x", close_prs: true })).toEqual({ v: 1, ok: false, error: M().ctlTicketAlreadyClosed("A-1") });
  });

  it("close_ticket lists what was closed and what was not among the named PRs, with a hint per reason; it never says to gh pr close a PR shared with a ticket or not checked", async () => {
    const { run } = setup({
      openPrs: () => ({
        closable: [1, 2].map((n) => ({ url: `https://github.com/o/r/pull/${n}`, number: n, slug: "o/r", cwd: "/r" })),
        unclosable: [
          { url: "https://github.com/o/r/pull/8", number: 8, kind: "shared", ticket: "A-2" }, { url: "https://github.com/o/r/pull/9", number: 9, kind: "not_own_branch" },
          { url: "https://github.com/o/r/pull/7", number: 7, kind: "not_own_branch" },
        ],
      }),
      closePr: async (pr) => {
        if (pr.number === 2) throw new Error("gh: boom");
        return "closed";
      },
    });
    // 没点名的 #7 不报（点名了才算这次要处理的）。
    const r = await run({ op: "close_ticket", ticket: "A-1", reason: "不做了", close_prs: true, pr_urls: [1, 2, 8, 9].map((n) => `https://github.com/o/r/pull/${n}`) });
    expect(r).toMatchObject({
      ok: true,
      value: {
        closedPrs: ["https://github.com/o/r/pull/1"],
        prErrors: [{ url: "https://github.com/o/r/pull/8", kind: "shared", ticket: "A-2" }, { url: "https://github.com/o/r/pull/9", kind: "not_own_branch" }, { url: "https://github.com/o/r/pull/2", kind: "failed" }],
      },
    });
    const note = (r.ok && (r.value as { note: string }).note) || "";
    expect(note).toBe(M().ctlClosePrErrors([{ kind: "shared", ticket: "A-2" }, { kind: "not_own_branch" }, { kind: "failed" }]));
    expect(note).toContain("A-2");
    // 只有 gh 失败的那一类让总控自己 gh pr close；另外两类明确说不要关。
    expect(M().ctlClosePrErrors([{ kind: "shared", ticket: "A-2" }])).not.toContain("gh pr close");
    expect(M().ctlClosePrErrors([{ kind: "not_own_branch" }])).not.toContain("gh pr close");
    expect(M().ctlClosePrErrors([{ kind: "failed" }])).toContain("gh pr close");
    // 核对失败的：明确说不要自己关（还不知道是不是这个 ticket 的），请用户重试。
    expect(M().ctlClosePrErrors([{ kind: "unverified" }])).toContain("不要自己 gh pr close");
  });

  // BTL-270 审查（建议 2）：总控要关 PR 必须点名。
  it("close_ticket with close_prs but no pr_urls does nothing and returns the closable list to pick from", async () => {
    const closed: string[] = [];
    const { run, tickets, followups } = setup({
      openPrs: () => ({
        closable: [{ url: "https://github.com/o/r/pull/1", number: 1, slug: "o/r", cwd: "/r" }],
        unclosable: [{ url: "https://github.com/o/r/pull/9", number: 9, kind: "not_own_branch" }],
      }),
      closePr: async (pr) => (closed.push(pr.url), "closed"),
    });
    const r = await run({ op: "close_ticket", ticket: "A-1", reason: "不做了", close_prs: true, end_sessions: true });
    expect(r).toMatchObject({
      ok: true,
      value: {
        ticket: "A-1", closed: false, status: "merged_pending_followup",
        closablePrs: [{ url: "https://github.com/o/r/pull/1", number: 1 }],
        prErrors: [{ url: "https://github.com/o/r/pull/9", kind: "not_own_branch" }],
        note: M().ctlClosePickPrs(1, 1, false),
      },
    });
    expect(closed).toEqual([]);
    expect(tickets.get("A-1")?.statusManual).toBeNull();
    expect(followups.get("a1")?.status).toBe("open");
    // 带上 pr_urls 再来：只关点名的，ticket 关掉。点名了却不是它开着的 PR：没碰，列在 notOpenPrs。
    const again = await run({
      op: "close_ticket", ticket: "A-1", reason: "不做了", close_prs: true, pr_urls: ["https://github.com/O/R/pull/1/", "https://github.com/o/r/pull/77"],
    });
    expect(again).toMatchObject({ ok: true, value: { status: "closed", closedPrs: ["https://github.com/o/r/pull/1"], notOpenPrs: ["https://github.com/o/r/pull/77"] } });
    expect((again.ok && (again.value as { note: string }).note) || "").toContain(M().ctlCloseNotOpenPrs(1));
    expect(closed).toEqual(["https://github.com/o/r/pull/1"]);
  });

  it("close_ticket without close_prs closes the ticket and no PR", async () => {
    const closed: string[] = [];
    const { run, tickets } = setup({
      openPrs: () => ({ closable: [{ url: "https://github.com/o/r/pull/1", number: 1, slug: "o/r", cwd: "/r" }], unclosable: [] }),
      closePr: async (pr) => (closed.push(pr.url), "closed"),
    });
    expect(await run({ op: "close_ticket", ticket: "A-1", reason: "不做了" })).toMatchObject({ ok: true, value: { status: "closed", closedPrs: [] } });
    expect(tickets.get("A-1")?.statusManual).toBe("closed");
    expect(closed).toEqual([]);
  });

  it("refreshes PRs as the coordinator, so given-up PRs are not forced (BTL-270 review)", async () => {
    const { run, refreshSources } = setup();
    await run({ op: "close_ticket", ticket: "A-1", reason: "不做了" });
    await run({ op: "reopen_ticket", ticket: "A-1" });
    await run({ op: "close_ticket", ticket: "A-1", reason: "还是不做" });
    // 关着的改成别的状态：先撤销关闭，也按总控算。
    await run({ op: "set_ticket_status", ticket: "A-1", status: "blocked" });
    expect(refreshSources).toEqual(["coordinator", "coordinator", "coordinator", "coordinator"]);
  });
});
