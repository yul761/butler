import { describe, expect, it } from "vitest";
import { clickTab, pickTab, tabIsOpen, toggleTabs } from "./page-tabs";

describe("page tabs", () => {
  const ids = ["progress", "tickets", "reports", "decisions"];

  it("uses the last tab while it still exists", () => {
    expect(pickTab("reports", ids, "progress")).toBe("reports");
    expect(pickTab(null, ids, "progress")).toBe("progress");
    expect(pickTab("archived", ids, "progress")).toBe("progress");
  });

  it("reads a legacy empty value as no remembered tab", () => {
    expect(pickTab("", ids, "progress")).toBe("progress");
  });

  it("falls back to the first tab when the default is missing", () => {
    expect(pickTab(null, ["reports", "decisions"], "progress")).toBe("reports");
    expect(pickTab(null, [], "progress")).toBe("");
  });

  it("starts collapsed unless the open flag is 1", () => {
    expect(tabIsOpen(null)).toBe(false);
    expect(tabIsOpen("")).toBe(false);
    expect(tabIsOpen("1")).toBe(true);
  });

  it("collapses on a second click of the open tab and remembers it", () => {
    expect(clickTab({ tab: "progress", open: true }, "progress")).toEqual({ tab: "progress", open: false });
    expect(clickTab({ tab: "progress", open: true }, "tickets")).toEqual({ tab: "tickets", open: true });
  });

  it("opens the clicked tab while collapsed, even the remembered one", () => {
    expect(clickTab({ tab: "progress", open: false }, "progress")).toEqual({ tab: "progress", open: true });
    expect(clickTab({ tab: "progress", open: false }, "reports")).toEqual({ tab: "reports", open: true });
  });

  it("expanding with the toggle restores the last tab", () => {
    const collapsed = clickTab({ tab: "reports", open: true }, "reports");
    expect(toggleTabs(collapsed)).toEqual({ tab: "reports", open: true });
    expect(toggleTabs({ tab: "reports", open: true })).toEqual({ tab: "reports", open: false });
  });
});
