import { describe, expect, it } from "vitest";
import { landingDue, landingKey, pickTab, resolveTab } from "./page-tabs";

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

describe("forceTab is a one-shot landing", () => {
  const ids = ["progress", "reports", "archived"];
  it("lands on the forced tab first, then the user's pick wins even if forceTab is still passed", () => {
    let saved: string | null = resolveTab(null, "reports", ids, "progress"); // initial state
    expect(pickTab(saved, ids, "progress")).toBe("reports");
    saved = "archived"; // user clicks another tab; PageTabs renders with pickTab only
    expect(pickTab(saved, ids, "progress")).toBe("archived");
  });
});

describe("landingKey (forceSeq re-fires the same tab)", () => {
  it("is null without a landing", () => {
    expect(landingKey(null)).toBeNull();
    expect(landingKey(undefined, 3)).toBeNull();
  });
  it("changes when the sequence bumps, even for the same tab", () => {
    expect(landingKey("terminal", 1)).not.toBe(landingKey("terminal", 2));
    expect(landingKey("terminal", 1)).toBe(landingKey("terminal", 1));
  });
  it("without a sequence it only changes with the tab (existing callers)", () => {
    expect(landingKey("pr")).toBe(landingKey("pr"));
    expect(landingKey("pr")).not.toBe(landingKey("log"));
  });
});

describe("landingDue (a landing waits for its tab to appear)", () => {
  it("lands once the target tab is there, even if it shows up after the landing was asked for", () => {
    const key = landingKey("archived", 1);
    // 目标 tab 还没出现：先不落，也不算落过。
    expect(landingDue("archived", ["a", "b"], "p|" + key, null)).toBe(false);
    // tab 后出现：补落。
    expect(landingDue("archived", ["a", "b", "archived"], "p|" + key, null)).toBe(true);
    // 落过了：tab 列表再变也不再拉回去。
    expect(landingDue("archived", ["a", "archived"], "p|" + key, "p|" + key)).toBe(false);
    // 没有落点。
    expect(landingDue(null, ["a"], "p|null", null)).toBe(false);
  });
});
