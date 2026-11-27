import { describe, expect, it } from "vitest";
import { noPreReview, type PreReviewBadge, type PreReviewQueueItem, type PreReviewQueueView } from "../../shared/prereview";
import { preReviewChip, preReviewSidebarText, preReviewStoppedText } from "./prereview-view";
import { STRINGS } from "./strings";

const b = (o: Partial<PreReviewBadge>): PreReviewBadge => ({ ...noPreReview("T-1"), id: 1, repoSlug: "o/app", branch: "feat/x", headSha: "a".repeat(40), ...o });
const item = (o: Partial<PreReviewQueueItem>): PreReviewQueueItem => ({ ...b(o), id: o.id ?? 1, jobId: 1, prNumber: null, prUrl: null, ending: null, ...o });
const q = (o: Partial<PreReviewQueueView>): PreReviewQueueView => ({ running: [], ending: [], queued: [], concurrency: 2, stopped: null, ...o });

describe.each(["zh", "en"] as const)("pre-review chip text (%s, BTL-271)", (lang) => {
  const S = STRINGS[lang];

  it("names every state, with the queue place, the minutes running and the violation count", () => {
    expect(preReviewChip(noPreReview("T-1"), 0, S)).toMatchObject({ state: "none", label: S.prq.none, tone: "muted" });
    expect(preReviewChip(b({ state: "queued", position: 3 }), 0, S)).toMatchObject({ label: S.prq.queued(3), tone: "info" });
    expect(preReviewChip(b({ state: "running", startedAt: 0 }), 7 * 60_000 + 5_000, S)).toMatchObject({ label: S.prq.running(7), tone: "info" });
    expect(preReviewChip(b({ state: "clean" }), 0, S)).toMatchObject({ label: S.prq.clean, tone: "good" });
    expect(preReviewChip(b({ state: "violations", violations: 2 }), 0, S)).toMatchObject({ label: S.prq.violations(2), tone: "bad" });
    expect(preReviewChip(b({ state: "error", detail: "boom" }), 0, S)).toMatchObject({ label: S.prq.error, tone: "bad" });
    expect(preReviewChip(b({ state: "error", detail: "boom" }), 0, S).title).toContain("boom");
  });

  it("paused says why (manual, cost breaker, quota, memory)", () => {
    for (const reason of ["manual", "cost", "quota", "memory"] as const) {
      const v = preReviewChip(b({ state: "paused", reason, position: 1 }), 0, S);
      expect(v.label).toBe(S.prq.paused(S.prq.reason[reason]));
      expect(v.tone).toBe("warn");
    }
  });

  it("the hover text says what a queued one waits for, which code, the trigger and the last result", () => {
    const v = preReviewChip(b({ state: "queued", position: 2, waiting: "worktree", trigger: "evidence", last: { state: "violations", id: 9, violations: 3, headSha: "b".repeat(40), finishedAt: 1 } }), 0, S);
    expect(v.title).toContain(S.prq.waiting.worktree);
    expect(v.title).toContain(S.prq.code("o/app", "feat/x", "aaaaaaa"));
    expect(v.title).toContain(S.prq.trigger.evidence);
    expect(v.title).toContain(S.prq.last(S.prq.violations(3)));
  });

  it("the sidebar says how many run and queue, says when the queue is stopped, and is empty when nothing is there", () => {
    expect(preReviewSidebarText(q({}), S)).toBeNull();
    const text = preReviewSidebarText(q({ running: [item({ id: 1, state: "running" })], queued: [item({ id: 2, state: "queued" }), item({ id: 3, state: "queued" })] }), S)!;
    expect(text).toContain(S.prq.sidebar(1, 2));
    expect(text.startsWith(S.prq.sidebarLabel)).toBe(true);
    const stopped = preReviewSidebarText(q({ queued: [item({ id: 2, state: "paused" })], stopped: { reason: "quota", until: null } }), S)!;
    expect(stopped).toContain(S.prq.sidebarStopped(S.prq.reason.quota));
  });

  it("the queue page says why the queue is stopped", () => {
    expect(preReviewStoppedText(q({}), S)).toBeNull();
    expect(preReviewStoppedText(q({ stopped: { reason: "manual", until: null } }), S)).toBe(S.prq.stopped(S.prq.reason.manual));
    expect(preReviewStoppedText(q({ stopped: { reason: "cost", until: Date.UTC(2026, 10, 26, 9) } }), S)).toContain(S.prq.reason.cost);
  });
});
