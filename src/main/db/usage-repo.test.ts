import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { UsageRepo, type UsageRow } from "./usage-repo";

const row = (messageId: string, o: Partial<UsageRow> = {}): UsageRow => ({
  messageId, at: 100, model: "claude-opus", input: 1, cacheWrite5m: 2, cacheWrite1h: 3, cacheRead: 4, output: 5, context: 10,
  sessionId: "s1", agentId: null, source: "session", job: null, ...o,
});

describe("UsageRepo", () => {
  it("records rows once per message id", () => {
    const r = new UsageRepo(memDb());
    expect(r.record([row("m1"), row("m1")])).toBe(1);
    expect(r.record([row("m1")])).toBe(0);
  });

  it("latestContext returns the newest session turn", () => {
    const r = new UsageRepo(memDb());
    r.record([row("a", { at: 100, context: 10 }), row("b", { at: 200, context: 50 }), row("c", { at: 300, context: 999, source: "subagent", agentId: "ag" })]);
    expect(r.latestContext("s1")).toBe(50);
    expect(r.latestContext("nope")).toBeNull();
  });

  it("stores and reads cursors", () => {
    const r = new UsageRepo(memDb());
    expect(r.cursor("/f")).toBeNull();
    r.setCursor("/f", 10, 20);
    expect(r.cursor("/f")).toEqual({ offset: 10, size: 20 });
    r.setCursor("/f", 30, 40);
    expect(r.cursor("/f")).toEqual({ offset: 30, size: 40 });
  });

  it("since filters by time and round-trips fields", () => {
    const r = new UsageRepo(memDb());
    r.record([row("a", { at: 100 }), row("b", { at: 200, source: "headless", sessionId: null, job: "summary", model: null })]);
    const got = r.since(150);
    expect(got).toEqual([{ ...row("b", { at: 200, source: "headless", sessionId: null, job: "summary", model: null }), task: null, requestedTier: null, fallbackFrom: null, costUsd: null, ticketKey: null }]);
  });
});

describe("UsageRepo.totalsFor (workstream L)", () => {
  const row = (id: string, o: Partial<UsageRow>): UsageRow => ({
    messageId: id, sessionId: null, agentId: null, source: "session", job: null, at: 1, model: "M1",
    input: 10, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 100, output: 2, context: 0, ...o,
  });

  it("adds a session chain and the ticket's headless rows, weighting tokens", () => {
    const repo = new UsageRepo(memDb());
    repo.record([
      row("a", { sessionId: "s1" }),
      row("b", { sessionId: "s2", agentId: "sub" }),
      row("c", { sessionId: "other" }),
      row("d", { source: "headless", ticketKey: "T-1", costUsd: 0.5 }),
      row("e", { source: "headless", ticketKey: "T-2" }),
    ]);
    const t = repo.totalsFor({ sessionIds: ["s1", "s2"], ticketKey: "T-1" });
    expect(t).toHaveLength(1);
    // 每行 10 + 0.1×100 + 5×2 = 30
    expect(t[0]).toMatchObject({ model: "M1", rows: 3, weighted: 90, costUsd: 0.5, unpricedRows: 2 });
    expect(repo.totalsFor({ sessionIds: ["s1"] })[0]).toMatchObject({ rows: 1 });
    expect(repo.totalsFor({})).toEqual([]);
    expect(repo.since(0).find((r) => r.messageId === "d")?.ticketKey).toBe("T-1");
  });
});
