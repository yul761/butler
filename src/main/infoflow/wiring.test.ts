import { describe, expect, it } from "vitest";
import type { CloseResult, RetryCloseOptions, RetryCloseResult } from "../tickets/ticket-close";
import type { FlowLeftovers } from "../../shared/infoflow";
import type { Session, Ticket } from "../../shared/types";
import { recipients } from "./targets";
import { closeStep, infoflowLookups, infoflowTicketActions, type InfoflowLookupDeps } from "./wiring";

const closed = (over: Partial<Extract<CloseResult, { ok: true }>> = {}): Extract<CloseResult, { ok: true }> => ({
  ok: true, ticket: "BTL-12", ignoredFollowups: 0, closedPrs: [], prErrors: [], endedSessions: [], sessionErrors: [], reopenedMeanwhile: false, ...over,
});

function actions(retryResult: RetryCloseResult) {
  const retries: RetryCloseOptions[] = [];
  let notified = 0;
  const act = infoflowTicketActions({
    tickets: { setBlock: () => undefined },
    blocks: { reorder: () => undefined },
    notify: () => void notified++,
    closer: {
      close: async () => closed(),
      retry: async (_k, o) => {
        retries.push(o);
        return retryResult;
      },
      reopen: async () => ({ ok: false, error: "not_closed" }),
      preview: async () => null,
    },
  });
  return { act, retries, notified: () => notified };
}

describe("closeStep (BTL-272, shared closeOutcome)", () => {
  it("is not done while a PR is still open: ticket closed, PR not", () => {
    const prErrors = [{ url: "https://x/pull/41", error: "gh: 502", kind: "failed" as const }];
    expect(closeStep(closed({ prErrors }))).toEqual({ kind: "partial", leftovers: { prErrors, sessionErrors: [] } });
  });

  it("does not throw on pick_prs (routing closed PRs without naming them): nothing was done, here is the list to ask with", () => {
    const r: CloseResult = {
      ok: false, error: "pick_prs", ticket: "BTL-12", closable: [{ url: "https://x/pull/41", number: 41 }],
      prErrors: [{ url: "https://x/pull/43", error: "BTL-13 uses it too", kind: "shared" }], alreadyClosed: false,
    };
    expect(closeStep(r)).toEqual({ kind: "pick", prs: { closable: ["https://x/pull/41"], unclosable: [{ url: "https://x/pull/43", error: "BTL-13 uses it too" }] } });
  });

  it("is reopened, not done, when the ticket was reopened while closing", () => {
    expect(closeStep(closed({ reopenedMeanwhile: true }))).toEqual({ kind: "reopened" });
  });

  it("lists shared_branch PRs from pick_prs as ones it can't close, with their reason", () => {
    const r: CloseResult = {
      ok: false, error: "pick_prs", ticket: "BTL-12", closable: [],
      prErrors: [{ url: "https://x/pull/44", error: "BTL-13 has a branch with the same name", kind: "shared_branch", ticket: "BTL-13" }], alreadyClosed: true,
    };
    expect(closeStep(r)).toEqual({ kind: "pick", prs: { closable: [], unclosable: [{ url: "https://x/pull/44", error: "BTL-13 has a branch with the same name" }] } });
  });

  // BTL-270 的新语义：已经关着的 ticket 再关不再抛 already_closed 的错，按 closedMeanwhile 说这次实际做了什么。
  it("someone else closed it first and nothing was left: closed_meanwhile nothing, not an error", () => {
    expect(closeStep({ ok: false, error: "already_closed", checkedPrs: true })).toEqual({ kind: "closed_meanwhile", how: "nothing" });
    expect(closeStep({ ok: false, error: "already_closed", checkedPrs: false })).toEqual({ kind: "closed_meanwhile", how: "nothing" });
  });

  it("someone else closed it first and the named PRs were closed: closed_meanwhile prs / sessions / both", () => {
    expect(closeStep(closed({ alreadyClosed: true, closedPrs: ["https://x/pull/41"] }))).toEqual({ kind: "closed_meanwhile", how: "prs" });
    expect(closeStep(closed({ alreadyClosed: true, endedSessions: ["s1"] }))).toEqual({ kind: "closed_meanwhile", how: "sessions" });
    expect(closeStep(closed({ alreadyClosed: true, closedPrs: ["https://x/pull/41"], endedSessions: ["s1"] }))).toEqual({ kind: "closed_meanwhile", how: "both" });
    expect(closeStep(closed({ alreadyClosed: true }))).toEqual({ kind: "closed_meanwhile", how: "nothing" });
  });

  it("someone else closed it first and a PR failed (closedMeanwhile failed): partial marked closedMeanwhile, with the errors", () => {
    const prErrors = [{ url: "https://x/pull/41", error: "gh: 502", kind: "failed" as const }];
    const sessionErrors = [{ id: "s1", error: "busy" }];
    expect(closeStep(closed({ alreadyClosed: true, prErrors }))).toEqual({ kind: "partial", leftovers: { prErrors, sessionErrors: [], closedMeanwhile: true } });
    expect(closeStep(closed({ alreadyClosed: true, closedPrs: ["https://x/pull/42"], sessionErrors }))).toEqual({ kind: "partial", leftovers: { prErrors: [], sessionErrors, closedMeanwhile: true } });
  });

  it("reopened wins over closed meanwhile", () => {
    expect(closeStep(closed({ alreadyClosed: true, reopenedMeanwhile: true, closedPrs: ["https://x/pull/41"] }))).toEqual({ kind: "reopened" });
  });
});

describe("infoflowTicketActions.retryClose (BTL-272 on BTL-270's retryRequest)", () => {
  it("does not call gh again when every leftover PR is one that can't be closed, and keeps them listed", async () => {
    const t = actions(closed());
    const leftovers: FlowLeftovers = {
      prErrors: [
        { url: "https://x/pull/41", error: "not this ticket's branch", kind: "not_own_branch" },
        { url: "https://x/pull/42", error: "BTL-13 uses it too", kind: "shared" },
      ],
      sessionErrors: [],
    };
    expect(await t.act.retryClose("BTL-12", leftovers)).toEqual({ kind: "partial", leftovers });
    expect(t.retries).toEqual([]);
  });

  it("retries only the leftovers that could still close", async () => {
    const t = actions(closed());
    const leftovers: FlowLeftovers = {
      prErrors: [
        { url: "https://x/pull/41", error: "gh: 502", kind: "failed" },
        { url: "https://x/pull/42", error: "BTL-13 uses it too", kind: "shared" },
      ],
      sessionErrors: [{ id: "s1", error: "busy" }],
    };
    expect(await t.act.retryClose("BTL-12", leftovers)).toEqual({ kind: "done" });
    expect(t.retries).toEqual([{ source: "routing", prUrls: ["https://x/pull/41"], sessionIds: ["s1"] }]);
    expect(t.notified()).toBe(1);
  });
});

describe("infoflowLookups recipients (BTL-272: closed / done tickets get nothing)", () => {
  const s = (id: string, o: Partial<Session> = {}): Session => ({
    id, ticketKey: null, cwd: "/", origin: "shipherd", gitBranch: null, firstPrompt: null, lastActivityAt: 0, waitingForInput: false, replacedBy: null,
    dismissed: false, createdAt: 0, repoId: null, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, model: null, shipherd: false,
    lessonRunId: null, ...o,
  });
  const tk = (key: string, o: Partial<Ticket> = {}): Ticket => ({ key, featureId: 4, blockId: null, title: null, status: "active", statusManual: null, archivedAt: null, ...o }) as Ticket;

  function lookups(live: Set<string>) {
    const tickets = new Map([
      ["BTL-12", tk("BTL-12")],
      ["BTL-13", tk("BTL-13", { statusManual: "closed" })],
      ["BTL-14", tk("BTL-14", { status: "done" })],
    ]);
    const sessions = [
      s("t12", { ticketKey: "BTL-12" }), s("t13", { ticketKey: "BTL-13" }), s("t14", { ticketKey: "BTL-14" }),
      s("c4", { featureId: 4, coordinator: true }), s("fix13", { featureId: 4, ticketKey: "BTL-13" }),
    ];
    const deps: InfoflowLookupDeps = {
      tickets: { get: (k) => tickets.get(k) ?? null, listByFeature: (f) => [...tickets.values()].filter((t) => t.featureId === f) },
      features: { get: () => null, list: () => [] },
      blocks: { list: () => [], get: () => null },
      sessions: {
        head: (id) => sessions.find((x) => x.id === id) ?? null,
        listByTicket: (k) => sessions.filter((x) => x.ticketKey === k),
        listByFeature: (f) => sessions.filter((x) => x.featureId === f),
        listFeatureCoordinators: (f) => sessions.filter((x) => x.featureId === f && x.coordinator),
        listShipherd: () => [],
        listByTickets: (keys) => new Map(keys.map((k) => [k, sessions.filter((x) => x.ticketKey === k)])),
      } as InfoflowLookupDeps["sessions"],
      live: (id) => live.has(id),
      closed: (t) => (t.statusManual ?? t.status) === "closed",
    };
    return infoflowLookups(deps).recipients;
  }

  it("sends nothing to the sessions of a closed or done ticket, open or not; open tickets still get it", () => {
    const all = new Set(["t12", "t13", "t14", "c4", "fix13"]);
    for (const live of [all, new Set<string>()]) {
      const r = lookups(live);
      expect(recipients([{ kind: "ticket", key: "BTL-13" }], r, "x")).toEqual([]);
      expect(recipients([{ kind: "ticket", key: "BTL-14" }], r, "x")).toEqual([]);
      expect(recipients([{ kind: "ticket", key: "BTL-12" }], r, "x")).toEqual(["t12"]);
    }
    // epic：只发开着的、还在做的 ticket 的 session 和总控；关掉的 ticket 的修复 session 也不发。
    expect(recipients([{ kind: "epic", featureId: 4 }], lookups(all), "x").sort()).toEqual(["c4", "t12"]);
  });
});
