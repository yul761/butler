import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { S } from "../strings";
import { TicketPrRows } from "./PrStages";
import { TicketLogTab } from "./TicketLogTab";
import { TicketPrBody } from "./TicketPrTab";

describe("TicketPrBody", () => {
  const html = renderToStaticMarkup(
    createElement(TicketPrBody, { stages: createElement(TicketPrRows, { rows: [] }), review: "REVIEW", comments: "COMMENTS" }),
  );
  it("stacks stages, review and comments under their own headings", () => {
    expect(html).toContain(`<h3>${S.lay.prSecStages}</h3>`);
    expect(html).toContain(`<h3>${S.lay.prSecReview}</h3>`);
    expect(html).toContain(`<h3>${S.lay.prSecComments}</h3>`);
    expect(S.lay.prSecStages).toBe("阶段");
    expect(S.lay.prSecReview).toBe("CI · review · 风险 · 就绪");
    expect(S.lay.prSecComments).toBe("未处理的评论");
    expect(html.indexOf(S.lay.prSecStages)).toBeLessThan(html.indexOf("REVIEW"));
    expect(html.indexOf("REVIEW")).toBeLessThan(html.indexOf("COMMENTS"));
  });
  it("with no PR the stages part says so instead of throwing", () => {
    expect(html).toContain(S.prNoRepos);
  });
});

describe("TicketLogTab", () => {
  const html = renderToStaticMarkup(createElement(TicketLogTab, { ticketKey: "BTL-1" }));
  it("shows follow-ups, handoffs and memory as three sections, not toggles", () => {
    expect(html).toContain(`>${S.lay.logFollowups}<`);
    expect(html).toContain(`>${S.lay.logHandoffs}<`);
    expect(html).toContain(`>${S.lay.logMemory}<`);
    expect([S.lay.logFollowups, S.lay.logHandoffs, S.lay.logMemory]).toEqual(["待跟进", "交接记录", "记忆"]);
    expect(html).not.toContain("overview-panel");
    expect(html).toContain(S.noFollowups);
    expect(html).toContain(S.noHandoffs);
  });
  it("keeps the hand-off-now button next to the handoffs heading", () => {
    expect(html).toContain(`>${S.runHandoff}</button>`);
    const handoffs = html.indexOf(S.lay.logHandoffs);
    expect(handoffs).toBeLessThan(html.indexOf(S.runHandoff));
    expect(html.indexOf(S.runHandoff)).toBeLessThan(html.indexOf(S.lay.logMemory));
  });
});
