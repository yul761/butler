import type { Session } from "../../shared/types";
import type { SessionMessage } from "../db/session-messages-repo";
import { M } from "../strings";
import { sentByPatrol } from "../schedule/patrol-turns";
import type { TranscriptState } from "./discovery";

/**
 * 在后台恢复关着的 session（BTL-256，设计 docs/superpowers/specs/2026-11-21-btl-256-resume-closed-sessions-design.md）。
 * 信箱里有给它的消息、它的终端关着（Shipherd 重启过、闲置时自动关掉、总控 end_session 过）时，按它的种类 --resume 接上原来的对话。
 * claude 起来以后 SessionStart(resume) 照常调 sessionStopped，信箱按「停着的 session」的方式把消息送进去（看屏幕、等信任框，guard 照旧）。
 * 休眠着的不归这里（Hibernator.wake）。
 */

/** 内存不够以后这么久之内不再问内存（信箱每个 tick 都会来问）。 */
export const MEMORY_RETRY_MS = 60_000;
/** 一时的失败以后这么久再试。 */
export const RESUME_RETRY_MS = 10 * 60_000;
/** 一次 Shipherd 运行里对同一个 session 最多试这么多次。 */
export const MAX_RESUME_ATTEMPTS = 3;
/** 等 claude 的 SessionStart 最多这么久。 */
export const RESUME_START_TIMEOUT_MS = 60_000;
/** 恢复以后这么久之内送到的才发「已唤醒后送达」的回执。 */
const RECEIPT_WINDOW_MS = 30 * 60_000;
const POLL_MS = 250;
/** 打开失败的原因里再试也没用的：之后不再自动试。 */
const PERMANENT_OPEN = new Set(["no_ticket", "no_session", "no_repo", "pick_repo", "old_workdir", "kind"]);

/** 总控看得到的、一个关着的 session 收到消息时会怎样（list_sessions 的 wake）。 */
export type WakeState = "running" | "hibernated" | "resumes" | "resuming" | "waiting_memory" | "resume_failed" | "ended_by_user" | "not_managed";

export type ResumeStart =
  | { state: "resuming" | "running" | "hibernated" | "ended_by_user" | "not_managed" }
  | { state: "waiting_memory" | "resume_failed"; error: string };

export interface ResumableContext {
  ticketArchived(key: string): boolean;
  epicArchived(id: number): boolean;
  /** 现在要接着用的那个全局总控（SessionService.latestShipherd 的 id）；没接时全局总控都不恢复。 */
  latestShipherd?(): string | null;
}

/**
 * 能不能自动恢复：Shipherd 开的、属于一个 epic 或 ticket 的、总控管的 session。ticket 的 session 要是总控开的（用户自己点开的不算），
 * epic 级的（epic 总控、修复 session）都算。全局总控只算现在要接着用的那一个（latestShipherd，BTL-279 复核：崩了、重启后没起来的
 * 要能收到汇报和回复；旧的那些不拉起来）。复盘分析 session、隐藏了的、被替换的、ticket 或 epic 归档了的不算。
 * 用户点 × 结束的另外看（userEndedAt）：全局总控没有管它的总控，点 × 关掉的一直不自动开。
 * insisted（BTL-279「关了的就打开」）：它自己的总控发来的指示在等着，用户自己点开的 ticket session 也恢复；别的照样不算。
 */
export function resumable(h: Session, ctx: ResumableContext, insisted = false): boolean {
  if (h.origin !== "shipherd" || h.lessonRunId !== null || h.dismissed || h.replacedBy !== null) return false;
  if (h.shipherd) return h.ticketKey === null && (ctx.latestShipherd?.() ?? null) === h.id;
  if (h.ticketKey !== null) return (h.spawnedBy !== null || insisted) && !ctx.ticketArchived(h.ticketKey);
  return h.featureId !== null && !ctx.epicArchived(h.featureId);
}

/** 重启后恢复的顺序：有未读信箱消息的最先，然后是 ticket 有 PR 在等的，其余按最近活动。 */
export function restartOrder(heads: Session[], hasMail: (headId: string) => boolean, prWaiting: (h: Session) => boolean): Session[] {
  const rank = (h: Session) => (hasMail(h.id) ? 0 : prWaiting(h) ? 1 : 2);
  return [...heads].sort((a, b) => rank(a) - rank(b) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
}

/**
 * ResumerDeps.controllerMailSince 的算法（BTL-279）：排着等 headId 的指示（instruction、shipherd）里，它自己的总控（controls）发的最新一条的排队时间。
 * 巡检那一轮发的（meta.auto = "patrol"，复核建议 3）不算：用户点 × 关掉的不因为它拉起来。
 */
export function controllerMailSince(queued: readonly SessionMessage[], headId: string, headOf: (id: string) => string, controls: (from: string | null, headId: string) => boolean): number | null {
  let since: number | null = null;
  for (const m of queued) {
    if ((m.kind !== "instruction" && m.kind !== "shipherd") || headOf(m.toSession) !== headId) continue;
    if (sentByPatrol(m.meta)) continue;
    if (controls(m.fromSession, headId) && (since === null || m.queuedAt > since)) since = m.queuedAt;
  }
  return since;
}

export interface ResumerDeps {
  head(id: string): Session | null;
  /** 这条链现在开着终端。 */
  running(headId: string): boolean;
  /** 见 resumable（index.ts 带上 ticket、epic 的归档状态）。 */
  resumable(h: Session, insisted?: boolean): boolean;
  /**
   * 排着等这个 head 的、它自己的总控（isControllerOf）发来的指示里最新一条的排队时间；没有为 null（BTL-279）。
   * 有就算「总控要它」：用户点 × 之后才发来的也恢复，用户自己点开的 ticket session 也恢复。
   */
  controllerMailSince?(headId: string): number | null;
  transcript(headId: string): TranscriptState;
  /** 和 start_session 一样的内存准入（admitOrRefuse）。 */
  admit(what: string): Promise<{ ok: true; release: () => void } | { ok: false; error: string }>;
  /** 按种类 --resume（ticket、epic 总控、修复 session）。 */
  open(h: Session): Promise<{ ok: true; termId: string; alreadyOpen: boolean } | { ok: false; reason: string }>;
  started(termId: string): boolean;
  isOpen(termId: string): boolean;
  setWakeError(headId: string, error: string | null, at: number | null): void;
  /** 排着等这个 head 的、总控发的消息（instruction、shipherd）。 */
  waitingSenders(headId: string): { id: string; from: string; featureId: number | null }[];
  /** 发一条回执（信箱 reply，发送方是 Shipherd）。 */
  receipt(to: string, featureId: number | null, body: string): void;
  nameOf(id: string): string;
  notify(): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(msg: string, err?: unknown): void;
  startTimeoutMs?: number;
}

interface Failure {
  attempts: number;
  at: number;
  error: string;
  permanent: boolean;
}

const RECEIPT_KINDS = new Set(["instruction", "shipherd"]);

export class Resumer {
  /** head → 正在进行的这一次（准入、打开）。同时来的请求拿到同一个。 */
  private readonly inflight = new Map<string, Promise<ResumeStart>>();
  /** head → 已经打开、在等 SessionStart。 */
  private readonly starting = new Map<string, Promise<void>>();
  private readonly memory = new Map<string, { at: number; error: string }>();
  private readonly failures = new Map<string, Failure>();
  /** head → 恢复成功的时间：之后的第一批送达发回执。 */
  private readonly resumed = new Map<string, number>();
  /** 这一轮同步送到的、要发回执的：head → 发送方 → 消息 id。 */
  private readonly pendingReceipts = new Map<string, Map<string, { ids: string[]; featureId: number | null }>>();

  /** Shipherd 在退出：不再恢复，进行中的也不记失败、不发回执。 */
  private stopped = false;

  constructor(private readonly d: ResumerDeps) {}

  /** 退出 Shipherd 时（shutdownSessions）：之后的请求都不做，正在等的不算失败。 */
  stop(): void {
    this.stopped = true;
  }

  /**
   * 总控看的状态（list_sessions）。不问内存、不改状态。
   * asController：问的是它的总控（list_sessions 只列自己管的）：「总控现在发一条会怎样」，用户结束的、用户点开的也会恢复（BTL-279）。
   */
  status(sessionId: string, o: { asController?: boolean } = {}): WakeState {
    const h = this.d.head(sessionId);
    if (!h) return "not_managed";
    if (this.d.running(h.id)) return "running";
    if (h.hibernatedAt) return "hibernated";
    const insisted = o.asController === true || this.insisted(h);
    if (!this.d.resumable(h, insisted)) return "not_managed";
    if (h.userEndedAt != null && !insisted) return "ended_by_user";
    if (this.inflight.has(h.id) || this.starting.has(h.id)) return "resuming";
    if (this.blockedByFailure(h) !== null) return "resume_failed";
    const m = this.memory.get(h.id);
    if (m && this.d.now() - m.at < MEMORY_RETRY_MS) return "waiting_memory";
    return "resumes";
  }

  /**
   * 有消息等着这个关着的 session：能恢复就恢复。返回准入和打开的结果（等 SessionStart 在后台）。幂等，永不 reject。
   * why 只用于日志。
   */
  request(sessionId: string, why: "mail" | "restart"): Promise<ResumeStart> {
    const h = this.d.head(sessionId);
    if (!h || this.stopped) return Promise.resolve({ state: "not_managed" });
    const running = this.inflight.get(h.id);
    if (running) return running;
    if (this.starting.has(h.id)) return Promise.resolve({ state: "resuming" });
    const p = this.doRequest(h, why)
      .catch((e: unknown): ResumeStart => {
        this.d.log(`resume ${h.id}: failed`, e);
        return { state: "resume_failed", error: (e as Error).message };
      })
      .finally(() => this.inflight.delete(h.id));
    this.inflight.set(h.id, p);
    return p;
  }

  /** 重启后：按给的顺序一个一个恢复，第一次内存不够就停下（剩下的等有消息时再说）。 */
  async resumeAll(heads: Session[]): Promise<{ resumed: string[]; waitingMemory: string[] }> {
    const resumed: string[] = [];
    for (let i = 0; i < heads.length; i++) {
      const r = await this.request(heads[i].id, "restart");
      if (r.state === "resuming") resumed.push(heads[i].id);
      if (r.state === "waiting_memory") return { resumed, waitingMemory: heads.slice(i).map((h) => h.id) };
    }
    return { resumed, waitingMemory: [] };
  }

  /**
   * 这个 session 被别的路径打开了（用户点开、总控、唤醒）：失败和内存的记录都清掉。
   * 这里自己打开时也会调到（sessionService.opened），那时不清：成没成功要等 SessionStart 才知道，失败次数要接着数。
   */
  opened(sessionId: string): void {
    const h = this.d.head(sessionId);
    const id = h?.id ?? sessionId;
    if (this.inflight.has(id) || this.starting.has(id)) return;
    this.failures.delete(id);
    this.memory.delete(id);
    if (h?.wakeError) this.d.setWakeError(id, null, null);
  }

  /** 信箱送到一条（Mailbox 的 delivered）：恢复以后的第一批里总控发的，给发送方一条回执。 */
  delivered(m: SessionMessage): void {
    if (this.resumed.size === 0) return;
    const to = this.d.head(m.toSession)?.id ?? m.toSession;
    // 恢复时 claude 偶尔换了 session id：按链找（记的是恢复前的 head）。
    const head = this.resumed.has(to) ? to : [...this.resumed.keys()].find((k) => (this.d.head(k)?.id ?? k) === to);
    if (head === undefined) return;
    const at = this.resumed.get(head)!;
    if (this.d.now() - at > RECEIPT_WINDOW_MS) {
      this.resumed.delete(head);
      return;
    }
    let bySender = this.pendingReceipts.get(head);
    if (!bySender) {
      // 恢复以后的第一批（不管是什么消息）：这一批里总控发的合成一条回执，下一个微任务再发；之后的不再发。
      this.pendingReceipts.set(head, (bySender = new Map()));
      queueMicrotask(() => this.sendDelivered(head));
    }
    if (m.fromSession === null || !RECEIPT_KINDS.has(m.kind)) return;
    const entry = bySender.get(m.fromSession) ?? { ids: [], featureId: m.featureId };
    entry.ids.push(m.id);
    bySender.set(m.fromSession, entry);
  }

  /** 测试用：等所有后台的等待结束。 */
  async idle(): Promise<void> {
    while (this.inflight.size > 0 || this.starting.size > 0) await Promise.all([...this.inflight.values(), ...this.starting.values()]);
  }

  private sendDelivered(head: string): void {
    const bySender = this.pendingReceipts.get(head);
    this.pendingReceipts.delete(head);
    this.resumed.delete(head);
    if (!bySender) return;
    for (const [to, x] of bySender) this.d.receipt(to, x.featureId, M().resumeReceiptDelivered(this.d.nameOf(head), x.ids));
  }

  /** 之前失败过、现在不该再试：返回原因；能试为 null。 */
  private blockedByFailure(h: Session): string | null {
    const f = this.failures.get(h.id);
    if (f) {
      if (f.permanent || f.attempts >= MAX_RESUME_ATTEMPTS) return f.error;
      if (this.d.now() - f.at < RESUME_RETRY_MS) return f.error;
      return null;
    }
    // 上一次 Shipherd 运行（或休眠唤醒）留下的失败：一样等过 10 分钟。
    if (h.wakeError && h.wakeErrorAt != null && this.d.now() - h.wakeErrorAt < RESUME_RETRY_MS) return h.wakeError;
    return null;
  }

  /**
   * 它自己的总控有指示在等它（BTL-279「关了的就打开」）。用户点过 × 的，只认点 × 之后才发来的：
   * 不然用户刚关掉，还排着的那条马上又把它拉起来；之后总控再发一条，才是总控要它。
   */
  private insisted(h: Session): boolean {
    // 全局总控上面没有总控：点 × 关掉的谁发来的都不拉起来（BTL-279 复核）。
    if (h.shipherd) return false;
    const since = this.d.controllerMailSince?.(h.id) ?? null;
    return since !== null && (h.userEndedAt == null || since > h.userEndedAt);
  }

  private async doRequest(h: Session, why: "mail" | "restart"): Promise<ResumeStart> {
    if (this.d.running(h.id)) return { state: "running" };
    if (h.hibernatedAt) return { state: "hibernated" };
    const insisted = this.insisted(h);
    if (!this.d.resumable(h, insisted)) return { state: "not_managed" };
    if (h.userEndedAt != null && !insisted) return { state: "ended_by_user" };
    if (insisted && (h.userEndedAt != null || !this.d.resumable(h))) this.d.log(`resume ${h.id}: its coordinator sent an instruction; opening it though ${h.userEndedAt != null ? "the user ended it" : "the user opened it"}`);
    const blocked = this.blockedByFailure(h);
    if (blocked !== null) return { state: "resume_failed", error: blocked };
    const m = this.memory.get(h.id);
    if (m && this.d.now() - m.at < MEMORY_RETRY_MS) return { state: "waiting_memory", error: m.error };
    // 对话文件没了：说过话的接不上原来的对话，算永久失败；一句话都没说过的（开了就重启了）照常打开，消息就是它的第一句。
    if (h.firstPrompt !== null && this.d.transcript(h.id) === "absent") return this.fail(h, M().resumeNoTranscript, true);
    const room = await this.d.admit(`resume ${h.id}`);
    if (!room.ok) {
      this.memory.set(h.id, { at: this.d.now(), error: room.error });
      this.d.log(`resume ${h.id} (${why}): waiting for memory`);
      this.d.notify();
      return { state: "waiting_memory", error: room.error };
    }
    this.memory.delete(h.id);
    this.d.log(`resume ${h.id} (${why})`);
    let opened: Awaited<ReturnType<ResumerDeps["open"]>>;
    try {
      opened = await this.d.open(h);
    } catch (e) {
      this.d.log(`resume ${h.id}: open threw`, e);
      opened = { ok: false, reason: "error" };
    }
    if (!opened.ok || opened.alreadyOpen) room.release();
    if (!opened.ok) return this.fail(h, M().resumeOpenFailed(opened.reason), PERMANENT_OPEN.has(opened.reason));
    if (opened.alreadyOpen) return { state: "running" };
    const termId = opened.termId;
    const wait = this.waitStarted(h, termId, h.userEndedAt ?? null).finally(() => this.starting.delete(h.id));
    this.starting.set(h.id, wait);
    this.d.notify();
    return { state: "resuming" };
  }

  /** endedBefore：恢复前的 userEndedAt。之后变了才是用户这次点了 ×（打开时 opened 会清掉它）。 */
  private async waitStarted(h: Session, termId: string, endedBefore: number | null): Promise<void> {
    const deadline = this.d.now() + (this.d.startTimeoutMs ?? RESUME_START_TIMEOUT_MS);
    for (;;) {
      if (this.stopped) return;
      if (this.d.started(termId)) break;
      if (!this.d.isOpen(termId)) {
        // 用户在它起来之前点了 ×：不算恢复失败，也不再试。
        const ended = this.d.head(h.id)?.userEndedAt ?? null;
        if (ended !== null && ended !== endedBefore) return;
        this.fail(h, M().resumeExited, false);
        return;
      }
      if (this.d.now() >= deadline) {
        // 还开着（比如停在启动对话框上）：不报失败，起来以后信箱照常送，回执也照常发。
        this.d.log(`resume ${h.id}: not started after the timeout, terminal still open`);
        break;
      }
      await this.d.sleep(POLL_MS);
    }
    this.failures.delete(h.id);
    // 有总控的消息等着才发回执（重启后没消息的恢复不发，免得之后正常送到的也带上「原来关着」）。
    if (this.d.waitingSenders(h.id).length > 0) this.resumed.set(h.id, this.d.now());
    this.d.log(`resume ${h.id}: started`);
    this.d.notify();
  }

  /** 记下失败（wake_error，「现在」页有提醒），告诉排着消息的总控。 */
  private fail(h: Session, error: string, permanent: boolean): ResumeStart {
    const prev = this.failures.get(h.id);
    const f: Failure = { attempts: (prev?.attempts ?? 0) + 1, at: this.d.now(), error, permanent };
    this.failures.set(h.id, f);
    this.d.setWakeError(h.id, error, f.at);
    const retry = !permanent && f.attempts < MAX_RESUME_ATTEMPTS;
    this.d.log(`resume ${h.id} failed${retry ? " (will retry)" : ""}: ${error}`);
    const bySender = new Map<string, { ids: string[]; featureId: number | null }>();
    for (const x of this.d.waitingSenders(h.id)) {
      const e = bySender.get(x.from) ?? { ids: [], featureId: x.featureId };
      e.ids.push(x.id);
      bySender.set(x.from, e);
    }
    for (const [to, x] of bySender) this.d.receipt(to, x.featureId, M().resumeReceiptFailed(this.d.nameOf(h.id), x.ids, error, retry));
    this.d.notify();
    return { state: "resume_failed", error };
  }
}
