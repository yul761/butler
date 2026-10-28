import { afterEach, describe, expect, it } from "vitest";
import type { Pr } from "../../shared/handoff";
import type { FeatureHandoffRecord, FeatureView, TicketView } from "../../shared/types";
import { featureHeadline, firstSentence, groupByFeature, prLabel, prPill, summaryOutcomeMessage } from "./feature-summary-view";
import { STRINGS, setUiLang } from "./strings";

const ticket = (key: string, featureId: number | null): TicketView => ({
  key, title: null, repos: [], status: "active", statusManual: null, createdAt: 1, archivedAt: null, featureId,
  effectiveStatus: "active", sessions: [], hiddenSessions: [], waiting: false,
});
const record = (over: Partial<FeatureHandoffRecord> = {}): FeatureHandoffRecord => ({
  id: 1, featureId: 1, sessionId: null, trigger: "nightly", createdAt: 1, coversUntil: null, degraded: false, rawText: null, sourceRef: null,
  payload: { summary: "后端已合并。前端在等 review", blockers: [], next_steps: [], decisions: [], open_questions: [] },
  ...over,
});
const feature = (id: number, name: string, summary: FeatureHandoffRecord | null = null): FeatureView => ({
  id, name, workspaceDir: "/w", repos: [], createdAt: 1, archivedAt: null,
  tickets: [], sessions: [], hiddenSessions: [], waiting: false, summary, ticketPrs: {},
});
const pr = (state: Pr["state"], review: Pr["review"], number = 1, url = "https://github.com/o/r/pull/1"): Pr => ({ number, url, state, review });

afterEach(() => setUiLang("zh"));

describe("firstSentence", () => {
  it("stops after the first sentence mark, Chinese or English", () => {
    expect(firstSentence("后端已合并。前端在等 review")).toBe("后端已合并。");
    expect(firstSentence("Backend merged. Frontend")).toBe("Backend merged.");
    expect(firstSentence("能合并了吗？还差一个")).toBe("能合并了吗？");
    expect(firstSentence("Done! Next")).toBe("Done!");
  });

  it("stops at a line break", () => {
    expect(firstSentence("第一行\n第二行。")).toBe("第一行");
  });

  it("keeps dots inside file names and versions", () => {
    expect(firstSentence("改了 api.ts 和 v1.2 的接口。然后")).toBe("改了 api.ts 和 v1.2 的接口。");
  });

  it("is at most 80 characters", () => {
    const long = "长".repeat(200);
    expect(Array.from(firstSentence(long)).length).toBe(80);
    expect(firstSentence(long).endsWith("…")).toBe(true);
    expect(firstSentence("短句")).toBe("短句");
  });
});

describe("groupByFeature", () => {
  const tickets = [ticket("A-1", 1), ticket("B-1", 2), ticket("A-2", 1), ticket("S-1", null)];
  const features = [feature(1, "alpha"), feature(2, "beta")];

  it("groups interleaved entries by feature in order of first appearance and keeps the order inside a group", () => {
    const entries = [{ ticketKey: "A-1" }, { ticketKey: "B-1" }, { ticketKey: "A-2" }];
    const groups = groupByFeature(entries, tickets, features);
    expect(groups.map((g) => g.feature?.name)).toEqual(["alpha", "beta"]);
    expect(groups[0].entries.map((e) => e.ticketKey)).toEqual(["A-1", "A-2"]);
    expect(groups[1].entries.map((e) => e.ticketKey)).toEqual(["B-1"]);
  });

  it("puts standalone, archived and unknown tickets in the feature: null group", () => {
    const groups = groupByFeature([{ ticketKey: "S-1" }, { ticketKey: "A-1" }, { ticketKey: "GONE-1" }], tickets, features);
    expect(groups.map((g) => g.feature?.name ?? null)).toEqual([null, "alpha"]);
    expect(groups[0].entries.map((e) => e.ticketKey)).toEqual(["S-1", "GONE-1"]);
  });

  it("returns nothing for no entries, and one null group for an old brief without features", () => {
    expect(groupByFeature([], tickets, features)).toEqual([]);
    expect(groupByFeature([{ ticketKey: "S-1" }], tickets, [])).toEqual([{ feature: null, entries: [{ ticketKey: "S-1" }] }]);
  });
});

describe("featureHeadline", () => {
  it("is the first sentence of a valid summary, null otherwise", () => {
    expect(featureHeadline(feature(1, "a", record()))).toBe("后端已合并。");
    expect(featureHeadline(feature(1, "a"))).toBeNull();
    expect(featureHeadline(feature(1, "a", record({ degraded: true, payload: null, rawText: "x" })))).toBeNull();
  });
});

describe("prPill", () => {
  it("covers the five kinds", () => {
    expect(prPill(pr("merged", "approved"))).toBe("merged");
    expect(prPill(pr("closed", null))).toBe("closed");
    expect(prPill(pr("open", "approved"))).toBe("approved");
    expect(prPill(pr("open", "changes_requested"))).toBe("changes");
    expect(prPill(pr("open", "pending"))).toBe("pending");
    expect(prPill(pr("open", null))).toBe("pending");
  });
});

describe("prLabel", () => {
  it("is #number for one PR and repo#number when there are several", () => {
    const a = pr("open", null, 812, "https://github.com/o/backend/pull/812");
    const b = pr("open", null, 455, "https://github.com/o/frontend/pull/455");
    expect(prLabel(a, [a])).toBe("#812");
    expect(prLabel(a, [a, b])).toBe("backend#812");
    expect(prLabel(pr("open", null, 3, "https://gitlab.example/x/-/merge_requests/3"), [a, b])).toBe("#3");
  });
});

describe("summaryOutcomeMessage", () => {
  it("explains skips and failures in plain words, in both languages", () => {
    expect(summaryOutcomeMessage({ featureId: 1, status: "skipped", reason: "nothing_to_summarize" })).toContain("总控 session");
    expect(summaryOutcomeMessage({ featureId: 1, status: "skipped", reason: "rate_limited" })).toContain("额度");
    expect(summaryOutcomeMessage({ featureId: 1, status: "failed", reason: "timeout", message: "超时" })).toContain("超时");
    expect(summaryOutcomeMessage({ featureId: 1, status: "stored", handoffId: 2, degraded: false })).toBe(STRINGS.zh.featureSummaryStored);
    expect(summaryOutcomeMessage({ featureId: 1, status: "stored", handoffId: 2, degraded: true })).toBe(STRINGS.zh.featureSummaryStoredDegraded);
    setUiLang("en");
    expect(summaryOutcomeMessage({ featureId: 1, status: "skipped", reason: "nothing_to_summarize" })).toContain("coordinator session");
    expect(summaryOutcomeMessage({ featureId: 1, status: "skipped", reason: "rate_limited" })).toContain("rate limited");
  });
});
