import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ACTIVITY_OUTPUT_LIMIT, LAST_REPLY_LIMIT } from "../../shared/control";
import type { ActivityEvent, ActivityKind, SessionActivity } from "../../shared/activity";
import type { Feature, Session, Ticket } from "../../shared/types";
import { M } from "../strings";
import { backgroundTasks, classifyCommand, currentTool, DETAIL_LIMIT, newTranscriptState, type BackgroundTask, type RunningTool, type TranscriptState } from "./activity-parse";
import { foregroundOutputFile, readOutputTail, subagentOutputSizes, tasksDirFor, TranscriptTail, utf8Tail } from "./activity-sources";
import { liveEvent } from "./live-events";
import { sampleProcTree, type ProcSample } from "./proc-tree";
import { stripAnsi, type PtySnapshot } from "./pty-manager";
import type { StuckInput } from "./stuck-judge";
import { cpuQuiet, STUCK_CHECK_MS, StuckTracker, type StuckVerdict } from "./stuck-tracker";
import { DebouncedWatch, type WatchFn } from "./transcript-watch";

/** 活动刷新的间隔：transcript 有 fs.watch 盯着（BTL-190 第 7 点），这个 tick 是退路。 */
export const ACTIVITY_TICK_MS = 10_000;
/** transcript 变了以后多久重读（去抖）。 */
export const WATCH_DEBOUNCE_MS = 300;
/** 每个 session 留最近几条工具调用（实况窗口的小终端）。 */
export const RECENT_TOOLS = 3;
/** 全部 session 一共留最近几条记忆读写（实况窗口的核心卡片）。 */
export const RECENT_MEMORY = 8;
/** UserPromptSubmit 以后、transcript 还没动之前，最多把停着的 session 当成在想多久。 */
const PROMPT_HOLD_MS = 30_000;
/** 开始跟踪时往前留的余量：比这早的记录是重放出来的旧事，不推给界面。 */
const EVENT_SLACK_MS = 2000;
/** 同时最多请几个 headless Claude 判断。 */
const MAX_JUDGES = 2;
/** 给 Claude 判断时，最后输出和终端末尾各最多带多少字节。 */
const JUDGE_OUTPUT_BYTES = 4096;
const JUDGE_TERMINAL_BYTES = 2048;

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);
/** 这些工具的结果要等用户回答，跑着的时候 session 是在等人。 */
const USER_WAIT_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

export interface ActivityIntervals {
  tickMs: number;
  stuckCheckMs: number;
}

const positiveMs = (v: string | undefined, fallback: number): number => (/^[1-9]\d*$/.test(v ?? "") ? Number(v) : fallback);

/**
 * 活动刷新和卡住检查的间隔，只在这里读环境变量。e2e 等不起 3 分钟，把它们调短；
 * 只有 e2e 的标记 BUTLER_BACKGROUND_WINDOWS=1 在时才算数，正常运行永远是 10 秒和 3 分钟。
 */
export function activityIntervals(env: NodeJS.ProcessEnv): ActivityIntervals {
  const test = env.BUTLER_BACKGROUND_WINDOWS === "1";
  return {
    tickMs: test ? positiveMs(env.BUTLER_ACTIVITY_TICK_MS, ACTIVITY_TICK_MS) : ACTIVITY_TICK_MS,
    stuckCheckMs: test ? positiveMs(env.BUTLER_STUCK_CHECK_MS, STUCK_CHECK_MS) : STUCK_CHECK_MS,
  };
}

export interface StuckInfo {
  sessionId: string;
  ticketKey: string | null;
  featureId: number | null;
  epicId: number | null;
  reason: string;
}

export interface ActivityDeps {
  sessions: { head(id: string): Session | null };
  tickets: { get(key: string): Ticket | null };
  features: { get(id: number): Feature | null };
  /** openedAt：终端打开（新开或恢复）的时间，比它早开始的后台任务一定已经结束了。 */
  pty: {
    openIds(): string[];
    snapshot(termId: string): PtySnapshot;
    pid(termId: string): number | null;
    openedAt(termId: string): number;
    /** 当前屏幕上有权限确认（PtyManager.permissionShowing，看屏幕而不是输出流的末尾）。 */
    permissionShowing(termId: string): boolean;
  };
  /** session 的 transcript 文件；还没有时返回 null。 */
  transcriptFile: (sessionId: string) => string | null;
  judge: (input: StuckInput) => Promise<StuckVerdict | null>;
  /** 活动变化时调用；内容没变不调。 */
  notify: () => void;
  /**
   * 实况窗口的信号（BTL-190 第 7 点）：每个新的 tool_use、轮次开始和结束各一条。开始跟踪以前的记录（--resume 重放、Butler 启动前写的）、
   * 文件截短或轮转后重读出来的不推。
   */
  onEvent?: (e: ActivityEvent) => void;
  /** 盯 transcript 的 fs.watch；测试注入假的，null 不盯（只靠 tick）。默认用真的 fs.watch。 */
  watch?: WatchFn | null;
  /** 默认 300ms。 */
  watchDebounceMs?: number;
  /** 一次卡住只调一次。 */
  onStuck: (info: StuckInfo) => void;
  now: () => number;
  /** 默认 10 秒和 3 分钟。 */
  intervals?: ActivityIntervals;
  /** 测试注入；默认用 proc-tree 读真实进程树（子进程 CPU，以及 commands 这些后台命令的 shell 还在不在）。 */
  procTree?: (rootPid: number, commands: string[]) => Promise<ProcSample>;
  /** 测试注入；默认是 Claude 放命令输出的目录。 */
  tasksDir?: (transcriptFile: string, sessionId: string) => string | null;
  log?: (msg: string, err?: unknown) => void;
}

export interface DerivedActivity extends Pick<SessionActivity, "kind" | "detail" | "background" | "startedAt"> {
  /** 这一轮没结束或者有后台命令在跑，也没在等人确认或回答：才参与卡住检测。 */
  eligible: boolean;
}

function toolActivity(t: RunningTool): { kind: ActivityKind; detail: string | null } {
  if (EDIT_TOOLS.has(t.name)) return { kind: "edit", detail: t.file ? basename(t.file) : null };
  if (READ_TOOLS.has(t.name)) return { kind: "read", detail: null };
  if (AGENT_TOOLS.has(t.name)) return { kind: "agent", detail: null };
  if (USER_WAIT_TOOLS.has(t.name)) return { kind: "approval", detail: null };
  if (t.name === "Bash") return classifyCommand(t.command ?? "");
  return { kind: "command", detail: t.name.slice(0, DETAIL_LIMIT) };
}

/** 按开始时间排的后台任务，最新的在最后。 */
function sortedBackground(s: TranscriptState): BackgroundTask[] {
  return backgroundTasks(s).sort((a, b) => a.startedAt - b.startedAt);
}

/** transcript 状态加上终端有没有停在权限确认上，得出 session 此刻在做什么。 */
export function deriveActivity(s: TranscriptState, atPermissionPrompt: boolean): DerivedActivity {
  const task = sortedBackground(s).at(-1);
  const tool = currentTool(s);
  const running = tool && { ...toolActivity(tool), background: false, startedAt: tool.startedAt };
  const eligible = !atPermissionPrompt && running?.kind !== "approval" && (s.turnOpen || !!task);
  const noTool = { detail: null, background: false, startedAt: null, eligible };
  if (atPermissionPrompt) return { kind: "approval", ...noTool };
  if (running) return { ...running, eligible };
  if (task) return { ...classifyCommand(task.command), background: true, startedAt: task.startedAt, eligible };
  return { kind: s.turnOpen ? "thinking" : "waiting", ...noTool };
}

/** 读不了返回 null。 */
const fileSize = (file: string): Promise<number | null> => stat(file).then((s) => s.size, () => null);

/** 给 Claude 看的一句话：现在在做什么。 */
export function describeActivity(a: SessionActivity): string {
  const m = M();
  return `${[m.activityKinds[a.kind], a.detail].filter(Boolean).join(" ")}${a.background ? m.activityBackground : ""}`;
}

/** 卡住检测的范围：Butler 开的、不是修复 session 的所有 session（ticket、总控、epic），已归档的 ticket 和 feature 除外。 */
interface StuckScope {
  ticketKey: string | null;
  featureId: number | null;
  epicId: number | null;
}

interface Tracked {
  id: string;
  termId: string;
  cwd: string;
  scope: StuckScope | null;
  file: string | null;
  tail: TranscriptTail | null;
  transcriptSize: number;
  /** 所有相关输出文件的大小之和。 */
  outputSize: number;
  /** 上一次看到的每个输出文件的大小：一时读不了时沿用，不能当成文件变了。 */
  fileSizes: Map<string, number>;
  outputText: string;
  lastOutputAt: number | null;
  eligible: boolean;
  lastSampleAt: number;
  childCpuMs: number | null;
  /** 上一次采样以来子进程几乎没用 CPU；读不到为 null。 */
  childCpuQuiet: boolean | null;
  /** 第一次读完之前是 null。 */
  activity: SessionActivity | null;
  lastReply: string | null;
  lastReplyId: string | null;
  /** 上一次看到的后台任务 id（排好序拼起来）：变了就重新问进程树。 */
  shellKey: string;
  /** 这些后台任务的命令（问进程树时用来认 shell）。 */
  shellCommands: string[];
  /** 进程树里还有没有这些后台任务的 shell；还没问过、读不到为 null（照旧算在跑）。 */
  shellAlive: boolean | null;
  shellCheckedAt: number;
  /** 盯着 transcript 的 fs.watch；还没找到文件时为 null。 */
  watch: DebouncedWatch | null;
  /** 最近的工具调用（含记忆读写），从旧到新，最多 RECENT_TOOLS 条。 */
  recent: ActivityEvent[];
  /** 比这早的记录不推给界面：开始跟踪的时间，文件截短或轮转以后是那一刻。 */
  eventsSince: number;
  /** TranscriptTail 从头重建过的次数：变了说明这次读到的是重读出来的旧记录。 */
  restarts: number;
  /** UserPromptSubmit 到的时间：transcript 动之前先当它在想；没有为 null。 */
  promptAt: number | null;
  /** 那时读到的 transcript 大小。 */
  promptSize: number;
  /** transcript 里最近一次轮次开始的时间；还没有为 null。 */
  turnStartAt: number | null;
}

/** 这一次更新里最多读一次进程树：后台任务的检查和卡住采样共用。 */
type Probe = () => Promise<ProcSample>;

/**
 * 每 10 秒看一遍有终端的 session：读 transcript 和命令输出得出活动，每 3 分钟采一次样判断是否卡住。
 * 键是 sessions.head() 的 id：/clear 后新 id 接替旧 id，旧 id 的记录清掉。全部只存内存。
 */
export class ActivityMonitor {
  private readonly tickMs: number;
  private readonly stuckCheckMs: number;
  private readonly tracker: StuckTracker;
  private readonly tracked = new Map<string, Tracked>();
  /** 可疑、等着空出名额去判断的 session。 */
  private readonly wanted = new Set<string>();
  private readonly judging = new Set<string>();
  /** 每个 session 正在做的那次更新：tick 和 refreshSession 撞上时排队，同一段 transcript 不能读两遍（读到的位置会多走）。 */
  private readonly updating = new Map<string, Promise<boolean>>();
  /** 全部 session 最近的记忆读写，从旧到新。 */
  private memory: ActivityEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(private readonly d: ActivityDeps) {
    this.tickMs = d.intervals?.tickMs ?? ACTIVITY_TICK_MS;
    this.stuckCheckMs = d.intervals?.stuckCheckMs ?? STUCK_CHECK_MS;
    this.tracker = new StuckTracker(this.stuckCheckMs);
  }

  start(): void {
    this.stopped = false;
    void this.tick(this.d.now());
    this.timer = setInterval(() => void this.tick(this.d.now()), this.tickMs);
  }

  /** 退出时在关数据库之前调用：之后不再碰数据库，迟到的判断结果也不再生效。 */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.tracked.values()) t.watch?.close();
  }

  async tick(now: number): Promise<void> {
    // 上一次还没读完（磁盘慢、ps 慢）就跳过这次
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const changed = await this.refresh(now);
      if (this.stopped) return;
      this.startJudges(now);
      if (changed) this.d.notify();
    } catch (e) {
      this.d.log?.("activity tick failed", e);
    } finally {
      this.ticking = false;
    }
  }

  get(sessionId: string): SessionActivity | null {
    return this.tracked.get(sessionId)?.activity ?? null;
  }

  /**
   * 现在就重读这一个 session（和 tick 走同一条更新路径），活动变了就 notify。Stop 到的时候用：get() 是上一次 tick 的结果，
   * 那时它多半还在想或者在跑工具。没在跟踪（还没 tick 到、终端关了、/clear 换了 head）就什么也不做，留给下一次 tick。
   */
  async refreshSession(sessionId: string): Promise<void> {
    const t = this.tracked.get(sessionId);
    if (!t || this.stopped) return;
    const head = this.d.sessions.head(t.termId);
    if (head?.id !== sessionId || !this.d.pty.openIds().includes(t.termId)) return;
    try {
      // 排队期间 tick 可能已经把它忘了（终端退出）：那就不再读，免得又把它加回来。
      const changed = await this.serialUpdate(sessionId, () => (this.tracked.has(sessionId) ? this.update(head, t.termId, this.d.now()) : Promise.resolve(false)));
      if (changed && !this.stopped) this.d.notify();
    } catch (e) {
      this.d.log?.(`activity of session ${sessionId} failed`, e);
    }
  }

  /**
   * 收到 UserPromptSubmit（BTL-190 第 7 点）：马上重读。claude 可能还没把这条输入写进 transcript，
   * 这时先把停着的它当成在想，直到 transcript 动了（最多 30 秒）。id 可以是链上的旧 id。
   * 刚开的终端还没 tick 到：现在就开始跟踪（第一句话一发出去就算在干活，fs.watch 也马上挂上）。
   */
  async promptSubmitted(id: string): Promise<void> {
    const head = this.d.sessions.head(id);
    if (!head || this.stopped) return;
    let started = false;
    if (!this.tracked.has(head.id)) {
      const termId = this.d.pty.openIds().find((term) => this.d.sessions.head(term)?.id === head.id);
      if (termId === undefined) return;
      try {
        started = await this.serialUpdate(head.id, () => this.update(head, termId, this.d.now()));
      } catch (e) {
        this.d.log?.(`activity of session ${head.id} failed`, e);
        return;
      }
    }
    const t = this.tracked.get(head.id);
    if (!t || this.stopped) return;
    t.promptAt = this.d.now();
    t.promptSize = t.transcriptSize;
    await this.refreshSession(head.id);
    if (started && !this.stopped) this.d.notify();
  }

  /** 这个 session 最近的工具调用（含记忆读写），从旧到新，最多 3 条；没在跟踪为空。 */
  recent(sessionId: string): ActivityEvent[] {
    return [...(this.tracked.get(sessionId)?.recent ?? [])];
  }

  /** 全部 session 最近的记忆读写，从旧到新，最多 8 条。 */
  memoryLog(): ActivityEvent[] {
    return [...this.memory];
  }

  /** 当前命令输出的末尾，最多 4096 字节（不切开 UTF-8 字符）；读不到返回 ""。 */
  async output(sessionId: string): Promise<string> {
    return utf8Tail(this.tracked.get(sessionId)?.outputText ?? "", ACTIVITY_OUTPUT_LIMIT);
  }

  /** 最后一条 assistant 文字回复的结尾，最多 500 字符；没有终端在跑、还没读到时为 null。 */
  lastReply(sessionId: string): string | null {
    const r = this.tracked.get(sessionId)?.lastReply;
    if (!r) return null;
    const chars = [...r];
    return chars.length <= LAST_REPLY_LIMIT ? r : chars.slice(-LAST_REPLY_LIMIT).join("");
  }

  /** 最后一条 assistant 文字回复的全文和它的 message.id（“需要你”的判断用，调用方自己截）；没有回复或者回复没有 id 时为 null。 */
  lastReplyOf(sessionId: string): { id: string; text: string } | null {
    const t = this.tracked.get(sessionId);
    return t?.lastReply && t.lastReplyId ? { id: t.lastReplyId, text: t.lastReply } : null;
  }

  /** 用户点了“没事，忽略”：这一次不再提醒，直到 session 恢复活动后再次卡住。 */
  dismiss(sessionId: string): void {
    const t = this.tracked.get(sessionId);
    if (!t) return;
    this.tracker.dismiss(sessionId);
    if (this.syncVerdict(t)) this.d.notify();
  }

  /** 看一遍所有打开的终端，返回有没有内容变化。 */
  private async refresh(now: number): Promise<boolean> {
    const live = new Map<string, { head: Session; termId: string }>();
    for (const termId of this.d.pty.openIds()) {
      const head = this.d.sessions.head(termId);
      if (head) live.set(head.id, { head, termId });
    }
    let changed = false;
    for (const [id, t] of this.tracked) {
      if (live.has(id)) continue;
      t.watch?.close();
      this.tracked.delete(id);
      this.tracker.forget(id);
      this.wanted.delete(id);
      changed = true;
    }
    for (const { head, termId } of live.values()) {
      // 读文件的时候可能开始退出了，数据库随后就关
      if (this.stopped) return false;
      try {
        if (await this.serialUpdate(head.id, () => this.update(head, termId, now))) changed = true;
      } catch (e) {
        this.d.log?.(`activity of session ${head.id} failed`, e);
      }
    }
    return changed;
  }

  /** 同一个 session 的更新一个接一个做。 */
  private serialUpdate(id: string, run: () => Promise<boolean>): Promise<boolean> {
    const prev = this.updating.get(id);
    const next = prev ? prev.then(run, run) : run();
    this.updating.set(id, next);
    const clear = () => {
      if (this.updating.get(id) === next) this.updating.delete(id);
    };
    next.then(clear, clear);
    return next;
  }

  private async update(head: Session, termId: string, now: number): Promise<boolean> {
    const t = this.tracked.get(head.id) ?? this.track(head.id, termId);
    t.termId = termId;
    t.cwd = head.cwd;
    t.scope = this.scope(head);
    const { state: full, size } = await this.readTranscript(t);
    this.watchTranscript(t);
    const recentChanged = this.takeEvents(t, full, now);
    const probe = this.probe(t, now);
    const state = await this.liveBackground(t, full, now, probe);
    const { eligible, ...found } = deriveActivity(state, this.d.pty.permissionShowing(termId));
    const derived = this.holdPrompt(t, found, size, now);
    const output = await this.readOutput(t, state);
    const grew = size !== t.transcriptSize || output.size !== t.outputSize;
    t.transcriptSize = size;
    t.outputSize = output.size;
    t.outputText = output.text;
    t.eligible = eligible;
    t.lastReply = state.lastReply;
    t.lastReplyId = state.lastReplyId;
    if (grew) t.lastOutputAt = now;
    await this.sample(t, grew, now, probe);
    const next: SessionActivity = { sessionId: t.id, ...derived, lastOutputAt: t.lastOutputAt, ...this.verdict(t), lastOutput: output.lines };
    const changed = recentChanged || !isDeepStrictEqual(next, t.activity);
    t.activity = next;
    return changed;
  }

  /** 找到 transcript 以后挂上 fs.watch（已经挂着就什么也不做；文件被换掉后在这里重新挂）。 */
  private watchTranscript(t: Tracked): void {
    if (!t.file || this.d.watch === null || this.stopped) return;
    const id = t.id;
    t.watch ??= new DebouncedWatch(t.file, {
      delayMs: this.d.watchDebounceMs ?? WATCH_DEBOUNCE_MS,
      onChange: () => void this.refreshSession(id),
      watch: this.d.watch,
      log: this.d.log,
    });
    t.watch.ensure();
  }

  /**
   * 取走这次读到的事件：工具调用记进 recent，记忆读写也记进全局的 memory，新的推给界面。
   * 文件截短或轮转以后重读出来的是旧事：recent 清空重来，只推那以后的。返回 recent 有没有变。
   */
  private takeEvents(t: Tracked, state: TranscriptState, now: number): boolean {
    const pending = state.events.splice(0);
    const restarts = t.tail?.restarts ?? 0;
    let changed = false;
    if (restarts !== t.restarts) {
      t.restarts = restarts;
      t.eventsSince = now;
      changed = t.recent.length > 0;
      t.recent = [];
    }
    for (const raw of pending) {
      const e = liveEvent(t.id, raw);
      if (e.kind === "turn-start") t.turnStartAt = e.at;
      if (e.kind !== "turn-start" && e.kind !== "turn-end") {
        t.recent = [...t.recent, e].slice(-RECENT_TOOLS);
        changed = true;
      }
      if (e.kind === "memory-write" || e.kind === "memory-read") {
        this.memory = [...this.memory, e].sort((a, b) => a.at - b.at).slice(-RECENT_MEMORY);
      }
      if (e.at >= t.eventsSince && !this.stopped) this.d.onEvent?.(e);
    }
    return changed;
  }

  /**
   * UserPromptSubmit 到了、transcript 还没动：停着的先当在想。transcript 动了、已经记着这条输入开始的轮次
   * （hook 到之前就读到了，回得快的这一轮可能已经结束），或者过了 30 秒，就以 transcript 为准。
   */
  private holdPrompt(t: Tracked, a: Omit<DerivedActivity, "eligible">, size: number, now: number): Omit<DerivedActivity, "eligible"> {
    const recorded = t.promptAt !== null && t.turnStartAt !== null && t.turnStartAt >= t.promptAt - EVENT_SLACK_MS;
    if (t.promptAt !== null && (recorded || size !== t.promptSize || now - t.promptAt > PROMPT_HOLD_MS)) t.promptAt = null;
    if (t.promptAt === null || a.kind !== "waiting") return a;
    return { ...a, kind: "thinking", startedAt: t.promptAt };
  }

  private track(id: string, termId: string): Tracked {
    const t: Tracked = {
      id, termId, cwd: "", scope: null, file: null, tail: null, transcriptSize: 0, outputSize: 0, fileSizes: new Map(), outputText: "", lastOutputAt: null,
      eligible: false, lastSampleAt: Number.NEGATIVE_INFINITY, childCpuMs: null, childCpuQuiet: null, activity: null, lastReply: null, lastReplyId: null,
      shellKey: "", shellCommands: [], shellAlive: null, shellCheckedAt: Number.NEGATIVE_INFINITY,
      watch: null, recent: [], eventsSince: this.d.now() - EVENT_SLACK_MS, restarts: 0, promptAt: null, promptSize: 0, turnStartAt: null,
    };
    this.tracked.set(id, t);
    return t;
  }

  private scope(head: Session): StuckScope | null {
    if (head.origin !== "butler" || head.fixesSession !== null) return null;
    const ticket = head.ticketKey ? this.d.tickets.get(head.ticketKey) : null;
    if (head.ticketKey && (!ticket || ticket.archivedAt !== null)) return null;
    const featureId = ticket?.featureId ?? head.featureId;
    if (featureId !== null) {
      const feature = this.d.features.get(featureId);
      if (!feature || feature.archivedAt !== null) return null;
    }
    return { ticketKey: head.ticketKey, featureId, epicId: head.epicId };
  }

  private async readTranscript(t: Tracked): Promise<{ state: TranscriptState; size: number }> {
    t.file ??= this.d.transcriptFile(t.id);
    if (!t.file) return { state: newTranscriptState(), size: 0 };
    t.tail ??= new TranscriptTail(t.file);
    return t.tail.read();
  }

  /**
   * 去掉一定已经结束的后台任务，返回只剩活着的任务的状态（不改 TranscriptTail 里的那份）：
   * - 开始得比这个终端打开还早的：后台 shell 活不过它的 claude 进程，是 --resume 重放出来的旧任务；
   * - 进程树里已经没有它们的 shell 的（TaskStop 之外别的方式结束、没写通知）。进程树和卡住检查一样每 3 分钟看一次，
   *   看到没有了就不再看，直到后台任务变了；读不到就照旧算在跑。
   */
  private async liveBackground(t: Tracked, s: TranscriptState, now: number, probe: Probe): Promise<TranscriptState> {
    const openedAt = this.d.pty.openedAt(t.termId);
    let tasks = backgroundTasks(s).filter((task) => task.startedAt >= openedAt);
    const key = tasks.map((task) => task.taskId).sort().join(" ");
    if (key !== t.shellKey) {
      t.shellKey = key;
      t.shellCommands = tasks.map((task) => task.command);
      t.shellAlive = null;
    }
    if (tasks.length && t.shellAlive !== false && now - t.shellCheckedAt >= this.stuckCheckMs) await probe();
    if (t.shellAlive === false) tasks = [];
    if (tasks.length === s.background.size) return s;
    return { ...s, background: new Map(tasks.map((task) => [task.taskId, task])) };
  }

  /** 进程树读数，同一次更新里只读一次；读到后台任务的结论就记下来（已经知道没有了的不再问：前台命令的 shell 会让它们看起来又活了）。 */
  private probe(t: Tracked, now: number): Probe {
    let pending: Promise<ProcSample> | null = null;
    return () => {
      pending ??= (async () => {
        const commands = t.shellAlive === false ? [] : t.shellCommands;
        const pid = this.d.pty.pid(t.termId);
        const sample: ProcSample = pid === null ? { cpuMs: null, liveShell: null } : await (this.d.procTree ?? sampleProcTree)(pid, commands);
        if (commands.length) {
          t.shellAlive = sample.liveShell;
          t.shellCheckedAt = now;
        }
        return sample;
      })();
      return pending;
    };
  }

  /**
   * 前台 Bash 显示它自己的输出文件；其他情况显示最新后台任务的。
   * 大小把所有后台任务都算上：显示的是最新的，但旧的那个在涨也说明没有卡住。
   * 子 agent 在跑时再算上它的 transcript：只读的子 agent 在主 transcript、命令输出和子进程 CPU 上都看不出动静。
   * 这部分只算大小，不显示。
   */
  private async readOutput(t: Tracked, s: TranscriptState): Promise<{ size: number; lines: string[]; text: string }> {
    const dir = t.file ? (this.d.tasksDir ?? tasksDirFor)(t.file, t.id) : null;
    const files = sortedBackground(s).flatMap((task) => task.outputFile ?? (dir ? [join(dir, `${task.taskId}.output`)] : []));
    const tool = currentTool(s);
    let shown = files.at(-1) ?? null;
    if (tool?.name === "Bash") shown = dir ? await foregroundOutputFile(dir, tool.startedAt, new Set(files.map((f) => basename(f)))) : null;
    const tail = shown ? await readOutputTail(shown) : null;
    const sizes = new Map<string, number>();
    if (shown) sizes.set(shown, tail?.size ?? t.fileSizes.get(shown) ?? 0);
    for (const f of files) if (f !== shown) sizes.set(f, (await fileSize(f)) ?? t.fileSizes.get(f) ?? 0);
    const agent = tool && AGENT_TOOLS.has(tool.name) ? tool : null;
    const subagents = agent && dir ? await subagentOutputSizes(dir, agent.startedAt) : null;
    if (subagents) for (const [f, n] of subagents) sizes.set(f, n ?? t.fileSizes.get(f) ?? 0);
    // 前台命令或子 agent 还在跑却读不到 tasks 目录：一时读不了，上次的大小继续算。
    const unread = tool?.name === "Bash" ? !shown : !!agent && !subagents;
    if (unread) for (const [f, n] of t.fileSizes) if (!sizes.has(f)) sizes.set(f, n);
    t.fileSizes = sizes;
    const size = [...sizes.values()].reduce((sum, n) => sum + n, 0);
    return { size, lines: tail?.lines ?? [], text: tail ? utf8Tail(tail.text, JUDGE_OUTPUT_BYTES) : "" };
  }

  /** 卡住检测采样：平时每 3 分钟一次；已经卡住时一有动静马上采，红点不用等到下一次检查才消失。 */
  private async sample(t: Tracked, grew: boolean, now: number, probe: Probe): Promise<void> {
    if (!t.scope) {
      this.tracker.forget(t.id);
      this.wanted.delete(t.id);
      return;
    }
    if (grew || !t.eligible) this.wanted.delete(t.id);
    const moved = this.tracker.state(t.id).stuck && (grew || !t.eligible);
    if (!moved && now - t.lastSampleAt < this.stuckCheckMs) return;
    t.lastSampleAt = now;
    if (t.eligible) {
      const cpu = (await probe()).cpuMs;
      t.childCpuQuiet = cpuQuiet(t.childCpuMs, cpu);
      t.childCpuMs = cpu;
    }
    if (this.stopped) return;
    const sample = { transcriptSize: t.transcriptSize, outputSize: t.outputSize, childCpuMs: t.childCpuMs, eligible: t.eligible };
    const suspicious = this.tracker.observe(t.id, sample, now);
    if (suspicious && !this.judging.has(t.id)) this.wanted.add(t.id);
    if (!suspicious) this.wanted.delete(t.id);
  }

  private verdict(t: Tracked): Pick<SessionActivity, "stuck" | "reason" | "action"> {
    return t.scope ? this.tracker.state(t.id) : { stuck: null, reason: null, action: null };
  }

  /** 把卡住的结论写回活动，返回有没有变化。 */
  private syncVerdict(t: Tracked): boolean {
    if (!t.activity) return false;
    const next = { ...t.activity, ...this.verdict(t) };
    const changed = !isDeepStrictEqual(next, t.activity);
    t.activity = next;
    return changed;
  }

  /** 名额满了的留在 wanted 里，下一轮再看。判断要几十秒，不能挡住活动刷新，所以不等它。 */
  private startJudges(now: number): void {
    for (const id of this.wanted) {
      if (this.judging.size >= MAX_JUDGES) return;
      this.wanted.delete(id);
      const t = this.tracked.get(id);
      if (!t?.scope) continue;
      this.judging.add(id);
      this.judge(t, t.scope, now).catch((e: unknown) => this.d.log?.(`stuck judge of session ${id} failed`, e));
    }
  }

  private async judge(t: Tracked, scope: StuckScope, now: number): Promise<void> {
    const quietSince = t.lastOutputAt;
    let verdict: StuckVerdict | null = null;
    try {
      verdict = await this.d.judge(this.judgeInput(t, now));
    } catch (e) {
      this.d.log?.(`stuck judge of session ${t.id} failed`, e);
    } finally {
      this.judging.delete(t.id);
    }
    // 判断期间 session 退出或者 /clear：这个结论和现在的 session 无关了。
    if (this.stopped || this.tracked.get(t.id) !== t) return;
    // 有了新输出或者转去等人确认：“卡住”已经过时，“没卡住”照样算数，10 分钟静默期要记下。
    if (verdict?.stuck && (t.lastOutputAt !== quietSince || !t.eligible)) return;
    const result = this.tracker.judged(t.id, verdict, this.d.now());
    if (this.syncVerdict(t)) this.d.notify();
    if (result === "newly_stuck" && verdict) this.d.onStuck({ sessionId: t.id, ...scope, reason: verdict.reason });
  }

  private judgeInput(t: Tracked, now: number): StuckInput {
    return {
      cwd: t.cwd,
      activity: t.activity ? describeActivity(t.activity) : "",
      minutes: Math.round((now - (t.lastOutputAt ?? now)) / 60_000),
      lastOutput: t.outputText,
      terminalTail: utf8Tail(stripAnsi(this.d.pty.snapshot(t.termId).data), JUDGE_TERMINAL_BYTES),
      childCpuQuiet: t.childCpuQuiet,
    };
  }
}
