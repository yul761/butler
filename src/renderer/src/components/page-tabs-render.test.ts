import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageTabs } from "./PageTabs";

describe("PageTabs (always open)", () => {
  const html = renderToStaticMarkup(
    createElement(PageTabs, {
      page: "test-page",
      defaultTab: "overview",
      tabs: [
        { id: "overview", label: createElement("span", null, "概况", createElement("span", { className: "count" }, 3)), content: "BODY", className: "attention" },
        { id: "reports", label: "汇报", content: "OTHER" },
      ],
    }),
  );

  it("always selects exactly one tab and shows its content", () => {
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain("BODY");
    expect(html).not.toContain("OTHER");
  });

  it("has no collapse toggle", () => {
    expect(html).not.toContain("page-tabs-toggle");
    expect(html).not.toContain("collapsed");
  });

  it("keeps the attention mark and the count on the tab", () => {
    expect(html).toMatch(/class="page-tab tab-overview active attention"/);
    expect(html).toContain('<span class="count">3</span>');
  });

  it("lands on a valid forceTab on the first render, with no flash of the default", () => {
    const forced = renderToStaticMarkup(
      createElement(PageTabs, {
        page: "test-page-force",
        defaultTab: "overview",
        forceTab: "reports",
        tabs: [
          { id: "overview", label: "概况", content: "BODY" },
          { id: "reports", label: "汇报", content: "OTHER" },
        ],
      }),
    );
    expect(forced).toContain("OTHER");
    expect(forced).not.toContain("BODY");
  });
});
