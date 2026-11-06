import { describe, expect, it } from "vitest";
import { taskMessage } from "../../shared/control";
import type { SessionView } from "../../shared/types";
import { initialPane, sessionLabel, splitSessions } from "./sessions";

const s = (id: string, over: Partial<SessionView> = {}): SessionView => ({
  id, ticketKey: "T-1", cwd: "/w", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null,
  waitingForInput: false, replacedBy: null, dismissed: false, createdAt: 1, termId: null, repoId: null, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, epicId: null, model: null, ...over,
});

describe("sessionLabel", () => {
  it("uses the first prompt, collapsed to one line and truncated", () => {
    expect(sessionLabel(s("a", { firstPrompt: "修复登录页\n的 token 过期" }), "新对话")).toBe("修复登录页 的 token 过期");
    expect(sessionLabel(s("a", { firstPrompt: "x".repeat(40) }), "新对话")).toBe(`${"x".repeat(24)}…`);
  });

  it("shows the task itself for a session the coordinator started, in both languages", () => {
    for (const lang of ["zh", "en"] as const) {
      const firstPrompt = taskMessage("build the settings page with tabs", lang, "feature");
      expect(sessionLabel(s("a", { firstPrompt }), "新对话")).toBe("build the settings page …");
    }
  });

  it("falls back when there is no prompt yet", () => {
    expect(sessionLabel(s("a", { firstPrompt: "  " }), "新对话")).toBe("新对话");
    expect(sessionLabel(s("a"), "新对话")).toBe("新对话");
  });
});

describe("splitSessions", () => {
  it("shows the most recent ones up to the limit and hides the rest, keeping order", () => {
    const list = ["a", "b", "c", "d", "e"].map((id) => s(id));
    const { shown, hidden } = splitSessions(list, 3);
    expect(shown.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(hidden.map((x) => x.id)).toEqual(["d", "e"]);
  });

  it("always shows open and waiting sessions even when they are older", () => {
    const list = [s("a"), s("b"), s("c"), s("d", { termId: "d" }), s("e", { waitingForInput: true }), s("f")];
    const { shown, hidden } = splitSessions(list, 3);
    expect(shown.map((x) => x.id)).toEqual(["a", "d", "e"]);
    expect(hidden.map((x) => x.id)).toEqual(["b", "c", "f"]);
  });
});

describe("initialPane", () => {
  it("opens the coordinator terminal it names", () => {
    // 「现在」页点的是第二个总控：页面切到它的终端，不是第一个终端。/clear 过的 session 的终端号还是启动时的 id。
    const list = [s("c1", { termId: "c1", coordinator: true }), s("c2", { termId: "t-c2", coordinator: true })];
    expect(initialPane(list, "c2")).toBe("t-c2");
  });

  it("falls back to the first open terminal when nothing is named or the named one is not open", () => {
    const list = [s("a"), s("b", { termId: "b" }), s("c", { termId: "c" })];
    expect(initialPane(list, null)).toBe("b");
    expect(initialPane(list, undefined)).toBe("b");
    expect(initialPane(list, "a")).toBe("b");
    expect(initialPane(list, "gone")).toBe("b");
    expect(initialPane([s("a")], "a")).toBeNull();
  });
});
