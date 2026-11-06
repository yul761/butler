import { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Feature, Session, Ticket } from "../../shared/types";
import { setLang } from "../i18n";
import { tempDir } from "../test-utils";
import { ACTIVITY_TICK_MS, ActivityMonitor, activityIntervals, type ActivityDeps, deriveActivity } from "./activity-monitor";
import { applyEntry, newTranscriptState } from "./activity-parse";
import type { StuckInput } from "./stuck-judge";
import { STUCK_CHECK_MS, type StuckVerdict } from "./stuck-tracker";

const AT = "2026-10-31T10:00:00.000Z";
const AT_MS = Date.parse(AT);

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: "assistant",
  timestamp: AT,
  message: { stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (id: string) => ({ type: "user", timestamp: AT, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const endTurn = () => ({ type: "assistant", timestamp: AT, message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } });
const interrupted = (text = "[Request interrupted by user]") => ({ type: "user", timestamp: AT, message: { role: "user", content: [{ type: "text", text }] } });
const thinking = () => ({ type: "assistant", timestamp: AT, message: { stop_reason: null, content: [{ type: "text", text: "hmm" }] } });
const backgroundStarted = (toolId: string, taskId: string, file: string) => ({
  type: "user",
  timestamp: AT,
  toolUseResult: { backgroundTaskId: taskId },
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: `Command running in background with ID: b1. Output is being written to: ${file}. You will be notified when it completes \u2014 do not poll that file or sleep while waiting.` }] },
});
const backgroundDone = (taskId: string) => ({
  type: "queue-operation",
  operation: "enqueue",
  content: `<task-notification><task-id>${taskId}</task-id><status>completed</status></task-notification>`,
});

const flush = () => new Promise((r) => setImmediate(r));
const row = (id: string, over: Partial<Session> = {}): Session => ({
  id, ticketKey: "DMS-1", cwd: "/work", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null, waitingForInput: false,
  replacedBy: null, dismissed: false, createdAt: 1, repoId: 1, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, epicId: null, ...over,
});

/** 假的依赖：session、ticket、feature 是内存表，transcript 和输出文件是真的临时文件。 */
function harness(over: Partial<ActivityDeps> = {}) {
  const dir = tempDir("butler-activity-");
  const heads = new Map<string, Session>();
  const open = new Set<string>();
  const screens = new Map<string, string>();
  const tickets = new Map<string, Pick<Ticket, "featureId" | "archivedAt">>([
    ["DMS-1", { featureId: 7, archivedAt: null }],
    ["DMS-2", { featureId: 7, archivedAt: null }],
    ["DMS-3", { featureId: 7, archivedAt: null }],
    ["SOLO-1", { featureId: null, archivedAt: null }],
  ]);
  const features = new Map<number, Pick<Feature, "archivedAt">>([[7, { archivedAt: null }]]);
  const judgeCalls: StuckInput[] = [];
  const judgeResults: ((v: StuckVerdict | null) => void)[] = [];
  const stuckInfos: unknown[] = [];
  const cpuPids: number[] = [];
  const logs: string[] = [];
  let notifications = 0;
  let cpu: number | null = 100;
  let clock = 1_000_000;

  const deps: ActivityDeps = {
    sessions: { head: (id) => heads.get(id) ?? null },
    tickets: { get: (key) => (tickets.get(key) as Ticket | undefined) ?? null },
    features: { get: (id) => (features.get(id) as Feature | undefined) ?? null },
    pty: {
      openIds: () => [...open],
      snapshot: (id) => ({ data: screens.get(id) ?? "", exitCode: null }),
      pid: (id) => (open.has(id) ? 4000 : null),
    },
    transcriptFile: (id) => join(dir, `${id}.jsonl`),
    tasksDir: () => join(dir, "tasks"),
    judge: (input) => {
      judgeCalls.push(input);
      return new Promise((resolve) => judgeResults.push(resolve));
    },
    notify: () => notifications++,
    onStuck: (info) => stuckInfos.push(info),
    now: () => clock,
    childCpu: async (pid) => {
      cpuPids.push(pid);
      return cpu;
    },
    log: (m, e) => logs.push(`${m} ${e instanceof Error ? e.message : ""}`),
    ...over,
  };
  const monitor = new ActivityMonitor(deps);

  const transcript = (id: string, ...entries: unknown[]) => {
    appendFileSync(join(dir, `${id}.jsonl`), entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
  };
  const openSession = (id: string, over: Partial<Session> = {}) => {
    heads.set(id, row(id, over));
    open.add(id);
  };
  /** 跑 n 次检查（每次隔一个检查间隔）：第一次是基线，之后两次没变化才算可疑。 */
  const checks = async (n: number) => {
    for (let i = 0; i < n; i++) {
      clock += STUCK_CHECK_MS;
      await monitor.tick(clock);
    }
  };
  /** 电脑睡了一觉：隔这么久才有下一次 tick。 */
  const sleep = async (ms: number) => {
    clock += ms;
    await monitor.tick(clock);
  };
  /** 再过一个活动刷新周期（不到检查间隔）。 */
  const beat = async () => {
    clock += ACTIVITY_TICK_MS;
    await monitor.tick(clock);
  };

  return {
    dir, deps, monitor, heads, open, screens, tickets, features, judgeCalls, judgeResults, stuckInfos, cpuPids, logs, transcript, openSession, checks, beat, sleep,
    notifications: () => notifications,
    setCpu: (v: number | null) => (cpu = v),
    /** 一个在跑的前台命令：这一轮没结束，满足检测条件。 */
    busy: (id: string) => transcript(id, toolUse(`${id}-t`, "Bash", { command: "pnpm lint" })),
  };
}

/** 真实布局：子 agent 的 transcript 在别处，tasks 目录里只有指向它的符号链接。返回链接的目标。 */
function subagentFile(h: ReturnType<typeof harness>, name: string): string {
  const tasks = join(h.dir, "tasks");
  const real = join(h.dir, "subagents");
  mkdirSync(tasks, { recursive: true });
  mkdirSync(real, { recursive: true });
  const target = join(real, `agent-${name}.jsonl`);
  writeFileSync(target, "{}\n");
  symlinkSync(target, join(tasks, `${name}.output`));
  return target;
}

/** 一个在跑的 Agent 工具；开始时间用现在，这样链接目标算在它开始之后写的。 */
function agentRunning(h: ReturnType<typeof harness>, id: string, tool = "Agent"): void {
  h.openSession(id);
  h.transcript(id, { ...toolUse(`${id}-a`, tool, { prompt: "read the code" }), timestamp: new Date().toISOString() });
}

const stateOf = (...entries: unknown[]) => {
  const s = newTranscriptState();
  for (const e of entries) applyEntry(s, e);
  return s;
};

afterEach(() => {
  setLang("zh");
  vi.useRealTimers();
});

describe("deriveActivity", () => {
  it.each([
    ["Edit", { file_path: "/a/b/foo.ts" }, "edit", "foo.ts"],
    ["Write", { file_path: "/a/new.ts" }, "edit", "new.ts"],
    ["NotebookEdit", { notebook_path: "/a/n.ipynb" }, "edit", "n.ipynb"],
    ["Read", { file_path: "/a/foo.ts" }, "read", null],
    ["Grep", { pattern: "x" }, "read", null],
    ["Glob", { pattern: "*" }, "read", null],
    ["Bash", { command: "git push origin main" }, "push", "git push origin main"],
    ["Bash", { command: "gh run watch 123" }, "ci", "gh run watch 123"],
    ["Bash", { command: "pnpm test" }, "test", "pnpm test"],
    ["Bash", { command: "ls -la" }, "command", "ls -la"],
    ["Agent", { prompt: "x" }, "agent", null],
    ["Task", { prompt: "x" }, "agent", null],
    ["WebFetch", { url: "https://x" }, "command", "WebFetch"],
  ])("classifies %s %j", (name, input, kind, detail) => {
    const a = deriveActivity(stateOf(toolUse("t", name, input)), false);
    expect(a).toMatchObject({ kind, detail, background: false, startedAt: AT_MS, eligible: true });
  });

  it("cuts the name of an unknown tool to 40 characters", () => {
    expect(deriveActivity(stateOf(toolUse("t", "x".repeat(60))), false).detail).toHaveLength(40);
  });

  it("is thinking while the turn is open with nothing running", () => {
    expect(deriveActivity(stateOf(thinking()), false)).toMatchObject({ kind: "thinking", detail: null, startedAt: null, eligible: true });
  });

  it("is waiting when the turn ended", () => {
    expect(deriveActivity(stateOf(thinking(), endTurn()), false)).toMatchObject({ kind: "waiting", background: false, eligible: false });
  });

  it("is waiting with an empty transcript", () => {
    expect(deriveActivity(newTranscriptState(), false)).toMatchObject({ kind: "waiting", eligible: false });
  });

  it("reports approval over a running tool, and an approval is not eligible", () => {
    expect(deriveActivity(stateOf(toolUse("t", "Bash", { command: "rm x" })), true)).toMatchObject({ kind: "approval", detail: null, startedAt: null, eligible: false });
  });

  it.each(["AskUserQuestion", "ExitPlanMode"])("treats %s as waiting on you, keeping when it started", (name) => {
    expect(deriveActivity(stateOf(toolUse("t", name, { question: "x" })), false)).toMatchObject({ kind: "approval", detail: null, background: false, startedAt: AT_MS, eligible: false });
  });

  it("keeps a question ineligible while a background command runs", () => {
    const s = stateOf(toolUse("t1", "Bash", { command: "pnpm test", run_in_background: true }), backgroundStarted("t1", "a", "/x/a.output"), toolUse("t2", "AskUserQuestion"));
    expect(deriveActivity(s, false)).toMatchObject({ kind: "approval", background: false, eligible: false });
  });

  it("shows the newest background command once the turn ended, and counts it as eligible", () => {
    const s = stateOf(
      toolUse("t1", "Bash", { command: "pnpm test", run_in_background: true }),
      backgroundStarted("t1", "a", "/x/a.output"),
      { ...toolUse("t2", "Bash", { command: "git push", run_in_background: true }), timestamp: "2026-10-31T10:05:00.000Z" },
      backgroundStarted("t2", "b", "/x/b.output"),
      endTurn(),
    );
    expect(deriveActivity(s, false)).toMatchObject({ kind: "push", detail: "git push", background: true, startedAt: Date.parse("2026-10-31T10:05:00.000Z"), eligible: true });
  });

  it("prefers a running tool over a background command", () => {
    const s = stateOf(toolUse("t1", "Bash", { command: "git push" }), backgroundStarted("t1", "a", "/x/a.output"), toolUse("t2", "Edit", { file_path: "/a/b.ts" }));
    expect(deriveActivity(s, false)).toMatchObject({ kind: "edit", detail: "b.ts", background: false });
  });

  it("goes back to waiting when the background command finished", () => {
    const s = stateOf(toolUse("t1", "Bash", { command: "git push" }), backgroundStarted("t1", "a", "/x/a.output"), endTurn(), backgroundDone("a"));
    expect(deriveActivity(s, false)).toMatchObject({ kind: "waiting", background: false, eligible: false });
  });
});

describe("ActivityMonitor activity", () => {
  it("reads the terminal's session, and nothing for a session without a terminal", async () => {
    const h = harness();
    h.openSession("s1");
    h.heads.set("closed", row("closed"));
    h.transcript("s1", toolUse("t1", "Edit", { file_path: "/a/foo.ts" }));
    h.transcript("closed", toolUse("t2", "Edit", { file_path: "/a/bar.ts" }));
    await h.checks(1);
    expect(h.monitor.get("s1")).toMatchObject({ sessionId: "s1", kind: "edit", detail: "foo.ts", background: false, startedAt: AT_MS, stuck: false, reason: null, action: null, lastOutput: [] });
    expect(h.monitor.get("closed")).toBeNull();
  });

  it("shows approval from the terminal text, and the transcript state again afterwards", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    h.screens.set("s1", "Bash command\n\x1b[1mDo you want to proceed?\x1b[0m\n1. Yes");
    await h.beat();
    expect(h.monitor.get("s1")?.kind).toBe("approval");
    h.screens.set("s1", "running");
    await h.beat();
    expect(h.monitor.get("s1")?.kind).toBe("command");
  });

  it("shows the background command after the turn ends, then waiting when it finishes", async () => {
    const h = harness();
    const out = join(h.dir, "bg.output");
    writeFileSync(out, "step 1\nstep 2\n");
    h.openSession("s1");
    h.transcript("s1", toolUse("t1", "Bash", { command: "git push origin x", run_in_background: true }), backgroundStarted("t1", "b1", out), endTurn());
    await h.beat();
    expect(h.monitor.get("s1")).toMatchObject({ kind: "push", detail: "git push origin x", background: true, lastOutput: ["step 1", "step 2"] });

    h.transcript("s1", backgroundDone("b1"));
    await h.beat();
    expect(h.monitor.get("s1")).toMatchObject({ kind: "waiting", background: false, lastOutput: [] });
  });

  it("falls back to <tasksDir>/<taskId>.output when the tool result has no path", async () => {
    const h = harness();
    mkdirSync(join(h.dir, "tasks"));
    writeFileSync(join(h.dir, "tasks", "b1.output"), "from tasks dir\n");
    h.openSession("s1");
    const noPath = { type: "user", timestamp: AT, toolUseResult: { backgroundTaskId: "b1" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Command running in background with ID: b1." }] } };
    h.transcript("s1", toolUse("t1", "Bash", { command: "git push origin x", run_in_background: true }), noPath, endTurn());
    await h.beat();
    expect(h.monitor.get("s1")).toMatchObject({ background: true, lastOutput: ["from tasks dir"] });
  });

  it("keeps the last 6 lines of a foreground command's output file", async () => {
    const h = harness();
    mkdirSync(join(h.dir, "tasks"));
    writeFileSync(join(h.dir, "tasks", "x.output"), Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n"));
    h.openSession("s1");
    // tool_use 的时间用现在，这样文件算在它开始之后写的
    h.transcript("s1", { ...toolUse("t1", "Bash", { command: "pnpm build" }), timestamp: new Date().toISOString() });
    await h.beat();
    expect(h.monitor.get("s1")?.lastOutput).toEqual(["line 3", "line 4", "line 5", "line 6", "line 7", "line 8"]);
  });

  it("returns the end of the output as text, at most 4096 bytes without cutting a character, and \"\" when unseen", async () => {
    const h = harness();
    mkdirSync(join(h.dir, "tasks"));
    writeFileSync(join(h.dir, "tasks", "x.output"), `${"界".repeat(3000)}\nlast line`);
    h.openSession("s1");
    h.transcript("s1", { ...toolUse("t1", "Bash", { command: "pnpm build" }), timestamp: new Date().toISOString() });
    expect(await h.monitor.output("s1")).toBe("");
    await h.beat();
    const out = await h.monitor.output("s1");
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(4096);
    expect(out.endsWith("last line")).toBe(true);
    expect(out).not.toContain("\ufffd");
    expect(await h.monitor.output("nope")).toBe("");
  });

  it("does not take a background task's file for the foreground command's output", async () => {
    const h = harness();
    mkdirSync(join(h.dir, "tasks"));
    const bg = join(h.dir, "tasks", "b1.output");
    writeFileSync(bg, "background line\n");
    const now = new Date().toISOString();
    h.openSession("s1");
    h.transcript("s1", toolUse("t1", "Bash", { command: "git push", run_in_background: true }), backgroundStarted("t1", "b1", bg), { ...toolUse("t2", "Bash", { command: "sleep 9" }), timestamp: now });
    await h.beat();
    expect(h.monitor.get("s1")).toMatchObject({ detail: "sleep 9", lastOutput: [] });
  });

  it("falls back to the command alone when the output file and the transcript are missing", async () => {
    const h = harness();
    h.openSession("s1");
    h.openSession("s2");
    h.transcript("s1", toolUse("t1", "Bash", { command: "git push", run_in_background: true }), backgroundStarted("t1", "b1", join(h.dir, "gone.output")), endTurn());
    await h.beat();
    expect(h.monitor.get("s1")).toMatchObject({ kind: "push", background: true, lastOutput: [] });
    expect(h.monitor.get("s2")).toMatchObject({ kind: "waiting", lastOutputAt: null });
    expect(h.logs).toEqual([]);
  });

  it("gives the end of a running session's last reply, at most 500 characters, and null when unseen", async () => {
    const h = harness();
    h.openSession("s1");
    await h.beat();
    expect(h.monitor.lastReply("s1")).toBeNull();
    const long = `${"前".repeat(600)}要我关掉吗？`;
    h.transcript("s1", { type: "assistant", timestamp: AT, message: { stop_reason: "end_turn", content: [{ type: "text", text: long }] } });
    await h.beat();
    expect(h.monitor.lastReply("s1")).toBe(long.slice(-500));
    expect(h.monitor.lastReply("nope")).toBeNull();
    h.open.delete("s1");
    await h.beat();
    expect(h.monitor.lastReply("s1")).toBeNull();
  });

  it("copes with no transcript file being found", async () => {
    const h = harness();
    h.deps.transcriptFile = () => null;
    h.openSession("s1");
    await h.beat();
    expect(h.monitor.get("s1")).toMatchObject({ kind: "waiting", lastOutput: [] });
  });

  it("moves lastOutputAt only when the transcript or the output grew", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.beat();
    const first = h.monitor.get("s1")!.lastOutputAt;
    expect(first).not.toBeNull();
    await h.beat();
    expect(h.monitor.get("s1")?.lastOutputAt).toBe(first);
    h.transcript("s1", toolResult("s1-t"));
    await h.beat();
    expect(h.monitor.get("s1")!.lastOutputAt).toBeGreaterThan(first!);
  });

  it("notifies only when the content changed", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.beat();
    expect(h.notifications()).toBe(1);
    await h.beat();
    await h.beat();
    expect(h.notifications()).toBe(1);
    h.transcript("s1", toolResult("s1-t"), toolUse("t2", "Edit", { file_path: "/a/b.ts" }));
    await h.beat();
    expect(h.notifications()).toBe(2);
  });

  it("notifies once per tick however many sessions changed", async () => {
    const h = harness();
    h.openSession("s1");
    h.openSession("s2");
    await h.beat();
    expect(h.notifications()).toBe(1);
  });

  it("refreshSession re-reads one session now and notifies when its activity changed", async () => {
    const h = harness();
    h.openSession("s1");
    h.openSession("s2");
    h.busy("s1");
    h.busy("s2");
    await h.beat();
    expect(h.notifications()).toBe(1);
    h.transcript("s1", toolResult("s1-t"), endTurn());
    h.transcript("s2", toolResult("s2-t"), endTurn());
    await h.monitor.refreshSession("s1");
    expect(h.monitor.get("s1")?.kind).toBe("waiting");
    // 只读了 s1。
    expect(h.monitor.get("s2")?.kind).toBe("command");
    expect(h.notifications()).toBe(2);
    await h.monitor.refreshSession("s1");
    expect(h.notifications()).toBe(2);
  });

  it("refreshSession does nothing for a session it does not track", async () => {
    const h = harness();
    h.openSession("s1");
    await h.monitor.refreshSession("s1");
    expect(h.monitor.get("s1")).toBeNull();
    expect(h.notifications()).toBe(0);
  });

  it("refreshSession and a tick at the same time read the new part of the transcript once", async () => {
    const h = harness();
    h.openSession("s1");
    h.transcript("s1", toolUse("t1", "Edit", { file_path: "/a/foo.ts" }));
    await h.beat();
    h.transcript("s1", toolResult("t1"));
    await Promise.all([h.monitor.refreshSession("s1"), h.beat()]);
    // 同一段读了两遍的话读到的位置会多走一段，接下来这条长的就从半中间读起、整条丢掉。
    h.transcript("s1", toolUse("t2", "Edit", { file_path: `/a/${"x".repeat(2000)}.ts` }));
    await h.beat();
    expect(h.monitor.get("s1")).toMatchObject({ kind: "edit", detail: `${"x".repeat(2000)}.ts` });
  });

  it("forgets a session whose terminal exited", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.beat();
    h.open.delete("s1");
    const before = h.notifications();
    await h.beat();
    expect(h.monitor.get("s1")).toBeNull();
    expect(h.notifications()).toBe(before + 1);
  });

  it("follows /clear: the new head takes over and the old id is gone", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.beat();
    // 终端还是 s1 那个，head 换成了 s2
    h.heads.set("s1", row("s2"));
    h.transcript("s2", toolUse("t9", "Edit", { file_path: "/a/after.ts" }));
    await h.beat();
    expect(h.monitor.get("s1")).toBeNull();
    expect(h.monitor.get("s2")).toMatchObject({ sessionId: "s2", kind: "edit", detail: "after.ts" });
  });

  it("does not let one bad session stop the others", async () => {
    const h = harness();
    const original = h.deps.transcriptFile;
    h.deps.transcriptFile = (id) => {
      if (id === "bad") throw new Error("boom");
      return original(id);
    };
    h.openSession("bad");
    h.openSession("s1");
    h.busy("s1");
    await h.beat();
    expect(h.monitor.get("s1")?.kind).toBe("command");
    expect(h.logs.join()).toContain("bad");
  });
});

describe("ActivityMonitor stuck detection scope", () => {
  const judgedNever = async (h: ReturnType<typeof harness>, id: string) => {
    h.busy(id);
    await h.checks(6);
    expect(h.judgeCalls).toEqual([]);
    // 活动照常读取，只是没检查
    expect(h.monitor.get(id)).toMatchObject({ kind: "command", stuck: null, reason: null, action: null });
  };

  const judgedOnce = async (h: ReturnType<typeof harness>, id: string) => {
    h.busy(id);
    await h.checks(3);
    expect(h.judgeCalls.length).toBeGreaterThan(0);
    expect(h.monitor.get(id)?.stuck).not.toBeNull();
  };

  it("checks a standalone ticket's session", async () => {
    const h = harness();
    h.openSession("s1", { ticketKey: "SOLO-1" });
    await judgedOnce(h, "s1");
  });

  it("checks a session without a ticket", async () => {
    const h = harness();
    h.openSession("s1", { ticketKey: null });
    await judgedOnce(h, "s1");
  });

  it("checks the feature coordinator and reports its feature", async () => {
    const h = harness();
    h.openSession("s1", { ticketKey: null, coordinator: true, featureId: 7 });
    await judgedOnce(h, "s1");
    h.judgeResults[0]({ stuck: true, reason: "the hook hangs", action: "kill it" });
    await flush();
    expect(h.stuckInfos).toEqual([{ sessionId: "s1", ticketKey: null, featureId: 7, epicId: null, reason: "the hook hangs" }]);
  });

  it("checks an epic session and reports its epic", async () => {
    const h = harness();
    h.openSession("s1", { ticketKey: null, epicId: 3 });
    await judgedOnce(h, "s1");
    h.judgeResults[0]({ stuck: true, reason: "the hook hangs", action: "kill it" });
    await flush();
    expect(h.stuckInfos).toEqual([{ sessionId: "s1", ticketKey: null, featureId: null, epicId: 3, reason: "the hook hangs" }]);
  });

  it("checks a ticket coordinator", async () => {
    const h = harness();
    h.openSession("s1", { coordinator: true, repoId: null });
    await judgedOnce(h, "s1");
  });

  it("does not check a session that Butler did not start", async () => {
    const h = harness();
    h.openSession("s1", { origin: "discovered" });
    await judgedNever(h, "s1");
  });

  it("does not check a fix session", async () => {
    const h = harness();
    h.openSession("s1", { fixesSession: "stuck-one" });
    await judgedNever(h, "s1");
  });

  it("does not check a ticket of an archived feature", async () => {
    const h = harness();
    h.features.set(7, { archivedAt: 5 });
    h.openSession("s1");
    await judgedNever(h, "s1");
  });

  it("does not check an archived ticket, which has no row to mark", async () => {
    const h = harness();
    h.tickets.set("DMS-1", { featureId: 7, archivedAt: 5 });
    h.openSession("s1");
    await judgedNever(h, "s1");
  });

  it("does not check a coordinator of an archived feature", async () => {
    const h = harness();
    h.features.set(7, { archivedAt: 5 });
    h.openSession("s1", { ticketKey: null, coordinator: true, featureId: 7 });
    await judgedNever(h, "s1");
  });

  it("does not spend a ps on a session outside the scope", async () => {
    const h = harness();
    h.openSession("s1", { fixesSession: "stuck-one" });
    h.busy("s1");
    await h.checks(3);
    expect(h.cpuPids).toEqual([]);
  });

  it("reports false, not null, for a ticket session in scope", async () => {
    const h = harness();
    h.openSession("s1");
    await h.beat();
    expect(h.monitor.get("s1")?.stuck).toBe(false);
  });
});

describe("ActivityMonitor stuck detection", () => {
  it("asks the judge after a baseline and two unchanged checks", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(2);
    expect(h.judgeCalls).toEqual([]);
    await h.checks(1);
    expect(h.judgeCalls).toHaveLength(1);
  });

  it("samples every 3 minutes, not every tick", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(1);
    for (let i = 0; i < 17; i++) await h.beat();
    expect(h.cpuPids).toEqual([4000]);
    await h.beat();
    expect(h.cpuPids).toEqual([4000, 4000]);
    for (let i = 0; i < 17; i++) await h.beat();
    expect(h.judgeCalls).toEqual([]);
    await h.beat();
    expect(h.judgeCalls).toHaveLength(1);
  });

  it("does not check a session that waits for a reply", async () => {
    const h = harness();
    h.openSession("s1");
    h.transcript("s1", thinking(), endTurn());
    await h.checks(5);
    expect(h.judgeCalls).toEqual([]);
  });

  it("does not check a session at a permission prompt", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    h.screens.set("s1", "Do you want to proceed?");
    await h.checks(5);
    expect(h.judgeCalls).toEqual([]);
    expect(h.monitor.get("s1")?.kind).toBe("approval");
  });

  it.each(["AskUserQuestion", "ExitPlanMode"])("does not check a session waiting in %s, nor spend a ps on it", async (name) => {
    const h = harness();
    h.openSession("s1");
    h.transcript("s1", toolUse("t1", name));
    await h.checks(5);
    expect(h.judgeCalls).toEqual([]);
    expect(h.cpuPids).toEqual([]);
    expect(h.monitor.get("s1")).toMatchObject({ kind: "approval", stuck: false });
  });

  it("starts from a new baseline once the question is answered", async () => {
    const h = harness();
    h.openSession("s1");
    h.transcript("s1", toolUse("t1", "AskUserQuestion"));
    await h.checks(5);
    h.transcript("s1", toolResult("t1"), toolUse("t2", "Bash", { command: "pnpm lint" }));
    await h.checks(2);
    expect(h.judgeCalls).toEqual([]);
    await h.checks(1);
    expect(h.judgeCalls).toHaveLength(1);
  });

  it("does not check a session showing the plan prompt", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    h.screens.set("s1", "Ready to code?\n\x1b[1mWould you like to proceed?\x1b[0m\n❯ 1. Yes, and auto-accept edits");
    await h.checks(5);
    expect(h.judgeCalls).toEqual([]);
    expect(h.monitor.get("s1")?.kind).toBe("approval");
  });

  describe("a running subagent", () => {
    it.each(["Agent", "Task"])("does not turn suspicious while %s writes its transcript, and does once it stops", async (tool) => {
      const h = harness();
      const target = subagentFile(h, "a");
      agentRunning(h, "s1", tool);
      for (let i = 0; i < 6; i++) {
        appendFileSync(target, "more\n");
        await h.checks(1);
      }
      expect(h.judgeCalls).toEqual([]);
      await h.checks(1);
      expect(h.judgeCalls).toEqual([]);
      await h.checks(1);
      expect(h.judgeCalls).toHaveLength(1);
    });

    it("counts its growth as output", async () => {
      const h = harness();
      const target = subagentFile(h, "a");
      agentRunning(h, "s1");
      await h.beat();
      const first = h.monitor.get("s1")!.lastOutputAt;
      await h.beat();
      expect(h.monitor.get("s1")?.lastOutputAt).toBe(first);
      appendFileSync(target, "more\n");
      await h.beat();
      expect(h.monitor.get("s1")!.lastOutputAt).toBeGreaterThan(first!);
    });

    it("clears the mark as soon as a stalled subagent writes again", async () => {
      const h = harness();
      const target = subagentFile(h, "a");
      agentRunning(h, "s1");
      await h.checks(3);
      h.judgeResults[0]({ stuck: true, reason: "r", action: "a" });
      await flush();
      appendFileSync(target, "more\n");
      await h.beat();
      expect(h.monitor.get("s1")).toMatchObject({ stuck: false, reason: null, action: null });
    });

    it("counts each of several subagents, and skips a dangling link", async () => {
      const h = harness();
      const a = subagentFile(h, "a");
      const b = subagentFile(h, "b");
      symlinkSync(join(h.dir, "subagents", "agent-gone.jsonl"), join(h.dir, "tasks", "gone.output"));
      agentRunning(h, "s1");
      appendFileSync(a, "a is done\n");
      for (let i = 0; i < 6; i++) {
        appendFileSync(b, "more\n");
        await h.checks(1);
      }
      expect(h.judgeCalls).toEqual([]);
      await h.checks(2);
      expect(h.judgeCalls).toHaveLength(1);
      expect(h.logs).toEqual([]);
    });

    it("does not change what the activity shows", async () => {
      const h = harness();
      const target = subagentFile(h, "a");
      appendFileSync(target, "secret transcript line\n");
      agentRunning(h, "s1");
      await h.checks(3);
      expect(h.monitor.get("s1")).toMatchObject({ kind: "agent", detail: null, background: false, lastOutput: [] });
      expect(await h.monitor.output("s1")).toBe("");
      expect(h.judgeCalls[0].lastOutput).toBe("");
    });

    it("keeps showing a background command's output next to it", async () => {
      const h = harness();
      const target = subagentFile(h, "a");
      const out = join(h.dir, "bg.output");
      writeFileSync(out, "from the command\n");
      h.openSession("s1");
      h.transcript("s1", toolUse("t1", "Bash", { command: "git push", run_in_background: true }), backgroundStarted("t1", "b1", out));
      h.transcript("s1", { ...toolUse("t2", "Agent"), timestamp: new Date().toISOString() });
      for (let i = 0; i < 4; i++) {
        appendFileSync(target, "more\n");
        await h.checks(1);
      }
      expect(h.monitor.get("s1")).toMatchObject({ kind: "agent", lastOutput: ["from the command"] });
      expect(h.judgeCalls).toEqual([]);
    });

    it("does not count the links while another tool runs", async () => {
      const h = harness();
      const target = subagentFile(h, "a");
      h.openSession("s1");
      h.transcript("s1", { ...toolUse("t1", "Bash", { command: "pnpm lint" }), timestamp: new Date().toISOString() });
      for (let i = 0; i < 3; i++) {
        appendFileSync(target, "more\n");
        await h.checks(1);
      }
      expect(h.judgeCalls).toHaveLength(1);
      expect(h.monitor.get("s1")?.lastOutput).toEqual([]);
    });
  });

  it("checks a session whose turn ended while a background command runs, until the command finishes", async () => {
    const h = harness();
    const out = join(h.dir, "bg.output");
    writeFileSync(out, "start\n");
    h.openSession("s1");
    h.transcript("s1", toolUse("t1", "Bash", { command: "git push", run_in_background: true }), backgroundStarted("t1", "b1", out), endTurn());
    await h.checks(3);
    expect(h.judgeCalls).toHaveLength(1);
    expect(h.judgeCalls[0]).toMatchObject({ activity: expect.stringContaining("git push"), lastOutput: "start" });
  });

  it("stops checking a session once its background command finished", async () => {
    const h = harness();
    h.openSession("s1");
    h.transcript("s1", toolUse("t1", "Bash", { command: "git push", run_in_background: true }), backgroundStarted("t1", "b1", join(h.dir, "bg.output")), endTurn());
    await h.checks(2);
    h.transcript("s1", backgroundDone("b1"));
    await h.checks(5);
    expect(h.judgeCalls).toEqual([]);
  });

  it("counts a growing output file, on any background task, as a change", async () => {
    const h = harness();
    const a = join(h.dir, "a.output");
    const b = join(h.dir, "b.output");
    writeFileSync(a, "a\n");
    writeFileSync(b, "b\n");
    h.openSession("s1");
    h.transcript("s1", toolUse("t1", "Bash", { command: "x", run_in_background: true }), backgroundStarted("t1", "a", a), toolUse("t2", "Bash", { command: "y", run_in_background: true }), backgroundStarted("t2", "b", b), endTurn());
    for (let i = 0; i < 5; i++) {
      appendFileSync(a, "more\n");
      await h.checks(1);
    }
    expect(h.judgeCalls).toEqual([]);
  });

  it("counts child CPU as a change", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    for (let i = 0; i < 5; i++) {
      h.setCpu(i * 10_000);
      await h.checks(1);
    }
    expect(h.judgeCalls).toEqual([]);
  });

  it("gives the judge the session's facts, bounded from the end", async () => {
    setLang("en");
    const h = harness();
    const out = join(h.dir, "bg.output");
    writeFileSync(out, `first line\n${"中".repeat(3000)}\nlast line\n`);
    h.openSession("s1", { cwd: "/repo/x" });
    h.transcript("s1", toolUse("t1", "Bash", { command: "pnpm test", run_in_background: true }), backgroundStarted("t1", "b1", out), endTurn());
    h.screens.set("s1", `${"a".repeat(5000)}\x1b[31mtail end\x1b[0m`);
    await h.checks(3);
    const input = h.judgeCalls[0];
    expect(input.cwd).toBe("/repo/x");
    expect(input.activity).toBe("running tests pnpm test (background)");
    expect(input.childCpuQuiet).toBe(true);
    expect(input.minutes).toBe(6);
    expect(Buffer.byteLength(input.lastOutput, "utf8")).toBeLessThanOrEqual(4096);
    expect(input.lastOutput.endsWith("last line")).toBe(true);
    expect(input.lastOutput).not.toContain("first line");
    expect(input.lastOutput).not.toContain("�");
    expect(Buffer.byteLength(input.terminalTail, "utf8")).toBeLessThanOrEqual(2048);
    expect(input.terminalTail.endsWith("tail end")).toBe(true);
    expect(input.terminalTail).not.toContain("\x1b");
  });

  it("describes the activity in the current language", async () => {
    const h = harness();
    h.openSession("s1");
    h.transcript("s1", toolUse("t1", "Bash", { command: "pnpm lint" }));
    await h.checks(3);
    expect(h.judgeCalls[0].activity).toBe("运行命令 pnpm lint");
  });

  it("tells the judge the child CPU was quiet since the last check, whatever the total is", async () => {
    for (const total of [0, 5_000_000]) {
      const h = harness();
      h.openSession("s1");
      h.busy("s1");
      h.setCpu(total);
      await h.checks(3);
      expect(h.judgeCalls[0].childCpuQuiet).toBe(true);
    }
  });

  it("measures the child CPU from the last check, not from the baseline", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    // 每次都低于 2 秒：累计超过 2 秒也算安静
    for (const cpu of [1000, 2500, 4000]) {
      h.setCpu(cpu);
      await h.checks(1);
    }
    expect(h.judgeCalls[0].childCpuQuiet).toBe(true);
  });

  it("tells the judge the child CPU is unknown when ps fails now or failed at the last check", async () => {
    const now = harness();
    now.openSession("s1");
    now.busy("s1");
    now.setCpu(null);
    await now.checks(3);
    expect(now.judgeCalls[0].childCpuQuiet).toBeNull();

    const before = harness();
    before.openSession("s1");
    before.busy("s1");
    await before.checks(1);
    before.setCpu(null);
    await before.checks(1);
    before.setCpu(100);
    await before.checks(1);
    expect(before.judgeCalls[0].childCpuQuiet).toBeNull();
  });

  it("runs at most 2 judges at once, and the next one when a slot frees", async () => {
    const h = harness();
    for (const id of ["a", "b", "c"]) {
      h.openSession(id);
      h.busy(id);
    }
    await h.checks(3);
    expect(h.judgeCalls).toHaveLength(2);
    await h.beat();
    expect(h.judgeCalls).toHaveLength(2);

    h.judgeResults[0](null);
    await flush();
    await h.beat();
    expect(h.judgeCalls).toHaveLength(3);
  });

  it("does not let a judge hold up the activity refresh", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    expect(h.judgeResults).toHaveLength(1);
    h.transcript("s1", toolUse("t2", "Edit", { file_path: "/a/b.ts" }));
    await h.beat();
    expect(h.monitor.get("s1")?.detail).toBe("b.ts");
  });

  it("does not start a second judge for a session already being judged", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(5);
    expect(h.judgeCalls).toHaveLength(1);
  });

  it("drops a queued session that moved on before a slot freed", async () => {
    const h = harness();
    for (const id of ["a", "b", "c"]) {
      h.openSession(id);
      h.busy(id);
    }
    await h.checks(3);
    h.transcript("c", toolResult("c-t"));
    await h.beat();
    h.judgeResults[0](null);
    await flush();
    await h.beat();
    expect(h.judgeCalls).toHaveLength(2);
  });

  it("drops a queued session when a later check is no longer suspicious", async () => {
    const h = harness();
    for (const id of ["a", "b", "c"]) {
      h.openSession(id);
      h.busy(id);
    }
    await h.checks(3);
    expect(h.judgeCalls).toHaveLength(2);
    // 只有 CPU 动了：transcript 和输出都没长，c 还排着队
    h.setCpu(100_000);
    await h.checks(1);
    h.judgeResults[0](null);
    await flush();
    await h.beat();
    expect(h.judgeCalls).toHaveLength(2);
  });

  it("marks a session stuck and fires onStuck once", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    const before = h.notifications();
    h.judgeResults[0]({ stuck: true, reason: "the hook hangs", action: "kill it" });
    await flush();
    expect(h.monitor.get("s1")).toMatchObject({ kind: "command", stuck: true, reason: "the hook hangs", action: "kill it" });
    expect(h.stuckInfos).toEqual([{ sessionId: "s1", ticketKey: "DMS-1", featureId: 7, epicId: null, reason: "the hook hangs" }]);
    expect(h.notifications()).toBe(before + 1);

    await h.checks(4);
    expect(h.judgeCalls).toHaveLength(1);
    expect(h.stuckInfos).toHaveLength(1);
  });

  it("does nothing on stuck: false and stays quiet for 10 minutes", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    h.judgeResults[0]({ stuck: false, reason: "", action: "" });
    await flush();
    expect(h.monitor.get("s1")?.stuck).toBe(false);
    expect(h.stuckInfos).toEqual([]);
    await h.checks(3);
    expect(h.judgeCalls).toHaveLength(1);
    await h.checks(1);
    expect(h.judgeCalls).toHaveLength(2);
  });

  it("records stuck: false that arrives during a permission prompt", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    h.screens.set("s1", "Do you want to proceed?");
    await h.beat();
    h.judgeResults[0]({ stuck: false, reason: "", action: "" });
    await flush();
    h.screens.set("s1", "running");
    // 结论在 10 秒后到，静默期到那之后的 10 分钟：后面三次检查都在里面
    await h.checks(3);
    expect(h.judgeCalls).toHaveLength(1);
    await h.checks(1);
    expect(h.judgeCalls).toHaveLength(2);
  });

  it("records stuck: false that arrives after the output grew", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    h.transcript("s1", thinking());
    await h.beat();
    h.judgeResults[0]({ stuck: false, reason: "", action: "" });
    await flush();
    await h.checks(3);
    expect(h.judgeCalls).toHaveLength(1);
    await h.checks(1);
    expect(h.judgeCalls).toHaveLength(2);
  });

  it("keeps the 10 quiet minutes when a permission prompt came and went", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(4);
    // 判断慢：结论到的时候已经快到下一次检查了，静默期才盖得住之后的三次采样
    for (let i = 0; i < 17; i++) await h.beat();
    h.judgeResults[0]({ stuck: false, reason: "", action: "" });
    await flush();
    h.screens.set("s1", "Do you want to proceed?");
    await h.beat();
    h.screens.set("s1", "running");
    await h.checks(3);
    expect(h.judgeCalls).toHaveLength(1);
    await h.checks(1);
    expect(h.judgeCalls).toHaveLength(2);
  });

  it("does not notify twice for a stuck session that survives sleep", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    h.judgeResults[0]({ stuck: true, reason: "the hook hangs", action: "kill it" });
    await flush();

    await h.sleep(STUCK_CHECK_MS * 4);
    expect(h.monitor.get("s1")).toMatchObject({ stuck: true, reason: "the hook hangs", action: "kill it" });
    await h.checks(4);
    expect(h.judgeCalls).toHaveLength(1);
    expect(h.stuckInfos).toHaveLength(1);
  });

  it("stays dismissed across sleep", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    h.judgeResults[0]({ stuck: true, reason: "r", action: "a" });
    await flush();
    h.monitor.dismiss("s1");

    await h.sleep(STUCK_CHECK_MS * 4);
    await h.checks(4);
    expect(h.judgeCalls).toHaveLength(1);
    expect(h.monitor.get("s1")?.stuck).toBe(false);
  });

  it("clears the mark when the session moved during sleep", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    h.judgeResults[0]({ stuck: true, reason: "r", action: "a" });
    await flush();
    h.transcript("s1", toolResult("s1-t"));
    await h.sleep(STUCK_CHECK_MS * 4);
    expect(h.monitor.get("s1")).toMatchObject({ stuck: false, reason: null, action: null });
  });

  it("retries at the next check when the judge fails or throws", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    h.judgeResults[0](null);
    await flush();
    expect(h.monitor.get("s1")?.stuck).toBe(false);
    await h.checks(1);
    expect(h.judgeCalls).toHaveLength(2);

    h.deps.judge = async () => {
      throw new Error("no");
    };
    h.judgeResults[1](null);
    await flush();
    await h.checks(1);
    await flush();
    expect(h.logs.join()).toContain("no");
  });

  it("clears the mark on the next tick when the session moves again", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    h.judgeResults[0]({ stuck: true, reason: "r", action: "a" });
    await flush();
    h.transcript("s1", toolResult("s1-t"));
    await h.beat();
    expect(h.monitor.get("s1")).toMatchObject({ stuck: false, reason: null, action: null });
  });

  it("clears the mark as soon as a permission prompt shows", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    h.judgeResults[0]({ stuck: true, reason: "r", action: "a" });
    await flush();
    h.screens.set("s1", "Do you want to proceed?");
    await h.beat();
    expect(h.monitor.get("s1")).toMatchObject({ kind: "approval", stuck: false });
  });

  it("notifies again if it gets stuck again after recovering", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    h.judgeResults[0]({ stuck: true, reason: "r", action: "a" });
    await flush();
    h.transcript("s1", thinking());
    await h.checks(3);
    h.judgeResults[1]({ stuck: true, reason: "r2", action: "a2" });
    await flush();
    expect(h.stuckInfos).toHaveLength(2);
  });

  it("dismiss clears the mark and stays silent until the session moved and stalled again", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    h.judgeResults[0]({ stuck: true, reason: "r", action: "a" });
    await flush();
    const before = h.notifications();

    h.monitor.dismiss("s1");
    expect(h.monitor.get("s1")).toMatchObject({ stuck: false, reason: null, action: null });
    expect(h.notifications()).toBe(before + 1);
    await h.checks(4);
    expect(h.judgeCalls).toHaveLength(1);

    h.transcript("s1", thinking());
    await h.checks(3);
    expect(h.judgeCalls).toHaveLength(2);
  });

  it("treats a session interrupted with Esc as waiting, not thinking, and never judges it", async () => {
    for (const text of ["[Request interrupted by user]", "[Request interrupted by user for tool use]"]) {
      const h = harness();
      h.openSession("s1");
      h.busy("s1");
      h.transcript("s1", interrupted(text));
      await h.checks(5);
      expect(h.monitor.get("s1")).toMatchObject({ kind: "waiting", background: false, stuck: false });
      expect(h.judgeCalls).toEqual([]);
    }
  });

  it("keeps checking a background command after an interrupt", async () => {
    const h = harness();
    const out = join(h.dir, "bg.output");
    writeFileSync(out, "start\n");
    h.openSession("s1");
    h.transcript("s1", toolUse("t1", "Bash", { command: "git push", run_in_background: true }), backgroundStarted("t1", "b1", out), interrupted());
    await h.checks(3);
    expect(h.monitor.get("s1")).toMatchObject({ kind: "push", background: true });
    expect(h.judgeCalls).toHaveLength(1);
  });

  describe("a transient read failure", () => {
    /** s1 卡住之后，f 让某个文件读不了一下，再恢复。 */
    const stuckThenBlip = async (h: ReturnType<typeof harness>, blip: () => () => void) => {
      await h.checks(3);
      h.judgeResults[0]({ stuck: true, reason: "r", action: "a" });
      await flush();
      const at = h.monitor.get("s1")!.lastOutputAt;
      const restore = blip();
      await h.beat();
      expect(h.monitor.get("s1")).toMatchObject({ stuck: true, reason: "r", action: "a", lastOutputAt: at });
      restore();
      await h.beat();
      expect(h.monitor.get("s1")).toMatchObject({ stuck: true, lastOutputAt: at });
      await h.checks(4);
      expect(h.monitor.get("s1")).toMatchObject({ stuck: true, lastOutputAt: at });
      expect(h.judgeCalls).toHaveLength(1);
      expect(h.stuckInfos).toHaveLength(1);
    };
    const gone = (file: string) => () => {
      const body = readFileSync(file);
      rmSync(file);
      return () => writeFileSync(file, body);
    };

    it("of the transcript is not growth", async () => {
      const h = harness();
      h.openSession("s1");
      h.busy("s1");
      await stuckThenBlip(h, gone(join(h.dir, "s1.jsonl")));
    });

    it("of the shown output file is not growth", async () => {
      const h = harness();
      const out = join(h.dir, "bg.output");
      writeFileSync(out, "start\n");
      h.openSession("s1");
      h.transcript("s1", toolUse("t1", "Bash", { command: "git push", run_in_background: true }), backgroundStarted("t1", "b1", out), endTurn());
      await stuckThenBlip(h, gone(out));
    });

    it("of an older background task's file is not growth", async () => {
      const h = harness();
      const a = join(h.dir, "a.output");
      const b = join(h.dir, "b.output");
      writeFileSync(a, "older\n");
      writeFileSync(b, "newer\n");
      h.openSession("s1");
      h.transcript(
        "s1",
        toolUse("t1", "Bash", { command: "x", run_in_background: true }), backgroundStarted("t1", "a", a),
        toolUse("t2", "Bash", { command: "y", run_in_background: true }), backgroundStarted("t2", "b", b),
        endTurn(),
      );
      await stuckThenBlip(h, gone(a));
    });

    it("of the tasks directory is not growth for a foreground command", async () => {
      const h = harness();
      const tasks = join(h.dir, "tasks");
      mkdirSync(tasks);
      writeFileSync(join(tasks, "x.output"), "running\n");
      h.openSession("s1");
      h.transcript("s1", { ...toolUse("t1", "Bash", { command: "pnpm build" }), timestamp: new Date().toISOString() });
      await stuckThenBlip(h, () => {
        const body = readFileSync(join(tasks, "x.output"));
        rmSync(tasks, { recursive: true });
        return () => {
          mkdirSync(tasks);
          writeFileSync(join(tasks, "x.output"), body);
        };
      });
    });

    it("of a subagent's transcript is not growth", async () => {
      const h = harness();
      const target = subagentFile(h, "a");
      agentRunning(h, "s1");
      await stuckThenBlip(h, gone(target));
    });

    it("of the tasks directory is not growth for a subagent", async () => {
      const h = harness();
      const target = subagentFile(h, "a");
      agentRunning(h, "s1");
      await stuckThenBlip(h, () => {
        rmSync(join(h.dir, "tasks"), { recursive: true });
        return () => {
          mkdirSync(join(h.dir, "tasks"));
          symlinkSync(target, join(h.dir, "tasks", "a.output"));
        };
      });
    });

    it("still lets real growth after the failure clear the mark", async () => {
      const h = harness();
      h.openSession("s1");
      h.busy("s1");
      await h.checks(3);
      h.judgeResults[0]({ stuck: true, reason: "r", action: "a" });
      await flush();
      const file = join(h.dir, "s1.jsonl");
      const body = readFileSync(file);
      rmSync(file);
      await h.beat();
      writeFileSync(file, body);
      h.transcript("s1", toolResult("s1-t"));
      await h.beat();
      expect(h.monitor.get("s1")?.stuck).toBe(false);
    });

    it("still counts a finished background task's file leaving the sum as a change", async () => {
      const h = harness();
      const out = join(h.dir, "bg.output");
      writeFileSync(out, "start\n");
      h.openSession("s1");
      h.transcript("s1", toolUse("t1", "Bash", { command: "git push", run_in_background: true }), backgroundStarted("t1", "b1", out), endTurn());
      await h.beat();
      const at = h.monitor.get("s1")!.lastOutputAt;
      h.transcript("s1", backgroundDone("b1"));
      await h.beat();
      expect(h.monitor.get("s1")!.lastOutputAt).toBeGreaterThan(at!);
    });
  });

  it("ignores dismissing an unknown session", () => {
    const h = harness();
    h.monitor.dismiss("nope");
    expect(h.notifications()).toBe(0);
  });

  it("drops a verdict when the session produced output while it was being judged", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    h.transcript("s1", thinking());
    await h.beat();
    h.judgeResults[0]({ stuck: true, reason: "r", action: "a" });
    await flush();
    expect(h.monitor.get("s1")?.stuck).toBe(false);
    expect(h.stuckInfos).toEqual([]);
  });

  it("drops a verdict for a session that reached a permission prompt while being judged", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    h.screens.set("s1", "Do you want to proceed?");
    await h.beat();
    h.judgeResults[0]({ stuck: true, reason: "r", action: "a" });
    await flush();
    expect(h.stuckInfos).toEqual([]);
  });

  it("drops a verdict for a session that exited while being judged", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    h.open.delete("s1");
    await h.beat();
    h.judgeResults[0]({ stuck: true, reason: "r", action: "a" });
    await flush();
    expect(h.stuckInfos).toEqual([]);
  });

  it("forgets the tracker when the terminal exits: reopening starts from a new baseline", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(2);
    h.open.delete("s1");
    await h.beat();
    h.open.add("s1");
    await h.checks(2);
    expect(h.judgeCalls).toEqual([]);
    await h.checks(1);
    expect(h.judgeCalls).toHaveLength(1);
  });

  it("forgets the tracker on /clear: the old id does not keep its mark", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    h.judgeResults[0]({ stuck: true, reason: "r", action: "a" });
    await flush();
    h.heads.set("s1", row("s2"));
    h.busy("s2");
    await h.beat();
    expect(h.monitor.get("s1")).toBeNull();
    expect(h.monitor.get("s2")).toMatchObject({ stuck: false });

    // 同一个 id 回来（比如恢复）：记录已经清掉，不带着红点
    h.heads.set("s1", row("s1"));
    await h.beat();
    expect(h.monitor.get("s1")?.stuck).toBe(false);
  });

  it("uses the pty's pid for the child CPU", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(1);
    expect(h.cpuPids).toEqual([4000]);
  });

  it("compares nothing but sizes when the terminal has no pid", async () => {
    const h = harness();
    h.deps.pty.pid = () => null;
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    expect(h.cpuPids).toEqual([]);
    expect(h.judgeCalls[0].childCpuQuiet).toBeNull();
  });
});

describe("activityIntervals", () => {
  const production = { tickMs: ACTIVITY_TICK_MS, stuckCheckMs: STUCK_CHECK_MS };
  const asked = { BUTLER_ACTIVITY_TICK_MS: "200", BUTLER_STUCK_CHECK_MS: "1000" };

  it("stays at 10 seconds and 3 minutes by default", () => {
    expect(activityIntervals({})).toEqual({ tickMs: 10_000, stuckCheckMs: 180_000 });
  });

  it("honours the variables only under the e2e flag", () => {
    expect(activityIntervals(asked)).toEqual(production);
    expect(activityIntervals({ ...asked, BUTLER_BACKGROUND_WINDOWS: "0" })).toEqual(production);
    expect(activityIntervals({ ...asked, BUTLER_BACKGROUND_WINDOWS: "1" })).toEqual({ tickMs: 200, stuckCheckMs: 1000 });
  });

  it("keeps the default for a value that is not a positive whole number", () => {
    for (const bad of ["", "0", "-5", "1.5", "soon"]) {
      expect(activityIntervals({ BUTLER_BACKGROUND_WINDOWS: "1", BUTLER_ACTIVITY_TICK_MS: bad, BUTLER_STUCK_CHECK_MS: bad }), bad).toEqual(production);
    }
  });
});

describe("ActivityMonitor lifecycle", () => {
  it("refreshes on the configured interval", async () => {
    vi.useFakeTimers();
    const h = harness({ intervals: { tickMs: 200, stuckCheckMs: 1000 } });
    const tick = vi.spyOn(h.monitor, "tick").mockResolvedValue();
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(1000);
    h.monitor.stop();
    expect(tick).toHaveBeenCalledTimes(6);
  });

  it("samples and judges on the configured check interval", async () => {
    const h = harness({ intervals: { tickMs: 200, stuckCheckMs: 1000 } });
    h.openSession("s1");
    h.busy("s1");
    for (const at of [1000, 1500, 2000, 2500, 3000]) await h.monitor.tick(at);
    await flush();
    expect(h.judgeCalls).toHaveLength(1);
  });

  it("uses the configured check interval for the gap rule too", async () => {
    const h = harness({ intervals: { tickMs: 200, stuckCheckMs: 1000 } });
    h.openSession("s1");
    h.busy("s1");
    // 第二次检查隔了 2500 毫秒，比两个检查间隔长：连不上，要再两次才算可疑。
    for (const at of [1000, 3500, 4500]) await h.monitor.tick(at);
    await flush();
    expect(h.judgeCalls).toHaveLength(0);
    await h.monitor.tick(5500);
    await flush();
    expect(h.judgeCalls).toHaveLength(1);
  });

  it("skips a tick that overlaps the previous one", async () => {
    const h = harness();
    let release: () => void = () => undefined;
    let calls = 0;
    h.deps.childCpu = () => {
      calls++;
      return new Promise((r) => (release = () => r(0)));
    };
    h.openSession("s1");
    h.busy("s1");
    const first = h.monitor.tick(1_000_000);
    await vi.waitFor(() => expect(calls).toBe(1));
    await h.monitor.tick(2_000_000);
    expect(calls).toBe(1);
    release();
    await first;
    expect(h.monitor.get("s1")).not.toBeNull();
    const third = h.monitor.tick(3_000_000);
    await vi.waitFor(() => expect(calls).toBe(2));
    release();
    await third;
  });

  it("start refreshes right away and every 10 seconds, stop ends it", async () => {
    vi.useFakeTimers();
    const h = harness();
    const seen: number[] = [];
    const tick = vi.spyOn(h.monitor, "tick").mockImplementation(async (now) => void seen.push(now));
    h.monitor.start();
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(ACTIVITY_TICK_MS);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([1_000_000, 1_000_000]);
    h.monitor.stop();
    vi.advanceTimersByTime(ACTIVITY_TICK_MS * 3);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("ignores a verdict that arrives after stop, and later ticks", async () => {
    const h = harness();
    h.openSession("s1");
    h.busy("s1");
    await h.checks(3);
    h.monitor.stop();
    const before = h.notifications();
    h.judgeResults[0]({ stuck: true, reason: "r", action: "a" });
    await flush();
    await h.beat();
    expect(h.stuckInfos).toEqual([]);
    expect(h.notifications()).toBe(before);
  });

  it("does not touch the database after stop while a tick is reading files", async () => {
    const h = harness();
    let release: (() => void) | null = null;
    h.deps.childCpu = () => new Promise((r) => (release = () => r(0)));
    h.openSession("s1");
    h.openSession("s2");
    h.busy("s1");
    const running = h.monitor.tick(1_000_000);
    await vi.waitFor(() => expect(release).not.toBeNull());
    h.monitor.stop();
    h.deps.tickets.get = () => {
      throw new Error("database closed");
    };
    release!();
    await running;
    expect(h.logs).toEqual([]);
  });
});
