// 信箱（BTL-245，设计 docs/superpowers/specs/2026-11-20-btl-245-mailbox-design.md）：session 之间的消息一律排队、存进库里。
// 在忙的 session 下一次工具调用时由 PostToolUse hook 带进去（磁盘投影 <mailbox>/<终端>/），停着的直接输入，
// 总控可以先按 Esc 叫停再送。状态只有 queued / delivered / replied。
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGE_LIMIT, sanitizeTask, TASK_LIMIT } from "../../shared/control";
import {
  DONE_SUFFIX, MAIN_SUFFIX, MSG_SUFFIX, messageFileName, messageIdOf, TAKEN_SUFFIX, wakesTarget, type MailboxFile,
} from "../../shared/mailbox";
import { PATROL_ETA_REASONS, type MailboxAttempt, type MailboxBlockReason, type MessageKind, type MessageScope, type MessageView, type Session } from "../../shared/types";
import type { NewSessionMessage, SessionMessage, SessionMessagesRepo } from "../db/session-messages-repo";
import type { DeliveryCheck } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import { M } from "../strings";

/** 送到之后这么久没回复就不再等。 */
export const REPLY_WAIT_MS = 24 * 3600_000;
/** 消息留这么久，之后删掉（还在排队的也删：目标一个月都没再打开）。 */
export const MESSAGE_KEEP_MS = 30 * 24 * 3600_000;
/** 旧消息多久清一次（BTL-275）：要留 30 天，原来每 10 秒一个 DELETE。 */
export const PRUNE_EVERY_MS = 10 * 60_000;
/** hook 认领了这么久还没写出去（崩了）：放回去，下一次工具调用再送。 */
export const TAKEN_STALE_MS = 60_000;
/** 主进程认领了这么久（直接输入的结果一直没回来，Shipherd 上次崩在这里）：放回去。deliver 最多等 1 分钟。 */
export const MAIN_STALE_MS = 5 * 60_000;
/** 排队超过这么久才送到的，正文前注明是多久之前发的。 */
export const AGE_NOTE_MS = 10 * 60_000;
/** 总控发的消息排了这么久还没送到（原因不是用户在打字、有草稿）：给它发一条回执说明原因（BTL-269）。 */
export const STUCK_RECEIPT_MS = 2 * 60_000;
/** 只是这一轮还在干活（turn）的等更久才回执：跑几分钟的工具很正常，不为一句「还没送到」叫醒总控。 */
export const STUCK_TURN_RECEIPT_MS = 10 * 60_000;
/**
 * 刚停下、还在判断是不是在问用户（judging）最多压总控的消息这么久（BTL-279）：判断一般几秒到一分钟，排队排满了、模型一直没回来时
 * 不能一直压着，过了就送进去，注明不是用户的回答。
 */
export const JUDGING_HOLD_MS = 90_000;
/** 送到后这么久之内，每个 tick 都替等【回复】的 head 看一眼（probeAwaiting，BTL-279 复核）；之后按指数退避。 */
export const PROBE_DENSE_MS = 10 * 60_000;
/** 退避的第一个间隔，每看一次翻一倍，最长 PROBE_MAX_GAP_MS。 */
export const PROBE_FIRST_GAP_MS = 20_000;
export const PROBE_MAX_GAP_MS = 5 * 60_000;
/** 跟着角色走、不跟着对话走的消息（BTL-279）：收件的总控关了、另一个接替了它，就改投给接替的那个。 */
const FOLLOWS_ROLE = new Set<string>(["reply", "report"]);
/**
 * 「在确认」（unsure：记录说在干活、屏幕上画着空输入框、没有转圈和确认框，只是还没安静够久）挡了这么久就送进去（BTL-279）：
 * 判断不准时倾向送达。安静够 45 秒的早就放行了，挡这么久的是输出一直有点动静（状态栏、后台日志）的。
 */
export const UNSURE_DELIVER_MS = 3 * 60_000;
/** send_message 最多等这么久看消息送没送到，再如实返回（MCP 请求 60 秒超时，留足余量）。 */
export const SETTLE_MS = 15_000;
/** 用户在打字、有草稿：这时不发「还没送到」的回执，等用户。 */
const USER_REASONS: ReadonlySet<MailboxBlockReason> = new Set(["typing", "draft"]);
/** 卡这么久的回执 ref：同一对（发件人、收件人）只排一条，送到前按 ref 换成最新的。 */
const stuckRef = (to: string, from: string): string => `stuck:${to}:${from}`;
/** 「还没送到」回执说的是哪几条（回执 meta 里存的原消息 id）。 */
const receiptIds = (m: SessionMessage): string[] => {
  const ids = (m.meta as { ids?: unknown } | null)?.ids;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
};

/**
 * 它在等用户回答什么（BTL-269 A2）：还没答的 ask_user（id、问题、提问时间），和「需要你」判断出来、用文字问的那条回复（理由、回复时间）。
 * 只是刚停下、还没判断完的不算（undecided）：那时返回 null。
 */
export interface AwaitingUser {
  asks: { id: number; question: string; at: number }[];
  text: { reason: string; at: number | null } | null;
}

/** 总控的指示带的 meta（BTL-269 A2）：answers 是 send_message 的 answers（问题 id，或 true = 它现在等着的那个），text 是总控写的原文。 */
export interface InstructionMeta {
  answers?: number | true;
  text?: string;
}

/**
 * 这条总控的指示替用户回答了哪几个提问（BTL-269 A2）：只认明确带了 answers 的，而且只认在它排进来之前就问了的提问；
 * 提问之前就排着的旧消息永远不算。answers 是 id 时只认那一个；true 时认排进来之前问的全部，没有 ask_user 时认用文字问的那条。
 * 不算回答返回 null；算回答时 asks 是要记成总控代答的 ask_user（文字提问时为空）。
 */
export function answeredBy(m: Pick<SessionMessage, "queuedAt" | "meta">, waiting: AwaitingUser | null): { asks: number[]; question: string } | null {
  const answers = (m.meta as InstructionMeta | null)?.answers;
  if (!waiting || (answers !== true && typeof answers !== "number")) return null;
  const before = waiting.asks.filter((a) => a.at < m.queuedAt && (answers === true || a.id === answers));
  if (before.length > 0) return { asks: before.map((a) => a.id), question: before.map((a) => a.question).join(" / ") };
  if (answers === true && waiting.asks.length === 0 && waiting.text && waiting.text.at !== null && waiting.text.at < m.queuedAt) return { asks: [], question: waiting.text.reason };
  return null;
}

/** 列表里最多几条。 */
export const RECENT_MESSAGES = 30;
/** 直接输入一次最多这么多字符；第一条总要送。 */
const INPUT_LIMIT = TASK_LIMIT - 1000;
/** 一条消息的正文最多这么多字符：一条总能放进一次直接输入（开头另算），也放得进一次 additionalContext。 */
export const MAILBOX_BODY_LIMIT = INPUT_LIMIT - 500;

export interface MailboxFs {
  mkdir(dir: string): void;
  readdir(dir: string): string[];
  write(file: string, text: string): void;
  read(file: string): string;
  rename(from: string, to: string): void;
  unlink(file: string): void;
  rmdir(dir: string): void;
  mtime(file: string): number;
}

export const realMailboxFs: MailboxFs = {
  mkdir: (d) => mkdirSync(d, { recursive: true }),
  readdir: (d) => readdirSync(d),
  write: (f, t) => writeFileSync(f, t, { mode: 0o600 }),
  read: (f) => readFileSync(f, "utf8"),
  rename: (a, b) => renameSync(a, b),
  unlink: (f) => unlinkSync(f),
  rmdir: (d) => rmSync(d, { recursive: true, force: true }),
  mtime: (f) => statSync(f).mtimeMs,
};

export interface MailboxDeps {
  repo: SessionMessagesRepo;
  /** 投影的根目录（paths.mailbox）。 */
  root: string;
  fs?: MailboxFs;
  head(sessionId: string): Session | null;
  /** 跑着这个 session（链上任何一个 id）的终端；没有为 null。 */
  termOf(sessionId: string): string | null;
  /** 现在开着的终端。 */
  openTerms(): string[];
  /** 直接输入前的 guard。answer：这一批里有 ask_user 的回答、换新以后的「接着做」或用户自己的话，不看「需要你」（它等的就是这些）。 */
  /** force：用户点了「现在送进去」（DeliveryGuard.check 的 force）。 */
  /** lenient：排着的已经「在确认」（unsure）挡了 UNSURE_DELIVER_MS（DeliveryGuard.check 的 lenient，BTL-279）。 */
  check(sessionId: string, o: { answer: boolean; force?: boolean; lenient?: boolean }): DeliveryCheck;
  recheckAfter(sessionId: string, passed: { termId: string }, o: { answer: boolean; force?: boolean; lenient?: boolean }): () => boolean;
  /**
   * 这条消息是收件人自己的总控发的指示（epic 总控发给自己 epic 里的 session、全局总控发给 epic 总控）：「需要你」时也送进去，
   * 注明是总控在回答（BTL-269 A）。没接时都不算。
   */
  fromController?(m: SessionMessage, headId: string): boolean;
  /**
   * 这条消息是收件人管的 session 发来的（BTL-279：epic 里的 session 给 epic 总控的汇报、epic 总控给全局总控的）：和 fromController
   * 同一个判断（isControllerOf），方向反过来。它在等用户回答时这些也送进去，注明不是用户的回答。没接时都不算。
   */
  fromSubordinate?(m: SessionMessage, headId: string): boolean;
  /** 这个 session（head）休眠着（终端是 Shipherd 为了省内存关的）。没接时都算关着。 */
  hibernated?(headId: string): boolean;
  deliver(termId: string, text: string, recheck: () => boolean): Promise<DeliverResult>;
  /** 叫停：现在能不能按 Esc（在忙、屏幕上没有要用户回答的对话框、用户没在打字、没有草稿）。 */
  canInterrupt(termId: string): boolean;
  interrupt(termId: string): void;
  /** 叫停之后的复查：粘贴前用户没往这个终端里输入过。 */
  interruptRecheck(termId: string): () => boolean;
  /** 目标最后一条回复（ActivityMonitor.lastReplyOf）。 */
  lastReply(sessionId: string): { id: string; text: string; at: number | null } | null;
  /**
   * transcript 显示它最近一轮已经结束（ActivityMonitor.turnClosed）：最后一条回复是说完了的话，不是一轮中间的。
   * 记录说在等输入、却从送到以后一直没停下过时（UserPromptSubmit 和 Stop 都丢了），凭它补查回复（BTL-279 复核）。没接时不补查。
   */
  turnClosed?(headId: string): boolean;
  /** 给人看的 session 名字（列表、回复的开头）："ABC-1"、"feature 登录改版的总控"、"Shipherd 总控"。null 是 Shipherd 自己。 */
  nameOf(sessionId: string | null): string;
  /**
   * Shipherd 往这个 session（head）里直接输入：start 在 deliver 之前，之后是 sent / failed。这一段引起的那次 UserPromptSubmit
   * 不算用户在终端里答了提问（InboxService.shipherdTyping）。
   */
  typing?(headId: string, phase: "start" | "sent" | "failed"): void;
  /**
   * 它在等用户回答什么（BTL-269 A1/A2）：判断出来需要你、或者有未答的 ask_user。只是刚停下、还没判断完的返回 null：
   * guard 照样挡（needs_you），但这时不当作它在等用户，总控的消息也接着等判断完。没接时都当 null。
   */
  awaitingUser?(headId: string): AwaitingUser | null;
  /**
   * 带了 answers 的总控指示送进去了（BTL-269 A2）：这几个 ask_user 记成总控代答（只认 queuedAt 之后还没答的），
   * 答案是总控写的原文，by 是总控的名字。
   */
  coordinatorAnswered?(headId: string, o: { asks: number[]; answer: string; by: string; queuedAt: number }): void;
  /**
   * 目标没开着终端、排着的不只是约定广播：休眠着的就叫它醒（醒来停下时 stopped 再送）；真关了的什么都不做，下次打开再送。
   * 约定广播不为它叫醒谁。
   */
  wake?(headId: string): void;
  /**
   * 这个关着的 head 的角色现在由另一个开着的 session 担着（新开的全局总控、同一个 epic 新开的总控）；没有为 null（BTL-279）。
   * 发给它的回复和汇报改投给那个：不然用户换了一个总控对话，回复就一直等着旧的那个。
   */
  successor?(headId: string): string | null;
  /**
   * 正在换新的 session（head）：不往磁盘上投影（BTL-248）。换新的 /handoff 那一轮里 hook 送进去的消息会被紧接着的 /clear 清掉；
   * 直接输入本来就被 guard 的 refreshing 挡着。换新结束后调用方 syncTerm 再 flush。
   */
  held?(headId: string): boolean;
  /** 每送到一条（hook 或直接输入）都调一次（BTL-256：后台恢复以后给发送方回执）。 */
  delivered?(m: SessionMessage): void;
  /** 收件人所在的 epic（ticket 的 session 从 ticket 往上找）：没写 featureId 的消息记在这里，epic 的消息列表看得到。 */
  featureOf?(headId: string): number | null;
  notify(): void;
  /** 只有消息列表要变（BTL-279：又试了一次、次数和时间变了）：只通知 messages 范围，不惊动别的界面。没接时用 notify。 */
  notifyMessages?(): void;
  now(): number;
  newId?: () => string;
  log(msg: string, err?: unknown): void;
}

export interface SendInput {
  kind: MessageKind;
  /** 发送方 session；Shipherd 自己发的为 null。 */
  from: string | null;
  to: string;
  featureId: number | null;
  /** 已经渲染好的正文（各来源原来那段文字）。 */
  body: string;
  interrupt?: boolean;
  ref?: string;
  meta?: unknown;
  /** 调用方马上用 opened 交给刚打开的终端：这里先不直接输入（也不写投影）。 */
  hold?: boolean;
}

/** 诊断导出里的一条消息（BTL-279）：不带正文。ref 只留前缀（report、stuck……）。 */
export interface MailboxDiagRow {
  id: string;
  kind: MessageKind;
  ref: string | null;
  from: string | null;
  to: string;
  /** 现在的收件人（按 head 链找到的最新一个）。 */
  head: string;
  /** 排着的：收件人现在跑在哪个终端（null = 关着、休眠着）。 */
  term: string | null;
  status: SessionMessage["status"];
  via: SessionMessage["via"];
  queuedAt: string;
  deliveredAt: string | null;
  repliedAt: string | null;
  blockedReason: MailboxBlockReason | null;
  blockedSince: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  lastAttempt: MailboxAttempt | null;
  stuckReceiptAt: string | null;
  /** 正在往里贴（直接输入、叫停）。 */
  inFlight: boolean;
}

/** 发出那一刻目标的状态：在忙（下一次工具调用时送）、停着（马上送）、关着（下次打开时送）。 */
export type TargetState = "busy" | "idle" | "closed";

const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());
/** 正文的版本：按 ref 换了正文（回答改了、评论多了）就变。 */
const revOf = (m: Pick<SessionMessage, "body">): string => createHash("sha1").update(m.body).digest("hex").slice(0, 16);
/** 排着的里有 session 等的那种（ask_user 的回答、换新以后的「接着做」）：不看「需要你」，也不注明不是用户的回答。flush 和 deliverNow 共用。 */
const answersWait = (queued: readonly SessionMessage[]): boolean => queued.some((m) => m.kind === "answer" || m.kind === "refresh");

const EXPECTS_REPLY: ReadonlySet<MessageKind> = new Set(["instruction", "shipherd"]);

/** 什么时候能送到（给 send_message、list_sessions 的那句话）：巡检按 PATROL_ETA_REASONS 换成它自己的一句。 */
export const etaOf = (reason: MailboxBlockReason, kind?: string): string =>
  kind === "patrol" && PATROL_ETA_REASONS.has(reason) ? M().mailboxEtaPatrol : M().mailboxEta[reason];

export class Mailbox {
  /** 上次清旧消息的时间（BTL-275）。 */
  private prunedAt: number | null = null;
  private readonly fs: MailboxFs;
  /** 正在直接输入的终端：同一个终端不同时送两段。 */
  private readonly inputting = new Set<string>();
  /** 正在叫停送进去的消息：不往磁盘上投影（不让 hook 抢走）。 */
  private readonly interrupting = new Set<string>();
  /** 正在直接输入的消息：等输入框的这段时间里也不往磁盘上投影，不然 hook 会再送一遍。 */
  private readonly inFlight = new Set<string>();
  /** 送达回调，按 ref 的前缀（`report:12` 的 `report`）。 */
  private readonly handlers = new Map<string, (m: SessionMessage) => void>();
  /** 每个 session（head）最后一次停下来的时间：送达记账晚于它停下来时补查回复。 */
  private readonly stoppedAt = new Map<string, number>();
  /** probeAwaiting 的节奏，按 head：它最新一条等回复的消息什么时候送到的（since）、上一次看是什么时候、下一次隔多久。 */
  private readonly probes = new Map<string, { since: number; at: number; gap: number }>();
  /** 排队时间严格递增：同一毫秒排的几条也按排的顺序送（磁盘上的文件名按它排序）。 */
  private lastQueuedAt = 0;
  /** send 之后马上那一次送的尝试，按消息 id：settle 等它（BTL-269）。 */
  private readonly attempts = new Map<string, Promise<unknown>>();

  constructor(private readonly d: MailboxDeps) {
    this.fs = d.fs ?? realMailboxFs;
  }

  /** 送达时调：按 ref 的前缀分发（汇报标成 answered、预审写 deliveredAt 之类）。 */
  on(prefix: string, fn: (m: SessionMessage) => void): void {
    this.handlers.set(prefix, fn);
  }

  private successorOf(head: string): string | null {
    try {
      // 休眠是 Shipherd 为了省内存关的，不是用户换了一个（BTL-279 review）：叫醒它自己收，不改投。
      if (this.d.hibernated?.(head)) return null;
      const next = this.d.successor?.(head) ?? null;
      // 只交给开着的：接替的也关着就照样排在原来的信箱里，免得在两个关着的之间来回改投。
      const to = next === null ? null : this.headOf(next);
      return to === null || to === head || this.d.termOf(to) === null ? null : to;
    } catch (e) {
      this.d.log(`mailbox: successor of ${head} failed`, e);
      return null;
    }
  }

  private headOf(id: string): string {
    return this.d.head(id)?.id ?? id;
  }

  /** 排一条，马上试着送。永不抛（排队本身失败除外：那是库坏了）。 */
  send(input: SendInput): { id: string; state: TargetState } {
    const to = this.headOf(input.to);
    const msg: NewSessionMessage = {
      id: this.d.newId?.() ?? randomUUID(), kind: input.kind, fromSession: input.from === null ? null : this.headOf(input.from), toSession: to,
      featureId: input.featureId ?? this.d.featureOf?.(to) ?? null, body: input.body.slice(0, MAILBOX_BODY_LIMIT), queuedAt: (this.lastQueuedAt = Math.max(this.d.now(), this.lastQueuedAt + 1)),
      interrupt: input.interrupt === true, ref: input.ref, meta: input.meta, expectsReply: EXPECTS_REPLY.has(input.kind),
    };
    const before = input.ref ? this.d.repo.queuedByRef(input.ref) : null;
    const { id } = this.d.repo.enqueue(msg);
    // 换了正文（回答改了、评论又多了）：磁盘上旧的那份删掉重写；hook 已经拿走的就让它送旧的，那时这条已经送到了。
    if (before) {
      const old = this.d.termOf(before.toSession);
      if (old !== null) {
        this.dropFile(old, before.id);
        this.syncTerm(old);
      }
    }
    const term = this.d.termOf(to);
    const state: TargetState = term === null ? "closed" : this.d.head(term)?.waitingForInput ? "idle" : "busy";
    let attempt: Promise<unknown> | null = null;
    if (input.interrupt && term !== null && state === "busy" && this.d.canInterrupt(term)) {
      this.interrupting.add(id);
      attempt = this.interruptAndSend(to, term, id);
    } else if (!input.hold) {
      if (term !== null) this.syncTerm(term);
      attempt = this.flush(to);
    }
    if (attempt) {
      this.attempts.set(id, attempt);
      const done = () => {
        if (this.attempts.get(id) === attempt) this.attempts.delete(id);
      };
      attempt.then(done, done);
    }
    this.d.notify();
    return { id, state };
  }

  /**
   * 等 send 之后那一次尝试（最多 capMs），如实说这条现在怎么样了（BTL-269）：送到了；还在排队，挡住它的原因和开始的时间；
   * delivering 是正在往里贴（deliver 在等输入框）。消息不在了（撤回、清理）也算 queued、原因 null。
   */
  async settle(
    id: string,
    capMs = SETTLE_MS,
  ): Promise<{ delivery: "delivered"; at: number | null } | { delivery: "queued"; reason: MailboxBlockReason | "delivering" | null; since: number | null; kind?: string }> {
    const attempt = this.attempts.get(id);
    if (attempt) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([attempt.catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, capMs)))]);
      clearTimeout(timer);
    }
    const m = this.d.repo.get(id);
    if (m && m.status !== "queued") return { delivery: "delivered", at: m.deliveredAt };
    if (this.inFlight.has(id) || this.interrupting.has(id)) return { delivery: "queued", reason: "delivering", since: null };
    return { delivery: "queued", reason: m?.blockedReason ?? null, since: m?.blockedSince ?? null, kind: m?.kind };
  }

  /**
   * 给 send_message 的返回（BTL-269）：settle 之后的结果，加上给人看的一句话。delivery 是 delivered 或 queued；
   * queued 时 blockedBy 是挡住它的原因（delivering = 正在往里贴；null = 还没试过），blockedSince 是这个原因开始的时间。
   */
  async outcome(id: string, capMs = SETTLE_MS): Promise<{ delivery: "delivered" | "queued"; blockedBy: MailboxBlockReason | "delivering" | null; blockedSince: string | null; note: string }> {
    const r = await this.settle(id, capMs);
    const note = Mailbox.note(r, this.d.now());
    if (r.delivery === "delivered") return { delivery: "delivered", blockedBy: null, blockedSince: null, note };
    return { delivery: "queued", blockedBy: r.reason, blockedSince: iso(r.since), note };
  }

  /**
   * 排给这个 session（任何一个 id）、还没送到的：几条、最早那条排了多久、挡住它的原因（BTL-269：list_sessions、session_activity 里显示）。
   * 一条都没有返回 null。
   */
  pendingFor(sessionId: string): {
    queued: number; oldestQueuedAt: number; reason: MailboxBlockReason | null; since: number | null; kind: string; attempts: number; lastAttemptAt: number | null;
  } | null {
    const mine = this.d.repo.queued().filter((m) => this.headOf(m.toSession) === this.headOf(sessionId));
    if (mine.length === 0) return null;
    const first = mine.reduce((a, b) => (b.queuedAt < a.queuedAt ? b : a));
    const blocked = mine.find((m) => m.blockedReason !== null) ?? first;
    // 次数看试得最多的那条（最早排的那条一般就是它），最后一次尝试看所有排着的里最近的（BTL-279）。
    const attempts = Math.max(...mine.map((m) => m.attempts));
    const last = mine.reduce<number | null>((a, m) => (m.lastAttemptAt !== null && (a === null || m.lastAttemptAt > a) ? m.lastAttemptAt : a), null);
    return { queued: mine.length, oldestQueuedAt: first.queuedAt, reason: blocked.blockedReason, since: blocked.blockedSince, kind: blocked.kind, attempts, lastAttemptAt: last };
  }

  /** 给 list_sessions、session_activity 的一项（BTL-269）：几条在排队、挡住的原因和开始时间、一句话；没有在排队的为 null。 */
  pendingView(sessionId: string): {
    queued: number; oldestQueuedAt: string; blockedBy: MailboxBlockReason | null; blockedSince: string | null; attempts: number; lastAttemptAt: string | null; note: string;
  } | null {
    const p = this.pendingFor(sessionId);
    if (!p) return null;
    const note = Mailbox.note({ delivery: "queued", reason: p.reason, since: p.since, kind: p.kind }, this.d.now());
    return {
      queued: p.queued, oldestQueuedAt: new Date(p.oldestQueuedAt).toISOString(), blockedBy: p.reason, blockedSince: iso(p.since),
      attempts: p.attempts, lastAttemptAt: iso(p.lastAttemptAt), note,
    };
  }


  /** 这几条这次没送进去（BTL-279）：次数加一，记下时间和结果，通知消息列表。 */
  private attempted(list: SessionMessage[], result: MailboxAttempt): void {
    if (list.length === 0) return;
    this.d.repo.attempted(list.map((m) => m.id), this.d.now(), result);
    (this.d.notifyMessages ?? this.d.notify)();
  }

  /**
   * 记下挡住这几条的原因（只记变了的），变了就写日志、通知界面。
   * 尝试次数只算真的试过的（BTL-279 review）：原因变了的那几条，或者 tried（这次真的去贴了）。每个 tick 照样挡着的不算，
   * 不然排一夜的消息一小时涨三百多次，每次还要写库、发通知。
   */
  private block(head: string, list: SessionMessage[], reason: MailboxBlockReason, tried = false): void {
    if (list.length === 0) return;
    const changed = this.d.repo.setBlocked(list.map((m) => m.id), reason, this.d.now());
    const ids = new Set(changed);
    this.attempted(tried ? list : list.filter((m) => ids.has(m.id)), reason);
    if (changed.length === 0) return;
    this.d.log(`mailbox: ${head} blocked (${reason}): ${changed.length} message(s) waiting`);
    // 原因变了：还排着的回执说的是旧原因和旧 ETA，撤回；这几条按现在的原因重新算回执（下一次 tick）。
    for (const receipt of this.queuedStuckReceipts(new Set(changed))) {
      this.withdraw(receipt.ref!);
      this.d.repo.clearStuckReceipt(receiptIds(receipt));
      this.d.log(`mailbox: ${head}: the reason changed to ${reason}; withdrew the stale stuck receipt ${receipt.id}`);
    }
    this.d.notify();
  }

  /** 还在排队、ref 以 prefix: 开头的那些 ref。 */
  queuedRefs(prefix: string): string[] {
    return this.d.repo.queued().flatMap((m) => (m.ref?.startsWith(`${prefix}:`) ? [m.ref] : []));
  }

  /** 撤回这个 ref 还在排队的那一条（hook 已经拿走的照样会送到）。 */
  withdraw(ref: string): void {
    const m = this.d.repo.queuedByRef(ref);
    if (!m || this.d.repo.withdraw(ref) === null) return;
    const term = this.d.termOf(m.toSession);
    if (term !== null) {
      this.dropFile(term, m.id);
      this.syncTerm(term);
    }
    this.settleStuckReceipts(m.id);
    this.d.notify();
  }

  /** 这个 ref 还在排队的那一条；没有为 null。 */
  queuedByRef(ref: string): SessionMessage | null {
    return this.d.repo.queuedByRef(ref);
  }

  // ---- 磁盘投影 ----

  private dirOf(termId: string): string {
    return join(this.d.root, termId);
  }

  private list(dir: string): string[] {
    try {
      return this.fs.readdir(dir);
    } catch {
      return [];
    }
  }

  /** 这个终端该在磁盘上有的消息（在排队、不在叫停里），先排的在前。 */
  /** 排给这个 head 的，按排进来的先后；换新以后的「接着做」排最前：新上下文先 recall，再看换新期间来的。 */
  private queuedFor(headId: string): SessionMessage[] {
    const mine = this.d.repo.queued().filter((m) => this.headOf(m.toSession) === headId);
    return [...mine.filter((m) => m.kind === "refresh"), ...mine.filter((m) => m.kind !== "refresh")];
  }

  private render(m: SessionMessage): string {
    const age = this.d.now() - m.queuedAt;
    return age > AGE_NOTE_MS ? `${M().mailboxAge(Math.round(age / 60_000))}\n${m.body}` : m.body;
  }

  /**
   * 让这个终端的投影和库对上：缺的写上、不该有的 .json 删掉；一条都没有就把目录删掉（hook 的判断就是看目录在不在）。
   * 巡检（kind patrol）不写：只在总控停下来时直接输入、自成一轮（BTL-279 第五轮）。hook 把它带进别人那一轮的话，那一轮不算巡检，
   * 巡检时发给用户关掉的 epic 总控的消息就会把它拉起来。
   */
  syncTerm(termId: string): void {
    try {
      const head = this.d.head(termId);
      const dir = this.dirOf(termId);
      const want = head && !this.d.held?.(head.id) ? this.queuedFor(head.id).filter((m) => m.kind !== "patrol" && !this.interrupting.has(m.id) && !this.inFlight.has(m.id)) : [];
      const names = this.list(dir);
      const present = new Set<string>();
      for (const n of names) {
        const id = messageIdOf(n);
        if (id === null) continue;
        present.add(id);
        if (n.endsWith(MSG_SUFFIX) && !want.some((m) => m.id === id)) this.unlink(join(dir, n));
      }
      const missing = want.filter((m) => !present.has(m.id));
      if (missing.length > 0) {
        this.fs.mkdir(dir);
        for (const m of missing) {
          // 用户自己的话经 hook 送：说明一句是用户说的，不是别的 session 写的（BTL-248）。
          const text = m.kind === "user" ? `${M().mailboxUser}\n${this.render(m)}` : this.render(m);
          const file: MailboxFile = { id: m.id, text, intro: M().mailboxIntro, rev: revOf(m) };
          const name = messageFileName(m.queuedAt, m.id);
          // 先写临时文件再改名：hook 不会读到写了一半的。
          this.fs.write(join(dir, `${name}.tmp`), JSON.stringify(file));
          this.fs.rename(join(dir, `${name}.tmp`), join(dir, name));
        }
      }
      if (this.list(dir).filter((n) => messageIdOf(n) !== null).length === 0) this.removeDir(termId);
    } catch (e) {
      this.d.log(`mailbox: sync ${termId} failed`, e);
    }
  }

  /** 这一条在磁盘上还没被认领的 .json 删掉。 */
  private dropFile(termId: string, id: string): void {
    const dir = this.dirOf(termId);
    for (const n of this.list(dir)) if (n.endsWith(MSG_SUFFIX) && messageIdOf(n) === id) this.unlink(join(dir, n));
  }

  private removeDir(termId: string): void {
    try {
      this.fs.rmdir(this.dirOf(termId));
    } catch {
      // 下一次再删。
    }
  }

  private unlink(file: string): void {
    try {
      this.fs.unlink(file);
    } catch {
      // 已经没了。
    }
  }

  /**
   * hook 送出去的记账：.done 记成送达（via hook）再删掉；hook 认领了太久没写出去的 .taken、主进程上次崩在半路留下的 .main 放回去。
   * 然后和库对一遍。
   */
  sweep(termId: string): void {
    const dir = this.dirOf(termId);
    const now = this.d.now();
    let changed = false;
    for (const n of this.list(dir)) {
      const id = messageIdOf(n);
      if (id === null) continue;
      const file = join(dir, n);
      if (n.endsWith(DONE_SUFFIX)) {
        const m = this.d.repo.get(id);
        // hook 认领和写出去时都 touch 过：mtime 就是送到的时间。送的是换正文之前的那份：新正文还没送到，留着排队。
        if (m && m.status === "queued" && this.fileRev(file) === revOf(m)) changed = this.markDelivered(m, "hook", this.fileTime(file, now)) || changed;
        this.unlink(file);
        continue;
      }
      const stale = n.includes(TAKEN_SUFFIX) ? TAKEN_STALE_MS : n.endsWith(MAIN_SUFFIX) && !this.inputting.has(termId) ? MAIN_STALE_MS : null;
      if (stale !== null && now - this.fileTime(file, now) > stale) {
        try {
          this.fs.rename(file, join(dir, n.slice(0, n.indexOf(MSG_SUFFIX) + MSG_SUFFIX.length)));
        } catch {
          // 已经被处理了。
        }
      }
    }
    this.syncTerm(termId);
    if (changed) this.d.notify();
  }

  /** 文件里记的正文版本；读不出（旧版本写的）就当是现在的。 */
  private fileRev(file: string): string | undefined {
    try {
      const v = (JSON.parse(this.fs.read(file)) as Partial<MailboxFile>).rev;
      return typeof v === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  }

  private fileTime(file: string, fallback: number): number {
    try {
      return this.fs.mtime(file);
    } catch {
      return fallback;
    }
  }

  /** 启动时：上一次留下的投影全部删掉重建（.done 先记账）。 */
  rebuild(): void {
    for (const t of this.list(this.d.root)) this.sweep(t);
    const open = new Set(this.d.openTerms());
    for (const t of this.list(this.d.root)) if (!open.has(t)) this.removeDir(t);
    for (const t of open) this.syncTerm(t);
  }

  /** 终端退出了：先记账，再删掉它的投影（消息留在库里，下次打开再送）。 */
  termExited(termId: string): void {
    const dir = this.dirOf(termId);
    for (const n of this.list(dir)) if (n.endsWith(DONE_SUFFIX)) this.sweep(termId);
    this.removeDir(termId);
  }

  // ---- 送达 ----

  private markDelivered(m: SessionMessage, via: "hook" | "input", at: number): boolean {
    const target = this.headOf(m.toSession);
    // 基线是送达之前的最后一条回复；对方一轮很短时，记账前它已经回完了，那条比送达晚，不能当基线。
    const last = m.expectsReply ? this.d.lastReply(target) : null;
    const baseReplyId = last && (last.at === null || last.at <= at) ? last.id : null;
    if (!this.d.repo.delivered(m.id, { at, via, toSession: target, baseReplyId })) return false;
    const prefix = m.ref?.split(":")[0];
    const fn = prefix ? this.handlers.get(prefix) : undefined;
    if (fn) {
      try {
        fn({ ...m, status: "delivered", deliveredAt: at, via });
      } catch (e) {
        this.d.log(`mailbox: delivered handler for ${m.ref} failed`, e);
      }
    }
    try {
      this.d.delivered?.({ ...m, status: "delivered", deliveredAt: at, via });
    } catch (e) {
      this.d.log(`mailbox: delivered callback for ${m.id} failed`, e);
    }
    this.settleStuckReceipts(m.id);
    // 送达的记账晚于对方停下来（假 claude、很短的一轮）：马上补查一次回复。
    if (m.expectsReply && (this.stoppedAt.get(target) ?? -Infinity) >= at) {
      void this.checkReplies(target).catch((e: unknown) => this.d.log(`mailbox: late reply check for ${target} failed`, e));
    }
    return true;
  }

  /**
   * 合成一段直接输入的正文；第一条总要送，放不下的留到下一次。
   * 用户在对话 tab 里说的话（kind user）不和 Shipherd 的消息合在一起：开头是 user 的这一批只要接着的 user，原样输入，
   * 不加信箱开头，对话里照旧是「你：」；开头不是 user 的这一批碰到 user 就停（BTL-248）。
   */
  /** pastHold：它在等用户（或者还在判断）时送进去的（BTL-279）：总控的提示之外的每一条注明不是用户的回答。 */
  private batch(list: SessionMessage[], head: string, waiting: AwaitingUser | null = null, pastHold = false): { text: string; ids: SessionMessage[] } {
    // 换新以后的「接着做」单独原样输入：它是新上下文的第一句话。
    if (list[0]?.kind === "refresh") return { text: sanitizeTask(list[0].body), ids: [list[0]] };
    const user = list[0]?.kind === "user";
    // 巡检和同时排着的别的非 user 消息（回复、汇报、指示）合成一次输入：这一轮按巡检处理（PatrolTurns），
    // 那几条在这一轮里引出的 send_message 也算巡检发的。用户的话不合进来（下面遇到 user 就断开）。
    const parts: string[] = [];
    const ids: SessionMessage[] = [];
    let size = 0;
    for (const m of list) {
      if ((m.kind === "user") !== user) break;
      const part = user ? m.body : this.withAnswerNote(m, head, waiting, pastHold);
      if (ids.length > 0 && size + part.length > INPUT_LIMIT) break;
      parts.push(part);
      ids.push(m);
      size += part.length + 8;
    }
    if (user) return { text: sanitizeTask(parts.join("\n\n")), ids };
    const intro = M().mailboxIntro.replace("{n}", String(ids.length));
    return { text: sanitizeTask([intro, ...parts].join("\n\n---\n\n")), ids };
  }

  /**
   * 它在等用户回答时送进去的总控指示（BTL-269 A2），每一条前面注明：明确替用户回答了（answeredBy）的说是回答；
   * 别的说不是回答、问题还在等用户。不在等用户、不是自己的总控发的不加。
   */
  private withAnswerNote(m: SessionMessage, head: string, waiting: AwaitingUser | null, pastHold = false): string {
    const text = this.render(m);
    if (!waiting || !this.fromController(m, head)) return pastHold ? `${M().mailboxNotUserAnswer}\n${text}` : text;
    const a = answeredBy(m, waiting);
    return `${a ? M().mailboxAnswersQuestion(a.question) : M().mailboxNotAnAnswer}\n${text}`;
  }

  private awaiting(head: string): AwaitingUser | null {
    try {
      return this.d.awaitingUser?.(head) ?? null;
    } catch (e) {
      this.d.log(`mailbox: awaitingUser for ${head} failed`, e);
      return null;
    }
  }

  /** 认领要直接输入的消息：磁盘上的 .json 改成 .main；被 hook 拿走了的（.taken / .done）不送。 */
  private claim(termId: string, list: SessionMessage[]): { mine: SessionMessage[]; files: Map<string, string> } {
    const dir = this.dirOf(termId);
    const byId = new Map<string, string>();
    for (const n of this.list(dir)) {
      const id = messageIdOf(n);
      if (id !== null) byId.set(id, n);
    }
    const mine: SessionMessage[] = [];
    const files = new Map<string, string>();
    for (const m of list) {
      const n = byId.get(m.id);
      if (n === undefined) {
        mine.push(m); // 没投影（叫停的、刚排的还没写上）。
        continue;
      }
      if (!n.endsWith(MSG_SUFFIX)) continue;
      try {
        this.fs.rename(join(dir, n), join(dir, `${n}${MAIN_SUFFIX}`));
        files.set(m.id, `${n}${MAIN_SUFFIX}`);
        mine.push(m);
      } catch {
        // hook 刚拿走。
      }
    }
    return { mine, files };
  }

  private release(termId: string, files: Map<string, string>, sent: Set<string>): void {
    const dir = this.dirOf(termId);
    for (const [id, n] of files) {
      if (sent.has(id)) this.unlink(join(dir, n));
      else {
        try {
          this.fs.rename(join(dir, n), join(dir, n.slice(0, -MAIN_SUFFIX.length)));
        } catch {
          // sweep 过 5 分钟放回去。
        }
      }
    }
  }

  /**
   * 直接输入：目标停着、guard 让送时，把它排队的消息合成一段贴进去。在忙、关着、guard 不让时什么都不做（消息留着，hook 或下一次再送）。
   * 永不 reject。
   */
  async flush(sessionId: string): Promise<void> {
    const head = this.headOf(sessionId);
    const term = this.d.termOf(head);
    if (term === null) {
      let queued = this.queuedFor(head);
      const next = queued.some((m) => FOLLOWS_ROLE.has(m.kind)) ? this.successorOf(head) : null;
      if (next !== null) {
        const moved = queued.filter((m) => FOLLOWS_ROLE.has(m.kind));
        this.d.repo.readdress(moved.map((m) => m.id), next);
        this.d.log(`mailbox: ${head} is closed and ${next} took over its role; readdressing ${moved.length} replies/reports`);
        queued = queued.filter((m) => !FOLLOWS_ROLE.has(m.kind));
        this.d.notify();
      }
      if (queued.length > 0) {
        this.block(head, queued, this.d.hibernated?.(head) ? "hibernated" : "closed");
        if (this.d.wake && queued.some(wakesTarget)) this.d.wake(head);
      }
      // 改投的那几条放到最后再送（BTL-279 review）：往 next 里贴最多要一分钟，等完再按之前读的状态挡 head、叫醒它就过时了。
      if (next !== null) await this.flush(next);
      return;
    }
    const queued = this.queuedFor(head).filter((m) => !this.interrupting.has(m.id));
    if (queued.length === 0) return;
    if (this.inputting.has(term)) {
      // 正在往里贴前一批：这些没在那一批里，等它那一轮的工具调用（hook）或者停下来。
      this.block(head, queued.filter((m) => !this.inFlight.has(m.id)), "auto_input");
      return;
    }
    let answer = answersWait(queued);
    const lenient = this.blockedFor(queued, "unsure") >= UNSURE_DELIVER_MS;
    let list = queued;
    let gate = this.d.check(head, { answer, lenient });
    let waiting: AwaitingUser | null = null;
    /** 没进这一批的等什么：needs_you，或者还在判断（judging）。 */
    let held: MailboxBlockReason | null = null;
    if (!gate.ok && gate.block === "needs_you") {
      waiting = this.awaiting(head);
      // 只是刚停下、还没判断完（BTL-269 A1）：不知道它是不是在问用户，总控的也不送、不当作在代答，判断完下一次 tick 再看。
      // 判断了 JUDGING_HOLD_MS 还没结论（BTL-279）：不再等，总控的照样送，注明不是用户的回答（没有当作代答的提问）。
      held = waiting === null ? "judging" : "needs_you";
      const judgedLong = waiting === null && this.blockedFor(queued, "judging") >= JUDGING_HOLD_MS;
      // 用户自己在对话 tab 里说的话不看这个：它就是用户在回答。
      // 判断完、确实在等用户时，自己的总控发来的指示也送（BTL-269 A2），每一条注明是不是在替用户回答。
      // 给总控的回复、它管的 session 的汇报也送（BTL-279：总控在等用户时一直收不到汇报），注明不是用户的回答。Shipherd 的别的消息接着等。
      list = queued.filter((m) => m.kind === "user" || ((waiting !== null || judgedLong) && (this.fromController(m, head) || this.forController(m, head))));
      if (list.length === 0) {
        this.block(head, queued, held);
        return;
      }
      answer = true;
      gate = this.d.check(head, { answer, lenient });
    }
    if (!gate.ok) {
      this.block(head, queued, gate.block === "busy" ? (gate.busy ?? "turn") : gate.block);
      return;
    }
    if (held) this.block(head, queued.filter((m) => !list.includes(m)), held);
    if (lenient) this.d.log(`mailbox: ${head} looked stopped for ${Math.round(this.blockedFor(queued, "unsure") / 1000)} s without the evidence settling; typing the messages in anyway`);
    await this.input(head, gate.termId, list, this.d.recheckAfter(head, gate, { answer, lenient }), undefined, undefined, waiting, held !== null);
  }

  /** 这几条里最早从什么时候起一直因为 reason 挡着，到现在多久；没有的为 0。 */
  private blockedFor(list: SessionMessage[], reason: MailboxBlockReason): number {
    const since = list.flatMap((m) => (m.blockedReason === reason && m.blockedSince !== null ? [m.blockedSince] : []));
    return since.length === 0 ? 0 : this.d.now() - Math.min(...since);
  }

  /**
   * 给它的回复、它管的 session 发来的汇报（BTL-279）：它在等用户时也该看到。回复（reply）都是回它自己发出去的消息的
   * （对方这一轮的最后一段话、Shipherd 的「还没送到」「叫不醒」回执），谁发的都算；汇报要是它管的 session 发的。
   */
  private forController(m: SessionMessage, head: string): boolean {
    if (m.kind === "reply") return true;
    if (m.kind !== "report" || m.fromSession === null) return false;
    try {
      return this.d.fromSubordinate?.(m, head) === true;
    } catch (e) {
      this.d.log(`mailbox: fromSubordinate for ${m.id} failed`, e);
      return false;
    }
  }

  private fromController(m: SessionMessage, head: string): boolean {
    if (m.fromSession === null || !EXPECTS_REPLY.has(m.kind)) return false;
    try {
      return this.d.fromController?.(m, head) === true;
    } catch (e) {
      this.d.log(`mailbox: fromController for ${m.id} failed`, e);
      return false;
    }
  }

  /**
   * 用户在界面上点了「现在送进去」（BTL-269）：不等它停下、不看「需要你」和刚打过字，这一条排在最前、连同其他排着的一起贴进去。
   * 确认框、草稿、换新、熔断、终端关着照样挡：返回挡住的原因。
   */
  async deliverNow(id: string): Promise<{ delivered: boolean; reason: MailboxBlockReason | "delivering" | "gone" | null }> {
    const m = this.d.repo.get(id);
    if (!m) return { delivered: false, reason: "gone" };
    if (m.status !== "queued") return { delivered: true, reason: null };
    const head = this.headOf(m.toSession);
    const term = this.d.termOf(head);
    if (term === null) {
      await this.flush(head);
      // flush 可能把它改投给了接替的那个、而且送进去了（BTL-279 review）：按它现在的状态回答。
      const after = this.d.repo.get(id);
      if (after && after.status !== "queued") return { delivered: true, reason: null };
      if (after && this.headOf(after.toSession) !== head) return { delivered: false, reason: after.blockedReason };
      return { delivered: false, reason: this.d.hibernated?.(head) ? "hibernated" : "closed" };
    }
    if (this.inputting.has(term)) return { delivered: false, reason: this.inFlight.has(id) ? "delivering" : "auto_input" };
    const o = { answer: true, force: true };
    const gate = this.d.check(head, o);
    if (!gate.ok) {
      const reason = gate.block === "busy" ? (gate.busy ?? "turn") : gate.block;
      this.block(head, [m], reason);
      return { delivered: false, reason };
    }
    this.d.log(`mailbox: ${head}: the user asked to deliver ${id} now`);
    const queued = this.queuedFor(head).filter((x) => !this.interrupting.has(x.id));
    // 它在等用户回答时，总控的指示照样注明是不是在替用户回答（和 flush 一样）。
    // 不点「现在送进去」本来会被「需要你」挡住的（在等用户、或者还没判断完）：和 flush 越过它时一样，别的每一条注明不是用户的回答（BTL-279 复核建议 5）。
    // 用 lenient 再看一次：只跳过 unsure，挡在「需要你」之前的别的检查和刚才 force 的那次一样，force 已经过了。
    // answer 和 flush 用同一个判断（复核）：排着 ask_user 的回答时 flush 不看「需要你」、也不注明，这里也不能给用户自己的回答注明「不是用户的回答」。
    const pastHold = (() => {
      const plain = this.d.check(head, { answer: answersWait(queued), lenient: true });
      return !plain.ok && plain.block === "needs_you";
    })();
    await this.input(head, gate.termId, queued, this.d.recheckAfter(head, gate, o), id, undefined, this.awaiting(head), pastHold);
    const after = this.d.repo.get(id);
    if (after && after.status !== "queued") return { delivered: true, reason: null };
    return { delivered: false, reason: after?.blockedReason ?? null };
  }

  /**
   * 刚为这些消息打开的终端（send_message 打开了关着的总控）：排着的消息当第一条输入交进去（submit 自己等输入框就绪），不过 guard。
   * 返回送到没有。永不 reject。
   */
  async opened(sessionId: string, termId: string, submit: (termId: string, text: string) => Promise<DeliverResult>): Promise<boolean> {
    const head = this.headOf(sessionId);
    if (this.inputting.has(termId)) return false;
    return this.input(head, termId, this.queuedFor(head), () => true, undefined, submit);
  }

  private async input(
    head: string, term: string, queued: SessionMessage[], recheck: () => boolean, forced?: string,
    submit?: (termId: string, text: string) => Promise<DeliverResult>, waiting: AwaitingUser | null = null, pastHold = false,
  ): Promise<boolean> {
    this.inputting.add(term);
    const sent = new Set<string>();
    let files = new Map<string, string>();
    try {
      this.sweep(term);
      const fresh = queued.filter((m) => this.d.repo.get(m.id)?.status === "queued");
      const claimed = this.claim(term, fresh);
      files = claimed.files;
      if (claimed.mine.length === 0) return false;
      for (const m of claimed.mine) this.inFlight.add(m.id);
      // 叫停的那一条排在最前，一定在这一批里。
      const list = forced ? [...claimed.mine.filter((m) => m.id === forced), ...claimed.mine.filter((m) => m.id !== forced)] : claimed.mine;
      const { text, ids } = this.batch(list, head, waiting, pastHold);
      // 这一批里注明了「替用户回答」的那些提问（PR #108 第三轮 review 建议 2）：等输入框的时候（最多 1 分钟）用户可能自己在卡片上
      // 答了。贴进去之前再看一次，有一个已经不在等了就这次不送，留着排队，下一次按新的状态重新写注明。
      const noteAsks = ids.flatMap((m) => (this.fromController(m, head) ? (answeredBy(m, waiting)?.asks ?? []) : []));
      const stillAsked = (): boolean => {
        if (noteAsks.length === 0) return true;
        const open = new Set((this.awaiting(head)?.asks ?? []).map((a) => a.id));
        const ok = noteAsks.every((id) => open.has(id));
        if (!ok) this.d.log(`mailbox: ${head} no longer waits on question ${noteAsks.join(", ")}; not typing in an answer note that is out of date`);
        return ok;
      };
      // 送达时间取在真正贴进去的那一刻（BTL-279 review）：deliver 在贴之前同步调 check，过了马上就贴。
      // 在 deliver 之前取的话，等输入框那一分钟里旧的一轮写完的回复比它晚，会被当成这条的【回复】。
      let at = this.d.now();
      const check = (): boolean => {
        const ok = stillAsked() && recheck();
        if (ok) at = this.d.now();
        return ok;
      };
      // 用户自己的话不算 Shipherd 输入的：它的 UserPromptSubmit 照样算用户在终端里回答了。
      const typing = ids[0]?.kind === "user" ? undefined : this.d.typing;
      typing?.(head, "start");
      const result = await (submit ? (stillAsked() ? submit(term, text) : Promise.resolve<DeliverResult>("blocked")) : this.d.deliver(term, text, check)).catch((e: unknown) => {
        // 抛了也要收尾，不然那个 session 下一次 UserPromptSubmit 一直被当成 Shipherd 的。
        typing?.(head, "failed");
        throw e;
      });
      typing?.(head, result === "sent" ? "sent" : "failed");
      if (result !== "sent") {
        this.d.log(`mailbox: input to ${head}: ${result}`);
        // 没等到输入框（BTL-269）：如实记下来，别留着之前的原因（比如还说「在干活」）。recheck 没过、终端退出的下一次检查会记真正的原因。
        if (result === "timeout") this.block(head, claimed.mine, "deliver_failed", true);
        else this.attempted(claimed.mine, result === "exited" ? "exited" : "recheck");
        return false;
      }
      for (const m of ids) {
        // 等输入框的时候按 ref 换了正文：送进去的是旧的，新的留着排队。
        const now = this.d.repo.get(m.id);
        if (now && revOf(now) !== revOf(m)) continue;
        if (this.markDelivered(m, "input", at)) sent.add(m.id);
      }
      // 明确替用户回答了的（BTL-269 A2）：那几个提问记成总控代答。看的是实际送进去的这一批。
      for (const m of ids) {
        const a = sent.has(m.id) && this.fromController(m, head) ? answeredBy(m, waiting) : null;
        if (!a || a.asks.length === 0) continue;
        try {
          const meta = m.meta as InstructionMeta | null;
          this.d.coordinatorAnswered?.(head, { asks: a.asks, answer: typeof meta?.text === "string" ? meta.text : m.body, by: this.d.nameOf(m.fromSession), queuedAt: m.queuedAt });
        } catch (e) {
          this.d.log(`mailbox: coordinatorAnswered for ${head} failed`, e);
        }
      }
      this.d.notify();
      return true;
    } catch (e) {
      this.d.log(`mailbox: input to ${head} failed`, e);
      return false;
    } finally {
      for (const id of files.keys()) this.inFlight.delete(id);
      for (const m of queued) this.inFlight.delete(m.id);
      this.release(term, files, sent);
      this.inputting.delete(term);
      this.syncTerm(term);
    }
  }

  /** 叫停：按 Esc，等输入框就绪（deliver 最多等 1 分钟），连同其他排队的一起送。送不成就当普通消息排队。 */
  private async interruptAndSend(head: string, term: string, id: string): Promise<void> {
    try {
      if (this.inputting.has(term)) return;
      this.d.interrupt(term);
      const queued = this.queuedFor(head);
      await this.input(head, term, queued, this.d.interruptRecheck(term), id);
    } catch (e) {
      this.d.log(`mailbox: interrupt ${head} failed`, e);
    } finally {
      this.interrupting.delete(id);
      const t = this.d.termOf(head);
      if (t !== null) this.syncTerm(t);
    }
  }

  // ---- 回复 ----

  /**
   * 一个 session 停下来了（sessionStopped，活动已经重读过）：先看等回复的消息有没有回复，再直接输入它排队的消息。永不 reject。
   */
  async stopped(sessionId: string): Promise<void> {
    const head = this.headOf(sessionId);
    this.stoppedAt.set(head, this.d.now());
    try {
      await this.checkReplies(head);
    } catch (e) {
      this.d.log(`mailbox: reply check for ${head} failed`, e);
    }
    const term = this.d.termOf(head);
    if (term !== null) this.sweep(term);
    await this.flush(head);
  }

  private async checkReplies(head: string): Promise<void> {
    const waiting = this.d.repo.awaitingReply(this.d.now() - REPLY_WAIT_MS).filter((m) => this.headOf(m.toSession) === head);
    if (waiting.length === 0) return;
    const reply = this.d.lastReply(head);
    if (!reply) return;
    const m = M();
    let changed = false;
    for (const x of waiting) {
      // resume 之后第一次 Stop 看到的可能是上一次对话的最后一条回复：要比排队的时间晚才算。
      // 要比送到的时间晚：送到之前它停下来留的那条是上一件事的回复。
      if (reply.id === x.baseReplyId || (reply.at !== null && (x.deliveredAt !== null ? reply.at <= x.deliveredAt : reply.at < x.queuedAt))) continue;
      const text = reply.text.slice(-MESSAGE_LIMIT);
      if (!this.d.repo.replied(x.id, { text, at: reply.at ?? this.d.now() })) continue;
      changed = true;
      if (x.fromSession !== null) {
        this.send({ kind: "reply", from: head, to: x.fromSession, featureId: x.featureId, body: m.shipherdReplyLine(this.d.nameOf(head), [x.id], text) });
      }
    }
    if (changed) this.d.notify();
  }

  // ---- 定时 ----

  /** 每个调度 tick：清扫所有投影、删掉关了的终端的投影、给停着的直接输入、清理旧消息。永不 reject。 */
  async tick(): Promise<void> {
    try {
      const open = new Set(this.d.openTerms());
      for (const t of this.list(this.d.root)) {
        if (open.has(t)) this.sweep(t);
        else this.termExited(t);
      }
      for (const t of open) this.syncTerm(t);
      const now = this.d.now();
      if (this.prunedAt === null || now - this.prunedAt >= PRUNE_EVERY_MS) {
        this.prunedAt = now;
        if (this.d.repo.prune(now - MESSAGE_KEEP_MS) > 0) this.d.notify();
      }
      // 各送各的（BTL-279）：一个 session 的输入框一直没就绪（deliver 最多等 1 分钟）不能拖住别的 session。
      // 上一次 tick 还在给它贴的，flush 里 inputting 会挡住，不会贴两次。
      const heads = new Set(this.d.repo.queued().map((m) => this.headOf(m.toSession)));
      // flush 本应永不 reject；万一哪个抛了，别的 head 照送，查回复、回执这一拍也照做（BTL-279 second review）。
      const list = [...heads];
      const done = await Promise.allSettled(list.map((h) => this.flush(h)));
      done.forEach((r, i) => {
        if (r.status === "rejected") this.d.log(`mailbox: flushing ${list[i]} failed`, r.reason);
      });
      this.probeAwaiting(heads);
      this.stuckReceipts();
    } catch (e) {
      this.d.log("mailbox: tick failed", e);
    }
  }

  /**
   * 在等【回复】、终端开着、又没有排队消息的 head（BTL-279 review）：看它这一轮是不是已经结束了、只是没有 Stop。
   * - 记录还说在干活：过一次 guard。只有 guard 会凭屏幕证据校正记录（校正按停下处理，停下时查回复）；
   *   不看一眼的话，要等下一条消息排进来才校正，【回复】一直回不来。
   * - 记录说在等输入、可从送到以后一直没停下过（复核：那一轮的 UserPromptSubmit 和 Stop 都丢了，记录停在贴之前的「在等」，
   *   guard 不会去校正它）：transcript 显示那一轮已经结束了，就直接查回复（checkReplies 只认送到以后的回复）。
   * 只看开着的：guard 对关着的会去叫醒休眠的，不能为了查回复叫醒它。有排队消息的 flush 已经过过 guard，只跳过第一种。
   * 节奏（复核建议 4）：送到后 PROBE_DENSE_MS 之内每个 tick 都看，之后间隔从 PROBE_FIRST_GAP_MS 起翻倍，最长 PROBE_MAX_GAP_MS。
   */
  private probeAwaiting(flushed: Set<string>): void {
    const now = this.d.now();
    const latest = new Map<string, number>();
    for (const m of this.d.repo.awaitingReply(now - REPLY_WAIT_MS)) {
      const h = this.headOf(m.toSession);
      const at = m.deliveredAt ?? m.queuedAt;
      if (at > (latest.get(h) ?? -Infinity)) latest.set(h, at);
    }
    for (const h of this.probes.keys()) if (!latest.has(h)) this.probes.delete(h);
    for (const [h, since] of latest) {
      if (this.d.termOf(h) === null || !this.probeDue(h, since, now)) continue;
      try {
        if (this.d.head(h)?.waitingForInput !== true) {
          // 有排队消息的，flush 这一拍已经过过 guard 了。
          if (!flushed.has(h)) this.d.check(h, { answer: false });
          continue;
        }
        // 查回复不跳过有排队消息的（复核）：flush 不查回复，别的消息一直挡着（需要你、草稿、打字）时，这条的回复也得回来。
        // 送到以后停下过的，停下时已经查过了。
        if (since <= (this.stoppedAt.get(h) ?? -Infinity) || this.d.turnClosed?.(h) !== true) continue;
        void this.checkReplies(h).catch((e: unknown) => this.d.log(`mailbox: reply check for ${h} (no Stop since the delivery) failed`, e));
      } catch (e) {
        this.d.log(`mailbox: checking ${h} for a reply that ended without Stop failed`, e);
      }
    }
  }

  /** 这一 tick 该不该替 h 看一眼（见 probeAwaiting 的节奏）。since 变了（又送到一条）从头算。 */
  private probeDue(h: string, since: number, now: number): boolean {
    const p = this.probes.get(h);
    if (!p || p.since !== since || now - since < PROBE_DENSE_MS) {
      this.probes.set(h, { since, at: now, gap: PROBE_FIRST_GAP_MS });
      return true;
    }
    if (now - p.at < p.gap) return false;
    p.at = now;
    p.gap = Math.min(PROBE_MAX_GAP_MS, p.gap * 2);
    return true;
  }

  /**
   * 总控发的消息排了 STUCK_RECEIPT_MS 还没送到、原因不是用户在打字或有草稿：给发件的总控回一条，说明卡在哪、什么时候能送（BTL-269）。
   * 每条消息只算一次（stuck_receipt_at 存在库里，重启也不重发）；同一对发件人、收件人合成一条。
   */
  private stuckReceipts(): void {
    const now = this.d.now();
    const stuck = this.d.repo.queued().filter(
      // 从现在这个原因开始的时间算（blockedSince），不从排队算：刚从「在干活」变成「在确认」的不马上发回执、紧接着又撤回。
      (m) => m.fromSession !== null && EXPECTS_REPLY.has(m.kind) && m.stuckReceiptAt === null && m.blockedReason !== null
        && now - (m.blockedSince ?? m.queuedAt) >= (m.blockedReason === "turn" ? STUCK_TURN_RECEIPT_MS : STUCK_RECEIPT_MS)
        && !USER_REASONS.has(m.blockedReason) && !this.inFlight.has(m.id),
    );
    const groups = new Map<string, SessionMessage[]>();
    for (const m of stuck) {
      const key = `${this.headOf(m.toSession)}\n${m.fromSession}`;
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    for (const fresh of groups.values()) {
      const to = this.headOf(fresh[0].toSession);
      const from = fresh[0].fromSession!;
      // 同一对已经有一条回执排着（之前卡住的几条）：合进同一条，不能用新的这几条把它说的那几条顶掉（审查建议 2）。
      const earlier = this.d.repo.queuedByRef(stuckRef(to, from));
      const freshIds = new Set(fresh.map((m) => m.id));
      const carried = earlier
        ? receiptIds(earlier).filter((id) => !freshIds.has(id)).map((id) => this.d.repo.get(id)).filter((m): m is SessionMessage => m?.status === "queued")
        : [];
      const list = [...carried, ...fresh];
      // 回执只说这一组里最近的原因（它们排给同一个 session，挡住的原因一样）。
      const reason = list.reduce((a, b) => ((b.blockedSince ?? 0) > (a.blockedSince ?? 0) ? b : a)).blockedReason!;
      const minutes = Math.max(1, Math.round((now - Math.min(...list.map((m) => m.queuedAt))) / 60_000));
      try {
        this.send({
          kind: "reply", from: null, to: from, featureId: list[0].featureId, ref: stuckRef(to, from), meta: { ids: list.map((m) => m.id) },
          body: M().mailboxStuckReceipt(this.d.nameOf(to), list.map((m) => m.id), minutes, M().mailboxBlocked[reason], M().mailboxEta[reason]),
        });
        this.d.repo.setStuckReceipt(fresh.map((m) => m.id), now);
        this.d.log(`mailbox: ${list.length} message(s) from ${from} to ${to} stuck ${minutes} min (${reason}); told the sender`);
      } catch (e) {
        this.d.log(`mailbox: stuck receipt to ${from} failed`, e);
      }
    }
  }

  /**
   * 还排着、说到了这几条的「还没送到」回执。按回执 meta 里存的原消息 id 找，不按现在的 head 拼 ref：
   * 目标在回执排队期间换新了（head 变了），照样找得到。
   */
  private queuedStuckReceipts(ids: Set<string>): SessionMessage[] {
    return this.d.repo.queued().filter((m) => m.ref?.startsWith("stuck:") === true && receiptIds(m).some((id) => ids.has(id)));
  }

  /** 这一条不排了（送到了、撤回了）：说到它的回执里的消息都不排了，回执就过时了，撤回（仓库规则 8）。 */
  private settleStuckReceipts(id: string): void {
    for (const receipt of this.queuedStuckReceipts(new Set([id]))) {
      if (receiptIds(receipt).some((x) => this.d.repo.get(x)?.status === "queued")) continue;
      this.withdraw(receipt.ref!);
    }
  }

  /** 给 send_message、list_sessions 用的一句话：送到了，或者为什么还没送到、什么时候能送到。 */
  static note(r: { delivery: "delivered" } | { delivery: "queued"; reason: MailboxBlockReason | "delivering" | null; since: number | null; kind?: string }, now: number): string {
    const m = M();
    if (r.delivery === "delivered") return m.mailboxDelivered;
    if (r.reason === "delivering") return m.mailboxDelivering;
    if (r.reason === null) return m.mailboxQueuedUnknown;
    const minutes = r.since === null ? 0 : Math.floor((now - r.since) / 60_000);
    return m.mailboxQueued(m.mailboxBlocked[r.reason], etaOf(r.reason, r.kind), minutes);
  }

  // ---- 诊断 ----

  /**
   * 诊断导出用（BTL-279）：排着的每一条为什么还没送进去、从什么时候起、试了几次、最后一次的时间和结果，收件人现在跑在哪个终端；
   * 最近的几条怎么送进去的、回复了没有；正在往里贴的终端。不带正文（导出的文件用户会发给别人）。
   */
  diagnostics(limit = RECENT_MESSAGES): { queued: MailboxDiagRow[]; recent: MailboxDiagRow[]; inputting: string[] } {
    const row = (m: SessionMessage): MailboxDiagRow => {
      const head = this.headOf(m.toSession);
      return {
        id: m.id, kind: m.kind, ref: m.ref?.split(":")[0] ?? null, from: m.fromSession, to: m.toSession, head, term: m.status === "queued" ? this.d.termOf(head) : null,
        status: m.status, via: m.via, queuedAt: new Date(m.queuedAt).toISOString(), deliveredAt: iso(m.deliveredAt), repliedAt: iso(m.repliedAt),
        blockedReason: m.blockedReason, blockedSince: iso(m.blockedSince), attempts: m.attempts, lastAttemptAt: iso(m.lastAttemptAt), lastAttempt: m.lastAttempt,
        stuckReceiptAt: iso(m.stuckReceiptAt), inFlight: this.inFlight.has(m.id) || this.interrupting.has(m.id),
      };
    };
    const queued = this.d.repo.queued();
    const recent = this.d.repo.recentAll(limit).filter((m) => m.status !== "queued");
    return { queued: queued.map(row), recent: recent.map(row), inputting: [...this.inputting] };
  }

  // ---- 界面 ----

  /** 一个 session（任何一个 id）发出或收到的最近几条；scope 见 MessageScope，shipherd 时给 Shipherd 总控的 session id 们。 */
  views(scope: MessageScope, shipherdSessions: string[], limit = RECENT_MESSAGES): MessageView[] {
    const rows = "featureId" in scope ? this.d.repo.recent({ featureId: scope.featureId }, limit) : this.d.repo.recent({ sessions: shipherdSessions }, limit);
    return rows.map((x) => ({
      id: x.id, kind: x.kind, from: this.d.nameOf(x.fromSession), to: this.d.nameOf(x.toSession), toSession: x.toSession, status: x.status, via: x.via,
      interrupt: x.interrupt, text: x.body, queuedAt: new Date(x.queuedAt).toISOString(), deliveredAt: iso(x.deliveredAt), reply: x.replyText, repliedAt: iso(x.repliedAt),
      blocked: x.status === "queued" && x.blockedReason !== null ? { reason: x.blockedReason, since: iso(x.blockedSince) } : null,
      attempts: x.attempts, lastAttemptAt: iso(x.lastAttemptAt), lastAttempt: x.lastAttempt,
    }));
  }
}
