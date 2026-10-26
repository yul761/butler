import { describe, expect, it } from "vitest";
import type { SessionView } from "../../shared/types";
import { sessionLabel, splitSessions } from "./sessions";

const s = (id: string, over: Partial<SessionView> = {}): SessionView => ({
  id, ticketKey: "T-1", cwd: "/w", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null,
  waitingForInput: false, replacedBy: null, dismissed: false, createdAt: 1, termId: null, repoId: null, coordinator: false, spawnedBy: null, featureId: null, ...over,
});

describe("sessionLabel", () => {
  it("uses the first prompt, collapsed to one line and truncated", () => {
    expect(sessionLabel(s("a", { firstPrompt: "修复登录页\n的 token 过期" }), "新对话")).toBe("修复登录页 的 token 过期");
    expect(sessionLabel(s("a", { firstPrompt: "x".repeat(40) }), "新对话")).toBe(`${"x".repeat(24)}…`);
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
