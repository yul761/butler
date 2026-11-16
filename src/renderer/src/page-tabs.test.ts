import { describe, expect, it } from "vitest";
import { clickTab, pickTab } from "./page-tabs";

describe("page tabs", () => {
  const ids = ["progress", "tickets", "reports", "decisions"];

  it("uses the remembered tab while it still exists", () => {
    expect(pickTab("reports", ids, "progress")).toBe("reports");
    expect(pickTab(null, ids, "progress")).toBe("progress");
    expect(pickTab("archived", ids, "progress")).toBe("progress");
  });

  it("keeps a collapsed page collapsed", () => {
    expect(pickTab("", ids, "progress")).toBe("");
  });

  it("falls back to the first tab when the default is missing", () => {
    expect(pickTab(null, ["reports", "decisions"], "progress")).toBe("reports");
    expect(pickTab(null, [], "progress")).toBe("");
  });

  it("collapses on a second click of the open tab", () => {
    expect(clickTab("progress", "progress")).toBe("");
    expect(clickTab("progress", "tickets")).toBe("tickets");
    expect(clickTab("", "tickets")).toBe("tickets");
  });
});
