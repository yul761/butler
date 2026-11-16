import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageTabs } from "./PageTabs";

describe("PageTabs while collapsed (the default)", () => {
  const html = renderToStaticMarkup(
    createElement(PageTabs, {
      page: "test-page",
      defaultTab: "decisions",
      tabs: [
        { id: "decisions", label: createElement("span", null, "待你决定", createElement("span", { className: "count" }, 3)), content: "BODY", className: "attention" },
        { id: "reports", label: "汇报", content: "OTHER" },
      ],
    }),
  );

  it("renders no panel and selects no tab", () => {
    expect(html).toContain("page-tabs collapsed");
    expect(html).not.toContain("BODY");
    expect(html).not.toContain('aria-selected="true"');
  });

  it("keeps the red attention mark and the count on the tab", () => {
    expect(html).toMatch(/class="page-tab tab-decisions attention"/);
    expect(html).toContain('<span class="count">3</span>');
  });

  it("has a toggle that says it expands", () => {
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("展开，回到上次停的 tab");
  });
});
