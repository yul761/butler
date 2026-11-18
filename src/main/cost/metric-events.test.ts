import { describe, expect, it, vi } from "vitest";
import { memDb } from "../test-utils";
import { MetricsRepo } from "../db/metrics-repo";
import { Metrics } from "../metrics/events";
import { backgroundMetricEvents, costMetricEvents } from "./metric-events";

describe("cost and background metric events", () => {
  it("records breaker steps as cost.* events on the ticket or the session", () => {
    const record = vi.fn(() => true);
    const on = costMetricEvents(record);
    on("pause", { subjectKind: "ticket", subjectId: "BTL-1", spent: 5.5, cap: 5, unit: "usd", detail: "background only" });
    on("downgrade", { subjectKind: "session", subjectId: "root-1", spent: 3, cap: 4, unit: "usd" });
    expect(record).toHaveBeenNthCalledWith(1, "cost.pause", {
      ticketKey: "BTL-1",
      data: { subject: "ticket", spent: 5.5, cap: 5, unit: "usd", detail: "background only" },
    });
    expect(record).toHaveBeenNthCalledWith(2, "cost.downgrade", { sessionId: "root-1", data: { subject: "session", spent: 3, cap: 4, unit: "usd" } });
  });

  it("records background yields and resumes, and still logs them", () => {
    const record = vi.fn(() => true);
    const log = vi.fn();
    const on = backgroundMetricEvents(record, log);
    on("yield", { kind: "backtest", reason: "active" });
    on("resume", { kind: "backtest" });
    expect(record.mock.calls).toEqual([
      ["background.yield", { data: { kind: "backtest", reason: "active" } }],
      ["background.resume", { data: { kind: "backtest" } }],
    ]);
    expect(log).toHaveBeenCalledWith("background: yield backtest (active)");
  });

  it("lands in H's metrics_events with valid kinds", () => {
    const db = memDb();
    const repo = new MetricsRepo(db);
    const { recordEvent } = new Metrics({ repo, now: () => 1000 });
    costMetricEvents(recordEvent)("takeover", { subjectKind: "ticket", subjectId: "BTL-2", spent: 1, cap: null, unit: "tokens" });
    backgroundMetricEvents(recordEvent, () => undefined)("yield", { kind: "backtest", reason: "quota" });
    const rows = db.prepare("SELECT kind, ticket_key AS ticketKey, data FROM metrics_events ORDER BY id").all() as { kind: string; ticketKey: string | null; data: string }[];
    expect(rows.map((r) => [r.kind, r.ticketKey])).toEqual([["cost.takeover", "BTL-2"], ["background.yield", null]]);
    expect(JSON.parse(rows[0]!.data)).toEqual({ subject: "ticket", spent: 1, cap: null, unit: "tokens" });
  });
});
