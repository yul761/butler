import { describe, expect, it, vi } from "vitest";
import type { Followup } from "../../shared/types";
import { withTransaction } from "../db/database";
import { FollowupsRepo } from "../db/followups-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { insertTicket, memDb } from "../test-utils";
import { M } from "../strings";
import { classifyOpenPrs, closePreview, closeTicket, prRefreshOptions, reopenTicket, retryClose, setTicketStatus, type ClosablePr, type LiveSession, type OpenPrRow, type OpenPrs, type TicketCloseDeps } from "./ticket-close";

const followup = (id: string, o: Partial<Followup> = {}): Followup => ({
  id, ticketKey: "T-1", kind: "doc", description: id, trigger: "none", dueDate: null, status: "open", snoozedUntil: null, source: "session", createdAt: 1, doneAt: null, ...o,
});

function setup(o: { prs?: ClosablePr[]; unclosable?: OpenPrs["unclosable"]; openPrs?: TicketCloseDeps["openPrs"]; sessions?: LiveSession[]; closePr?: TicketCloseDeps["closePr"]; endSession?: TicketCloseDeps["endSession"] } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const followups = new FollowupsRepo(db);
  insertTicket(tickets, { key: "T-1", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "blocked", statusManual: null, createdAt: 1, archivedAt: null });
  followups.insert(followup("open"));
  followups.insert(followup("snoozed", { status: "snoozed", snoozedUntil: "2026-12-01" }));
  followups.insert(followup("done", { status: "done", doneAt: 5 }));
  const calls: string[] = [];
  const refreshSources: string[] = [];
  const d: TicketCloseDeps = {
    tickets, followups,
    transaction: (fn) => withTransaction(db, fn),
    openPrs: o.openPrs ?? (async () => ({ closable: o.prs ?? [], unclosable: o.unclosable ?? [] })),
    closePr: o.closePr ?? (async (pr) => (calls.push(`close ${pr.url}`), "closed")),
    liveSessions: () => o.sessions ?? [],
    endSession: o.endSession ?? ((s) => (calls.push(`end ${s.id}`), { ok: true })),
    rederive: (k) => void calls.push(`rederive ${k}`),
    refreshPrs: (k, source) => {
      calls.push(`refresh ${k}`);
      refreshSources.push(source);
    },
    notify: vi.fn(),
    now: () => 100,
    log: () => {},
  };
  return { d, tickets, followups, calls, refreshSources };
}

describe("closeTicket", () => {
  it("sets the manual status to closed with the reason and source, ignores what is left to do, and notifies", async () => {
    const { d, tickets, followups, calls } = setup();
    const r = await closeTicket(d, "T-1", { reason: "需求变了", source: "coordinator" });
    expect(r).toEqual({ ok: true, ticket: "T-1", ignoredFollowups: 2, closedPrs: [], prErrors: [], endedSessions: [], sessionErrors: [], reopenedMeanwhile: false });
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

  it("closes the open PRs and ends the sessions when asked, and reports every PR and session it could not close or end", async () => {
    const prs: ClosablePr[] = [
      { url: "https://github.com/o/r/pull/1", number: 1, slug: "o/r", cwd: "/r" },
      { url: "https://github.com/o/r/pull/2", number: 2, slug: "o/r", cwd: "/r" },
    ];
    const closed: string[] = [];
    prs.push({ url: "https://github.com/o/r/pull/3", number: 3, slug: "o/r", cwd: "/r" });
    const sources: string[] = [];
    const { d, calls } = setup({
      prs,
      unclosable: [{ url: "https://github.com/o/r/pull/9", number: 9, kind: "never_read" }],
      sessions: [{ id: "s1", termId: "s1", hibernated: false }, { id: "s2", termId: null, hibernated: true }, { id: "busy", termId: "busy", hibernated: false }, { id: "me", termId: "me", hibernated: false }],
      closePr: async (pr, _reason, o) => {
        sources.push(`${o.key}:${o.source}`);
        if (pr.number === 2) throw new Error("gh: not allowed");
        if (pr.number === 3) return "skipped";
        closed.push(pr.url);
        return "closed";
      },
      endSession: (s) => (s.id === "busy" ? { ok: false, error: "working" } : (calls.push(`end ${s.id}`), { ok: true })),
    });
    const r = await closeTicket(d, "T-1", { reason: "不做了", source: "user", closePrs: true, endSessions: true, except: "me" });
    expect(r).toMatchObject({
      ok: true, closedPrs: ["https://github.com/o/r/pull/1"],
      prErrors: [
        { url: "https://github.com/o/r/pull/9", error: M().ticketClosePrWhy("never_read", null), kind: "never_read" },
        { url: "https://github.com/o/r/pull/2", error: "gh: not allowed", kind: "failed" },
        { url: "https://github.com/o/r/pull/3", kind: "skipped" },
      ],
      endedSessions: ["s1", "s2"], sessionErrors: [{ id: "busy", error: "working" }], reopenedMeanwhile: false,
    });
    expect(closed).toEqual(["https://github.com/o/r/pull/1"]);
    expect(sources).toEqual(["T-1:user", "T-1:user", "T-1:user"]);
    expect(calls).toEqual(["end s1", "end s2", "rederive T-1", "refresh T-1"]);
  });

  it("stops closing PRs and does not end sessions when the ticket is reopened while gh is running", async () => {
    const prs: ClosablePr[] = [1, 2].map((n) => ({ url: `https://github.com/o/r/pull/${n}`, number: n, slug: "o/r", cwd: "/r" }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const closed: number[] = [];
    const { d, calls, tickets } = setup({
      prs,
      sessions: [{ id: "s1", termId: "s1", hibernated: false }],
      closePr: async (pr) => {
        await gate;
        closed.push(pr.number);
        return "closed";
      },
    });
    const pending = closeTicket(d, "T-1", { reason: "不做了", source: "coordinator", closePrs: true, prUrls: prs.map((p) => p.url), endSessions: true });
    await Promise.resolve();
    // gh 还在跑：用户点了重新打开。
    expect(reopenTicket(d, "T-1", "user")).toMatchObject({ ok: true });
    calls.length = 0;
    release();
    const r = await pending;
    expect(r).toMatchObject({ ok: true, closedPrs: ["https://github.com/o/r/pull/1"], endedSessions: [], reopenedMeanwhile: true });
    expect(closed).toEqual([1]);
    expect(calls).toEqual(["refresh T-1"]);
    expect(tickets.get("T-1")?.statusManual).toBeNull();
  });

  it("refuses a closed ticket when asked for nothing more, and keeps the first close's time, reason and source (BTL-270 review)", async () => {
    const { d, tickets, calls } = setup({ prs: [{ url: "https://github.com/o/r/pull/1", number: 1, slug: "o/r", cwd: "/r" }] });
    await closeTicket(d, "T-1", { reason: "需求变了", source: "user" });
    calls.length = 0;
    expect(await closeTicket(d, "T-1", { reason: "又说一遍", source: "coordinator" })).toEqual({ ok: false, error: "already_closed", checkedPrs: false });
    expect(tickets.get("T-1")!.closure).toEqual({ at: 100, reason: "需求变了", source: "user" });
    expect(calls).toEqual([]);
  });

  it("closes only the PRs ticked in the dialog and reports only those: unticked PRs it can't close are not leftovers (BTL-270 review)", async () => {
    const prs: ClosablePr[] = [1, 2].map((n) => ({ url: `https://github.com/o/r/pull/${n}`, number: n, slug: "o/r", cwd: "/r" }));
    const { d, calls } = setup({ prs, unclosable: [{ url: "https://github.com/o/r/pull/9", number: 9, kind: "not_own_branch" }] });
    const r = await closeTicket(d, "T-1", { reason: "不做了", source: "user", closePrs: true, prUrls: ["https://github.com/O/R/pull/2/"] });
    expect(r).toMatchObject({ ok: true, closedPrs: ["https://github.com/o/r/pull/2"], prErrors: [] });
    expect(calls).toEqual(["close https://github.com/o/r/pull/2", "rederive T-1", "refresh T-1"]);
  });

  it("a ticked PR that can't be closed by the time it is closed (became shared, or its head check failed) is still reported", async () => {
    const { d } = setup({
      prs: [],
      unclosable: [
        { url: "https://github.com/o/r/pull/2", number: 2, kind: "shared", ticket: "T-2" },
        { url: "https://github.com/o/r/pull/3", number: 3, kind: "unverified", error: "关之前核对 PR 失败" },
        { url: "https://github.com/o/r/pull/9", number: 9, kind: "not_own_branch" },
      ],
    });
    const r = await closeTicket(d, "T-1", { reason: "不做了", source: "user", closePrs: true, prUrls: ["https://github.com/o/r/pull/2", "https://github.com/o/r/pull/3"] });
    expect(r).toMatchObject({ ok: true, closedPrs: [], prErrors: [
      { url: "https://github.com/o/r/pull/2", kind: "shared", ticket: "T-2", error: M().ticketClosePrWhy("shared", "T-2") },
      { url: "https://github.com/o/r/pull/3", kind: "unverified", error: "关之前核对 PR 失败" },
    ] });
  });

  it("a coordinator or routing close with nothing it could name closes the ticket at once and lists the PRs it can't close, reading them once (BTL-270 review)", async () => {
    for (const source of ["coordinator", "routing"] as const) {
      const { d, tickets, calls } = setup({ prs: [], unclosable: [{ url: "https://github.com/o/r/pull/9", number: 9, kind: "given_up" }] });
      const reads = vi.spyOn(d, "openPrs");
      const r = await closeTicket(d, "T-1", { reason: "不做了", source, closePrs: true });
      expect(r).toMatchObject({ ok: true, closedPrs: [], prErrors: [{ url: "https://github.com/o/r/pull/9", kind: "given_up" }] });
      expect(tickets.get("T-1")?.statusManual).toBe("closed");
      expect(calls.filter((c) => c.startsWith("close "))).toEqual([]);
      expect(reads).toHaveBeenCalledTimes(1);
    }
    // 只有核对失败（可以重试、能点名）的：还是先回清单，让它点名。
    const { d, tickets } = setup({ prs: [], unclosable: [{ url: "https://github.com/o/r/pull/3", number: 3, kind: "unverified", error: "e" }] });
    expect(await closeTicket(d, "T-1", { reason: "不做了", source: "coordinator", closePrs: true })).toMatchObject({ ok: false, error: "pick_prs", closable: [] });
    expect(tickets.get("T-1")?.statusManual).toBeNull();
  });

  it("a coordinator or routing close asking to close PRs without naming them does nothing and returns what could be closed (BTL-270 review)", async () => {
    for (const source of ["coordinator", "routing"] as const) {
      const prs: ClosablePr[] = [{ url: "https://github.com/o/r/pull/1", number: 1, slug: "o/r", cwd: "/r" }];
      const { d, tickets, followups, calls } = setup({ prs, unclosable: [{ url: "https://github.com/o/r/pull/9", number: 9, kind: "given_up" }], sessions: [{ id: "s1", termId: "s1", hibernated: false }] });
      const r = await closeTicket(d, "T-1", { reason: "不做了", source, closePrs: true, endSessions: true });
      expect(r).toEqual({
        ok: false, error: "pick_prs", ticket: "T-1", closable: [{ url: "https://github.com/o/r/pull/1", number: 1 }],
        prErrors: [{ url: "https://github.com/o/r/pull/9", kind: "given_up", error: M().ticketClosePrWhy("given_up", null) }], alreadyClosed: false,
      });
      expect(calls).toEqual([]);
      expect(tickets.get("T-1")?.statusManual).toBeNull();
      expect(followups.get("open")?.status).toBe("open");
    }
    // 用户（关闭框）不点名就是能关的全部。
    const { d, calls } = setup({ prs: [{ url: "https://github.com/o/r/pull/1", number: 1, slug: "o/r", cwd: "/r" }] });
    expect(await closeTicket(d, "T-1", { reason: "不做了", source: "user", closePrs: true })).toMatchObject({ ok: true, closedPrs: ["https://github.com/o/r/pull/1"] });
    expect(calls[0]).toBe("close https://github.com/o/r/pull/1");
  });

  it("with nothing ticked (prUrls empty) closes no PR and reports none", async () => {
    const prs: ClosablePr[] = [{ url: "https://github.com/o/r/pull/1", number: 1, slug: "o/r", cwd: "/r" }];
    const { d, calls } = setup({ prs, unclosable: [{ url: "https://github.com/o/r/pull/9", number: 9, kind: "shared" }] });
    const r = await closeTicket(d, "T-1", { reason: "不做了", source: "user", closePrs: true, prUrls: [] });
    expect(r).toMatchObject({ ok: true, closedPrs: [], prErrors: [] });
    expect(calls.filter((c) => c.startsWith("close "))).toEqual([]);
  });

  it("passes who closed, reopened or set the status on to the PR refresh, so only the user forces given-up PRs (BTL-270 review)", async () => {
    const { d, refreshSources } = setup();
    await closeTicket(d, "T-1", { reason: "不做了", source: "coordinator" });
    reopenTicket(d, "T-1", "routing");
    await closeTicket(d, "T-1", { reason: "还是不做", source: "routing" });
    // 关着的改状态先撤销关闭：照样按改状态的人算。
    setTicketStatus(d, "T-1", "in_review", "user");
    expect(refreshSources).toEqual(["coordinator", "routing", "routing", "user"]);
  });

  it("refuses an unknown ticket and an empty reason without writing anything", async () => {
    const { d, tickets } = setup();
    expect(await closeTicket(d, "NOPE", { reason: "x", source: "user" })).toEqual({ ok: false, error: "no_ticket" });
    expect(await closeTicket(d, "T-1", { reason: "  ", source: "user" })).toEqual({ ok: false, error: "empty_reason" });
    expect(tickets.get("T-1")?.statusManual).toBeNull();
  });
});

describe("closeTicket on a ticket that is already closed (closing the PRs left over, BTL-270 review)", () => {
  const pr = (n: number): ClosablePr => ({ url: `https://github.com/o/r/pull/${n}`, number: n, slug: "o/r", cwd: "/r" });

  it("a coordinator asking again without naming PRs gets the list to name, with alreadyClosed; nothing is touched", async () => {
    const { d, tickets, calls } = setup({ prs: [pr(1)], unclosable: [{ url: pr(3).url, number: 3, kind: "unverified", error: "e" }] });
    await closeTicket(d, "T-1", { reason: "需求变了", source: "user" });
    calls.length = 0;
    const r = await closeTicket(d, "T-1", { reason: "再关一次", source: "coordinator", closePrs: true });
    expect(r).toEqual({
      ok: false, error: "pick_prs", ticket: "T-1", closable: [{ url: pr(1).url, number: 1 }], prErrors: [{ url: pr(3).url, kind: "unverified", error: "e" }], alreadyClosed: true,
    });
    expect(calls).toEqual([]);
    expect(tickets.get("T-1")!.closure).toEqual({ at: 100, reason: "需求变了", source: "user" });
  });

  it("closing named leftovers succeeds: only the named ones are read and checked, the comment carries the first reason, the close itself is unchanged", async () => {
    const reasons: string[] = [];
    const asked: (string[] | undefined)[] = [];
    let first = true;
    const { d, tickets, calls } = setup({
      openPrs: async (_key, only) => {
        asked.push(only && [...only]);
        // 第一次关时 PR 2 的核对失败了；这次核对上了。
        const all = first ? { closable: [pr(1)], unclosable: [{ url: pr(2).url, number: 2, kind: "unverified" as const, error: "timeout" }] } : { closable: [pr(1), pr(2)], unclosable: [] };
        return { closable: all.closable.filter((p) => !only || only.has(p.url)), unclosable: all.unclosable.filter((p) => !only || only.has(p.url)) };
      },
      closePr: async (p, reason) => (reasons.push(reason), calls.push(`close ${p.number}`), "closed"),
    });
    const r1 = await closeTicket(d, "T-1", { reason: "需求变了", source: "coordinator", closePrs: true, prUrls: [pr(1).url, pr(2).url] });
    expect(r1).toMatchObject({ ok: true, closedPrs: [pr(1).url], prErrors: [{ url: pr(2).url, kind: "unverified" }] });
    first = false;
    calls.length = 0;
    reasons.length = 0;
    const r2 = await closeTicket(d, "T-1", { reason: "再试一次", source: "coordinator", closePrs: true, prUrls: [pr(2).url] });
    expect(r2).toEqual({ ok: true, ticket: "T-1", ignoredFollowups: 0, closedPrs: [pr(2).url], prErrors: [], endedSessions: [], sessionErrors: [], reopenedMeanwhile: false, alreadyClosed: true });
    expect(asked.at(-1)).toEqual([pr(2).url]);
    expect(calls).toEqual(["close 2", "rederive T-1", "refresh T-1"]);
    expect(reasons).toEqual(["需求变了"]);
    expect(tickets.get("T-1")!.closure).toEqual({ at: 100, reason: "需求变了", source: "coordinator" });
  });

  it("a named leftover whose check fails again is reported as unverified again and not closed", async () => {
    const { d, calls } = setup({ prs: [], unclosable: [{ url: pr(2).url, number: 2, kind: "unverified", error: "timeout" }] });
    await closeTicket(d, "T-1", { reason: "需求变了", source: "user" });
    calls.length = 0;
    const r = await closeTicket(d, "T-1", { reason: "x", source: "coordinator", closePrs: true, prUrls: [pr(2).url] });
    expect(r).toMatchObject({ ok: true, alreadyClosed: true, closedPrs: [], prErrors: [{ url: pr(2).url, kind: "unverified", error: "timeout" }] });
    expect(calls.filter((c) => c.startsWith("close "))).toEqual([]);
  });

  it("with no PR left that can be closed (none open, or only ones that can't be closed) it is already_closed, for every source", async () => {
    for (const unclosable of [[], [{ url: pr(8).url, number: 8, kind: "shared" as const, ticket: "T-2" }]]) {
      for (const source of ["user", "coordinator", "routing"] as const) {
        const { d, calls } = setup({ prs: [], unclosable });
        await closeTicket(d, "T-1", { reason: "需求变了", source: "user" });
        calls.length = 0;
        expect(await closeTicket(d, "T-1", { reason: "x", source, closePrs: true })).toEqual({ ok: false, error: "already_closed", checkedPrs: true });
        expect(calls).toEqual([]);
      }
    }
  });

  it("named PRs that can't be closed come back as ok with why in prErrors, as on the first close; not already_closed (BTL-270 review)", async () => {
    const unclosable = [
      { url: pr(4).url, number: 4, kind: "not_own_branch" as const },
      { url: pr(5).url, number: 5, kind: "shared_branch" as const, ticket: "T-2" },
    ];
    const { d, calls } = setup({ prs: [], unclosable });
    await closeTicket(d, "T-1", { reason: "需求变了", source: "user" });
    calls.length = 0;
    for (const source of ["coordinator", "user"] as const) {
      const r = await closeTicket(d, "T-1", { reason: "x", source, closePrs: true, prUrls: [pr(4).url, pr(5).url] });
      expect(r).toEqual({
        ok: true, ticket: "T-1", ignoredFollowups: 0, closedPrs: [], endedSessions: [], sessionErrors: [], reopenedMeanwhile: false, alreadyClosed: true,
        prErrors: [
          { url: pr(4).url, kind: "not_own_branch", error: M().ticketClosePrWhy("not_own_branch", null) },
          { url: pr(5).url, kind: "shared_branch", ticket: "T-2", error: M().ticketClosePrWhy("shared_branch", "T-2") },
        ],
      });
    }
    expect(calls.filter((c) => c.startsWith("close "))).toEqual([]);
  });

  it("reopened while its PRs are read: closes nothing, ends nothing, says reopenedMeanwhile instead of asking to name PRs (BTL-270 review)", async () => {
    const ref: { tickets?: TicketsRepo; d?: TicketCloseDeps } = {};
    const { d, tickets, calls } = setup({
      openPrs: async () => {
        if (ref.tickets!.get("T-1")?.statusManual === "closed") reopenTicket(ref.d!, "T-1", "user");
        return { closable: [pr(1)], unclosable: [] };
      },
      sessions: [{ id: "s1", termId: "s1", hibernated: false }],
    });
    ref.tickets = tickets;
    ref.d = d;
    tickets.close("T-1", { at: 50, reason: "需求变了", source: "user" });
    for (const o of [{ source: "coordinator" as const }, { source: "coordinator" as const, prUrls: [pr(1).url] }, { source: "user" as const, prUrls: [pr(1).url], endSessions: true }]) {
      if (tickets.get("T-1")?.statusManual !== "closed") tickets.close("T-1", { at: 50, reason: "需求变了", source: "user" });
      calls.length = 0;
      const r = await closeTicket(d, "T-1", { reason: "x", closePrs: true, ...o });
      expect(r).toEqual({ ok: true, ticket: "T-1", ignoredFollowups: 0, closedPrs: [], prErrors: [], endedSessions: [], sessionErrors: [], reopenedMeanwhile: true, alreadyClosed: true });
      expect(calls.filter((c) => c.startsWith("close ") || c.startsWith("end "))).toEqual([]);
    }
  });

  it("the user's close dialog on a ticket a coordinator closed meanwhile closes the ticked PRs with the reason the user wrote; the close keeps the coordinator's reason", async () => {
    const reasons: string[] = [];
    const { d, tickets } = setup({ prs: [pr(1)], closePr: async (_p, reason) => (reasons.push(reason), "closed") });
    tickets.close("T-1", { at: 50, reason: "总控先关了", source: "coordinator" });
    const r = await closeTicket(d, "T-1", { reason: "我这边也不做了", source: "user", closePrs: true, prUrls: [pr(1).url] });
    expect(r).toMatchObject({ ok: true, alreadyClosed: true, closedPrs: [pr(1).url] });
    expect(reasons).toEqual(["我这边也不做了"]);
    expect(tickets.get("T-1")!.closure).toEqual({ at: 50, reason: "总控先关了", source: "coordinator" });
  });

  it("end_sessions on a closed ticket ends the sessions still left, even with no PR to close", async () => {
    const { d, calls } = setup({ sessions: [{ id: "s1", termId: "s1", hibernated: false }] });
    await closeTicket(d, "T-1", { reason: "需求变了", source: "user" });
    calls.length = 0;
    const r = await closeTicket(d, "T-1", { reason: "x", source: "coordinator", closePrs: true, endSessions: true });
    expect(r).toMatchObject({ ok: true, alreadyClosed: true, closedPrs: [], endedSessions: ["s1"] });
    expect(calls).toEqual(["end s1", "rederive T-1", "refresh T-1"]);
  });

  it("a ticket closed by someone else while the coordinator's first read runs is treated as closed: nothing is closed twice", async () => {
    const ref: { tickets?: TicketsRepo } = {};
    const { d, tickets: t, followups } = setup({
      openPrs: async () => {
        if (ref.tickets!.get("T-1")?.statusManual !== "closed") ref.tickets!.close("T-1", { at: 50, reason: "用户先关了", source: "user" });
        return { closable: [], unclosable: [] };
      },
    });
    ref.tickets = t;
    expect(await closeTicket(d, "T-1", { reason: "不做了", source: "coordinator", closePrs: true })).toEqual({ ok: false, error: "already_closed", checkedPrs: true });
    expect(t.get("T-1")!.closure).toEqual({ at: 50, reason: "用户先关了", source: "user" });
    // 没走第二次关闭：后续事项没被这次忽略。
    expect(followups.get("open")?.status).toBe("open");
  });
});

describe("retryClose (the close dialog's retry)", () => {
  it("tries again only the PRs and sessions it is given, with the reason the ticket was closed with", async () => {
    const prs: ClosablePr[] = [1, 2, 3].map((n) => ({ url: `https://github.com/o/r/pull/${n}`, number: n, slug: "o/r", cwd: "/r" }));
    const reasons: string[] = [];
    let fail = true;
    const { d, calls } = setup({
      prs,
      sessions: [{ id: "s1", termId: "s1", hibernated: false }, { id: "busy", termId: "busy", hibernated: false }],
      closePr: async (pr, reason) => {
        reasons.push(reason);
        if (pr.number === 2 && fail) throw new Error("gh: timeout");
        calls.push(`close ${pr.number}`);
        return "closed";
      },
      endSession: (s) => (s.id === "busy" && fail ? { ok: false, error: "working" } : (calls.push(`end ${s.id}`), { ok: true })),
    });
    const first = await closeTicket(d, "T-1", { reason: "需求变了", source: "user", closePrs: true, endSessions: true });
    expect(first).toMatchObject({ prErrors: [{ url: "https://github.com/o/r/pull/2", kind: "failed" }], sessionErrors: [{ id: "busy" }] });
    calls.length = 0;
    reasons.length = 0;
    fail = false;
    const r = await retryClose(d, "T-1", { source: "user", prUrls: ["https://github.com/o/r/pull/2"], sessionIds: ["busy"] });
    expect(r).toEqual({ ok: true, ticket: "T-1", closedPrs: ["https://github.com/o/r/pull/2"], prErrors: [], endedSessions: ["busy"], sessionErrors: [], reopenedMeanwhile: false });
    // PR 1、3 和 s1 上次已经处理过，不再碰。
    expect(calls).toEqual(["close 2", "end busy", "rederive T-1", "refresh T-1"]);
    expect(reasons).toEqual(["需求变了"]);
  });

  it("reports again what still fails, and does nothing for a ticket that is no longer closed", async () => {
    const { d, tickets } = setup({
      prs: [{ url: "https://github.com/o/r/pull/2", number: 2, slug: "o/r", cwd: "/r" }],
      closePr: async () => { throw new Error("gh: timeout"); },
    });
    await closeTicket(d, "T-1", { reason: "不做了", source: "user", closePrs: true });
    const again = await retryClose(d, "T-1", { source: "user", prUrls: ["https://github.com/o/r/pull/2"], sessionIds: [] });
    expect(again).toMatchObject({ ok: true, closedPrs: [], prErrors: [{ url: "https://github.com/o/r/pull/2", error: "gh: timeout", kind: "failed" }] });
    reopenTicket(d, "T-1", "user");
    expect(await retryClose(d, "T-1", { source: "user", prUrls: ["https://github.com/o/r/pull/2"], sessionIds: [] })).toEqual({ ok: false, error: "not_closed" });
    expect(await retryClose(d, "NOPE", { source: "user", prUrls: [], sessionIds: [] })).toEqual({ ok: false, error: "no_ticket" });
    expect(tickets.get("T-1")!.statusManual).toBeNull();
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
    const r = reopenTicket(d, "T-1", "user");
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
    expect(reopenTicket(d, "T-1", "user")).toEqual({ ok: false, error: "not_closed" });
    expect(reopenTicket(d, "NOPE", "user")).toEqual({ ok: false, error: "no_ticket" });
  });
});

describe("setTicketStatus (the status menu and set_ticket_status)", () => {
  it("on a closed ticket undoes the close first, then sets the manual status; null only undoes the close", async () => {
    const { d, tickets, followups } = setup();
    await closeTicket(d, "T-1", { reason: "需求变了", source: "user" });
    expect(setTicketStatus(d, "T-1", "in_review", "user")).toEqual({ ok: true, ticket: "T-1", status: "in_review", reopened: true });
    expect(tickets.get("T-1")).toMatchObject({ statusManual: "in_review", closure: null });
    expect(followups.get("open")?.status).toBe("open");
    await closeTicket(d, "T-1", { reason: "又不做了", source: "user" });
    expect(setTicketStatus(d, "T-1", null, "user")).toMatchObject({ ok: true, status: "blocked", reopened: true });
    expect(tickets.get("T-1")?.statusManual).toBeNull();
    expect(setTicketStatus(d, "NOPE", null, "user")).toEqual({ ok: false, error: "no_ticket" });
  });
});

describe("classifyOpenPrs (which open PRs closing a ticket may close)", () => {
  const row = (n: number, o: Partial<OpenPrRow & { gaveUp: boolean; other: string | null }> = {}) => ({
    url: `https://github.com/o/r/pull/${n}`, number: n, slug: "o/r", repoId: 1, headBranch: "own", state: "open" as const, checkedAt: 5, gaveUp: false, other: null, ...o,
  });
  const classify = (rows: ReturnType<typeof row>[], own: (repoId: number, branch: string) => boolean = (_r, b) => b === "own" || b === "child") =>
    classifyOpenPrs(rows, { givenUp: (r) => r.gaveUp, ownBranch: own, sharedWith: (r) => r.other, ghDir: () => "/r" });

  it("closes only PRs on this ticket's own branches (its repo branch, or a branch it owns); everything else is listed with why", () => {
    const r = classify([
      row(1), row(2, { headBranch: "child" }), row(3, { headBranch: "someone-else" }), row(4, { headBranch: null }),
      row(5, { checkedAt: 0 }), row(6, { gaveUp: true }), row(7, { repoId: null }), row(8, { other: "T-2" }), row(9, { state: "closed" }),
    ]);
    expect(r.closable.map((p) => p.number)).toEqual([1, 2]);
    expect(r.unclosable).toEqual([
      { url: "https://github.com/o/r/pull/3", number: 3, kind: "not_own_branch" },
      { url: "https://github.com/o/r/pull/4", number: 4, kind: "not_own_branch" },
      { url: "https://github.com/o/r/pull/5", number: 5, kind: "never_read" },
      { url: "https://github.com/o/r/pull/6", number: 6, kind: "given_up" },
      { url: "https://github.com/o/r/pull/7", number: 7, kind: "foreign" },
      { url: "https://github.com/o/r/pull/8", number: 8, kind: "shared", ticket: "T-2" },
    ]);
  });

  it("a PR from a public branch (publicBranch) or whose head is its own target branch is not the ticket's own, even when ownBranch says yes (BTL-270 review)", () => {
    const rows = [row(1, { headBranch: "main", baseBranch: "release" }), row(2, { headBranch: "release", baseBranch: "release" }), row(3, { headBranch: "t", baseBranch: "main" })];
    const r = classifyOpenPrs(rows, {
      givenUp: (x) => x.gaveUp, ownBranch: () => true, publicBranch: (_id, b) => b === "main", sharedWith: () => null, ghDir: () => "/r",
    });
    expect(r.closable.map((p) => p.number)).toEqual([3]);
    expect(r.unclosable.map((u) => [u.number, u.kind])).toEqual([[1, "not_own_branch"], [2, "not_own_branch"]]);
  });

  it("an own branch name another ticket in the repo also used is shared_branch, naming that ticket; not folded into not_own_branch; a PR also linked to another ticket is shared even then (BTL-270 review)", () => {
    const rows = [row(1, { headBranch: "develop" }), row(2), row(3, { headBranch: "develop", other: "T-3" })];
    const r = classifyOpenPrs(rows, {
      givenUp: () => false, ownBranch: () => true, sharedBranch: (_id, b) => (b === "develop" ? "T-2" : null), sharedWith: (x) => x.other, ghDir: () => "/r",
    });
    expect(r.closable.map((p) => p.number)).toEqual([2]);
    expect(r.unclosable).toEqual([
      { url: "https://github.com/o/r/pull/1", number: 1, kind: "shared_branch", ticket: "T-2" },
      // 两个都成立：报 shared（PR 本身挂在 T-3 上），不报 shared_branch。
      { url: "https://github.com/o/r/pull/3", number: 3, kind: "shared", ticket: "T-3" },
    ]);
  });

  it("asks ownBranch with the PR's repo and head branch", () => {
    const asked: string[] = [];
    classify([row(1, { repoId: 7, headBranch: "x" })], (repoId, b) => (asked.push(`${repoId}:${b}`), true));
    expect(asked).toEqual(["7:x"]);
  });
});

describe("closePreview (what the close dialog lists before anything is closed)", () => {
  it("lists the closable PRs to tick and the unclosable ones with a reason in the current language", async () => {
    const { d } = setup({
      prs: [{ url: "https://github.com/o/r/pull/1", number: 1, slug: "o/r", cwd: "/r" }],
      unclosable: [{ url: "https://github.com/o/r/pull/8", number: 8, kind: "shared", ticket: "T-2" }],
    });
    expect(await closePreview(d, "T-1")).toEqual({
      closable: [{ url: "https://github.com/o/r/pull/1", number: 1 }],
      unclosable: [{ url: "https://github.com/o/r/pull/8", kind: "shared", ticket: "T-2", error: M().ticketClosePrWhy("shared", "T-2") }],
    });
    expect(await closePreview(d, "NOPE")).toBeNull();
  });
});

describe("prRefreshOptions (how a close / reopen / status change re-reads the PRs)", () => {
  it("forces given-up PRs only for the user and the ticket's own session; coordinator and routing don't (BTL-261)", () => {
    expect(prRefreshOptions("in_review", "user").retryGivenUp).toBe(true);
    expect(prRefreshOptions("in_review", "session").retryGivenUp).toBe(true);
    expect(prRefreshOptions("in_review", "coordinator").retryGivenUp).toBe(false);
    expect(prRefreshOptions("in_review", "routing").retryGivenUp).toBe(false);
  });

  it("re-reads the closed PRs of a ticket waiting for a decision, whoever asks, so a PR reopened on GitHub is seen", () => {
    for (const source of ["user", "coordinator", "routing", "session"] as const) {
      expect(prRefreshOptions("needs_decision", source).includeSettled).toBe(true);
      expect(prRefreshOptions("blocked", source).includeSettled).toBe(false);
    }
    expect(prRefreshOptions(null, "user")).toEqual({ retryGivenUp: true, includeSettled: false });
  });
});
