import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCollapsed } from "../local-prefs";
import { S } from "../strings";
import { TicketPrRows } from "./PrStages";
import { TicketLogTab } from "./TicketLogTab";
import { TicketPrBody } from "./TicketPrTab";

describe("TicketPrBody", () => {
  // 「阶段」的开合读写 localStorage：给一个内存里的。
  const store = new Map<string, string>();
  beforeEach(() => vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k),
  }));
  afterEach(() => { store.clear(); vi.unstubAllGlobals(); });
  const render = () => renderToStaticMarkup(
    createElement(TicketPrBody, { ticketKey: "BTL-1", stages: createElement(TicketPrRows, { rows: [] }), review: "REVIEW", comments: "COMMENTS" }),
  );
  it("the six stages start collapsed (BTL-244); review and comments stay open", () => {
    const html = render();
    expect(html).toContain(S.lay.prSecStages);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain(S.prNoRepos);
    expect(html).toContain("REVIEW");
    expect(html).toContain("COMMENTS");
  });
  it("stacks stages, review and comments under their own headings", () => {
    setCollapsed("ticket-pr-stages:BTL-1", false, true);
    const html = render();
    expect(html).toContain(`${S.lay.prSecStages}</button></h3>`);
    expect(html).toContain(`<h3>${S.lay.prSecReview}</h3>`);
    expect(html).toContain(`<h3>${S.lay.prSecComments}</h3>`);
    expect(S.lay.prSecStages).toBe("阶段");
    expect(S.lay.prSecReview).toBe("CI · review · 风险 · 就绪");
    expect(S.lay.prSecComments).toBe("未处理的评论");
    expect(html.indexOf(S.lay.prSecStages)).toBeLessThan(html.indexOf("REVIEW"));
    expect(html.indexOf("REVIEW")).toBeLessThan(html.indexOf("COMMENTS"));
  });
  it("with no PR the stages part says so instead of throwing", () => {
    setCollapsed("ticket-pr-stages:BTL-1", false, true);
    expect(render()).toContain(S.prNoRepos);
  });
});

describe("TicketLogTab", () => {
  const html = renderToStaticMarkup(createElement(TicketLogTab, { ticketKey: "BTL-1" }));
  it("shows follow-ups, handoffs and memory as three sections, not toggles", () => {
    expect(html).toContain(`>${S.lay.logFollowups}<`);
    expect(html).toContain(`>${S.lay.logHandoffs}<`);
    expect(html).toContain(`>${S.lay.logMemory}<`);
    expect([S.lay.logFollowups, S.lay.logHandoffs, S.lay.logMemory]).toEqual(["待跟进", "状态记录", "记忆"]);
    expect(html).not.toContain("overview-panel");
    expect(html).toContain(S.noFollowups);
    expect(html).toContain(S.noHandoffs);
  });
  it("lists the status history without the update button: that lives on the overview (BTL-244)", () => {
    expect(html).not.toContain(`>${S.runHandoff}</button>`);
    expect(html.indexOf(S.lay.logHandoffs)).toBeLessThan(html.indexOf(S.lay.logMemory));
  });
});
