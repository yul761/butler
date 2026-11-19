import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ExternalActionEntry } from "../../../shared/external";
import type { ProgressPr, ProgressView } from "../../../shared/progress";
import type { ButlerMessageView } from "../../../shared/types";
import { flattenStack, segmentWidths, sinceText, waitingText } from "../progress-ui";
import { S } from "../strings";
import { ExternalAuditList } from "./AuditPage";
import { ButlerRepliesList } from "./ButlerPage";
import { ProgressBody, StuckList } from "./ProgressPage";

const pr = (n: number, o: Partial<ProgressPr> = {}): ProgressPr => ({
  ticketKey: "T-1", prId: n, repo: "app", slug: "o/app", number: n, url: `https://github.com/o/app/pull/${n}`, title: `PR ${n}`, state: "open",
  isDraft: false, review: "pending", ci: "passing", headBranch: `b${n}`, baseBranch: "main", labels: [], author: "me", reviewers: [], reviewRequests: [],
  mergeable: "mergeable", mergeState: "clean", waitingOn: null, checkedAt: 500, statusChangedAt: 100, readError: false, ...o,
});

const HOUR = 3600_000;
const view = (): ProgressView => {
  const p1 = pr(1, { waitingOn: { who: "reviewers", names: ["alice"], reason: "review_requested" }, labels: ["ui"], title: "[auth] login" });
  const p2 = pr(2, { baseBranch: "b1", ci: "failing", waitingOn: { who: "author", names: ["me"], reason: "ci_failing" } });
  return {
    filter: { epicId: null, featureId: null },
    epics: [{ id: 10, name: "Q4" }],
    features: [{ id: 1, name: "Login", epicId: 10 }],
    counts: { merged: 1, blocked: 1, in_review: 1, in_progress: 0, not_started: 1, total: 4 },
    stuck: [
      { ticketKey: "T-2", ticketTitle: "crash", featureId: 1, pr: p2, waitingOn: p2.waitingOn!, since: 0 },
      { ticketKey: "T-1", ticketTitle: "login", featureId: 1, pr: p1, waitingOn: p1.waitingOn!, since: 26 * HOUR },
    ],
    stacks: [{ repo: "app", stacks: [{ pr: p1, children: [{ pr: p2, children: [] }] }], single: [pr(3)] }],
    groups: { byLabel: [{ key: "ui", prs: [p1] }, { key: null, prs: [p2] }], byPrefix: [{ key: "auth", prs: [p1] }] },
    featureGroups: [
      {
        id: 1, name: "Login", epicId: 10, line: "Login works.", summaryAt: 50, prStatusAt: 60, stale: true,
        counts: { merged: 1, blocked: 1, in_review: 1, in_progress: 0, not_started: 0 },
        tickets: [{ key: "T-1", title: "login", featureId: 1, bucket: "in_review", prs: 2, openPrs: 1 }],
      },
      { id: null, name: null, epicId: null, line: null, summaryAt: null, prStatusAt: null, stale: false, counts: { merged: 0, blocked: 0, in_review: 0, in_progress: 0, not_started: 1 }, tickets: [{ key: "X-9", title: null, featureId: null, bucket: "not_started", prs: 0, openPrs: 0 }] },
    ],
    freshness: { generatedAt: 27 * HOUR, prsCheckedOldest: 500, prsCheckedNewest: 900, readErrors: 1, unread: 2, summaryOldest: 50 },
  };
};

const noop = () => {};

describe("progress-ui helpers", () => {
  it("writes how long something has waited", () => {
    expect(sinceText(null, 0)).toBe(S.progress.unknownSince);
    expect(sinceText(1000, 1000)).toBe(S.durationNow);
    expect(sinceText(0, 5 * 60_000)).toBe(S.durationMinutes(5));
    expect(sinceText(0, 2 * HOUR + 60_000)).toBe(S.durationHours(2, 1));
    expect(sinceText(0, 50 * HOUR)).toBe(S.progress.durationDays(2, 2));
  });

  it("names who a PR waits on, and flattens a stack by depth", () => {
    expect(waitingText({ who: "reviewers", names: ["a", "b"], reason: "review_requested" })).toBe(S.labelled(S.progress.who.reviewers, "a, b"));
    expect(waitingText({ who: "ci", names: [], reason: "ci_pending" })).toBe(S.progress.who.ci);
    expect(flattenStack(view().stacks[0].stacks).map((x) => [x.pr.number, x.depth])).toEqual([[1, 0], [2, 1]]);
  });

  it("splits the summary bar by count and copes with zero tickets", () => {
    expect(segmentWidths({ a: 1, b: 3 }, ["a", "b"], 4)).toEqual({ a: 25, b: 75 });
    expect(segmentWidths({ a: 0, b: 0 }, ["a", "b"], 0)).toEqual({ a: 0, b: 0 });
  });
});

describe("the Progress page body", () => {
  const html = renderToStaticMarkup(createElement(ProgressBody, { view: view(), onOpenTicket: noop, onOpenFeature: noop }));

  it("shows every block", () => {
    for (const id of ["progress-summary", "progress-stuck", "progress-stacks", "progress-prs", "progress-features", "progress-freshness"]) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
  });

  it("puts each bucket's count in the summary bar, with its definition as a hint", () => {
    expect(html).toContain(S.progress.total(4));
    expect(html).toContain(S.progress.buckets.in_review);
    expect(html).toContain(`title="${S.progress.bucketDefs.blocked}"`);
  });

  it("lists who each PR waits on and for how long", () => {
    expect(html).toContain(S.progress.reasons.ci_failing);
    expect(html).toContain(S.labelled(S.progress.who.reviewers, "alice"));
    expect(html).toContain(S.durationHours(1, 0));
    expect(html).toContain(S.progress.durationDays(1, 3));
  });

  it("draws the stack, the grouped table, feature lines and freshness", () => {
    expect(html).toContain("b2 → b1");
    expect(html).toContain(S.progress.stackSingles(1));
    expect(html).toContain(S.progress.noLabel);
    expect(html).toContain("Login works.");
    expect(html).toContain(S.progress.stale);
    expect(html).toContain(S.progress.loose);
    expect(html).toContain(S.progress.freshnessUnread(2));
    expect(html).toContain(S.progress.freshnessErrors(1));
  });

  it("says so when no PR is waiting", () => {
    const empty = renderToStaticMarkup(createElement(StuckList, { stuck: [], now: 0, onOpenTicket: noop }));
    expect(empty).toContain(S.progress.stuckNone);
  });
});

describe("Butler replies tab", () => {
  const m = (o: Partial<ButlerMessageView>): ButlerMessageView => ({
    requestId: "r1", target: "feature Login", targetSession: "s1", status: "waiting", error: null, text: "status?", queuedAt: new Date(0).toISOString(),
    reply: null, repliedAt: null, deliveredAt: null, ...o,
  });

  it("lists each message with its status and reply", () => {
    const html = renderToStaticMarkup(createElement(ButlerRepliesList, { messages: [m({ status: "delivered", reply: "all green", repliedAt: new Date(0).toISOString() }), m({ requestId: "r2" })] }));
    expect(html).toContain("all green");
    expect(html).toContain(S.butlerMessageStatus.delivered);
    expect(html).toContain(S.butlerMessageStatus.waiting);
  });

  it("says so when nothing was sent", () => {
    expect(renderToStaticMarkup(createElement(ButlerRepliesList, { messages: [] }))).toContain(S.butlerRepliesNone);
  });
});

describe("outward actions audit", () => {
  it("shows the action, where, outcome and error", () => {
    const e: ExternalActionEntry = { id: 1, ts: 0, kind: "pr_label", repoSlug: "o/app", ticketKey: "T-1", target: "#3", summary: "add ui", payload: null, outcome: "failed", error: "403" };
    const html = renderToStaticMarkup(createElement(ExternalAuditList, { entries: [e, { ...e, id: 2, outcome: "skipped", error: null }] }));
    expect(html).toContain(S.externalActions.pr_label.label);
    expect(html).toContain("o/app · T-1");
    expect(html).toContain(S.labelled(S.externalOutcome.failed, "403"));
    expect(html).toContain(S.externalOutcome.skipped);
  });
});

describe("review badges and queue on the Progress page (ws-g)", () => {
  const q = (prId: number, o: Partial<import("../../../shared/prereview").ReviewQueueItem> = {}) => ({
    prId, ticketKey: "T-1", url: `u${prId}`, number: prId, title: `PR ${prId}`, repoSlug: "o/app", risk: "high" as const, ready: false,
    missing: [{ key: "evidence" as const, state: "fail" as const, detail: "" }], openedAt: 1, ...o,
  });

  it("hides the queue until it is read, then lists only PRs in this view with badges", () => {
    const none = renderToStaticMarkup(createElement(ProgressBody, { view: view(), onOpenTicket: noop }));
    expect(none).not.toContain('data-testid="progress-review-queue"');
    const html = renderToStaticMarkup(createElement(ProgressBody, { view: view(), onOpenTicket: noop, queue: [q(1), q(99)] }));
    expect(html).toContain('data-testid="progress-review-queue"');
    expect(html).toContain('data-testid="review-queue-1"');
    expect(html).not.toContain('data-testid="review-queue-99"');
    expect(html).toContain(S.rv.riskBadge(S.rv.level.high));
    expect(html).toContain(S.rv.missing(S.rv.cond.evidence));
  });

  it("says so when nothing waits for review", () => {
    const html = renderToStaticMarkup(createElement(ProgressBody, { view: view(), onOpenTicket: noop, queue: [] }));
    expect(html).toContain(S.rv.queueNone);
  });
});
