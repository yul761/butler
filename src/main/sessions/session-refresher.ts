import type { SessionActivity } from "../../shared/activity";
import { sanitizeTask } from "../../shared/control";
import type { RefreshRefusal, RefreshStep, Session } from "../../shared/types";
import { M } from "../strings";
import type { DeliveryCheck, DeliveryGuard } from "./delivery-guard";

/** 等 handoff 收进来最多 10 分钟，等 /clear 之后的新 id 最多 60 秒，失败之后 30 分钟内不再自动试（计划 16）。 */
export const REFRESH_HANDOFF_MS = 600_000, REFRESH_CLEAR_MS = 60_000, REFRESH_COOLDOWN_MS = 1_800_000;
/** 等待时多久看一次：handoff 收进来没有、新 id 接上没有、session 停下来没有。 */
const POLL_MS = 1_000;
/** epic 的进度要打开 StateCore 读，5 秒查一次。 */
const EPIC_POLL_MS = 5_000;
const HANDOFF_COMMAND = "/handoff";
const CLEAR_COMMAND = "/clear";

export type RefreshKind = "ticket" | "feature" | "epic";
export type RefreshTrigger = "auto" | "coordinator" | "manual";
export type { RefreshStep };
/**
 * done：三步都输入了。busy：现在不能往终端里输入（什么都没输入，不冷却）。already：这个 session 正在换新。
 * cooldown：30 分钟内失败过（手动触发不看这一条）。memory_off：记忆关着，换新以后接不上，什么都不输入。
 * failed：不能换新的 session，或者中途停下了（之后不再输入任何东西，进入冷却）。
 */
export type RefreshResult = "done" | RefreshRefusal;

/**
 * 能换新的 session 是哪一种（SessionRefresherDeps.kindOf）：ticket session 和 ticket 总控是 ticket，feature 总控是 feature，
 * epic session 是 epic。修复 session、不是 Butler 开的、没开着终端的、什么都不属于的返回 null。
 */
export function refreshKindOf(s: Session, terminalOpen: boolean): RefreshKind | null {
  if (!terminalOpen || s.origin !== "butler" || s.fixesSession !== null) return null;
  if (s.epicId !== null) return "epic";
  if (s.ticketKey) return "ticket";
  return s.featureId !== null ? "feature" : null;
}

/**
 * 总控的 refresh_session 和界面上的按钮：能开始就在后台开始（不等它跑完），返回 null；不能就马上返回原因，什么都不做。
 * precheck 和 refresh 之间没有 await，refresh 里同步的检查看到的是同一个状态。
 */
export function startRefresh(
  r: Pick<SessionRefresher, "precheck" | "refresh">, sessionId: string, trigger: RefreshTrigger, log: (msg: string, err?: unknown) => void,
): RefreshRefusal | null {
  const refused = r.precheck(sessionId, trigger);
  if (refused !== null) return refused;
  r.refresh(sessionId, trigger).catch((e: unknown) => log(`refresh ${sessionId} (${trigger}) failed`, e));
  return null;
}

/**
 * 自动换新那道 guard 的「需要你」（R33）：真判断出需要你就挡；判断还没出结论时，没在换新就挡（不开始新的自动换新），
 * 正在换新就不挡（/handoff 那条回复停下来以后判断要几秒，不能因此停在 /clear 之前）。
 */
export function autoRefreshNeedsYou(v: { reason: string | null; undecided: boolean; refreshing: boolean }): boolean {
  return v.reason !== null || (v.undecided && !v.refreshing);
}

export interface SessionRefresherDeps {
  /** 自动换新用：含「需要你」。和递 CI 结果用的不是同一个实例，不带 refreshing（R25），否则换新会挡住自己的下一步。 */
  guard: Pick<DeliveryGuard, "check">;
  /** 手动和总控触发用：不看「需要你」，其余条件（草稿、30 秒打字、屏幕确认）照样要满足。同样不带 refreshing。 */
  guardIgnoringNeedsYou: Pick<DeliveryGuard, "check">;
  head(sessionId: string): Session | null;
  /** 按 head 的 id 查。自动换新要求没有后台任务在跑（guard 把只剩后台任务的 session 当作停着，见计划 13 R9）。 */
  activity(sessionId: string): SessionActivity | null;
  /** 修复 session、headless、非 Butler 的返回 null。 */
  kindOf(s: Session): RefreshKind | null;
  contextOf(sessionId: string): number | null;
  /** 设置 refreshThresholdTokens，0 = 关。 */
  threshold(): number;
  /** ticket session 和 feature 总控的 /handoff 是 Butler 自己的命令（handoffCommandStatus === "installed"）。 */
  handoffCommandReady(): Promise<boolean>;
  /** Task 1 合并后恒为 true；留着这个开关是为了按顺序上线。 */
  epicPlanReady(): boolean;
  /** 设置里的记忆开关（memoryEnabled）：关着时 session 换新以后没有 handoff 可以 recall。 */
  memoryEnabled(): boolean;
  /** epic session 写的进度（MemoryService.epicProgress）：Butler 重新渲染时不变，只有 epic session 写了新的才变（R29）。 */
  epicProgress(epicId: number): Promise<string | null>;
  deliver(termId: string, text: string): Promise<"sent" | "exited" | "timeout">;
  /** 开着终端的 Butler session 的 head，自动检查用。 */
  sessions(): Session[];
  /** 换新开始、换了一步、结束时调用（「现在」页显示"换新中"）。 */
  notify(): void;
  now(): number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * 现在就重读这个 session 的活动（index.ts 的 refreshActivityOf）。等着输入下一步时每次看 guard 之前先读一次（R28）：
   * guard 看的是上一次刷新的活动，/clear 之后还没有 Stop，不读就一直当它在忙。不给就只靠活动监控自己的 tick。
   */
  refreshActivity?: (sessionId: string) => Promise<void>;
  log(msg: string, err?: unknown): void;
}

/** stop() 之后，正在进行的换新在下一个检查点用它悄悄退出（execute 接住，不记日志）。 */
class RefresherStopped extends Error {}

/** 一次正在进行的换新。 */
interface Run {
  /** 开始时的 head id；之后 /clear、压缩换了 id 也按链认。 */
  headId: string;
  termId: string;
  kind: RefreshKind;
  trigger: RefreshTrigger;
  step: RefreshStep;
  epicId: number | null;
  ticket: string;
  /** ticket / feature：Butler 输入 /handoff 的时间；之前收进来的 handoff（用户自己的 /handoff）不算。 */
  handoffTypedAt: number | null;
  /** ticket / feature：Butler 输入 /handoff 之后，capture 存下了这个 session 的 /handoff。 */
  stored: boolean;
}

/**
 * 给上下文太长的 session 换新（计划 16）：写 handoff → 等收进来 → /clear → 等新 id 接上 → 发接着做的话。
 * 每一步输入之前都要 session 重新停下来、用户没在打字、没有草稿；任何一步失败都停在原地，什么都不再输入，30 分钟内不再自动试。
 */
export class SessionRefresher {
  private readonly runs = new Set<Run>();
  /** 失败过的 session（按链认）和失败的时间。 */
  private readonly failedAt = new Map<string, number>();
  private readonly sleep: (ms: number) => Promise<void>;
  /** Butler 要退出了（stop）：不再开始换新，正在进行的在下一个检查点停下，不再输入、不再读库。 */
  private stopped = false;

  constructor(private readonly d: SessionRefresherDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** 每个活动 tick 之后调：找满足条件的 session，一次最多启动一个；已经有一个在换新时什么都不做。上下文最长的先换。 */
  autoCheck(): void {
    if (this.stopped || this.runs.size > 0 || !this.d.memoryEnabled()) return;
    const limit = this.d.threshold();
    if (!(limit > 0)) return;
    const candidates = this.d
      .sessions()
      .map((s) => ({ s, context: this.d.contextOf(s.id) }))
      .filter((c): c is { s: Session; context: number } => c.context !== null && c.context >= limit)
      .sort((a, b) => b.context - a.context);
    for (const { s } of candidates) {
      const run = this.begin(s.id, "auto");
      if (typeof run === "string") continue;
      void this.execute(run);
      return;
    }
  }

  async refresh(sessionId: string, trigger: RefreshTrigger): Promise<RefreshResult> {
    const run = this.begin(sessionId, trigger);
    return typeof run === "string" ? run : this.execute(run);
  }

  /**
   * 同步回答现在能不能开始换新（R31：总控的 refresh_session 要马上回答）：null 表示可以。
   * 看 session 种类、记忆开关、epic 规划、是否正在换新、冷却（手动不看）和 guard（按触发方式选）。
   * /handoff 命令文件是不是 Butler 的要读文件，留在 refresh() 里异步看。
   */
  precheck(sessionId: string, trigger: RefreshTrigger): RefreshRefusal | null {
    const r = this.check(sessionId, trigger);
    return "result" in r ? r.result : null;
  }

  /**
   * 退出前调用（index.ts 的 before-quit）：之后什么都不再开始；正在等的换新在下一个检查点（每次等待醒来、每次输入前后）
   * 悄悄结束：不输入、不读库、不记失败也不冷却。数据库在 will-quit 里关掉，那之后不能再碰它。
   */
  stop(): void {
    this.stopped = true;
  }

  /** 链上任何一个 id 都认。 */
  isRefreshing(sessionId: string): boolean {
    return this.runOf(sessionId) !== null;
  }

  stepOf(sessionId: string): RefreshStep | null {
    return this.runOf(sessionId)?.step ?? null;
  }

  /** capture 存下了这个 session 的 /handoff。Butler 还没输入 /handoff 时收进来的（用户自己的）不算。 */
  handoffStored(sessionId: string): void {
    for (const run of this.runs) {
      if (run.step === "handoff" && run.kind !== "epic" && run.handoffTypedAt !== null && this.sameChain(sessionId, run.headId)) run.stored = true;
    }
  }

  /** 开始前的同步检查（precheck 和 begin 共用）；通过时给出要登记的这次换新，不登记。 */
  private check(sessionId: string, trigger: RefreshTrigger): { result: RefreshRefusal } | { run: Run } {
    if (this.stopped) return { result: "busy" };
    if (!this.d.memoryEnabled()) return { result: "memory_off" };
    const head = this.d.head(sessionId);
    const kind = head ? this.d.kindOf(head) : null;
    // 缺了接着做的话要用的 ticket 号、epic id 的，不换新。
    if (!head || !kind || (kind === "epic" && head.epicId === null) || (kind === "ticket" && !head.ticketKey)) return { result: "failed" };
    // epic 规划单独存放之前，换新会让 epic session 写一份进度 handoff，把记忆里的规划冲掉：手动也不行。
    if (kind === "epic" && !this.d.epicPlanReady()) return { result: "failed" };
    if (this.isRefreshing(head.id)) return { result: "already" };
    if (trigger !== "manual" && this.cooling(head.id)) return { result: "cooldown" };
    const gate = this.canStart(head.id, trigger);
    if (!gate.ok) return { result: "busy" };
    return {
      run: {
        headId: gate.headId, termId: gate.termId, kind, trigger, step: "handoff", epicId: head.epicId, ticket: head.ticketKey ?? "",
        handoffTypedAt: null, stored: false,
      },
    };
  }

  /** 开始时和第一步输入之前（中间等过异步）都看这一道：guard 通过；自动触发还要求没有后台任务在跑。 */
  private canStart(sessionId: string, trigger: RefreshTrigger): DeliveryCheck {
    const gate = this.guardFor(trigger).check(sessionId);
    if (gate.ok && trigger === "auto" && this.d.activity(gate.headId)?.background === true) return { ok: false, block: "busy" };
    return gate;
  }

  /** 同步做完开始前的检查；通过就登记成正在换新（之后的异步检查期间也不会再起一次）。 */
  private begin(sessionId: string, trigger: RefreshTrigger): RefreshResult | Run {
    const r = this.check(sessionId, trigger);
    if ("result" in r) {
      if (r.result === "failed" && trigger !== "auto") this.d.log(`refresh ${sessionId}: not a session Butler can refresh now (or epic plans are not stored apart yet)`);
      return r.result;
    }
    const run = r.run;
    this.runs.add(run);
    this.d.log(`refresh ${run.headId} (${run.kind}, ${trigger}): started`);
    this.changed();
    return run;
  }

  /** 永不 reject。 */
  private async execute(run: Run): Promise<RefreshResult> {
    try {
      const result = await this.steps(run);
      if (result === "done") this.d.log(`refresh ${run.headId}: done`);
      return result;
    } catch (e) {
      if (e instanceof RefresherStopped) return "failed";
      return this.fail(run, "unexpected error", e);
    } finally {
      this.runs.delete(run);
      if (!this.stopped) this.changed();
    }
  }

  private async steps(run: Run): Promise<RefreshResult> {
    // 第一步：ticket 和 feature 总控输入 /handoff，等 capture 收进来；epic session 用 butler-epic 的 handoff 写进度，等进度变。
    // epic 比的是进度不是 handoff 的版本：Butler 自己重新渲染（feature 有变化）也会写新版本，但进度原样带着（R29）。
    let before: string | null = null;
    this.alive();
    if (run.kind === "epic") before = await this.d.epicProgress(run.epicId!);
    else if (!(await this.d.handoffCommandReady())) {
      this.alive();
      // 用户改过 /handoff 的命令文件：不知道它会输出什么，收不进来就只会白等 10 分钟。冷却期间不再试，也不再记日志。
      return this.fail(run, "/handoff is not Butler's own command (the command file was changed), so the session was not refreshed");
    }
    // 中间等过异步：重新看一眼。这时还什么都没输入，不通过就当作忙（记忆刚关掉就是 memory_off），不冷却。
    this.alive();
    if (!this.d.memoryEnabled()) return "memory_off";
    const gate = this.canStart(run.headId, run.trigger);
    if (!gate.ok || gate.termId !== run.termId) return "busy";
    // 从这一刻起收进来的 handoff 才算这次换新的（审查：用户自己的 /handoff 恰好在前面的检查期间收进来，不能让 /clear 跟着就输入）。
    run.stored = false;
    run.handoffTypedAt = this.d.now();
    const typedHandoff = await this.type(run, run.kind === "epic" ? M().refreshEpicHandoff : HANDOFF_COMMAND);
    if (typedHandoff) return this.fail(run, `typing the handoff request: ${typedHandoff}`);
    const handedOff =
      run.kind === "epic"
        ? await this.until(async () => {
            const progress = await this.d.epicProgress(run.epicId!);
            return progress !== null && progress !== before;
          }, REFRESH_HANDOFF_MS, EPIC_POLL_MS)
        : await this.until(() => run.stored, REFRESH_HANDOFF_MS, POLL_MS);
    if (!handedOff) return this.fail(run, `the handoff was not stored within ${REFRESH_HANDOFF_MS / 60_000} minutes`);

    // 第二步：/clear，等 SessionStart（source=clear）把新 id 接上 replaced_by。
    this.setStep(run, "clear");
    const beforeClear = await this.untilQuiet(run);
    if (beforeClear) return this.fail(run, `before /clear: ${beforeClear}`);
    this.alive();
    const oldHead = this.d.head(run.termId)?.id ?? run.headId;
    const typedClear = await this.type(run, CLEAR_COMMAND);
    if (typedClear) return this.fail(run, `typing /clear: ${typedClear}`);
    const cleared = await this.until(() => {
      const h = this.d.head(run.termId);
      return h !== null && h.id !== oldHead;
    }, REFRESH_CLEAR_MS, POLL_MS);
    if (!cleared) return this.fail(run, `no new session id within ${REFRESH_CLEAR_MS / 1000} seconds after /clear`);

    // 第三步：只让它调回进度、说一两句做到哪了，然后等用户。
    this.setStep(run, "resume");
    const beforeResume = await this.untilQuiet(run);
    if (beforeResume) return this.fail(run, `before the resume message: ${beforeResume}`);
    const typedResume = await this.type(run, M().refreshResume(run.kind, run.ticket));
    if (typedResume) return this.fail(run, `typing the resume message: ${typedResume}`);
    return "done";
  }

  /**
   * 等到能往里输入：session 又停下来了（写 handoff、/clear 时它本来就会忙一阵）就返回 null，最多等 REFRESH_CLEAR_MS。
   * 用户在打字、留了草稿、屏幕上有要用户回答的东西、终端关了或换了、记忆被关掉了，马上返回原因，不等。
   */
  private async untilQuiet(run: Run): Promise<string | null> {
    const end = this.d.now() + REFRESH_CLEAR_MS;
    for (;;) {
      this.alive();
      if (!this.d.memoryEnabled()) return "memory_off";
      await this.rereadActivity(run);
      this.alive();
      const gate = this.guardFor(run.trigger).check(run.headId);
      if (gate.ok) return gate.termId === run.termId ? null : "the terminal changed";
      if (gate.block !== "busy") return gate.block;
      if (this.d.now() >= end) return `still busy after ${REFRESH_CLEAR_MS / 1000} seconds`;
      await this.sleep(POLL_MS);
    }
  }

  /** 重读活动；读失败只记日志，照样看 guard（读不到就还是上一次的活动）。 */
  private async rereadActivity(run: Run): Promise<void> {
    try {
      await this.d.refreshActivity?.(run.headId);
    } catch (e) {
      this.d.log(`refresh ${run.headId}: re-reading the activity failed`, e);
    }
  }

  /** 条件在 ms 之内成立就返回 true；每 every 毫秒看一次。 */
  private async until(cond: () => boolean | Promise<boolean>, ms: number, every: number): Promise<boolean> {
    const end = this.d.now() + ms;
    for (;;) {
      this.alive();
      const met = await cond();
      // epic 的进度要读 StateCore：读的期间 stop 了，结果不算。
      this.alive();
      if (met) return true;
      if (this.d.now() >= end) return false;
      await this.sleep(every);
    }
  }

  /** 输入一段文字；成功返回 null，否则返回原因。 */
  private async type(run: Run, text: string): Promise<string | null> {
    this.alive();
    let r: "sent" | "exited" | "timeout";
    try {
      r = await this.d.deliver(run.termId, sanitizeTask(text));
    } catch (e) {
      this.alive();
      this.d.log(`refresh ${run.headId}: deliver failed`, e);
      return "deliver failed";
    }
    // 退出时终端被一起关掉，deliver 返回 exited：那不算失败。
    this.alive();
    return r === "sent" ? null : r;
  }

  /** stop() 之后在检查点退出。 */
  private alive(): void {
    if (this.stopped) throw new RefresherStopped();
  }

  private fail(run: Run, reason: string, err?: unknown): "failed" {
    this.failedAt.set(run.headId, this.d.now());
    this.d.log(`refresh ${run.headId} (${run.kind}, step ${run.step}): ${reason}; stopped, nothing more is typed`, err);
    return "failed";
  }

  private setStep(run: Run, step: RefreshStep): void {
    run.step = step;
    this.changed();
  }

  private changed(): void {
    try {
      this.d.notify();
    } catch (e) {
      this.d.log("refresh: notify failed", e);
    }
  }

  private guardFor(trigger: RefreshTrigger): Pick<DeliveryGuard, "check"> {
    return trigger === "auto" ? this.d.guard : this.d.guardIgnoringNeedsYou;
  }

  private runOf(sessionId: string): Run | null {
    for (const run of this.runs) if (this.sameChain(sessionId, run.headId)) return run;
    return null;
  }

  /** 30 分钟内失败过（按链认：失败之后 /clear 换了 id 也算）。过期的顺手删掉。 */
  private cooling(sessionId: string): boolean {
    const now = this.d.now();
    let cooling = false;
    for (const [id, at] of this.failedAt) {
      if (now - at >= REFRESH_COOLDOWN_MS) this.failedAt.delete(id);
      else if (this.sameChain(sessionId, id)) cooling = true;
    }
    return cooling;
  }

  /** 两个 id 是不是同一条 replaced_by 链：沿链走到的 head 相同。 */
  private sameChain(a: string, b: string): boolean {
    return a === b || (this.d.head(a)?.id ?? a) === (this.d.head(b)?.id ?? b);
  }
}
