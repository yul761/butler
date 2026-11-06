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

  it("classifies git rebase and git pull --rebase as rebase, not push", () => {
    expect(classifyCommand("git rebase origin/main").kind).toBe("rebase");
    expect(classifyCommand("git pull --rebase").kind).toBe("rebase");
    expect(classifyCommand("git pull --rebase && git push").kind).toBe("rebase");
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
    applyEntry(s, toolResult("t1", "Command running in background with ID: abc. Output is being written to: /tmp/x/abc.output. You will be notified when it completes — do not poll that file or sleep while waiting.", { toolUseResult: { backgroundTaskId: "abc" } }));
    expect(currentTool(s)).toBeNull();
    expect(backgroundTasks(s)).toEqual([
      { taskId: "abc", toolUseId: "t1", command: "pnpm dev", outputFile: "/tmp/x/abc.output", startedAt: Date.parse("2026-10-31T10:00:00.000Z") },
    ]);
    applyEntry(s, { type: "queue-operation", operation: "enqueue", content: "<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>" });
    expect(backgroundTasks(s)).toEqual([]);
  });

  it("reads the output file from the real tool_result text, including a path with a space", () => {
    // 真实文本里路径后面还有同一行的句子
    const real = "Command running in background with ID: b1r0793pr. Output is being written to: /private/tmp/claude-501/-Users-x-Code/44425d07-c421-4d49-a213-e41f12ddcad9/tasks/b1r0793pr.output. You will be notified when it completes \u2014 do not poll that file or sleep while waiting.";
    const spaced = "Command running in background with ID: sp1. Output is being written to: /tmp/my dir/tasks/sp1.output. You will be notified.";
    const eol = "Output is being written to: /tmp/x/eol.output.";
    const bare = "Output is being written to: /tmp/x/bare.output";
    const out = (id: string, text: string) => {
      const s = newTranscriptState();
      applyEntry(s, toolUse("t1", "Bash", { command: "x" }));
      applyEntry(s, toolResult("t1", text, { toolUseResult: { backgroundTaskId: id } }));
      return backgroundTasks(s)[0].outputFile;
    };
    expect(out("b1r0793pr", real)).toBe("/private/tmp/claude-501/-Users-x-Code/44425d07-c421-4d49-a213-e41f12ddcad9/tasks/b1r0793pr.output");
    expect(out("sp1", spaced)).toBe("/tmp/my dir/tasks/sp1.output");
    expect(out("eol", eol)).toBe("/tmp/x/eol.output");
    expect(out("bare", bare)).toBe("/tmp/x/bare.output");
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
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Command running in background with ID: abc. Output is being written to: /tmp/x/abc.output. You will be notified when it completes — do not poll that file or sleep while waiting." }, { type: "text", text: "go on" }] },
    });
    expect(backgroundTasks(s).map((b) => b.taskId)).toEqual(["abc"]);
  });

  it("clears a tool that never got a result when the turn ends, keeping background tasks", () => {
    const s = newTranscriptState();
    applyEntry(s, toolUse("t1", "Bash", { command: "pnpm dev" }));
    applyEntry(s, toolResult("t1", "Command running in background with ID: abc. Output is being written to: /tmp/x/abc.output. You will be notified when it completes — do not poll that file or sleep while waiting.", { toolUseResult: { backgroundTaskId: "abc" } }));
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

  describe("an interrupt (Esc)", () => {
    const say = (content: unknown) => ({ type: "user", message: { role: "user", content } });

    it.each([
      ["a plain interrupt", "[Request interrupted by user]"],
      ["an interrupt during a tool", "[Request interrupted by user for tool use]"],
      ["text blocks", [{ type: "text", text: "[Request interrupted by user]" }]],
    ])("ends the turn and clears running tools: %s", (_name, content) => {
      const s = newTranscriptState();
      applyEntry(s, toolUse("t1", "Bash", { command: "sleep 99" }));
      expect(s.turnOpen).toBe(true);
      applyEntry(s, say(content));
      expect(s.turnOpen).toBe(false);
      expect(currentTool(s)).toBeNull();
    });

    it("leaves background tasks alone", () => {
      const s = newTranscriptState();
      applyEntry(s, toolUse("t1", "Bash", { command: "pnpm dev" }));
      applyEntry(s, toolResult("t1", "Command running in background with ID: abc. Output is being written to: /tmp/x/abc.output. You will be notified when it completes — do not poll that file or sleep while waiting.", { toolUseResult: { backgroundTaskId: "abc" } }));
      applyEntry(s, say("[Request interrupted by user]"));
      expect(s.turnOpen).toBe(false);
      expect(backgroundTasks(s).map((b) => b.taskId)).toEqual(["abc"]);
    });

    it("handles the tool result in the same entry", () => {
      const s = newTranscriptState();
      applyEntry(s, toolUse("t1", "Bash", { command: "pnpm dev" }));
      applyEntry(s, say([{ type: "tool_result", tool_use_id: "t1", content: "stopped" }, { type: "text", text: "[Request interrupted by user for tool use]" }]));
      expect(s.turnOpen).toBe(false);
      expect(currentTool(s)).toBeNull();
    });

    it("opens the next turn on the next real message", () => {
      const s = newTranscriptState();
      applyEntry(s, say("[Request interrupted by user]"));
      applyEntry(s, say("try again"));
      expect(s.turnOpen).toBe(true);
    });

    it("does not mistake a message that only mentions it", () => {
      const s = newTranscriptState();
      applyEntry(s, say("why did I see [Request interrupted by user] just now?"));
      expect(s.turnOpen).toBe(true);
    });
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

describe("lastReply (task 11: end_session)", () => {
  const say = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content }, ...extra });

  it("is null until the assistant writes text, then the latest text reply", () => {
    const s = newTranscriptState();
    expect(s.lastReply).toBeNull();
    applyEntry(s, toolUse("t1", "Bash", { command: "ls" }));
    expect(s.lastReply).toBeNull();
    applyEntry(s, say([{ type: "text", text: "第一段" }, { type: "tool_use", id: "t2", name: "Read", input: {} }, { type: "text", text: "第二段" }]));
    expect(s.lastReply).toBe("第一段\n第二段");
    applyEntry(s, say([{ type: "text", text: "PR 已经合并了，要我关掉吗？" }]));
    expect(s.lastReply).toBe("PR 已经合并了，要我关掉吗？");
  });

  it("keeps the last text over tool-only and blank entries, and ignores sub-agents", () => {
    const s = newTranscriptState();
    applyEntry(s, say([{ type: "text", text: "做完了" }]));
    applyEntry(s, toolUse("t3", "Bash", { command: "ls" }));
    applyEntry(s, say([{ type: "text", text: "  " }]));
    applyEntry(s, say([{ type: "text", text: "子 agent 的话" }], { isSidechain: true }));
    applyEntry(s, say([{ type: "thinking", thinking: "想一想" }]));
    expect(s.lastReply).toBe("做完了");
  });
});
