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

  describe("a background task also ends", () => {
    /** 两个后台任务 a、b 在跑。 */
    const twoTasks = () => {
      const s = newTranscriptState();
      for (const id of ["a", "b"]) {
        applyEntry(s, toolUse(`bg-${id}`, "Bash", { command: `run ${id}`, run_in_background: true }));
        applyEntry(s, toolResult(`bg-${id}`, `Command running in background with ID: ${id}.`, { toolUseResult: { backgroundTaskId: id } }));
      }
      return s;
    };
    const ids = (s: ReturnType<typeof newTranscriptState>) => backgroundTasks(s).map((t) => t.taskId);
    // 真实 transcript 里 TaskStop 的结果：toolUseResult 带 task_id，内容是同样的 JSON 文本
    const stopped = (useId: string, taskId: string) =>
      toolResult(useId, JSON.stringify({ message: `Successfully stopped task: ${taskId} (run ${taskId})`, task_id: taskId }), {
        toolUseResult: { message: `Successfully stopped task: ${taskId} (run ${taskId})`, task_id: taskId, task_type: "local_bash", command: `run ${taskId}` },
      });

    it("when TaskStop stops it (toolUseResult.task_id)", () => {
      const s = twoTasks();
      applyEntry(s, toolUse("stop", "TaskStop", { task_id: "a" }));
      applyEntry(s, stopped("stop", "a"));
      expect(ids(s)).toEqual(["b"]);
    });

    it("when TaskStop's result has no task_id: the tool_use input's task_id counts, even for an error result", () => {
      const s = twoTasks();
      applyEntry(s, toolUse("stop", "TaskStop", { task_id: "b" }));
      applyEntry(s, toolResult("stop", "No task found with ID: b", { toolUseResult: "Error: No task found with ID: b" }));
      expect(ids(s)).toEqual(["a"]);
    });

    it("when KillShell kills it (shell_id in the result or the input)", () => {
      const s = twoTasks();
      applyEntry(s, toolUse("k1", "KillShell", { shell_id: "a" }));
      applyEntry(s, toolResult("k1", "Successfully killed shell: a (run a)", { toolUseResult: { message: "Successfully killed shell: a (run a)", shell_id: "a" } }));
      expect(ids(s)).toEqual(["b"]);
      applyEntry(s, toolUse("k2", "KillShell", { shell_id: "b" }));
      applyEntry(s, toolResult("k2", "ok"));
      expect(ids(s)).toEqual([]);
    });

    it("when the stop's tool_use fell outside the replayed tail but its result says it stopped the task", () => {
      const s = twoTasks();
      applyEntry(s, stopped("unseen", "a"));
      expect(ids(s)).toEqual(["b"]);
    });

    it("but not when another tool's result merely carries a task_id (TaskOutput)", () => {
      const s = twoTasks();
      applyEntry(s, toolUse("out", "TaskOutput", { task_id: "a" }));
      applyEntry(s, toolResult("out", "still running", { toolUseResult: { retrieval_status: "not_ready", task: { task_id: "a", status: "running" } } }));
      expect(ids(s)).toEqual(["a", "b"]);
    });

    it("on a <task-notification> in a user entry", () => {
      const s = twoTasks();
      applyEntry(s, { type: "user", message: { role: "user", content: "<task-notification>\n<task-id>a</task-id>\n<status>killed</status>\n</task-notification>" } });
      expect(ids(s)).toEqual(["b"]);
      applyEntry(s, { type: "user", message: { role: "user", content: [{ type: "text", text: "<task-notification>\n<task-id>b</task-id>\n<status>completed</status>\n</task-notification>" }] } });
      expect(ids(s)).toEqual([]);
    });

    it("on a <task-notification> in a queued_command attachment", () => {
      const s = twoTasks();
      applyEntry(s, { type: "attachment", attachment: { type: "queued_command", commandMode: "task-notification", prompt: "<task-notification>\n<task-id>b</task-id>\n<status>completed</status>\n</task-notification>" } });
      expect(ids(s)).toEqual(["a"]);
    });

    it("but not when a user message or a tool result only quotes a notification", () => {
      const s = twoTasks();
      applyEntry(s, { type: "user", message: { role: "user", content: "why did <task-notification><task-id>a</task-id></task-notification> show up?" } });
      applyEntry(s, toolResult("read", "line: <task-notification>\n<task-id>b</task-id>\n</task-notification>"));
      expect(ids(s)).toEqual(["a", "b"]);
    });
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

  it("keeps the message id of the entry the last reply came from, null when it has none", () => {
    const s = newTranscriptState();
    expect(s.lastReplyId).toBeNull();
    applyEntry(s, { type: "assistant", message: { id: "msg_1", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "要合并吗？" }] } });
    expect(s.lastReplyId).toBe("msg_1");
    applyEntry(s, { type: "assistant", message: { id: "msg_2", role: "assistant", stop_reason: null, content: [{ type: "tool_use", id: "t9", name: "Read", input: {} }] } });
    expect(s.lastReplyId).toBe("msg_1");
    applyEntry(s, say([{ type: "text", text: "没有 id" }]));
    expect(s.lastReply).toBe("没有 id");
    expect(s.lastReplyId).toBeNull();
  });
});

describe("events (BTL-190 7: the live window)", () => {
  const T0 = "2026-11-12T10:00:00.000Z";
  const at = (s: string) => Date.parse(s);
  const user = (content: unknown, timestamp = T0) => ({ type: "user", timestamp, message: { role: "user", content } });
  const reply = (stop: string | null, content: unknown[], timestamp = T0) => ({ type: "assistant", timestamp, message: { role: "assistant", stop_reason: stop, content } });

  it("records every tool_use with its name, input and time, in order", () => {
    const s = newTranscriptState();
    applyEntry(s, reply("tool_use", [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a/b.ts" } },
      { type: "tool_use", id: "t2", name: "mcp__butler-memory__remember", input: { text: "接口改成 v2" } },
    ], "2026-11-12T10:00:05.000Z"));
    expect(s.events.filter((e) => e.type === "tool")).toEqual([
      { type: "tool", at: at("2026-11-12T10:00:05.000Z"), name: "Read", input: { file_path: "/a/b.ts" } },
      { type: "tool", at: at("2026-11-12T10:00:05.000Z"), name: "mcp__butler-memory__remember", input: { text: "接口改成 v2" } },
    ]);
  });

  it("records turn-start and turn-end only when the turn actually opens or closes", () => {
    const s = newTranscriptState();
    applyEntry(s, user("fix it", "2026-11-12T10:00:01.000Z"));
    applyEntry(s, reply("tool_use", [{ type: "text", text: "looking" }]));
    applyEntry(s, toolResult("t1", "ok"));
    applyEntry(s, reply("end_turn", [{ type: "text", text: "done" }], "2026-11-12T10:00:09.000Z"));
    applyEntry(s, { type: "system", subtype: "turn_duration", timestamp: T0 });
    expect(s.events).toEqual([
      { type: "turn-start", at: at("2026-11-12T10:00:01.000Z") },
      { type: "turn-end", at: at("2026-11-12T10:00:09.000Z") },
    ]);
  });

  it("a restart without a user message (task notification) and an interrupt count as turn-start and turn-end", () => {
    const s = newTranscriptState();
    applyEntry(s, reply("tool_use", [{ type: "text", text: "back" }]));
    applyEntry(s, user("[Request interrupted by user]"));
    applyEntry(s, user("go on"));
    applyEntry(s, { type: "system", subtype: "stop_hook_summary", timestamp: T0 });
    expect(s.events.map((e) => e.type)).toEqual(["turn-start", "turn-end", "turn-start", "turn-end"]);
  });

  it("ignores sub-agent tool calls and keeps at most the latest 100 pending events", () => {
    const s = newTranscriptState();
    applyEntry(s, { ...reply("tool_use", [{ type: "tool_use", id: "sc", name: "Read", input: {} }]), isSidechain: true });
    expect(s.events).toEqual([]);
    for (let i = 0; i < 150; i++) applyEntry(s, reply("tool_use", [{ type: "tool_use", id: `t${i}`, name: `Tool${i}`, input: {} }]));
    expect(s.events).toHaveLength(100);
    expect(s.events.at(-1)).toMatchObject({ name: "Tool149" });
    // 第一条 assistant 打开了这一轮：turn-start 和最早的工具被挤掉了。
    expect(s.events[0]).toMatchObject({ name: "Tool50" });
  });
});
