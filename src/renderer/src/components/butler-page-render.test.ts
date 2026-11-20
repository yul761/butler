import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ButlerMessageView } from "../../../shared/types";
import { S } from "../strings";
import { ButlerLayout, ButlerRepliesSummary } from "./ButlerPage";

const layout = () =>
  renderToStaticMarkup(createElement(ButlerLayout, { title: S.butlerTitle, lede: S.butlerIntro, meta: createElement("span", null, "/ws"), left: createElement("i", null, "L"), right: createElement("b", null, "R") }));

describe("ButlerLayout", () => {
  it("has the title, the one-line lede and the split, but no page tabs", () => {
    const html = layout();
    expect(html).toContain('class="ticket-page butler-page"');
    expect(html).toContain(`<h2>${S.butlerTitle}</h2>`);
    expect(S.butlerTitle).toContain("总控");
    expect(html).toContain("管所有 epic 的那个 session：每天早上巡检、跨 epic 协调。子 session 的汇报都送到这里。");
    expect(html).toContain("control-split");
    expect(html).toContain("/ws");
    expect(html).not.toContain("page-tabs");
  });
});

describe("ButlerRepliesSummary", () => {
  const msg = { requestId: "r1", target: "feature:1", text: "hi", status: "delivered", queuedAt: "2026-11-03T09:00:00Z", error: null, reply: null, repliedAt: null } as unknown as ButlerMessageView;
  it("is a closed details with the count; hidden until messages are known", () => {
    expect(renderToStaticMarkup(createElement(ButlerRepliesSummary, { messages: null }))).toBe("");
    const html = renderToStaticMarkup(createElement(ButlerRepliesSummary, { messages: [msg, msg] }));
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain(S.lay.butlerSent(2));
    expect(html).toContain("butler-replies");
  });
  it("shows (0) and the empty line when nothing has been sent", () => {
    const html = renderToStaticMarkup(createElement(ButlerRepliesSummary, { messages: [] }));
    expect(html).toContain(S.lay.butlerSent(0));
    expect(html).toContain(S.butlerRepliesNone);
  });
});
