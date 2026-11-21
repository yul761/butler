import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MessageView } from "../../../shared/types";
import { S } from "../strings";
import { ButlerLayout } from "./ButlerPage";
import { MessageListSummary } from "./MessageList";

const layout = () =>
  renderToStaticMarkup(createElement(ButlerLayout, { title: S.butlerTitle, lede: S.butlerIntro, meta: createElement("span", null, "/ws"), left: createElement("i", null, "L"), right: createElement("b", null, "R") }));

describe("ButlerLayout", () => {
  it("has the title, the one-line lede and the split, but no page tabs", () => {
    const html = layout();
    expect(html).toContain('class="ticket-page butler-page"');
    expect(html).toContain(`<h2>${S.butlerTitle}</h2>`);
    expect(S.butlerTitle).toContain("总控");
    expect(html).toContain("管所有工作的那个 session：每天早上巡检、跨 epic 协调。子 session 的汇报都送到这里。");
    expect(html).toContain("control-split");
    expect(html).toContain("/ws");
    expect(html).not.toContain("page-tabs");
  });
});

describe("MessageListSummary (BTL-245)", () => {
  const msg = (status: MessageView["status"], extra: Partial<MessageView> = {}): MessageView => ({
    id: `m-${status}`, kind: "butler", from: "Butler 总控", to: "feature 登录 的总控", toSession: "s1", status, via: null, interrupt: false,
    text: "hi", queuedAt: "2026-11-03T09:00:00Z", deliveredAt: null, reply: null, repliedAt: null, ...extra,
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
    expect(html).toContain("Butler 总控 → feature 登录 的总控");
    expect(html).toContain(S.messageInterrupt);
    expect(html).toContain(S.messageVia.hook);
    expect(html).toContain(S.messageVia.input);
    expect(html).toContain("好的");
  });
  it("shows (0) and the empty line when there is nothing", () => {
    const html = renderToStaticMarkup(createElement(MessageListSummary, { messages: [] }));
    expect(html).toContain(S.lay.messages(0));
    expect(html).toContain(S.messagesNone);
  });
});
