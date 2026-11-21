import type { HibernateReason, Session } from "../../shared/types";
import type { MonitorSample } from "../procs/memory-monitor";
import type { OwnedProc } from "../procs/orphans";
import { classifyTree, type ProcInfo, type ProcTable } from "../procs/proc-table";
import { hibernateBlock, hibernateDue, pressureVictim, underPressure, waitState, type HibernateCandidate, type HibernateQuiet, type WaitInput, type WaitState } from "./hibernation";

/**
 * 休眠和唤醒（WS-M B、C、G 的 restart，设计 §3、§4、§9）。
 * 休眠 = 结束这个终端的整棵进程树，session 行上记着 hibernated_at；transcript 还在，唤醒就是平常的 --resume。
 * 唤醒只有一个入口 wake（幂等）。claude 起来以后 SessionStart(resume) 照常调 sessionStopped，
 * 那里把合并总控、inbox、巡检、CI 这些因为终端没开而压着的东西都递一遍。
 */

/** 唤醒等 SessionStart 最多这么久（和 deliver 等启动一样）。 */
export const WAKE_START_TIMEOUT_MS = 60_000;
/** 自动唤醒因为一时的原因没打开以后，这么久之内不再自动唤醒这条链（用户点开照样试）。 */
export const WAKE_RETRY_MS = 10 * 60_000;
/**
 * 打不开的原因里过一会儿可能就好的（ticket 正忙、找不到 claude、分支暂时不对、抛了错）：休眠留着，冷却以后再试。
 * 其他的（ticket 或 session 没了、目录不对）再试也没用：不再算休眠。
 */
const TRANSIENT_OPEN = new Set(["ticket_busy", "claude_missing", "branch_mismatch", "error"]);
/** 结束进程以后等这么久，还活着的强制结束。 */
export const HIBERNATE_KILL_WAIT_MS = 5_000;
const POLL_MS = 250;

/** 开着终端的 Butler session。 */
export interface HibernateTerminal {
  termId: string;
  head: Session;
}

export type WakeWhy = "delivery" | "user" | "memory" | "test";
export type WakeResult = "woken" | "not_hibernated" | "cooldown" | "failed";
export type HibernateResult = "hibernated" | "closed" | "busy" | ReturnType<typeof hibernateBlock>;

export interface HibernatorDeps {
  /** hibernateEnabled。 */
  enabled(): boolean;
  /** 这种等待停多少分钟后休眠（0 = 不休眠）。 */
  minutes(state: WaitState): number;
  /** 休眠时一起结束 watcher 和 dev server。 */
  endWatchers(): boolean;
  pressureOn(): boolean;
  pressureLine(): number;
  terminals(): HibernateTerminal[];
  /** 这个终端现在的情况（index.ts 从 pty、活动、换新、渲染进程拼出来）。wokeAt 由这里补上。 */
  candidate(t: HibernateTerminal): Omit<HibernateCandidate, "wokeAt">;
  waitInput(head: Session): WaitInput;
  sessions: {
    head(id: string): Session | null;
    setHibernated(id: string, at: number, reason: HibernateReason, memKb: number | null): void;
    clearHibernated(id: string): void;
    setWakeError(id: string, error: string | null, at: number | null): void;
  };
  readTable(): Promise<ProcTable | null>;
  pid(termId: string): number | null;
  isOpen(termId: string): boolean;
  /** claude 的 SessionStart 到了没有。 */
  started(termId: string): boolean;
  /** pty.reserve：结束的过程中别的自动输入进不来。 */
  reserve(termId: string): () => void;
  /** 结束终端（pty.kill，给根进程发信号）。 */
  endTerminal(termId: string): void;
  /** 给一个进程发信号（force：SIGKILL / taskkill /F）。进程不在时抛错也没关系。 */
  kill(pid: number, force: boolean): void;
  /** 休眠时留下的 watcher：孤儿清理先别动，唤醒或结束时放开（release 以后它们按普通孤儿清理）。 */
  spare(owner: string, procs: OwnedProc[]): void;
  release(owner: string): void;
  /** 按 session 自己的种类恢复（ticket、feature 总控、Butler 总控），都是 --resume。 */
  open(head: Session): Promise<{ ok: true; termId: string } | { ok: false; reason: string }>;
  notify(): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(msg: string, err?: unknown): void;
  startTimeoutMs?: number;
  killWaitMs?: number;
  /** 刚打开、刚唤醒的安静期（e2e 调短）。 */
  quiet?: HibernateQuiet;
}

const SPARE_CLASSES = new Set(["watcher", "dev_server"]);
const record = (p: ProcInfo): OwnedProc => ({ pid: p.pid, start: p.start, args: p.args });
const same = (a: OwnedProc, b: ProcInfo | undefined): boolean => !!b && b.start === a.start && b.args === a.args;

export class Hibernator {
  /** head → 正在进行的休眠。 */
  private readonly hibernating = new Map<string, Promise<HibernateResult>>();
  /** head → 正在进行的唤醒（wake 幂等）。 */
  private readonly waking = new Map<string, Promise<WakeResult>>();
  /** head → 上次醒来（打开）的时间。 */
  private readonly wokeAt = new Map<string, number>();
  private pressured = false;
  private stopped = false;

  constructor(private readonly d: HibernatorDeps) {}

  /** 退出前：之后不再休眠、不再唤醒。 */
  stop(): void {
    this.stopped = true;
  }

  /** 正在休眠（还没结束完）的 head。 */
  isHibernating(headId: string): boolean {
    return this.hibernating.has(headId);
  }

  /** 每个活动 tick：停够了的就休眠（按等的东西选分钟数）。 */
  tick(): void {
    if (this.stopped || !this.d.enabled()) return;
    const now = this.d.now();
    for (const t of this.d.terminals()) {
      if (this.hibernating.has(t.head.id)) continue;
      const c = this.candidate(t);
      if (hibernateBlock(c, now, this.d.quiet) !== null) continue;
      const state = waitState(this.d.waitInput(t.head));
      if (!hibernateDue(c, this.d.minutes(state), now)) continue;
      void this.hibernate(t.head.id, state);
    }
  }

  /** 每次内存采样（C）：内存紧张时休眠一个闲得最久的；上一个还没结束完就等下一次采样。 */
  onSample(s: MonitorSample): void {
    if (this.stopped || !this.d.pressureOn() || !s.system) return;
    this.pressured = underPressure(this.pressured, s.system.freePercent, this.d.pressureLine());
    if (!this.pressured || this.hibernating.size > 0) return;
    const now = this.d.now();
    const victim = pressureVictim(this.d.terminals().map((t) => this.candidate(t)), now, this.d.quiet);
    if (!victim) return;
    this.d.log(`memory pressure: ${s.system.freePercent}% free (line ${this.d.pressureLine()}%)`);
    void this.hibernate(victim.head.id, "pressure");
  }

  /**
   * 休眠一个 head：重新检查一遍、写 hibernated_at（在结束进程之前，handleExit 才知道这是休眠）、结束整棵树。
   * 检查和发信号之间没有 await（先读进程表），检查看到的就是结束时的状态。
   */
  hibernate(headId: string, reason: HibernateReason): Promise<HibernateResult> {
    const running = this.hibernating.get(headId);
    if (running) return running;
    const p = this.doHibernate(headId, reason).finally(() => this.hibernating.delete(headId));
    this.hibernating.set(headId, p);
    return p;
  }

  private async doHibernate(headId: string, reason: HibernateReason): Promise<HibernateResult> {
    if (this.stopped) return "busy";
    const find = () => this.d.terminals().find((x) => x.head.id === headId) ?? null;
    if (!find()) return "closed";
    const table = await this.d.readTable();
    const t = find();
    if (!t) return "closed";
    if (this.stopped) return "busy";
    const now = this.d.now();
    const block = hibernateBlock(this.candidate(t), now, this.d.quiet);
    if (block !== null) return block;
    const root = this.d.pid(t.termId);
    if (root === null) return "closed";
    const tree = table ? classifyTree(root, table) : [];
    const spared = new Set<number>();
    if (!this.d.endWatchers()) {
      for (const p of tree) if (p.pid !== root && (SPARE_CLASSES.has(p.cls) || spared.has(p.ppid))) spared.add(p.pid);
    }
    const victims = tree.filter((p) => p.pid !== root && !spared.has(p.pid)).map(record);
    const memKb = tree.length > 0 ? tree.reduce((n, p) => n + p.rssKb, 0) : null;
    const release = this.d.reserve(t.termId);
    try {
      this.d.sessions.setHibernated(t.head.id, now, reason, memKb);
      if (spared.size > 0) this.d.spare(t.head.id, tree.filter((p) => spared.has(p.pid)).map(record));
      const idleMin = Math.floor((now - this.candidate(t).idleSince) / 60_000);
      this.d.log(`hibernate ${t.head.id} (${reason}): idle ${idleMin} min, freed ~${memKb === null ? "?" : Math.round(memKb / 1024)} MB` +
        (spared.size > 0 ? `, kept ${spared.size} watcher process(es)` : ""));
      this.d.endTerminal(t.termId);
      for (const v of victims) this.signal(v.pid, false);
      this.d.notify();
      await this.d.sleep(this.d.killWaitMs ?? HIBERNATE_KILL_WAIT_MS);
      const after = await this.d.readTable();
      const rootRec = tree.find((p) => p.pid === root);
      for (const v of rootRec ? [record(rootRec), ...victims] : victims) {
        if (!after || !same(v, after.get(v.pid))) continue;
        this.d.log(`hibernate ${t.head.id}: pid ${v.pid} still running, forcing it`);
        this.signal(v.pid, true);
      }
      if (this.d.isOpen(t.termId)) {
        // 终端还没退出（进程表读不出来、结束信号没送到）：再强制结束一次根进程，还不退就算没休眠成，
        // 不然这个还活着的终端退出时 handleExit 会当它是休眠，等待标记和空 session 都不处理。
        this.signal(root, true);
        await this.d.sleep(this.d.killWaitMs ?? HIBERNATE_KILL_WAIT_MS);
        if (this.d.isOpen(t.termId)) {
          this.d.sessions.clearHibernated(t.head.id);
          this.d.release(t.head.id);
          this.d.log(`hibernate ${t.head.id}: the terminal did not exit, not hibernated`);
          this.d.notify();
          return "busy";
        }
      }
      return "hibernated";
    } finally {
      release();
    }
  }

  /**
   * 唤醒：按 session 的种类 --resume，等 SessionStart。正在唤醒的再调一次返回同一个 promise。
   * 一时打不开（TRANSIENT_OPEN）：休眠留着，记下 wake_error，10 分钟内不再自动唤醒（why 是 user 的照样试）。
   * 其他失败（claude 在 SessionStart 之前退出、60 秒没有 SessionStart、打不开、打开的是别的 session）：清掉休眠，记下 wake_error，提醒用户；
   * 之后它就是一个普通的关着的 session。
   */
  wake(headId: string, why: WakeWhy): Promise<WakeResult> {
    const head = this.d.sessions.head(headId);
    if (!head) return Promise.resolve("not_hibernated");
    const running = this.waking.get(head.id);
    if (running) return running;
    if (this.stopped || (!head.hibernatedAt && !this.hibernating.has(head.id))) return Promise.resolve("not_hibernated");
    if (why !== "user" && head.wakeErrorAt != null && this.d.now() - head.wakeErrorAt < WAKE_RETRY_MS) return Promise.resolve("cooldown");
    const p = this.doWake(head.id, why).finally(() => this.waking.delete(head.id));
    this.waking.set(head.id, p);
    return p;
  }

  /** 这条链现在是不是休眠着（唤醒中的也算：投递照样等它）。 */
  isHibernated(sessionId: string): boolean {
    const head = this.d.sessions.head(sessionId);
    return !!head && (!!head.hibernatedAt || this.hibernating.has(head.id) || this.waking.has(head.id));
  }

  private async doWake(headId: string, why: WakeWhy): Promise<WakeResult> {
    // 还在结束进程：等它结束完（终端还开着的时候没法 --resume）。
    await this.hibernating.get(headId);
    const head = this.d.sessions.head(headId);
    if (!head?.hibernatedAt) return "not_hibernated";
    this.d.log(`wake ${headId} (${why})`);
    let opened: Awaited<ReturnType<HibernatorDeps["open"]>>;
    try {
      opened = await this.d.open(head);
    } catch (e) {
      this.d.log(`wake ${headId}: open threw`, e);
      opened = { ok: false, reason: "error" };
    }
    if (!opened.ok) return this.wakeFailed(headId, `open failed: ${opened.reason}`, TRANSIENT_OPEN.has(opened.reason));
    const termId = opened.termId;
    // 打开的必须是这条链：Butler 总控已经有另一个对话开着时，openButler 返回的是那个终端。
    const got = this.d.sessions.head(termId)?.id ?? termId;
    if (got !== headId) return this.wakeFailed(headId, `another session (${got}) was opened instead`);
    const deadline = this.d.now() + (this.d.startTimeoutMs ?? WAKE_START_TIMEOUT_MS);
    for (;;) {
      if (this.d.started(termId)) break;
      if (!this.d.isOpen(termId)) return this.wakeFailed(headId, "claude --resume exited before it started");
      if (this.d.now() >= deadline) return this.wakeFailed(headId, "claude --resume did not start within 60 s");
      await this.d.sleep(POLL_MS);
      if (this.stopped) return "failed";
    }
    this.d.log(`wake ${headId}: started`);
    this.d.notify();
    return "woken";
  }

  private wakeFailed(headId: string, why: string, retry = false): WakeResult {
    if (!retry) {
      this.d.sessions.clearHibernated(headId);
      this.d.release(headId);
    }
    this.d.sessions.setWakeError(headId, why, this.d.now());
    this.d.log(`wake ${headId} failed${retry ? " (will retry)" : ""}: ${why}`);
    this.d.notify();
    return "failed";
  }

  /**
   * SessionService 打开了一个终端（用户点开、openAndSend、巡检、唤醒都走到这里）：清掉休眠和上次唤醒失败的记录，
   * 放开休眠时留下的 watcher（以后按普通孤儿清理），记下醒来的时间（10 分钟内不再休眠）。
   */
  opened(sessionId: string): void {
    const head = this.d.sessions.head(sessionId);
    if (!head) return;
    if (head.hibernatedAt) {
      this.d.sessions.clearHibernated(head.id);
      this.d.release(head.id);
      this.wokeAt.set(head.id, this.d.now());
    }
    if (head.wakeError) this.d.sessions.setWakeError(head.id, null, null);
  }

  /**
   * 休眠着的 session 不要了（用户隐藏、总控 end_session、另开了 Butler 总控）：不再算休眠（之后不自动唤醒），留下的 watcher 也清掉。
   */
  forget(headId: string, why = "hidden"): void {
    const head = this.d.sessions.head(headId);
    if (!head?.hibernatedAt) return;
    this.d.sessions.clearHibernated(head.id);
    this.d.release(head.id);
    this.d.log(`hibernate ${head.id}: ${why}, no longer hibernated`);
    this.d.notify();
  }

  /** 内存过大、换新也没降下来（G）：结束再立刻 --resume，排除规则和休眠一样。 */
  async restart(headId: string): Promise<WakeResult | HibernateResult> {
    const r = await this.hibernate(headId, "memory");
    if (r !== "hibernated") return r;
    return this.wake(headId, "memory");
  }

  private candidate(t: HibernateTerminal): HibernateCandidate {
    return { ...this.d.candidate(t), wokeAt: this.wokeAt.get(t.head.id) ?? 0 };
  }

  private signal(pid: number, force: boolean): void {
    try {
      this.d.kill(pid, force);
    } catch {
      // 已经退出。
    }
  }
}
