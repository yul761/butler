import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReviewQueueItem } from "../../../shared/prereview";
import { S } from "../strings";
import { AllWorkBody } from "./AllWorkPage";
import { ReviewQueueList } from "./ReviewQueue";

const noop = () => {};
const q = (prId: number, o: Partial<ReviewQueueItem> = {}): ReviewQueueItem => ({
  prId, ticketKey: "T-1", url: `u${prId}`, number: prId, title: `PR ${prId}`, repoSlug: "o/app", risk: "high", ready: false,
  missing: [{ key: "evidence", state: "fail", detail: "" }], openedAt: 1, ...o,
});
const html = (items: ReviewQueueItem[] | null) => renderToStaticMarkup(createElement(ReviewQueueList, { items, onOpenTicket: noop }));

describe("ReviewQueueList (待 review，全部工作页的「更多」里)", () => {
  it("one row per PR with repo#number, ticket, risk and readiness badges, missing conditions", () => {
    const h = html([q(51, { ready: true, missing: [] }), q(52)]);
    expect(h).toContain('data-testid="review-queue"');
    expect(h).toContain('data-testid="review-queue-51"');
    expect(h).toContain('data-testid="review-queue-52"');
    expect(h).toContain("o/app#51");
    expect(h).toContain(">T-1</button>");
    expect(h).toContain(S.rv.ready);
    expect(h).toContain(S.rv.notReady);
    expect(h).toContain(S.rv.riskBadge(S.rv.level.high));
    expect(h).toContain(S.rv.missing(S.rv.cond.evidence));
  });
  it("before the queue is read: heading only, no rows and no empty note", () => {
    const h = html(null);
    expect(h).toContain(S.rv.queueTitle);
    expect(h).not.toContain(S.rv.queueNone);
    expect(h).not.toContain("<table");
  });
  it("says so when nothing waits for review", () => {
    const h = html([]);
    expect(h).toContain(S.rv.queueNone);
    expect(h).not.toContain("<table");
  });
});

describe("AllWorkBody more section", () => {
  const props = { board: null, features: [], tickets: [], unclaimedCount: 0, now: 0, onNewTicket: noop, onNewFeature: noop, onGo: noop, onOpenTicket: noop };
  it("has the review queue next to stacks and intake when opened", () => {
    // focusMore 打开「更多」；静态渲染里队列还没取到数据，只有标题。
    const h = renderToStaticMarkup(createElement(AllWorkBody, { ...props, focusMore: "stacks" }));
    expect(h).toContain('data-testid="review-queue"');
    expect(h).toContain(S.rv.queueTitle);
  });
});
