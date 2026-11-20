import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConvMessage } from "../../shared/conversation";
import { ForkError } from "../../shared/fork";
import type { RegistryModel } from "../../shared/model-routing";
import type { Session } from "../../shared/types";
import type { ClaudeResult, HeadlessOutcome, HeadlessRequest } from "../claude/headless";
import { ForkDiscussionsRepo } from "../db/fork-discussions-repo";
import { setLang } from "../i18n";
import { M } from "../strings";
import { memDb, tempDir } from "../test-utils";
import { FORK_JOB, ForkService, forkEnv, writeForkSettings, type ForkDeps } from "./fork-service";
import { continueArgs, devForkArgs, forkSettings, strictForkArgs, type DevLaunch } from "./fork-args";
import type { FullForkPlan } from "./fork-cache";
import { LIGHT_QA_CHARS, LIGHT_RECALL_CHARS } from "./fork-mode";

afterEach(() => setLang("zh"));

const result = (over: Partial<ClaudeResult> = {}): ClaudeResult => ({
  sessionId: "fork-1", isError: false, subtype: "success", resultText: "因为要兼容旧数据。", structured: null, permissionDenials: [], apiErrorStatus: null,
  costUsd: 0.05, usage: { input: 10, cacheWrite5m: 0, cacheWrite1h: 20, cacheRead: 1000, output: 30 }, model: "claude-opus-5-5", durationMs: 100, ...over,
});
const ok = (over: Partial<ClaudeResult> = {}): HeadlessOutcome => ({ ok: true, result: result(over) });

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id, ticketKey: "BTL-1", cwd: "/repo", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null, waitingForInput: true, replacedBy: null,
  dismissed: false, createdAt: 0, repoId: null, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, epicId: null, model: "opus",
  butler: false, lessonRunId: null, ...over,
});

const launchOf = (id: string): DevLaunch => ({
  sessionId: id, cwd: "/dev", claudeArgs: ["--session-id", id, "--mcp-config", "/m/dev-mcp.json", "--settings", "/m/dev-settings.json", "--add-dir", "/other", "--model", "opus"],
  mcpConfigPath: "/m/dev-mcp.json", settingsPath: "/m/dev-settings.json", addDirs: ["/other"], model: "opus",
});

const PLAN: FullForkPlan = { cacheOk: true, permissionArgs: true, ownMcpConfig: true };

interface Held { release: (o: HeadlessOutcome) => void }

function setup(o: { plan?: FullForkPlan; launch?: boolean; lastTurnAgo?: number | null; head?: Partial<Session>; registry?: RegistryModel[] } = {}) {
  let t = 1_000_000;
  const now = () => ++t;
  const repo = new ForkDiscussionsRepo(memDb());
  const msgs: ConvMessage[] = [];
  const conv = {
    append: vi.fn((m: Omit<ConvMessage, "id">): ConvMessage => {
      const saved = { ...m, id: msgs.length + 1 };
      msgs.push(saved);
      return saved;
    }),
    byFork: (forkId: number) => msgs.filter((m) => m.forkId === forkId),
  };
  const heads = new Map<string, Session>([["root-1", session("head-2", o.head)]]);
  const chain = new Map<string, string>([["root-1", "root-1"], ["head-2", "root-1"], ["head-3", "root-1"], ["term-1", "root-1"]]);
  const calls: HeadlessRequest[] = [];
  const queue: (HeadlessOutcome | "hold")[] = [];
  const held: Held[] = [];
  const run = vi.fn((req: HeadlessRequest): Promise<HeadlessOutcome> => {
    calls.push(req);
    const next = queue.shift() ?? ok();
    if (next !== "hold") return Promise.resolve(next);
    return new Promise((resolve) => held.push({ release: resolve }));
  });
  let runN = 0;
  const lastTurnAgo = o.lastTurnAgo === undefined ? 60_000 : o.lastTurnAgo;
  const deps = {
    repo,
    conv,
    recentQa: vi.fn((root: string, max: number) => `QA(${root},${max})`),
    sessions: { rootOf: (id: string) => chain.get(id) ?? null, head: (id: string) => heads.get(chain.get(id) ?? id) ?? null },
    devLaunchOf: vi.fn((id: string) => (o.launch === false ? null : id === heads.get("root-1")?.id ? launchOf(id) : null)),
    transcriptExists: vi.fn<(id: string) => boolean>(() => true),
    devRunning: vi.fn<(id: string) => boolean>(() => true),
    hookReady: vi.fn<() => boolean>(() => true),
    lastTurnAt: vi.fn<(id: string) => number | null>(() => (lastTurnAgo === null ? null : t - lastTurnAgo)),
    recall: vi.fn(async (scope: string, max: number) => `RECALL(${scope},${max})`),
    files: { settings: vi.fn<(devSettingsPath: string | null) => string | null>(() => "/m/fork-settings.json"), mcp: vi.fn((_d: DevLaunch, runId: string): string | null => `/m/fork-mcp-${runId}.json`) },
    run,
    claude: vi.fn(() => ({ path: "/bin/claude" as string | null, pathValue: "/usr/bin" })),
    baseEnv: { CLAUDE_EFFORT: "high", HOME: "/h" } as NodeJS.ProcessEnv,
    recordHeadless: vi.fn(),
    onUsage: vi.fn(),
    onLimit: vi.fn(),
    registry: () => o.registry ?? [],
    changed: vi.fn(),
    send: vi.fn<ForkDeps["send"]>(async () => ({ ok: true, at: 5 })),
    remember: vi.fn<ForkDeps["remember"]>(async () => "written"),
    memoryEnabled: vi.fn<ForkDeps["memoryEnabled"]>(() => true),
    plan: o.plan ?? PLAN,
    now,
    newRunId: () => `run-${++runN}`,
    log: vi.fn(),
  } satisfies ForkDeps;
  const svc = new ForkService(deps);
  return { svc, deps, repo, msgs, calls, queue, held, heads, setT: (v: number) => (t = v) };
}

/** 等起跑（提示词是异步拼的，run 晚几个微任务才被调用）。 */
const tick = () => new Promise((r) => setTimeout(r, 0));

const forkErr = (f: () => unknown, code: string) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ForkError);
    expect((e as ForkError).code).toBe(code);
    return;
  }
  throw new Error(`expected ForkError(${code})`);
};

describe("ForkService 新分叉（精简）", () => {
  it("马上写入问题、返回 forkId；跑完写回答、记费用、按 head 判断", async () => {
    const s = setup({ head: { waitingForInput: false } });
    const { forkId } = s.svc.ask("head-2", null, "  为什么这么改？ ");
    expect(s.deps.conv.append).toHaveBeenCalledWith(expect.objectContaining({ role: "user", rootSessionId: "root-1", sessionId: "head-2", forkId, qa: false, text: "为什么这么改？" }));
    expect(s.repo.get(forkId)).toMatchObject({ status: "running", mode: "light", rootSessionId: "root-1", ticketKey: "BTL-1" });
    expect(s.deps.changed).toHaveBeenCalledWith("root-1");
    // 都按 head 的 id 查（session 的用量行按 head 记）。
    expect(s.deps.lastTurnAt).toHaveBeenCalledWith("head-2");
    expect(s.deps.transcriptExists).toHaveBeenCalledWith("head-2");
    expect(s.deps.devLaunchOf).toHaveBeenCalledWith("head-2");

    await s.svc.idle();
    expect(s.msgs.at(-1)).toMatchObject({ role: "assistant", text: "因为要兼容旧数据。", forkId, rootSessionId: "root-1" });
    const row = s.repo.get(forkId)!;
    expect(row).toMatchObject({ status: "idle", forkSessionId: "fork-1", costUsd: 0.05, costPartial: false, errorCode: null });
    expect(s.deps.recordHeadless).toHaveBeenCalledWith("fork-1", "/dev", expect.any(Number));
    expect(s.deps.onUsage).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", label: FORK_JOB, costUsd: 0.05, ticketKey: "BTL-1", model: "claude-opus-5-5" }));
    expect(s.deps.changed.mock.calls.length).toBeGreaterThanOrEqual(2);

    expect(s.calls).toHaveLength(1);
    const req = s.calls[0];
    expect(req.args).toEqual(strictForkArgs({ model: "opus", addDirs: ["/other"], forkSettingsPath: "/m/fork-settings.json" }));
    expect(req.args).not.toContain("--resume");
    expect(req.cwd).toBe("/dev");
    expect(req.claudePath).toBe("/bin/claude");
    expect(req.prompt).toContain(`RECALL(ticket:BTL-1,${LIGHT_RECALL_CHARS})`);
    expect(req.prompt).toContain(`QA(root-1,${LIGHT_QA_CHARS})`);
    expect(req.prompt).toContain("为什么这么改？");
    expect(s.deps.recentQa).toHaveBeenCalledWith("root-1", LIGHT_QA_CHARS);
    expect(s.deps.files.settings).toHaveBeenCalledWith("/m/dev-settings.json");
    expect(row.launchArgs).toEqual(req.args);
  });

  it("没有启动参数（/clear 之后、Butler 重启过）：精简，cwd 用 head 的，settings 照样传分叉那份", async () => {
    const s = setup({ launch: false });
    s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    expect(s.calls[0].args).toEqual(strictForkArgs({ model: "opus", addDirs: [], forkSettingsPath: "/m/fork-settings.json" }));
    expect(s.calls[0].cwd).toBe("/repo");
    expect(s.deps.files.settings).toHaveBeenCalledWith(null);
  });

  it("head 没存模型：不传 --model", async () => {
    const s = setup({ head: { model: null, waitingForInput: false } });
    s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    expect(s.calls[0].args).not.toContain("--model");
  });

  it("范围：feature 用 featureScope；都没有时 recall 为空、不去读", async () => {
    const f = setup({ head: { ticketKey: null, featureId: 7, waitingForInput: false } });
    f.svc.ask("root-1", null, "q");
    await f.svc.idle();
    expect(f.deps.recall).toHaveBeenCalledWith("feature:7", LIGHT_RECALL_CHARS);
    const n = setup({ head: { ticketKey: null, featureId: null, waitingForInput: false } });
    n.svc.ask("root-1", null, "q");
    await n.svc.idle();
    expect(n.deps.recall).not.toHaveBeenCalled();
    expect(n.calls[0].prompt).not.toContain("RECALL");
  });

  it("环境变量：headlessEnv 加上跟交互 session 一样的默认值；CLAUDE_EFFORT 之类原样带上；用户自己的值优先", async () => {
    const s = setup();
    s.deps.baseEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "100000";
    s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    const env = s.calls[0].env;
    expect(env.CLAUDE_EFFORT).toBe("high");
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("sonnet");
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("100000");
    expect(env.BUTLER_SESSION).toBe("headless:run-1");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.BUTLER_TICKET).toBeUndefined();
    expect(s.calls[0].timeoutMs).toBe(5 * 60 * 1000);
  });
});

describe("ForkService 新分叉（完整）", () => {
  it("缓存可用、开发 session 停在输入框、最近跑过：照抄开发参数，cwd 用启动时的，提示词只有问题", async () => {
    const s = setup();
    const { forkId } = s.svc.ask("term-1", null, "为什么这么改？");
    await s.svc.idle();
    const req = s.calls[0];
    expect(req.args).toEqual(devForkArgs(launchOf("head-2"), { forkSettingsPath: "/m/fork-settings.json", forkMcpConfigPath: "/m/fork-mcp-run-1.json", plan: PLAN }));
    expect(req.args).toContain("/m/fork-mcp-run-1.json");
    expect(s.deps.files.mcp).toHaveBeenCalledWith(launchOf("head-2"), "run-1");
    expect(req.cwd).toBe("/dev");
    expect(req.prompt).toBe(M().fork.fullPrompt("为什么这么改？"));
    expect(req.prompt.endsWith("为什么这么改？")).toBe(true);
    expect(s.repo.get(forkId)).toMatchObject({ mode: "full", cwd: "/dev" });
    expect(s.deps.recall).not.toHaveBeenCalled();
    expect(s.deps.lastTurnAt).toHaveBeenCalledWith("head-2");
  });

  it("不另写 MCP 配置时用开发 session 那份", async () => {
    const plan = { ...PLAN, ownMcpConfig: false };
    const s = setup({ plan });
    s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    expect(s.deps.files.mcp).not.toHaveBeenCalled();
    expect(s.calls[0].args).toEqual(devForkArgs(launchOf("head-2"), { forkSettingsPath: "/m/fork-settings.json", forkMcpConfigPath: null, plan }));
    expect(s.calls[0].args).toContain("/m/dev-mcp.json");
  });

  it("最后一轮太久以前、没有用量：精简", async () => {
    for (const ago of [56 * 60_000, null]) {
      const s = setup({ lastTurnAgo: ago });
      const { forkId } = s.svc.ask("root-1", null, "q");
      expect(s.repo.get(forkId)!.mode).toBe("light");
    }
  });

  it("接着问：continueArgs(launch_args, 分叉 id)，cwd 用行里的，回答写进同一个分叉", async () => {
    const s = setup();
    const { forkId } = s.svc.ask("root-1", null, "第一问");
    await s.svc.idle();
    const first = s.repo.get(forkId)!.launchArgs;
    s.queue.push(ok({ resultText: "第二答" }));
    expect(s.svc.ask("head-2", forkId, "第二问")).toEqual({ forkId });
    await s.svc.idle();
    expect(s.calls[1].args).toEqual(continueArgs(first, "fork-1"));
    expect(s.calls[1].cwd).toBe("/dev");
    expect(s.calls[1].prompt).toBe("第二问");
    expect(s.msgs.filter((m) => m.forkId === forkId).map((m) => [m.role, m.text])).toEqual([
      ["user", "第一问"], ["assistant", "因为要兼容旧数据。"], ["user", "第二问"], ["assistant", "第二答"],
    ]);
    expect(s.repo.get(forkId)).toMatchObject({ status: "idle", costUsd: 0.1 });
    expect(s.svc.list("root-1")).toHaveLength(1);
  });
});

describe("ForkService 开发 session 正在跑 / 被换新", () => {
  it("开发 session 正在跑：精简；用完整上下文重问报 dev_busy", async () => {
    const s = setup({ head: { waitingForInput: false } });
    const { forkId } = s.svc.ask("root-1", null, "q");
    expect(s.repo.get(forkId)!.mode).toBe("light");
    await s.svc.idle();
    forkErr(() => s.svc.reaskFull(forkId), "dev_busy");
  });

  it("开发 session 关着（终端退出后 waitingForInput 被清掉）：不算在跑，用完整上下文重问照样起跑，严格参数续 head", async () => {
    const s = setup({ head: { waitingForInput: false }, launch: false });
    s.deps.devRunning.mockReturnValue(false);
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    const re = s.svc.reaskFull(forkId);
    await s.svc.idle();
    expect(s.deps.devRunning).toHaveBeenCalledWith("head-2");
    expect(s.repo.get(re.forkId)).toMatchObject({ mode: "full", reaskOf: forkId, status: "idle" });
    expect(s.calls[1].args).toEqual(strictForkArgs({ resumeSessionId: "head-2", model: "opus", addDirs: [], forkSettingsPath: "/m/fork-settings.json" }));
  });

  it("开着终端、没停在输入框：照样 dev_busy", async () => {
    const s = setup({ head: { waitingForInput: false } });
    s.deps.devRunning.mockReturnValue(true);
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    forkErr(() => s.svc.reaskFull(forkId), "dev_busy");
  });

  it("自动选档：关着的开发 session 算空着（别的条件满足就完整）", async () => {
    const s = setup({ head: { waitingForInput: false } });
    s.deps.devRunning.mockReturnValue(false);
    const { forkId } = s.svc.ask("root-1", null, "q");
    expect(s.repo.get(forkId)!.mode).toBe("full");
    await s.svc.idle();
  });

  it("休眠的开发 session（没有终端）：能完整重问；没有 transcript 照样 no_transcript", async () => {
    const s = setup({ head: { waitingForInput: true, hibernatedAt: 5 }, launch: false });
    s.deps.devRunning.mockReturnValue(false);
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    s.deps.transcriptExists.mockReturnValue(false);
    forkErr(() => s.svc.reaskFull(forkId), "no_transcript");
    s.deps.transcriptExists.mockReturnValue(true);
    const re = s.svc.reaskFull(forkId);
    await s.svc.idle();
    expect(s.repo.get(re.forkId)).toMatchObject({ mode: "full", status: "idle" });
  });

  it("没有 transcript：重问报 no_transcript", async () => {
    const s = setup({ head: { waitingForInput: false } });
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    s.heads.set("root-1", session("head-2"));
    s.deps.transcriptExists.mockReturnValue(false);
    forkErr(() => s.svc.reaskFull(forkId), "no_transcript");
  });

  it("分叉进行中开发 session 被换新：接着问照样用行里的分叉 id 和 cwd；新 head 也能列出它", async () => {
    const s = setup();
    s.queue.push("hold");
    const { forkId } = s.svc.ask("root-1", null, "q1");
    s.heads.set("root-1", session("head-3", { cwd: "/elsewhere" }));
    await tick();
    s.held[0].release(ok());
    await s.svc.idle();
    const first = s.repo.get(forkId)!.launchArgs;
    s.svc.ask("head-3", forkId, "q2");
    await s.svc.idle();
    expect(s.calls[1].args).toEqual(continueArgs(first, "fork-1"));
    expect(s.calls[1].cwd).toBe("/dev");
    expect(s.svc.list("head-3").map((f) => f.id)).toEqual([forkId]);
    expect(s.deps.devLaunchOf).not.toHaveBeenCalledWith("head-3");
  });
});

describe("ForkService 连点", () => {
  it("同一个分叉在跑时再问：fork_busy，不写用户消息", async () => {
    const s = setup();
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    s.queue.push("hold");
    s.svc.ask("root-1", forkId, "q2");
    const n = s.msgs.length;
    forkErr(() => s.svc.ask("root-1", forkId, "q3"), "fork_busy");
    expect(s.msgs).toHaveLength(n);
    await tick();
    s.held[0].release(ok());
    await s.svc.idle();
  });

  it("库里是 running（别的入口在跑）：fork_busy", () => {
    const s = setup();
    const row = s.repo.create({ rootSessionId: "root-1", mode: "light", ticketKey: null, featureId: null, cwd: "/w", launchArgs: ["-p"], at: 1 });
    forkErr(() => s.svc.ask("root-1", row.id, "q"), "fork_busy");
    expect(s.msgs).toHaveLength(0);
  });

  it("同一个根、同一句问题连着两次新分叉：同一个 forkId，只跑一次", async () => {
    const s = setup();
    s.queue.push("hold");
    const a = s.svc.ask("root-1", null, "q");
    const b = s.svc.ask("head-2", null, " q ");
    expect(b).toEqual(a);
    expect(s.msgs.filter((m) => m.role === "user")).toHaveLength(1);
    await tick();
    s.held[0].release(ok());
    await s.svc.idle();
    expect(s.deps.run).toHaveBeenCalledTimes(1);
    // 跑完以后同一句再问是新的分叉。
    expect(s.svc.ask("root-1", null, "q").forkId).not.toBe(a.forkId);
    await s.svc.idle();
  });

  it("reaskFull 连点两次返回同一个新 forkId；新分叉是完整的、问的是原来的问题", async () => {
    const s = setup({ head: { waitingForInput: false } });
    const { forkId } = s.svc.ask("root-1", null, "第一问");
    await s.svc.idle();
    s.svc.ask("root-1", forkId, "第二问");
    await s.svc.idle();
    s.heads.set("root-1", session("head-2"));
    s.queue.push("hold");
    const a = s.svc.reaskFull(forkId);
    const b = s.svc.reaskFull(forkId);
    expect(a.forkId).not.toBe(forkId);
    expect(b).toEqual(a);
    await tick();
    s.held[0].release(ok());
    await s.svc.idle();
    expect(s.deps.run).toHaveBeenCalledTimes(3);
    expect(s.repo.get(a.forkId)).toMatchObject({ mode: "full", reaskOf: forkId, status: "idle" });
    expect(s.calls[2].prompt).toBe(M().fork.fullPrompt(M().fork.reaskPrompt(["第一问", "第二问"])));
    expect(s.calls[2].args).toEqual(devForkArgs(launchOf("head-2"), { forkSettingsPath: "/m/fork-settings.json", forkMcpConfigPath: "/m/fork-mcp-run-3.json", plan: PLAN }));
    expect(s.msgs.filter((m) => m.forkId === a.forkId && m.role === "user")).toHaveLength(1);
  });

  it("库里已经有一个在跑的重问：返回那一个", () => {
    const s = setup();
    const orig = s.repo.create({ rootSessionId: "root-1", mode: "light", ticketKey: null, featureId: null, cwd: "/w", launchArgs: ["-p"], at: 1 });
    s.repo.finish(orig.id, { at: 2, addCost: null, partial: false });
    const re = s.repo.create({ rootSessionId: "root-1", mode: "full", ticketKey: null, featureId: null, cwd: "/w", launchArgs: ["-p"], at: 3, reaskOf: orig.id });
    expect(s.svc.reaskFull(orig.id)).toEqual({ forkId: re.id });
    expect(s.deps.run).not.toHaveBeenCalled();
  });

  it("缓存不可用：重问用严格参数续开发 session", async () => {
    const plan = { cacheOk: false, permissionArgs: false, ownMcpConfig: false };
    const s = setup({ plan });
    const { forkId } = s.svc.ask("root-1", null, "q");
    expect(s.repo.get(forkId)!.mode).toBe("light");
    await s.svc.idle();
    const re = s.svc.reaskFull(forkId);
    await s.svc.idle();
    expect(s.calls[1].args).toEqual(strictForkArgs({ resumeSessionId: "head-2", model: "opus", addDirs: ["/other"], forkSettingsPath: "/m/fork-settings.json" }));
    expect(s.repo.get(re.forkId)!.mode).toBe("full");
  });
});

describe("ForkService 失败", () => {
  it("撞限额：failed + resetAt，报给 availability，费用照记，问题还在，没有回答", async () => {
    const s = setup();
    const limit = { kind: "rate_limit" as const, resetsAt: 123, message: "limit" };
    s.queue.push({ ok: false, reason: "rate_limited", message: "limit", limit, stderr: "", result: result({ costUsd: 0.01, isError: true, resultText: "limit" }) });
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    const row = s.repo.get(forkId)!;
    expect(row).toMatchObject({ status: "failed", errorCode: "rate_limited", errorResetAt: 123, costUsd: 0.01, forkSessionId: null });
    expect(s.deps.onLimit).toHaveBeenCalledWith(limit, FORK_JOB);
    expect(s.deps.onUsage).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0.01, label: FORK_JOB }));
    expect(s.msgs.map((m) => m.role)).toEqual(["user"]);
    expect(s.svc.list("root-1")[0]).toMatchObject({ status: "failed", error: { code: "rate_limited", resetAt: 123 } });
  });

  it("onUsage、onLimit 抛错不影响分叉的结果", async () => {
    const s = setup();
    s.deps.onUsage.mockImplementation(() => {
      throw new Error("db");
    });
    s.deps.onLimit.mockImplementation(() => {
      throw new Error("x");
    });
    s.queue.push({ ok: false, reason: "rate_limited", message: "", limit: { kind: "rate_limit", resetsAt: 9, message: "" }, stderr: "", result: null });
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    expect(s.repo.get(forkId)).toMatchObject({ status: "failed", errorCode: "rate_limited", costUsd: null, costPartial: false });
    const second = s.svc.ask("root-1", null, "q2");
    await s.svc.idle();
    expect(s.repo.get(second.forkId)).toMatchObject({ status: "idle" });
    expect(s.deps.log).toHaveBeenCalled();
  });

  it("第一轮就失败再问：用 launch_args 原样重跑（精简的照样带上下文）；不是第一轮失败：continueArgs", async () => {
    const s = setup({ head: { waitingForInput: false } });
    s.queue.push({ ok: false, reason: "timeout", message: "t", limit: null, stderr: "", result: null });
    const { forkId } = s.svc.ask("root-1", null, "q1");
    await s.svc.idle();
    expect(s.repo.get(forkId)).toMatchObject({ status: "failed", errorCode: "timeout" });
    const first = s.repo.get(forkId)!.launchArgs;
    s.svc.ask("root-1", forkId, "q1 again");
    // 重新起跑时清掉上一次的错误。
    expect(s.svc.list("root-1")[0]).toMatchObject({ status: "running", error: null });
    await s.svc.idle();
    expect(s.calls[1].args).toEqual(first);
    expect(s.calls[1].prompt).toContain("RECALL");
    expect(s.calls[1].prompt).toContain("q1 again");
    expect(s.svc.list("root-1")[0]).toMatchObject({ status: "idle", error: null });

    s.queue.push({ ok: false, reason: "exit_nonzero", message: "x", limit: null, stderr: "", result: null });
    s.svc.ask("root-1", forkId, "q2");
    await s.svc.idle();
    s.svc.ask("root-1", forkId, "q3");
    await s.svc.idle();
    expect(s.calls[3].args).toEqual(continueArgs(first, "fork-1"));
    expect(s.calls[3].prompt).toBe("q3");
  });

  it("没有结果的一轮：超时之类可能花了钱，记成 partial；起不来、被限额挡住的不算", async () => {
    const s = setup();
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    s.queue.push({ ok: false, reason: "timeout", message: "t", limit: null, stderr: "", result: null });
    s.svc.ask("root-1", forkId, "q2");
    await s.svc.idle();
    expect(s.repo.get(forkId)).toMatchObject({ status: "failed", errorCode: "timeout", costUsd: 0.05, costPartial: true });
    for (const reason of ["spawn_failed", "rate_limited", "model_unavailable"] as const) {
      const n = setup();
      n.queue.push({ ok: false, reason, message: "", limit: null, stderr: "", result: null });
      const f = n.svc.ask("root-1", null, "q");
      await n.svc.idle();
      expect(n.repo.get(f.forkId)).toMatchObject({ costUsd: null, costPartial: false });
    }
  });

  it("CLI 没分叉（返回的就是 --resume 的开发 session）：不存成分叉 id、不记 headless、这一轮 not_forked，接着问直接拒绝、不起跑", async () => {
    const s = setup();
    s.queue.push(ok({ sessionId: "head-2" }));
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    expect(s.calls[0].args).toContain("--fork-session");
    expect(s.repo.get(forkId)).toMatchObject({ status: "failed", errorCode: "not_forked", forkSessionId: null, costUsd: 0.05 });
    expect(s.deps.recordHeadless).not.toHaveBeenCalled();
    expect(s.msgs.map((m) => m.role)).toEqual(["user"]);
    expect(s.deps.log).toHaveBeenCalledWith(expect.stringContaining("instead of forking"));
    forkErr(() => s.svc.ask("root-1", forkId, "q2"), "not_forked");
    await s.svc.idle();
    expect(s.deps.run).toHaveBeenCalledTimes(1);
    expect(s.msgs.map((m) => m.role)).toEqual(["user"]);
    expect(s.svc.list("root-1")[0]).toMatchObject({ status: "failed", error: { code: "not_forked", resetAt: null } });
  });

  it("失败的一轮带着 --resume 那个 id：保留真正的失败原因和 resetAt，也不存成分叉 id、不记 headless", async () => {
    const s = setup();
    const limit = { kind: "rate_limit" as const, resetsAt: 77, message: "limit" };
    s.queue.push({ ok: false, reason: "rate_limited", message: "limit", limit, stderr: "", result: result({ sessionId: "head-2", isError: true, resultText: "limit" }) });
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    expect(s.repo.get(forkId)).toMatchObject({ status: "failed", errorCode: "rate_limited", errorResetAt: 77, forkSessionId: null });
    expect(s.deps.recordHeadless).not.toHaveBeenCalled();
    expect(s.deps.log).not.toHaveBeenCalledWith(expect.stringContaining("instead of forking"));
  });

  it("完整分叉第一轮失败后重跑：开发 session 现在在跑 → dev_busy，没有 transcript → no_transcript，都不起跑", async () => {
    const s = setup();
    s.queue.push({ ok: false, reason: "timeout", message: "t", limit: null, stderr: "", result: null });
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    expect(s.repo.get(forkId)).toMatchObject({ mode: "full", status: "failed", errorCode: "timeout", forkSessionId: null });
    s.heads.set("root-1", session("head-2", { waitingForInput: false }));
    forkErr(() => s.svc.ask("root-1", forkId, "q again"), "dev_busy");
    // 开发 session 关了（不在终端里跑）：不再算在跑，只剩 transcript 那一关。
    s.deps.devRunning.mockReturnValue(false);
    s.deps.transcriptExists.mockReturnValueOnce(false);
    forkErr(() => s.svc.ask("root-1", forkId, "q again"), "no_transcript");
    s.deps.devRunning.mockReturnValue(true);
    s.heads.set("root-1", session("head-2"));
    s.deps.transcriptExists.mockReturnValue(false);
    forkErr(() => s.svc.ask("root-1", forkId, "q again"), "no_transcript");
    await s.svc.idle();
    expect(s.deps.run).toHaveBeenCalledTimes(1);
    expect(s.msgs.map((m) => m.role)).toEqual(["user"]);
    expect(s.repo.get(forkId)).toMatchObject({ status: "failed", errorCode: "timeout" });
  });

  it("记回答出错：已经算出的费用照记，行标 bad_output", async () => {
    const s = setup();
    s.deps.conv.append.mockImplementationOnce((m) => ({ ...m, id: 1 })).mockImplementationOnce(() => {
      throw new Error("disk");
    });
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    expect(s.repo.get(forkId)).toMatchObject({ status: "failed", errorCode: "bad_output", costUsd: 0.05, costPartial: false });
  });

  it("changed 抛错不会让行一直挂在 running", async () => {
    const s = setup();
    s.deps.changed.mockImplementation(() => {
      throw new Error("ipc");
    });
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    expect(s.repo.get(forkId)!.status).toBe("idle");
    s.svc.ask("root-1", forkId, "q2");
    await s.svc.idle();
    expect(s.repo.get(forkId)!.status).toBe("idle");
  });

  it("跑完但回答是空的：no_answer，不写 assistant 消息", async () => {
    const s = setup();
    s.queue.push(ok({ resultText: "  " }));
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    expect(s.repo.get(forkId)).toMatchObject({ status: "failed", errorCode: "no_answer", costUsd: 0.05 });
    expect(s.msgs.map((m) => m.role)).toEqual(["user"]);
  });

  it("run 抛错：记成 spawn_failed，写日志", async () => {
    const s = setup();
    s.deps.run.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    expect(s.repo.get(forkId)).toMatchObject({ status: "failed", errorCode: "spawn_failed" });
    expect(s.deps.log).toHaveBeenCalled();
  });

  it("app 退出时被取消：什么都不写，行留着 running 给下次启动的 recover", async () => {
    const ctl = new AbortController();
    const s = setup();
    const svc = new ForkService({ ...s.deps, signal: ctl.signal });
    s.queue.push("hold");
    const { forkId } = svc.ask("root-1", null, "q");
    await tick();
    expect(s.calls[0].signal).toBe(ctl.signal);
    ctl.abort();
    s.held[0].release({ ok: false, reason: "aborted", message: "", limit: null, stderr: "", result: null });
    await svc.idle();
    expect(s.repo.get(forkId)!.status).toBe("running");
    expect(s.deps.onUsage).not.toHaveBeenCalled();
  });

  it("claude 找不到、hook 没装（settings 写不出来）：no_claude，不建行", () => {
    const a = setup();
    a.deps.claude.mockReturnValue({ path: null, pathValue: "" });
    forkErr(() => a.svc.ask("root-1", null, "q"), "no_claude");
    expect(a.repo.listByRoot("root-1")).toEqual([]);
    expect(a.msgs).toEqual([]);
    const b = setup();
    b.deps.files.settings.mockReturnValue(null);
    forkErr(() => b.svc.ask("root-1", null, "q"), "no_claude");
    expect(b.repo.listByRoot("root-1")).toEqual([]);
    expect(b.deps.run).not.toHaveBeenCalled();
  });

  it("接着问时 claude 找不到：no_claude，行不动", async () => {
    const s = setup();
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    s.deps.claude.mockReturnValue({ path: null, pathValue: "" });
    forkErr(() => s.svc.ask("root-1", forkId, "q2"), "no_claude");
    expect(s.repo.get(forkId)!.status).toBe("idle");
  });

  it("只读 hook 后来不可用了：接着问、完整重问、新分叉都报 no_claude，不起跑；行不动", async () => {
    const s = setup();
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    s.deps.hookReady.mockReturnValue(false);
    const n = s.msgs.length;
    forkErr(() => s.svc.ask("root-1", forkId, "q2"), "no_claude");
    forkErr(() => s.svc.reaskFull(forkId), "no_claude");
    forkErr(() => s.svc.ask("root-1", null, "q3"), "no_claude");
    expect(s.repo.get(forkId)!.status).toBe("idle");
    expect(s.repo.listByRoot("root-1")).toHaveLength(1);
    expect(s.msgs).toHaveLength(n);
    expect(s.deps.run).toHaveBeenCalledTimes(1);
  });

  it("问题不合法：bad_question；不认识的 id / 分叉：not_found", () => {
    const s = setup();
    forkErr(() => s.svc.ask("root-1", null, "   "), "bad_question");
    forkErr(() => s.svc.ask("root-1", null, "字".repeat(20_001)), "bad_question");
    forkErr(() => s.svc.ask("nobody", null, "q"), "not_found");
    forkErr(() => s.svc.ask("root-1", 999, "q"), "not_found");
    forkErr(() => s.svc.reaskFull(999), "not_found");
    expect(s.repo.listByRoot("root-1")).toEqual([]);
  });

  it("recover：running 的行变成 failed / interrupted", () => {
    const s = setup();
    const row = s.repo.create({ rootSessionId: "root-1", mode: "light", ticketKey: null, featureId: null, cwd: "/w", launchArgs: ["-p"], at: 1 });
    s.svc.recover();
    expect(s.repo.get(row.id)).toMatchObject({ status: "failed", errorCode: "interrupted" });
  });
});

describe("ForkService 结论", () => {
  it("没有结论时在分叉里要一轮；再调直接返回；之后又问了一句就过期", async () => {
    const s = setup();
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    s.queue.push(ok({ resultText: "结论：改 A。" }));
    expect(await s.svc.conclusion(forkId)).toEqual({ ok: true, text: "结论：改 A。" });
    expect(s.calls[1].prompt).toBe(M().fork.conclusionAsk);
    expect(s.calls[1].args).toEqual(continueArgs(s.repo.get(forkId)!.launchArgs, "fork-1"));
    expect(s.msgs.slice(-2).map((m) => [m.role, m.text, m.forkId])).toEqual([["user", M().fork.conclusionAsk, forkId], ["assistant", "结论：改 A。", forkId]]);
    expect(s.repo.get(forkId)!.conclusion).toBe("结论：改 A。");
    expect(s.svc.list("root-1")[0].conclusion).toBe("结论：改 A。");

    expect(await s.svc.conclusion(forkId)).toEqual({ ok: true, text: "结论：改 A。" });
    expect(s.deps.run).toHaveBeenCalledTimes(2);

    s.svc.ask("root-1", forkId, "那 B 呢？");
    await s.svc.idle();
    s.queue.push(ok({ resultText: "结论：改 A 和 B。" }));
    expect(await s.svc.conclusion(forkId)).toEqual({ ok: true, text: "结论：改 A 和 B。" });
    expect(s.deps.run).toHaveBeenCalledTimes(4);
  });

  it("分叉正在跑：fork_busy；要结论失败或还没有分叉 session：no_conclusion；不认识：not_found", async () => {
    const s = setup();
    s.queue.push("hold");
    const { forkId } = s.svc.ask("root-1", null, "q");
    expect(await s.svc.conclusion(forkId)).toEqual({ ok: false, reason: "fork_busy" });
    await tick();
    s.held[0].release({ ok: false, reason: "timeout", message: "", limit: null, stderr: "", result: null });
    await s.svc.idle();
    expect(await s.svc.conclusion(forkId)).toEqual({ ok: false, reason: "no_conclusion" });
    expect(await s.svc.conclusion(999)).toEqual({ ok: false, reason: "not_found" });

    s.svc.ask("root-1", forkId, "again");
    await s.svc.idle();
    s.queue.push({ ok: false, reason: "exit_nonzero", message: "", limit: null, stderr: "", result: null });
    expect(await s.svc.conclusion(forkId)).toEqual({ ok: false, reason: "no_conclusion" });
    expect(s.repo.get(forkId)!.conclusion).toBeNull();
  });

  it("要结论时只读 hook 不可用：no_conclusion，不起跑", async () => {
    const s = setup();
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    s.deps.hookReady.mockReturnValue(false);
    expect(await s.svc.conclusion(forkId)).toEqual({ ok: false, reason: "no_conclusion" });
    expect(s.deps.run).toHaveBeenCalledTimes(1);
    expect(s.repo.get(forkId)!.status).toBe("idle");
  });

  it("要结论时 claude 找不到：no_conclusion，写日志", async () => {
    const s = setup();
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    s.deps.claude.mockReturnValue({ path: null, pathValue: "" });
    expect(await s.svc.conclusion(forkId)).toEqual({ ok: false, reason: "no_conclusion" });
    expect(s.deps.log).toHaveBeenCalledWith(expect.stringContaining("claude was not found"));
  });

  it("要结论的那一轮在跑时再问：fork_busy", async () => {
    const s = setup();
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    s.queue.push("hold");
    const p = s.svc.conclusion(forkId);
    forkErr(() => s.svc.ask("root-1", forkId, "x"), "fork_busy");
    expect(await s.svc.conclusion(forkId)).toEqual({ ok: false, reason: "fork_busy" });
    await tick();
    s.held[0].release(ok({ resultText: "c" }));
    expect(await p).toEqual({ ok: true, text: "c" });
  });
});

describe("ForkService 费用", () => {
  it("CLI 没给金额、价格表也没有这个模型：费用未知、partial", async () => {
    const s = setup();
    s.queue.push(ok({ costUsd: null, model: "mystery" }));
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    expect(s.repo.get(forkId)).toMatchObject({ costUsd: null, costPartial: true });
    expect(s.svc.list("root-1")[0]).toMatchObject({ costUsd: null, costPartial: true });
    expect(s.deps.onUsage).toHaveBeenCalledWith(expect.objectContaining({ costUsd: null }));
  });

  it("CLI 没给金额、价格表里有：按价格估", async () => {
    const registry: RegistryModel[] = [{ name: "m1", tier: "high", enabled: true, account: "a", priceIn: 1, priceOut: 1, note: "" }];
    const s = setup({ registry });
    s.queue.push(ok({ costUsd: null, model: "m1" }));
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    const row = s.repo.get(forkId)!;
    expect(row.costPartial).toBe(false);
    expect(row.costUsd).toBeGreaterThan(0);
  });
});

describe("ForkService list", () => {
  it("ForkView 带消息；error 只在 failed 时有", async () => {
    const s = setup();
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    const [v] = s.svc.list("term-1");
    expect(v).toMatchObject({ id: forkId, rootSessionId: "root-1", mode: "full", status: "idle", error: null, reaskOf: null, summarySentAt: null });
    expect(v.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.svc.list("nobody")).toEqual([]);
  });
});

describe("forkEnv", () => {
  it("设了代理时把 127.0.0.1 加进 NO_PROXY（共享 MCP 是本机回环）；没设代理不动", () => {
    const withProxy = forkEnv({ HTTPS_PROXY: "http://p:8080", NO_PROXY: "corp.local", CLAUDE_EFFORT: "high" }, { pathValue: "/bin", runId: "r" });
    expect(withProxy.NO_PROXY.split(",")).toEqual(["corp.local", "127.0.0.1"]);
    expect(withProxy.CLAUDE_EFFORT).toBe("high");
    const none = forkEnv({ CLAUDE_EFFORT: "high" }, { pathValue: "/bin", runId: "r" });
    expect(none.NO_PROXY).toBeUndefined();
    expect(none.no_proxy).toBeUndefined();
  });
});

describe("writeForkSettings", () => {
  it("用开发那份 settings 和 butler-hook readonly 写出分叉 settings；同样内容同一个文件", () => {
    const dir = tempDir();
    const dev = join(dir, "dev.json");
    writeFileSync(dev, JSON.stringify({ enabledMcpjsonServers: ["x"], permissions: { allow: ["Bash"] }, hooks: { PreToolUse: [] } }));
    const p = writeForkSettings({ dir, devSettingsPath: dev, guardCommand: '"/b/butler-hook"' })!;
    expect(p.startsWith(join(dir, "fork-"))).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(forkSettings({ enabledMcpjsonServers: ["x"], permissions: { allow: ["Bash"] }, hooks: { PreToolUse: [] } }, '"/b/butler-hook"'));
    expect(readFileSync(p, "utf8")).toContain('\\"/b/butler-hook\\" readonly');
    expect(writeForkSettings({ dir, devSettingsPath: dev, guardCommand: '"/b/butler-hook"' })).toBe(p);
  });

  it("开发那份读不到当 null；hook 不可用返回 null", () => {
    const dir = tempDir();
    const p = writeForkSettings({ dir, devSettingsPath: join(dir, "missing.json"), guardCommand: '"/b/butler-hook"' })!;
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(forkSettings(null, '"/b/butler-hook"'));
    expect(writeForkSettings({ dir, devSettingsPath: null, guardCommand: null })).toBeNull();
  });
});

describe("ForkService 发给开发 session / 记进记忆", () => {
  async function withFork(s: ReturnType<typeof setup>) {
    const { forkId } = s.svc.ask("root-1", null, "q");
    await s.svc.idle();
    return forkId;
  }

  it("没有结论先要结论，再发给 root；成功后记下发送时间并通知", async () => {
    const s = setup();
    const forkId = await withFork(s);
    s.queue.push(ok({ resultText: "结论：改 A。" }));
    s.deps.changed.mockClear();
    expect(await s.svc.sendConclusion(forkId)).toEqual({ ok: true, at: 5 });
    expect(s.deps.send).toHaveBeenCalledWith("root-1", M().fork.conclusionForDev("结论：改 A。"));
    expect(s.repo.get(forkId)!.summarySentAt).not.toBeNull();
    expect(s.deps.changed).toHaveBeenCalledWith("root-1");
  });

  it("send 被挡（draft）：summary_sent_at 不变，结论留着，下次不再要结论", async () => {
    const s = setup();
    const forkId = await withFork(s);
    s.queue.push(ok({ resultText: "结论：改 A。" }));
    // 要结论那一轮自己会推 changed；只看递之后有没有再推。
    let changedAtSend = -1;
    s.deps.send.mockImplementationOnce(async () => {
      changedAtSend = s.deps.changed.mock.calls.length;
      return { ok: false, reason: "draft" };
    });
    const markSent = vi.spyOn(s.repo, "markSent");
    expect(await s.svc.sendConclusion(forkId)).toEqual({ ok: false, reason: "draft" });
    expect(s.repo.get(forkId)!.summarySentAt).toBeNull();
    expect(s.repo.get(forkId)!.conclusion).toBe("结论：改 A。");
    expect(s.deps.changed.mock.calls.length).toBe(changedAtSend);
    expect(markSent).not.toHaveBeenCalled();
    const runs = s.deps.run.mock.calls.length;
    expect(await s.svc.sendConclusion(forkId)).toEqual({ ok: true, at: 5 });
    expect(s.deps.run).toHaveBeenCalledTimes(runs);
  });

  it("分叉正在跑：fork_busy；要结论失败：no_conclusion；不认识：not_found", async () => {
    const s = setup();
    s.queue.push("hold");
    const { forkId } = s.svc.ask("root-1", null, "q");
    expect(await s.svc.sendConclusion(forkId)).toEqual({ ok: false, reason: "fork_busy" });
    await tick();
    s.held[0].release(ok());
    await s.svc.idle();
    s.queue.push({ ok: false, reason: "exit_nonzero", message: "", limit: null, stderr: "", result: null });
    expect(await s.svc.sendConclusion(forkId)).toEqual({ ok: false, reason: "no_conclusion" });
    expect(await s.svc.sendConclusion(999)).toEqual({ ok: false, reason: "not_found" });
    expect(s.deps.send).not.toHaveBeenCalled();
  });

  it("连点两次：第二次 in_flight", async () => {
    const s = setup();
    const forkId = await withFork(s);
    s.queue.push("hold");
    const first = s.svc.sendConclusion(forkId);
    expect(await s.svc.sendConclusion(forkId)).toEqual({ ok: false, reason: "in_flight" });
    await tick();
    s.held[0].release(ok({ resultText: "c" }));
    expect(await first).toEqual({ ok: true, at: 5 });
    expect(s.deps.send).toHaveBeenCalledTimes(1);
  });

  it("changed 抛错不影响返回", async () => {
    const s = setup();
    const forkId = await withFork(s);
    s.queue.push(ok({ resultText: "c" }));
    s.deps.changed.mockImplementation(() => {
      throw new Error("x");
    });
    expect(await s.svc.sendConclusion(forkId)).toEqual({ ok: true, at: 5 });
  });

  it("remember：用结论调 rememberText(ticket scope)，返回 written / full", async () => {
    const s = setup();
    const forkId = await withFork(s);
    s.queue.push(ok({ resultText: "结论：改 A。" }));
    expect(await s.svc.remember(forkId)).toBe("written");
    expect(s.deps.remember).toHaveBeenCalledWith("ticket:BTL-1", "结论：改 A。");
    s.deps.remember.mockResolvedValueOnce("full");
    expect(await s.svc.remember(forkId)).toBe("full");
  });

  it("remember：连点 busy；没有 ticket 也没有 feature：disabled，不写", async () => {
    const s = setup();
    const forkId = await withFork(s);
    s.queue.push(ok({ resultText: "c" }));
    let release!: (r: "written") => void;
    s.deps.remember.mockImplementationOnce(() => new Promise((res) => (release = res)));
    const first = s.svc.remember(forkId);
    await tick();
    expect(await s.svc.remember(forkId)).toBe("busy");
    release("written");
    expect(await first).toBe("written");

    const n = setup({ head: { ticketKey: null } });
    const id2 = await withFork(n);
    expect(await n.svc.remember(id2)).toBe("disabled");
    expect(n.deps.remember).not.toHaveBeenCalled();
  });

  it("remember：要结论失败：no_conclusion，不写记忆", async () => {
    const s = setup();
    const forkId = await withFork(s);
    s.queue.push({ ok: false, reason: "exit_nonzero", message: "", limit: null, stderr: "", result: null });
    expect(await s.svc.remember(forkId)).toBe("no_conclusion");
    expect(s.deps.remember).not.toHaveBeenCalled();
  });

  it("remember：分叉在跑 busy；不认识的分叉 failed", async () => {
    const s = setup();
    s.queue.push("hold");
    const { forkId } = s.svc.ask("root-1", null, "q");
    expect(await s.svc.remember(forkId)).toBe("busy");
    expect(await s.svc.remember(999)).toBe("failed");
    await tick();
    s.held[0].release(ok());
    await s.svc.idle();
  });

  it("remember：记忆整体关着：disabled，不要结论也不写", async () => {
    const s = setup();
    const forkId = await withFork(s);
    s.deps.memoryEnabled.mockReturnValue(false);
    const runs = s.deps.run.mock.calls.length;
    expect(await s.svc.remember(forkId)).toBe("disabled");
    expect(s.deps.run).toHaveBeenCalledTimes(runs);
    expect(s.deps.remember).not.toHaveBeenCalled();
  });

  it("sendConclusion：要结论抛错 -> no_conclusion 并写日志", async () => {
    const s = setup();
    const forkId = await withFork(s);
    s.deps.claude.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(await s.svc.sendConclusion(forkId)).toEqual({ ok: false, reason: "no_conclusion" });
    expect(s.deps.log).toHaveBeenCalled();
    expect(s.deps.send).not.toHaveBeenCalled();
  });

  it("sendConclusion：markSent 抛错：写日志，仍返回已送到", async () => {
    const s = setup();
    const forkId = await withFork(s);
    s.queue.push(ok({ resultText: "c" }));
    vi.spyOn(s.repo, "markSent").mockImplementation(() => {
      throw new Error("db");
    });
    expect(await s.svc.sendConclusion(forkId)).toEqual({ ok: true, at: 5 });
    expect(s.deps.log).toHaveBeenCalledWith(expect.stringContaining("markSent"), expect.any(Error));
  });
});
