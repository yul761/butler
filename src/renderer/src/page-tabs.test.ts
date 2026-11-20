import { describe, expect, it } from "vitest";
import { pickTab, resolveTab } from "./page-tabs";

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
});

describe("resolveTab", () => {
  const t = ["overview", "pr", "log"];
  it("uses the remembered tab", () => expect(resolveTab("log", null, t, "overview")).toBe("log"));
  it("drops a remembered tab that is gone", () => expect(resolveTab("gone", null, t, "overview")).toBe("overview"));
  it("the landing tab beats the remembered one", () => expect(resolveTab("log", "pr", t, "overview")).toBe("pr"));
  it("a landing tab that does not exist counts as none", () => expect(resolveTab(null, "nope", t, "overview")).toBe("overview"));
  it("no tabs gives empty", () => expect(resolveTab("", null, [], "x")).toBe(""));
});
