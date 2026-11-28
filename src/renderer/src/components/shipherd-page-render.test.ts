import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MessageView } from "../../../shared/types";
import { S } from "../strings";
import { ShipherdLayout } from "./ShipherdPage";
import { MessageListSummary } from "./MessageList";

const layout = () =>
  renderToStaticMarkup(createElement(ShipherdLayout, { title: S.shipherdTitle, lede: S.shipherdIntro, meta: createElement("span", null, "/ws"), left: createElement("i", null, "L"), right: createElement("b", null, "R") }));

describe("ShipherdLayout", () => {
  it("has the title, the one-line lede and the split, but no page tabs", () => {
    const html = layout();
    expect(html).toContain('class="ticket-page shipherd-page"');
    expect(html).toContain(`<h2>${S.shipherdTitle}</h2>`);
    expect(S.shipherdTitle).toContain("总控");
    expect(html).toContain("管所有工作的那个 session：每天早上巡检、跨 epic 协调。子 session 的汇报都送到这里。");
    expect(html).toContain("control-split");
    expect(html).toContain("/ws");
    expect(html).not.toContain("page-tabs");
  });
});

describe("MessageListSummary (BTL-245)", () => {
  const msg = (status: MessageView["status"], extra: Partial<MessageView> = {}): MessageView => ({
    id: `m-${status}`, kind: "shipherd", from: "Shipherd 总控", to: "feature 登录 的总控", toSession: "s1", status, via: null, interrupt: false,
    text: "hi", queuedAt: "2026-11-03T09:00:00Z", deliveredAt: null, reply: null, repliedAt: null, blocked: null, attempts: 0, lastAttemptAt: null, lastAttempt: null, ...extra,
  });
  it("is a closed details with the count; hidden until messages are known", () => {
    expect(renderToStaticMarkup(createElement(MessageListSummary, { messages: null }))).toBe("");
    const html = renderToStaticMarkup(createElement(MessageListSummary, { messages: [msg("queued"), msg("delivered")] }));
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain(S.lay.messages(2));
    expect(html).toContain("message-list");
  });
  it("shows each status, who sent it to whom, how it was delivered and the reply", () => {
    const html = renderToStaticMarkup(createElement(MessageListSummary, {
      messages: [
        msg("queued", { interrupt: true }),
        msg("delivered", { via: "hook", deliveredAt: "2026-11-03T09:01:00Z" }),
        msg("replied", { via: "input", deliveredAt: "2026-11-03T09:01:00Z", reply: "好的", repliedAt: "2026-11-03T09:05:00Z" }),
      ],
    }));
    for (const s of ["已排队", "已送达", "已回复"]) expect(html).toContain(s);
    expect(html).toContain("Shipherd 总控 → feature 登录 的总控");
    expect(html).toContain(S.messageInterrupt);
    expect(html).toContain(S.messageVia.hook);
    expect(html).toContain(S.messageVia.input);
    expect(html).toContain("好的");
  });
  it("says why a queued message has not got in yet and offers Deliver now; delivered ones have neither (BTL-269)", () => {
    const html = renderToStaticMarkup(createElement(MessageListSummary, {
      messages: [
        msg("queued", { id: "a", blocked: { reason: "unsure", since: "2026-11-03T09:02:00Z" } }),
        msg("queued", { id: "b" }),
        msg("delivered", { id: "c", deliveredAt: "2026-11-03T09:01:00Z" }),
      ],
    }));
    expect(html).toContain(S.mailboxBlocked.reason.unsure);
    expect(html.match(/data-testid="message-deliver-now"/g)).toHaveLength(2);
    expect(html.match(/data-testid="message-blocked"/g)).toHaveLength(2);
  });
  it("shows how many tries did not get a message in, when the last one was and why; it stays after delivery (BTL-279)", () => {
    const html = renderToStaticMarkup(createElement(MessageListSummary, {
      messages: [
        msg("queued", { id: "a", attempts: 7, lastAttemptAt: "2026-11-03T09:05:00Z", lastAttempt: "unsure", blocked: { reason: "unsure", since: "2026-11-03T09:02:00Z" } }),
        msg("delivered", { id: "b", attempts: 2, lastAttemptAt: "2026-11-03T09:01:00Z", lastAttempt: "recheck" }),
        msg("delivered", { id: "c" }),
      ],
    }));
    expect(html.match(/data-testid="message-attempts"/g)).toHaveLength(2);
    expect(html).toContain(S.mailboxBlocked.attempts(7, new Date("2026-11-03T09:05:00Z").toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }), S.mailboxBlocked.reason.unsure));
    expect(html).toContain(S.mailboxBlocked.attempt.recheck);
  });
  it("a queued patrol waiting on a busy turn says it goes in once the turn ends; other kinds and other reasons do not (BTL-279 sixth review)", () => {
    const html = renderToStaticMarkup(createElement(MessageListSummary, {
      messages: [
        msg("queued", { id: "p1", kind: "patrol", blocked: { reason: "turn", since: "2026-11-03T09:02:00Z" } }),
        msg("queued", { id: "p2", kind: "patrol", blocked: { reason: "closed", since: "2026-11-03T09:02:00Z" } }),
        msg("queued", { id: "p3", kind: "patrol" }),
        msg("queued", { id: "s1", blocked: { reason: "turn", since: "2026-11-03T09:02:00Z" } }),
      ],
    }));
    expect(html.match(/data-testid="message-patrol-eta"/g)).toHaveLength(1);
    expect(html).toContain(S.mailboxBlocked.patrolEta);
  });
  it("shows (0) and the empty line when there is nothing", () => {
    const html = renderToStaticMarkup(createElement(MessageListSummary, { messages: [] }));
    expect(html).toContain(S.lay.messages(0));
    expect(html).toContain(S.messagesNone);
  });
});
