import type { SessionActivity } from "../../shared/activity";
import { sanitizeTask } from "../../shared/control";
import type { Session } from "../../shared/types";
import { M } from "../strings";
import type { DeliveryGuard } from "./delivery-guard";

/** 等 handoff 收进来最多 10 分钟，等 /clear 之后的新 id 最多 60 秒，失败之后 30 分钟内不再自动试（计划 16）。 */
export const REFRESH_HANDOFF_MS = 600_000, REFRESH_CLEAR_MS = 60_000, REFRESH_COOLDOWN_MS = 1_800_000;
/** 等待时多久看一次：handoff 收进来没有、新 id 接上没有、session 停下来没有。 */
const POLL_MS = 1_000;
/** epic 的 handoff 版本要打开 StateCore 读，5 秒查一次。 */
const EPIC_POLL_MS = 5_000;
const HANDOFF_COMMAND = "/handoff";
const CLEAR_COMMAND = "/clear";

export type RefreshKind = "ticket" | "feature" | "epic";
export type RefreshTrigger = "auto" | "coordinator" | "manual";
export type RefreshStep = "handoff" | "clear" | "resume";
/**
 * done：三步都输入了。busy：现在不能往终端里输入（什么都没输入，不冷却）。already：这个 session 正在换新。
 * cooldown：30 分钟内失败过（手动触发不看这一条）。failed：不能换新的 session，或者中途停下了（之后不再输入任何东西，进入冷却）。
 */
export type RefreshResult = "done" | "busy" | "already" | "cooldown" | "failed";

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
  epicHandoffVersion(epicId: number): Promise<string | null>;
  deliver(termId: string, text: string): Promise<"sent" | "exited" | "timeout">;
  /** 开着终端的 Butler session 的 head，自动检查用。 */
  sessions(): Session[];
  /** 换新开始、换了一步、结束时调用（「现在」页显示"换新中"）。 */
  notify(): void;
  now(): number;
  sleep?: (ms: number) => Promise<void>;
  log(msg: string, err?: unknown): void;
}

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
  /** ticket / feature：capture 存下了这个 session 的 /handoff。 */
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

  constructor(private readonly d: SessionRefresherDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** 每个活动 tick 之后调：找满足条件的 session，一次最多启动一个；已经有一个在换新时什么都不做。上下文最长的先换。 */
  autoCheck(): void {
    if (this.runs.size > 0) return;
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

  /** 链上任何一个 id 都认。 */
  isRefreshing(sessionId: string): boolean {
    return this.runOf(sessionId) !== null;
  }

  stepOf(sessionId: string): RefreshStep | null {
    return this.runOf(sessionId)?.step ?? null;
  }

  /** capture 存下了这个 session 的 /handoff。 */
  handoffStored(sessionId: string): void {
    for (const run of this.runs) {
      if (run.step === "handoff" && run.kind !== "epic" && this.sameChain(sessionId, run.headId)) run.stored = true;
    }
  }

  /** 同步做完开始前的检查；通过就登记成正在换新（之后的异步检查期间也不会再起一次）。 */
  private begin(sessionId: string, trigger: RefreshTrigger): RefreshResult | Run {
    const head = this.d.head(sessionId);
    const kind = head ? this.d.kindOf(head) : null;
    if (!head || !kind || (kind === "epic" && head.epicId === null)) {
      if (trigger !== "auto") this.d.log(`refresh ${sessionId}: not a session Butler can refresh`);
      return "failed";
    }
    // epic 规划单独存放之前，换新会让 epic session 写一份进度 handoff，把记忆里的规划冲掉：手动也不行。
    if (kind === "epic" && !this.d.epicPlanReady()) {
      if (trigger !== "auto") this.d.log(`refresh ${head.id}: epic sessions cannot be refreshed before the epic plan is stored apart`);
      return "failed";
    }
    if (this.isRefreshing(head.id)) return "already";
    if (trigger !== "manual" && this.cooling(head.id)) return "cooldown";
    const gate = this.guardFor(trigger).check(head.id);
    if (!gate.ok) return "busy";
    if (trigger === "auto" && this.d.activity(gate.headId)?.background === true) return "busy";
    const run: Run = {
      headId: gate.headId, termId: gate.termId, kind, trigger, step: "handoff", epicId: head.epicId, ticket: head.ticketKey ?? "", stored: false,
    };
    this.runs.add(run);
    this.d.log(`refresh ${run.headId} (${kind}, ${trigger}): started`);
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
      return this.fail(run, "unexpected error", e);
    } finally {
      this.runs.delete(run);
      this.changed();
    }
  }

  private async steps(run: Run): Promise<RefreshResult> {
    // 第一步：ticket 和 feature 总控输入 /handoff，等 capture 收进来；epic session 用 butler-epic 的 handoff 写进度，等版本变。
    let before: string | null = null;
    if (run.kind === "epic") before = await this.d.epicHandoffVersion(run.epicId!);
    else if (!(await this.d.handoffCommandReady())) {
      // 用户改过 /handoff 的命令文件：不知道它会输出什么，收不进来就只会白等 10 分钟。冷却期间不再试，也不再记日志。
      return this.fail(run, "/handoff is not Butler's own command (the command file was changed), so the session was not refreshed");
    }
    // 中间等过异步：重新看一眼。这时还什么都没输入，不通过就当作忙，不冷却。
    const gate = this.guardFor(run.trigger).check(run.headId);
    if (!gate.ok || gate.termId !== run.termId) return "busy";
    const typedHandoff = await this.type(run, run.kind === "epic" ? M().refreshEpicHandoff : HANDOFF_COMMAND);
    if (typedHandoff) return this.fail(run, `typing the handoff request: ${typedHandoff}`);
    const handedOff =
      run.kind === "epic"
        ? await this.until(async () => {
            const v = await this.d.epicHandoffVersion(run.epicId!);
            return v !== null && v !== before;
          }, REFRESH_HANDOFF_MS, EPIC_POLL_MS)
        : await this.until(() => run.stored, REFRESH_HANDOFF_MS, POLL_MS);
    if (!handedOff) return this.fail(run, `the handoff was not stored within ${REFRESH_HANDOFF_MS / 60_000} minutes`);

    // 第二步：/clear，等 SessionStart（source=clear）把新 id 接上 replaced_by。
    this.setStep(run, "clear");
    const beforeClear = await this.untilQuiet(run);
    if (beforeClear) return this.fail(run, `before /clear: ${beforeClear}`);
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
   * 用户在打字、留了草稿、屏幕上有要用户回答的东西、终端关了或换了，马上返回原因，不等。
   */
  private async untilQuiet(run: Run): Promise<string | null> {
    const end = this.d.now() + REFRESH_CLEAR_MS;
    for (;;) {
      const gate = this.guardFor(run.trigger).check(run.headId);
      if (gate.ok) return gate.termId === run.termId ? null : "the terminal changed";
      if (gate.block !== "busy") return gate.block;
      if (this.d.now() >= end) return `still busy after ${REFRESH_CLEAR_MS / 1000} seconds`;
      await this.sleep(POLL_MS);
    }
  }

  /** 条件在 ms 之内成立就返回 true；每 every 毫秒看一次。 */
  private async until(cond: () => boolean | Promise<boolean>, ms: number, every: number): Promise<boolean> {
    const end = this.d.now() + ms;
    for (;;) {
      if (await cond()) return true;
      if (this.d.now() >= end) return false;
      await this.sleep(every);
    }
  }

  /** 输入一段文字；成功返回 null，否则返回原因。 */
  private async type(run: Run, text: string): Promise<string | null> {
    try {
      const r = await this.d.deliver(run.termId, sanitizeTask(text));
      return r === "sent" ? null : r;
    } catch (e) {
      this.d.log(`refresh ${run.headId}: deliver failed`, e);
      return "deliver failed";
    }
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
