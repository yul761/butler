import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ACTIVITY_OUTPUT_LIMIT } from "../../shared/control";
import type { ActivityKind, SessionActivity } from "../../shared/activity";
import type { Feature, Session, Ticket } from "../../shared/types";
import { M } from "../strings";
import { backgroundTasks, classifyCommand, currentTool, DETAIL_LIMIT, newTranscriptState, type BackgroundTask, type RunningTool, type TranscriptState } from "./activity-parse";
import { foregroundOutputFile, readOutputTail, tasksDirFor, TranscriptTail, utf8Tail } from "./activity-sources";
import { childCpuMs } from "./proc-tree";
import { permissionPromptShowing, stripAnsi, type PtySnapshot } from "./pty-manager";
import type { StuckInput } from "./stuck-judge";
import { cpuQuiet, STUCK_CHECK_MS, StuckTracker, type StuckVerdict } from "./stuck-tracker";

/** 活动刷新的间隔。 */
export const ACTIVITY_TICK_MS = 10_000;
/** 同时最多请几个 headless Claude 判断。 */
const MAX_JUDGES = 2;
/** 给 Claude 判断时，最后输出和终端末尾各最多带多少字节。 */
const JUDGE_OUTPUT_BYTES = 4096;
const JUDGE_TERMINAL_BYTES = 2048;

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);

export interface StuckInfo {
  sessionId: string;
  ticketKey: string;
  featureId: number;
  reason: string;
}

export interface ActivityDeps {
  sessions: { head(id: string): Session | null };
  tickets: { get(key: string): Ticket | null };
  features: { get(id: number): Feature | null };
  pty: { openIds(): string[]; snapshot(termId: string): PtySnapshot; pid(termId: string): number | null };
  /** session 的 transcript 文件；还没有时返回 null。 */
  transcriptFile: (sessionId: string) => string | null;
  judge: (input: StuckInput) => Promise<StuckVerdict | null>;
  /** 活动变化时调用；内容没变不调。 */
  notify: () => void;
  /** 一次卡住只调一次。 */
  onStuck: (info: StuckInfo) => void;
  now: () => number;
  /** 测试注入；默认用 proc-tree 读真实进程树。 */
  childCpu?: (rootPid: number) => Promise<number | null>;
  /** 测试注入；默认是 Claude 放命令输出的目录。 */
  tasksDir?: (transcriptFile: string, sessionId: string) => string | null;
  log?: (msg: string, err?: unknown) => void;
}

export interface DerivedActivity extends Pick<SessionActivity, "kind" | "detail" | "background" | "startedAt"> {
  /** 这一轮没结束或者有后台命令在跑，也没在等人确认：才参与卡住检测。 */
  eligible: boolean;
}

function toolActivity(t: RunningTool): { kind: ActivityKind; detail: string | null } {
  if (EDIT_TOOLS.has(t.name)) return { kind: "edit", detail: t.file ? basename(t.file) : null };
  if (READ_TOOLS.has(t.name)) return { kind: "read", detail: null };
  if (AGENT_TOOLS.has(t.name)) return { kind: "agent", detail: null };
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
  const eligible = !atPermissionPrompt && (s.turnOpen || !!task);
  const noTool = { detail: null, background: false, startedAt: null, eligible };
  if (atPermissionPrompt) return { kind: "approval", ...noTool };
  const tool = currentTool(s);
  if (tool) return { ...toolActivity(tool), background: false, startedAt: tool.startedAt, eligible };
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

/** 卡住检测的范围：有红点可放的行，也就是未归档 feature 下未归档 ticket 的普通 session。 */
interface StuckScope {
  ticketKey: string;
  featureId: number;
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
}

/**
 * 每 10 秒看一遍有终端的 session：读 transcript 和命令输出得出活动，每 3 分钟采一次样判断是否卡住。
 * 键是 sessions.head() 的 id：/clear 后新 id 接替旧 id，旧 id 的记录清掉。全部只存内存。
 */
export class ActivityMonitor {
  private readonly tracker = new StuckTracker();
  private readonly tracked = new Map<string, Tracked>();
  /** 可疑、等着空出名额去判断的 session。 */
  private readonly wanted = new Set<string>();
  private readonly judging = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(private readonly d: ActivityDeps) {}

  start(): void {
    this.stopped = false;
    void this.tick(this.d.now());
    this.timer = setInterval(() => void this.tick(this.d.now()), ACTIVITY_TICK_MS);
  }

  /** 退出时在关数据库之前调用：之后不再碰数据库，迟到的判断结果也不再生效。 */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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

  /** 当前命令输出的末尾，最多 4096 字节（不切开 UTF-8 字符）；读不到返回 ""。 */
  async output(sessionId: string): Promise<string> {
    return utf8Tail(this.tracked.get(sessionId)?.outputText ?? "", ACTIVITY_OUTPUT_LIMIT);
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
    for (const id of this.tracked.keys()) {
      if (live.has(id)) continue;
      this.tracked.delete(id);
      this.tracker.forget(id);
      this.wanted.delete(id);
      changed = true;
    }
    for (const { head, termId } of live.values()) {
      // 读文件的时候可能开始退出了，数据库随后就关
      if (this.stopped) return false;
      try {
        if (await this.update(head, termId, now)) changed = true;
      } catch (e) {
        this.d.log?.(`activity of session ${head.id} failed`, e);
      }
    }
    return changed;
  }

  private async update(head: Session, termId: string, now: number): Promise<boolean> {
    const t = this.tracked.get(head.id) ?? this.track(head.id, termId);
    t.termId = termId;
    t.cwd = head.cwd;
    t.scope = this.scope(head);
    const { state, size } = await this.readTranscript(t);
    const { eligible, ...derived } = deriveActivity(state, permissionPromptShowing(this.d.pty.snapshot(termId).data));
    const output = await this.readOutput(t, state);
    const grew = size !== t.transcriptSize || output.size !== t.outputSize;
    t.transcriptSize = size;
    t.outputSize = output.size;
    t.outputText = output.text;
    t.eligible = eligible;
    if (grew) t.lastOutputAt = now;
    await this.sample(t, grew, now);
    const next: SessionActivity = { sessionId: t.id, ...derived, lastOutputAt: t.lastOutputAt, ...this.verdict(t), lastOutput: output.lines };
    const changed = !isDeepStrictEqual(next, t.activity);
    t.activity = next;
    return changed;
  }

  private track(id: string, termId: string): Tracked {
    const t: Tracked = {
      id, termId, cwd: "", scope: null, file: null, tail: null, transcriptSize: 0, outputSize: 0, fileSizes: new Map(), outputText: "", lastOutputAt: null,
      eligible: false, lastSampleAt: Number.NEGATIVE_INFINITY, childCpuMs: null, childCpuQuiet: null, activity: null,
    };
    this.tracked.set(id, t);
    return t;
  }

  private scope(head: Session): StuckScope | null {
    if (!head.ticketKey || head.coordinator || head.fixesSession) return null;
    const ticket = this.d.tickets.get(head.ticketKey);
    if (!ticket || ticket.archivedAt !== null || ticket.featureId === null) return null;
    const feature = this.d.features.get(ticket.featureId);
    return feature && feature.archivedAt === null ? { ticketKey: head.ticketKey, featureId: ticket.featureId } : null;
  }

  private async readTranscript(t: Tracked): Promise<{ state: TranscriptState; size: number }> {
    t.file ??= this.d.transcriptFile(t.id);
    if (!t.file) return { state: newTranscriptState(), size: 0 };
    t.tail ??= new TranscriptTail(t.file);
    return t.tail.read();
  }

  /**
   * 前台 Bash 显示它自己的输出文件；其他情况显示最新后台任务的。
   * 大小把所有后台任务都算上：显示的是最新的，但旧的那个在涨也说明没有卡住。
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
    // 前台命令还在跑却找不到它的输出文件：tasks 目录一时读不了，上次的大小继续算。
    if (tool?.name === "Bash" && !shown) for (const [f, n] of t.fileSizes) if (!sizes.has(f)) sizes.set(f, n);
    t.fileSizes = sizes;
    const size = [...sizes.values()].reduce((sum, n) => sum + n, 0);
    return { size, lines: tail?.lines ?? [], text: tail ? utf8Tail(tail.text, JUDGE_OUTPUT_BYTES) : "" };
  }

  /** 卡住检测采样：平时每 3 分钟一次；已经卡住时一有动静马上采，红点不用等到下一次检查才消失。 */
  private async sample(t: Tracked, grew: boolean, now: number): Promise<void> {
    if (!t.scope) {
      this.tracker.forget(t.id);
      this.wanted.delete(t.id);
      return;
    }
    if (grew || !t.eligible) this.wanted.delete(t.id);
    const moved = this.tracker.state(t.id).stuck && (grew || !t.eligible);
    if (!moved && now - t.lastSampleAt < STUCK_CHECK_MS) return;
    t.lastSampleAt = now;
    if (t.eligible) {
      const cpu = await this.childCpu(t.termId);
      t.childCpuQuiet = cpuQuiet(t.childCpuMs, cpu);
      t.childCpuMs = cpu;
    }
    if (this.stopped) return;
    const sample = { transcriptSize: t.transcriptSize, outputSize: t.outputSize, childCpuMs: t.childCpuMs, eligible: t.eligible };
    const suspicious = this.tracker.observe(t.id, sample, now);
    if (suspicious && !this.judging.has(t.id)) this.wanted.add(t.id);
    if (!suspicious) this.wanted.delete(t.id);
  }

  private async childCpu(termId: string): Promise<number | null> {
    const pid = this.d.pty.pid(termId);
    if (pid === null) return null;
    return this.d.childCpu ? this.d.childCpu(pid) : childCpuMs(pid);
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
