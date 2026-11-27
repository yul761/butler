import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { noPreReview, type PreReviewBadge, type PreReviewQueueItem, type PreReviewQueueView } from "../../../shared/prereview";
import { S } from "../strings";
import { PreReviewChip, TicketChip } from "./PreReviewChip";
import { PreReviewQueueBody } from "./PreReviewQueuePage";

const b = (o: Partial<PreReviewBadge>): PreReviewBadge => ({ ...noPreReview("T-1"), id: 1, ...o });
const item = (o: Partial<PreReviewQueueItem> & { id: number }): PreReviewQueueItem => ({ ...b(o), jobId: o.id, prNumber: null, prUrl: null, ending: null, ...o });
const page = (q: PreReviewQueueView) =>
  renderToStaticMarkup(createElement(PreReviewQueueBody, { q, now: 10 * 60_000, onOpenTicket: () => {}, onOpenSettings: () => {} }));

describe("pre-review chip (BTL-271)", () => {
  it("shows the state, and hides 'not reviewed' where asked (session and PR rows)", () => {
    const html = renderToStaticMarkup(createElement(PreReviewChip, { badge: b({ state: "violations", violations: 2 }) }));
    expect(html).toContain('data-testid="prereview-chip"');
    expect(html).toContain('data-state="violations"');
    expect(html).toContain(S.prq.violations(2));
    expect(renderToStaticMarkup(createElement(PreReviewChip, { badge: noPreReview("T-1") }))).toContain(S.prq.none);
    expect(renderToStaticMarkup(createElement(PreReviewChip, { badge: noPreReview("T-1"), hideNone: true }))).toBe("");
    expect(renderToStaticMarkup(createElement(PreReviewChip, { badge: null }))).toBe("");
  });

  it("a ticket with pre-review switched off and never reviewed shows nothing; one reviewed before still shows its result", () => {
    const ticket = (overall: PreReviewBadge, enabled: boolean) => renderToStaticMarkup(createElement(TicketChip, { status: { ticketKey: "T-1", overall, items: [], enabled } }));
    expect(ticket(noPreReview("T-1"), true)).toContain(S.prq.none);
    // 预审关着（全局或 epic 档位）：不显示「未预审」（TurnCard、ScopeParts、ticket 页都用这一枚）。
    expect(ticket(noPreReview("T-1"), false)).toBe("");
    expect(ticket(b({ state: "violations", violations: 1 }), false)).toContain(S.prq.violations(1));
  });

  it("a running one says it is running", () => {
    const html = renderToStaticMarkup(createElement(PreReviewChip, { badge: b({ state: "running", startedAt: Date.now() }) }));
    expect(html).toContain('data-state="running"');
    expect(html).toContain(S.prq.running(0));
  });
});

describe("pre-review queue page (BTL-271)", () => {
  it("lists running and queued with ticket, PR, trigger and times; the first queued cannot move to the front", () => {
    const html = page({
      concurrency: 2, stopped: null, ending: [],
      running: [item({ id: 1, state: "running", ticketKey: "T-1", prNumber: 12, prUrl: "https://github.com/o/app/pull/12", trigger: "pr", startedAt: 5 * 60_000 })],
      queued: [item({ id: 2, state: "queued", position: 1, ticketKey: "T-2", trigger: "evidence", enqueuedAt: 6 * 60_000 }), item({ id: 3, state: "queued", position: 2, ticketKey: "T-3", waiting: "worktree" })],
    });
    expect(html).toContain('data-testid="prereview-running"');
    expect(html).toContain("T-1");
    expect(html).toContain("#12");
    expect(html).toContain(S.prq.trigger.pr);
    expect(html).toContain(S.prq.running(5));
    expect(html).toContain(S.prq.queued(1));
    expect(html).toContain(S.prq.waiting.worktree);
    expect(html).toContain(S.prq.concurrency(2));
    expect(html).toMatch(/data-testid="prereview-front-2"[^>]*disabled/);
    expect(html).not.toMatch(/data-testid="prereview-front-3"[^>]*disabled/);
    expect(html).toContain('data-testid="prereview-cancel-3"');
  });

  it("says why the queue is stopped", () => {
    const html = page({ concurrency: 2, running: [], ending: [], queued: [item({ id: 2, state: "paused", reason: "memory", position: 1 })], stopped: { reason: "memory", until: null } });
    expect(html).toContain(S.prq.stopped(S.prq.reason.memory));
    expect(html).toContain(S.prq.paused(S.prq.reason.memory));
  });

  it("says when there is nothing", () => {
    expect(page({ concurrency: 2, running: [], ending: [], queued: [], stopped: null })).toContain(S.prq.empty);
  });

  it("shows cancelled and finished runs that are still stopping as cancelling / finishing, apart from running and with no buttons", () => {
    const html = page({
      concurrency: 2, stopped: null, running: [], queued: [],
      ending: [item({ id: 4, state: "running", ending: "cancelling", ticketKey: "T-4", startedAt: 5 * 60_000 }), item({ id: 5, state: "clean", ending: "finishing", ticketKey: "T-5" })],
    });
    expect(html).not.toContain(S.prq.empty);
    expect(html).toContain('data-testid="prereview-ending"');
    expect(html).toMatch(/data-testid="prereview-item-4" data-state="cancelling"/);
    expect(html).toContain(S.prq.ending.cancelling);
    expect(html).toContain(S.prq.ending.finishing);
    // 不说「预审中」，也没有取消、插队的按钮。
    expect(html).not.toContain(S.prq.running(5));
    expect(html).not.toContain('data-testid="prereview-cancel-4"');
    expect(html).not.toContain('data-testid="prereview-running"');
  });
});
