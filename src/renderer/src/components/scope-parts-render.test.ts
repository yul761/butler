import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScopeBar, WhoTag } from "./ScopeParts";

describe("scope parts", () => {
  it("WhoTag shows the label with the turn tone", () => {
    const html = renderToStaticMarkup(createElement(WhoTag, { turn: { owner: "you", kind: "merge", risk: null } }));
    expect(html).toContain('class="who turn-tag turn-merge"');
    expect(html).toContain("你");
  });
  it("ScopeBar is empty without tickets", () => {
    expect(renderToStaticMarkup(createElement(ScopeBar, { bar: { done: 0, agent: 0, you: 0, external: 0, idle: 0 }, total: 0 }))).toBe("");
  });
  it("ScopeBar draws one segment per non-empty owner", () => {
    const html = renderToStaticMarkup(createElement(ScopeBar, { bar: { done: 1, agent: 0, you: 1, external: 0, idle: 0 }, total: 2 }));
    expect(html).toBe('<div class="turn-bar"><i class="turn-done" style="width:50%"></i><i class="turn-ask" style="width:50%"></i></div>');
  });
});
