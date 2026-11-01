import { describe, expect, it } from "vitest";
import { applyEntry, backgroundTasks, classifyCommand, currentTool, newTranscriptState } from "./activity-parse";

const toolUse = (id: string, name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  timestamp: "2026-10-31T10:00:00.000Z",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  ...extra,
});
const toolResult = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
  ...extra,
});

describe("classifyCommand", () => {
  it("classifies push, ci, test and other commands", () => {
    expect(classifyCommand("git push origin x").kind).toBe("push");
    expect(classifyCommand("gh run watch 123").kind).toBe("ci");
    expect(classifyCommand("gh pr checks 5 --watch").kind).toBe("ci");
    for (const c of ["pnpm test", "npx vitest run", "pytest -q", "go test ./...", "cargo test", "npx playwright test"]) {
      expect(classifyCommand(c).kind).toBe("test");
    }
    expect(classifyCommand("ls -la").kind).toBe("command");
  });
  it("truncates detail to 40 characters", () => {
    expect(classifyCommand("echo " + "a".repeat(100)).detail).toHaveLength(40);
  });
});

describe("applyEntry", () => {
  it("tracks tool_use until its tool_result", () => {
    const s = newTranscriptState();
    applyEntry(s, toolUse("t1", "Edit", { file_path: "/a/b.ts" }));
    expect(currentTool(s)).toMatchObject({ id: "t1", name: "Edit", file: "/a/b.ts", startedAt: Date.parse("2026-10-31T10:00:00.000Z") });
    applyEntry(s, toolResult("t1", "ok"));
    expect(currentTool(s)).toBeNull();
  });

  it("ignores sidechain entries", () => {
    const s = newTranscriptState();
    applyEntry(s, toolUse("t1", "Bash", { command: "ls" }, { isSidechain: true }));
    expect(currentTool(s)).toBeNull();
  });

  it("turns a backgrounded Bash call into a background task and clears it on notification", () => {
    const s = newTranscriptState();
    applyEntry(s, toolUse("t1", "Bash", { command: "pnpm dev" }));
    applyEntry(s, toolResult("t1", "Command running in background.\nOutput is being written to: /tmp/x/abc.output.", { toolUseResult: { backgroundTaskId: "abc" } }));
    expect(currentTool(s)).toBeNull();
    expect(backgroundTasks(s)).toEqual([
      { taskId: "abc", toolUseId: "t1", command: "pnpm dev", outputFile: "/tmp/x/abc.output", startedAt: Date.parse("2026-10-31T10:00:00.000Z") },
    ]);
    applyEntry(s, { type: "queue-operation", operation: "enqueue", content: "<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>" });
    expect(backgroundTasks(s)).toEqual([]);
  });

  it("tracks turnOpen", () => {
    const s = newTranscriptState();
    applyEntry(s, { type: "user", message: { role: "user", content: "fix it" } });
    expect(s.turnOpen).toBe(true);
    applyEntry(s, { type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } });
    expect(s.turnOpen).toBe(false);
    applyEntry(s, { type: "user", message: { role: "user", content: "again" } });
    applyEntry(s, { type: "system", subtype: "turn_duration" });
    expect(s.turnOpen).toBe(false);
    applyEntry(s, { type: "user", message: { role: "user", content: "more" } });
    applyEntry(s, { type: "system", subtype: "stop_hook_summary" });
    expect(s.turnOpen).toBe(false);
  });

  it("does not treat tool results as a new turn", () => {
    const s = newTranscriptState();
    applyEntry(s, toolResult("t1", "ok"));
    expect(s.turnOpen).toBe(false);
  });

  it("never throws on malformed entries", () => {
    const s = newTranscriptState();
    for (const e of [null, undefined, 42, "x", [], {}, { type: "assistant" }, { type: "assistant", message: { content: "x" } }, { type: "user", message: { content: [null, 1] } }, { type: "queue-operation" }]) {
      expect(() => applyEntry(s, e)).not.toThrow();
    }
  });
});

describe("applyEntry across turns", () => {
  it("handles tool_result blocks in a user entry that also has text", () => {
    const s = newTranscriptState();
    applyEntry(s, toolUse("t1", "Bash", { command: "ls" }));
    applyEntry(s, {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }, { type: "text", text: "also do this" }] },
    });
    expect(currentTool(s)).toBeNull();
    expect(s.turnOpen).toBe(true);
  });

  it("still records a background task from a mixed text and tool_result entry", () => {
    const s = newTranscriptState();
    applyEntry(s, toolUse("t1", "Bash", { command: "pnpm dev" }));
    applyEntry(s, {
      type: "user",
      toolUseResult: { backgroundTaskId: "abc" },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Output is being written to: /tmp/x/abc.output" }, { type: "text", text: "go on" }] },
    });
    expect(backgroundTasks(s).map((b) => b.taskId)).toEqual(["abc"]);
  });

  it("clears a tool that never got a result when the turn ends, keeping background tasks", () => {
    const s = newTranscriptState();
    applyEntry(s, toolUse("t1", "Bash", { command: "pnpm dev" }));
    applyEntry(s, toolResult("t1", "Output is being written to: /tmp/x/abc.output", { toolUseResult: { backgroundTaskId: "abc" } }));
    applyEntry(s, toolUse("t2", "Bash", { command: "sleep 99" }));
    applyEntry(s, { type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "stopped" }] } });
    expect(currentTool(s)).toBeNull();
    expect(backgroundTasks(s)).toHaveLength(1);

    applyEntry(s, toolUse("t3", "Bash", { command: "sleep 99" }));
    applyEntry(s, { type: "system", subtype: "turn_duration" });
    expect(currentTool(s)).toBeNull();
    applyEntry(s, toolUse("t4", "Bash", { command: "sleep 99" }));
    applyEntry(s, { type: "system", subtype: "stop_hook_summary" });
    expect(currentTool(s)).toBeNull();
    expect(backgroundTasks(s)).toHaveLength(1);
  });

  it("clears an orphan tool when a new real user message arrives", () => {
    const s = newTranscriptState();
    applyEntry(s, toolUse("t1", "Bash", { command: "sleep 99" }));
    applyEntry(s, { type: "user", message: { role: "user", content: "never mind" } });
    expect(currentTool(s)).toBeNull();
  });

  it("opens the turn on any assistant entry that is not end_turn (task notification restart)", () => {
    const s = newTranscriptState();
    applyEntry(s, { type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } });
    expect(s.turnOpen).toBe(false);
    applyEntry(s, { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "hm" }] } });
    expect(s.turnOpen).toBe(true);
    applyEntry(s, { type: "system", subtype: "turn_duration" });
    applyEntry(s, { type: "assistant", message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "streaming" }] } });
    expect(s.turnOpen).toBe(true);
  });
});
