import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { MetricsRepo, type NewMetricEvent } from "./metrics-repo";

const ev = (o: Partial<NewMetricEvent> = {}): NewMetricEvent => ({
  kind: "terminal_input", at: 100, sessionId: "s1", ticketKey: "T-1", prId: null, repoSlug: null, data: { mode: "prompt" }, dedupeKey: null, ...o,
});

describe("MetricsRepo", () => {
  it("records events and skips a repeated dedupe key", () => {
    const r = new MetricsRepo(memDb());
    expect(r.addEvent(ev({ dedupeKey: "k" }))).toBe(true);
    expect(r.addEvent(ev({ dedupeKey: "k" }))).toBe(false);
    expect(r.addEvent(ev())).toBe(true);
    expect(r.addEvent(ev())).toBe(true);
    expect(r.hasEvent("k")).toBe(true);
    expect(r.events(0)).toHaveLength(3);
    expect(r.events(0)[0].data).toEqual({ mode: "prompt" });
  });

  it("filters events by time and kind", () => {
    const r = new MetricsRepo(memDb());
    r.addEvent(ev({ at: 50 }));
    r.addEvent(ev({ at: 150, kind: "interrupt" }));
    r.addEvent(ev({ at: 200 }));
    expect(r.events(100).map((e) => e.at)).toEqual([150, 200]);
    expect(r.events(0, ["interrupt"]).map((e) => e.kind)).toEqual(["interrupt"]);
  });

  it("opens, touches and closes wait spans; closeStale ends open spans at their last sighting", () => {
    const r = new MetricsRepo(memDb());
    const a = r.openSpan({ sessionId: "s1", ticketKey: "T-1", kind: "human", category: "permission", source: "permission_prompt", startedAt: 100 });
    const b = r.openSpan({ sessionId: "s2", ticketKey: null, kind: "idle", category: null, source: null, startedAt: 100 });
    r.touchSpan(a, 150);
    r.closeSpan(a, 180);
    r.touchSpan(b, 400);
    expect(r.openSpans().map((s) => s.id)).toEqual([b]);
    expect(r.closeStale()).toBe(1);
    const spans = r.spans(0);
    expect(spans.find((s) => s.id === a)).toMatchObject({ endedAt: 180, category: "permission" });
    expect(spans.find((s) => s.id === b)).toMatchObject({ endedAt: 400 });
    expect(r.spans(300).map((s) => s.id)).toEqual([b]);
  });

  it("replaces the daily rollup from a day on", () => {
    const r = new MetricsRepo(memDb());
    r.replaceDaily("2026-01-01", [
      { day: "2026-01-01", groupKind: "all", groupKey: "", butler: true, metric: "pr_merged", n: 1, total: 1 },
      { day: "2026-01-02", groupKind: "repo", groupKey: "o/r", butler: false, metric: "cycle_open_ms", n: 1, total: 10 },
    ]);
    r.replaceDaily("2026-01-02", [{ day: "2026-01-02", groupKind: "all", groupKey: "", butler: true, metric: "pr_merged", n: 2, total: 2 }]);
    const rows = r.daily("2026-01-01");
    expect(rows).toHaveLength(2);
    expect(rows.map((x) => x.metric)).toEqual(["pr_merged", "pr_merged"]);
    expect(rows[1]).toMatchObject({ day: "2026-01-02", butler: true, n: 2 });
  });

  it("stores baseline PRs", () => {
    const r = new MetricsRepo(memDb());
    r.upsertBaseline({ slug: "o/r", number: 1, openedAt: 1, mergedAt: 5, firstCommitAt: null, humanComments: 2, copilotComments: 1, fetchedAt: 9 });
    expect(r.hasBaseline("o/r", 1)).toBe(true);
    expect(r.hasBaseline("o/r", 2)).toBe(false);
    expect(r.baselinePrs()[0]).toMatchObject({ number: 1, humanComments: 2 });
  });
});
