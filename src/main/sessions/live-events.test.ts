import { describe, expect, it } from "vitest";
import { LABEL_LIMIT, liveEvent, memoryKind, toolLabel } from "./live-events";

describe("memoryKind (BTL-190 7)", () => {
  it("remember and handoff write, recall, facts and why read, on any memory server", () => {
    for (const n of ["mcp__butler-memory__remember", "mcp__butler-feature__handoff", "mcp__statecore__remember"]) expect(memoryKind(n)).toBe("memory-write");
    for (const n of ["mcp__butler-workspace__recall", "mcp__butler-memory__facts", "mcp__statecore__why"]) expect(memoryKind(n)).toBe("memory-read");
  });

  it("anything else is a plain tool, including forget and names that only contain the word", () => {
    for (const n of ["Read", "Bash", "mcp__butler-memory__forget", "remember", "mcp__x__remember_me", "mcp__x__recall2", "Recall"]) expect(memoryKind(n)).toBeNull();
  });
});

describe("toolLabel", () => {
  it("summarises the common tools by their main argument", () => {
    expect(toolLabel("Bash", { command: "pnpm test --run\nsecond line" })).toBe("Bash pnpm test --run");
    expect(toolLabel("Edit", { file_path: "/repo/src/notify.ts" })).toBe("Edit notify.ts");
    expect(toolLabel("Write", { file_path: "C:\\repo\\a.md" })).toBe("Write a.md");
    expect(toolLabel("Read", { file_path: "/repo/README.md" })).toBe("Read README.md");
    expect(toolLabel("NotebookEdit", { notebook_path: "/n/x.ipynb" })).toBe("NotebookEdit x.ipynb");
    expect(toolLabel("Grep", { pattern: "buildNowView" })).toBe("Grep buildNowView");
    expect(toolLabel("Glob", { pattern: "**/*.ts" })).toBe("Glob **/*.ts");
    expect(toolLabel("Agent", { description: "find the IPC" })).toBe("Agent find the IPC");
    expect(toolLabel("WebFetch", { url: "https://example.com" })).toBe("WebFetch https://example.com");
    expect(toolLabel("TodoWrite", { todos: [] })).toBe("TodoWrite");
  });

  it("writes MCP tools as tool (server)", () => {
    expect(toolLabel("mcp__butler-sessions__list_sessions", {})).toBe("list_sessions (butler-sessions)");
  });

  it("memory tools show what was written or asked, falling back to the tool name", () => {
    expect(toolLabel("mcp__butler-memory__remember", { text: "  接口改成\n v2 " })).toBe("接口改成 v2");
    expect(toolLabel("mcp__butler-feature__handoff", { summary: "做完了登录页" })).toBe("做完了登录页");
    expect(toolLabel("mcp__butler-memory__recall", { query: "checkout totals" })).toBe("checkout totals");
    expect(toolLabel("mcp__butler-memory__recall", {})).toBe("recall");
    expect(toolLabel("mcp__butler-memory__facts", {})).toBe("facts");
    expect(toolLabel("mcp__butler-memory__why", { factId: "f_12" })).toBe("f_12");
  });

  it("is one line of at most LABEL_LIMIT characters", () => {
    const long = toolLabel("Bash", { command: `echo ${"字".repeat(200)}` });
    expect([...long].length).toBe(LABEL_LIMIT);
    expect(long.endsWith("…")).toBe(true);
    expect(toolLabel("mcp__m__remember", { text: "a\r\nb\tc" })).toBe("a b c");
  });
});

describe("liveEvent", () => {
  it("turns transcript events into activity events for a session", () => {
    expect(liveEvent("s1", { type: "tool", at: 5, name: "Read", input: { file_path: "/a/b.ts" } })).toEqual({ sessionId: "s1", at: 5, kind: "tool", label: "Read b.ts" });
    expect(liveEvent("s1", { type: "tool", at: 6, name: "mcp__butler-memory__remember", input: { text: "x" } })).toEqual({ sessionId: "s1", at: 6, kind: "memory-write", label: "x" });
    expect(liveEvent("s1", { type: "tool", at: 7, name: "mcp__butler-memory__recall", input: {} })).toEqual({ sessionId: "s1", at: 7, kind: "memory-read", label: "recall" });
    expect(liveEvent("s1", { type: "turn-start", at: 8 })).toEqual({ sessionId: "s1", at: 8, kind: "turn-start", label: "" });
    expect(liveEvent("s1", { type: "turn-end", at: 9 })).toEqual({ sessionId: "s1", at: 9, kind: "turn-end", label: "" });
  });
});
