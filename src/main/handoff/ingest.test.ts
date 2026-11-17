import { describe, expect, it, vi } from "vitest";
import type { Handoff, HandoffFollowup } from "../../shared/handoff";
import { FollowupsRepo } from "../db/followups-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { insertTicket, memDb } from "../test-utils";
import { ingestHandoff, rederiveTicketStatus } from "./ingest";
import { emptyHandoff } from "./schema";

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  insertTicket(tickets, { key: "PROJ-1", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  let now = 1000;
  let n = 0;
  const deps = { db, tickets, handoffs, followups, now: () => now, newFollowupId: () => `f${++n}` };
  return { deps, tickets, handoffs, followups, tick: (ms: number) => void (now += ms) };
}

const payload = (over: Partial<Handoff> = {}): Handoff => ({ ...emptyHandoff("WRONG-9"), ...over });
const fu = (over: Partial<HandoffFollowup> = {}): HandoffFollowup => ({
  id: null, kind: "config", description: "改 staging 配置", trigger: "after_merge", due_date: null, done: false, ...over,
});
const merged = { number: 7, url: "u", state: "merged" as const, review: "approved" as const };

describe("ingestHandoff", () => {
  it("remembers a merged PR that later handoffs and refreshes leave out, but not an open one", () => {
    const { deps, tickets, handoffs, tick } = setup();
    const open2 = { number: 8, url: "u8", state: "open" as const, review: "pending" as const };
    ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", rawText: null, payload: payload({ prs: [merged, open2] }) });
    tick(10);
    // 刷新（worktree 清理之后）没找到 PR：合并过的 #7 记着，开着的 #8 不补。
    const r = ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: null, trigger: "refresh", rawText: null, payload: payload({ status: "done", prs: [] }) });
    expect(r).toMatchObject({ status: "done" });
    expect(handoffs.latest("PROJ-1")?.payload?.prs).toEqual([merged]);
    expect(handoffs.knownPrs("PROJ-1")).toEqual([merged]);
    expect(tickets.get("PROJ-1")?.status).toBe("done");
    tick(10);
    // 再下一条把 #7 报成开着：还是已合并。
    ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", rawText: null, payload: payload({ prs: [{ ...merged, state: "open" }] }) });
    expect(handoffs.latest("PROJ-1")?.payload?.prs).toEqual([{ ...merged, state: "merged" }]);
  });

  it("knownPrs recovers merged PRs from older handoffs stored before this fix", () => {
    const { handoffs } = setup();
    handoffs.insert({ ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", createdAt: 1, payload: payload({ ticket: "PROJ-1", prs: [merged] }), rawText: null, sourceRef: null });
    handoffs.insert({ ticketKey: "PROJ-1", sessionId: null, trigger: "refresh", createdAt: 2, payload: payload({ ticket: "PROJ-1", prs: [] }), rawText: null, sourceRef: null });
    handoffs.insert({ ticketKey: "PROJ-1", sessionId: null, trigger: "nightly", createdAt: 3, payload: null, rawText: "broken", sourceRef: null });
    expect(handoffs.latestValid("PROJ-1")?.payload?.prs).toEqual([]);
    expect(handoffs.knownPrs("PROJ-1")).toEqual([merged]);
    expect(handoffs.knownPrs("NONE-1")).toEqual([]);
  });

  it("ingesting a handoff links its PRs in the same transaction", () => {
    const { deps, handoffs } = setup();
    const linked: [string, unknown[]][] = [];
    const pr = { number: 7, url: "https://github.com/a/x/pull/7", state: "open" as const, review: null };
    ingestHandoff({ ...deps, linkPrs: (k, prs) => void linked.push([k, prs]) }, { ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", rawText: null, payload: payload({ prs: [pr] }) });
    expect(linked).toEqual([["PROJ-1", [pr]]]);
    const boom = { ...deps, linkPrs: () => { throw new Error("link failed"); } };
    expect(() => ingestHandoff(boom, { ticketKey: "PROJ-1", sessionId: "s2", trigger: "command", rawText: null, payload: payload({ prs: [pr] }) })).toThrow("link failed");
    expect(handoffs.listByTicket("PROJ-1")).toHaveLength(1);
  });

  it("stores the handoff under the right ticket, creates followups and derives the status", () => {
    const { deps, tickets, handoffs, followups } = setup();
    const r = ingestHandoff(deps, {
      ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", rawText: "{}",
      payload: payload({ prs: [{ number: 7, url: "u", state: "open", review: "pending" }], followups: [fu(), fu({ description: "开 flag", kind: "flag" })] }),
    });
    expect(r).toMatchObject({ stored: true, degraded: false, status: "in_review" });
    expect(handoffs.latest("PROJ-1")?.payload?.ticket).toBe("PROJ-1");
    expect(followups.listByTicket("PROJ-1").map((f) => [f.id, f.status, f.source])).toEqual([
      ["f1", "open", "session"],
      ["f2", "open", "session"],
    ]);
    expect(tickets.get("PROJ-1")?.status).toBe("in_review");
    expect(tickets.statusTimes("PROJ-1").changedAt).toBe(1000);
  });

  it("applies done flags, never revives ignored items, and lands on done when nothing is left", () => {
    const { deps, tickets, followups, tick } = setup();
    ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", rawText: null, payload: payload({ followups: [fu(), fu({ description: "开 flag" })] }) });
    tick(10);
    const second = ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", rawText: null, payload: payload({ status: "in_review", prs: [merged], followups: [fu({ id: "f1", done: true })] }) });
    expect(second).toMatchObject({ status: "merged_pending_followup" });
    expect(followups.get("f1")).toMatchObject({ status: "done", doneAt: 1010 });
    followups.setStatus("f2", "ignored", 1020);
    tick(10);
    const third = ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: "s1", trigger: "command", rawText: null, payload: payload({ status: "in_review", prs: [merged], followups: [fu({ description: "开 flag" })] }) });
    expect(third).toMatchObject({ status: "done" });
    expect(followups.get("f2")?.status).toBe("ignored");
    expect(followups.listByTicket("PROJ-1")).toHaveLength(2);
    expect(tickets.get("PROJ-1")?.status).toBe("done");
  });

  it("stores a degraded handoff with its raw text and leaves the status alone", () => {
    const { deps, tickets, handoffs } = setup();
    tickets.setStatus("PROJ-1", "in_review", 5);
    expect(ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", payload: null, rawText: "我做了很多事" })).toMatchObject({
      stored: true, degraded: true, status: null,
    });
    expect(handoffs.latest("PROJ-1")).toMatchObject({ degraded: true, rawText: "我做了很多事" });
    expect(tickets.get("PROJ-1")?.status).toBe("in_review");
    const linkPrs = vi.fn();
    ingestHandoff({ ...deps, linkPrs }, { ticketKey: "PROJ-1", sessionId: "s2", trigger: "nightly", payload: null, rawText: "又一份" });
    expect(linkPrs).not.toHaveBeenCalled();
  });

  it("ignores a repeated sourceRef and unknown tickets", () => {
    const { deps, handoffs } = setup();
    const input = { ticketKey: "PROJ-1", sessionId: "s1", trigger: "command" as const, payload: payload(), rawText: "{}", sourceRef: "uuid-1" };
    expect(ingestHandoff(deps, input)).toMatchObject({ stored: true });
    expect(ingestHandoff(deps, input)).toEqual({ stored: false, reason: "duplicate" });
    expect(ingestHandoff(deps, { ...input, ticketKey: "NOPE-1", sourceRef: "uuid-2" })).toEqual({ stored: false, reason: "no_ticket" });
    expect(handoffs.listByTicket("PROJ-1")).toHaveLength(1);
  });

  it("re-derives the status after a followup is completed by hand", () => {
    const { deps, tickets, followups } = setup();
    ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: null, trigger: "nightly", rawText: null, payload: payload({ status: "in_review", prs: [merged], followups: [fu()] }) });
    expect(tickets.get("PROJ-1")?.status).toBe("merged_pending_followup");
    followups.setStatus("f1", "done", 2000);
    expect(rederiveTicketStatus(deps, "PROJ-1")).toBe("done");
    expect(tickets.get("PROJ-1")?.status).toBe("done");
  });

  it("ingest passes the model's own prs and the remembered ones separately", () => {
    const { deps, tickets, tick } = setup();
    ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", rawText: null, payload: payload({ prs: [merged] }) });
    tick(10);
    // 模型说 active、没提 PR：以前合并的 #7 只是记忆，不让它变 done。
    const r = ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", rawText: null, payload: payload({ status: "active", prs: [] }) });
    expect(r).toMatchObject({ status: "active" });
    expect(tickets.get("PROJ-1")?.status).toBe("active");
    tick(10);
    const linked = ingestHandoff({ ...deps, linkedOpen: () => true }, { ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", rawText: null, payload: payload({ status: "active", prs: [] }) });
    expect(linked).toMatchObject({ status: "in_review" });
  });

  it("rederive keeps done/mpf in sync with followups and leaves active alone", () => {
    const { deps, tickets, followups, tick } = setup();
    ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: null, trigger: "nightly", rawText: null, payload: payload({ status: "done", followups: [fu()] }) });
    expect(tickets.get("PROJ-1")?.status).toBe("merged_pending_followup");
    followups.setStatus("f1", "done", 2000);
    expect(rederiveTicketStatus(deps, "PROJ-1")).toBe("done");
    followups.setStatus("f1", "open", 2001);
    expect(rederiveTicketStatus(deps, "PROJ-1")).toBe("merged_pending_followup");
    tick(10);
    // 自动状态是 active 时，记着的已合并 PR 不会把它变成 done。
    ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: null, trigger: "nightly", rawText: null, payload: payload({ status: "active", prs: [merged] }) });
    tickets.setStatus("PROJ-1", "active", 3000);
    expect(rederiveTicketStatus(deps, "PROJ-1")).toBe("active");
    expect(tickets.get("PROJ-1")?.status).toBe("active");
  });
});
