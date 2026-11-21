// 信箱（BTL-245，设计 docs/superpowers/specs/2026-11-20-btl-245-mailbox-design.md）：session 之间的消息一律排队、存进库里。
// 在忙的 session 下一次工具调用时由 PostToolUse hook 带进去（磁盘投影 <mailbox>/<终端>/），停着的直接输入，
// 总控可以先按 Esc 叫停再送。状态只有 queued / delivered / replied。
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGE_LIMIT, sanitizeTask, TASK_LIMIT } from "../../shared/control";
import {
  DONE_SUFFIX, MAIN_SUFFIX, MSG_SUFFIX, messageFileName, messageIdOf, TAKEN_SUFFIX, type MailboxFile,
} from "../../shared/mailbox";
import type { MessageKind, MessageScope, MessageView, Session } from "../../shared/types";
import type { NewSessionMessage, SessionMessage, SessionMessagesRepo } from "../db/session-messages-repo";
import type { DeliveryCheck } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import { M } from "../strings";

/** 送到之后这么久没回复就不再等。 */
export const REPLY_WAIT_MS = 24 * 3600_000;
/** 消息留这么久，之后删掉（还在排队的也删：目标一个月都没再打开）。 */
export const MESSAGE_KEEP_MS = 30 * 24 * 3600_000;
/** hook 认领了这么久还没写出去（崩了）：放回去，下一次工具调用再送。 */
export const TAKEN_STALE_MS = 60_000;
/** 主进程认领了这么久（直接输入的结果一直没回来，Butler 上次崩在这里）：放回去。deliver 最多等 1 分钟。 */
export const MAIN_STALE_MS = 5 * 60_000;
/** 排队超过这么久才送到的，正文前注明是多久之前发的。 */
export const AGE_NOTE_MS = 10 * 60_000;
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
  rename(from: string, to: string): void;
  unlink(file: string): void;
  rmdir(dir: string): void;
  mtime(file: string): number;
}

export const realMailboxFs: MailboxFs = {
  mkdir: (d) => mkdirSync(d, { recursive: true }),
  readdir: (d) => readdirSync(d),
  write: (f, t) => writeFileSync(f, t, { mode: 0o600 }),
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
  /** 直接输入前的 guard。answer：这一批里有 ask_user 的回答，不看「需要你」（它就是在等这个回答）。 */
  check(sessionId: string, o: { answer: boolean }): DeliveryCheck;
  recheckAfter(sessionId: string, passed: { termId: string }, o: { answer: boolean }): () => boolean;
  deliver(termId: string, text: string, recheck: () => boolean): Promise<DeliverResult>;
  /** 叫停：现在能不能按 Esc（在忙、屏幕上没有要用户回答的对话框、用户没在打字、没有草稿）。 */
  canInterrupt(termId: string): boolean;
  interrupt(termId: string): void;
  /** 叫停之后的复查：粘贴前用户没往这个终端里输入过。 */
  interruptRecheck(termId: string): () => boolean;
  /** 目标最后一条回复（ActivityMonitor.lastReplyOf）。 */
  lastReply(sessionId: string): { id: string; text: string; at: number | null } | null;
  /** 给人看的 session 名字（列表、回复的开头）："ABC-1"、"feature 登录改版的总控"、"Butler 总控"。null 是 Butler 自己。 */
  nameOf(sessionId: string | null): string;
  /**
   * Butler 往这个 session（head）里直接输入：start 在 deliver 之前，之后是 sent / failed。这一段引起的那次 UserPromptSubmit
   * 不算用户在终端里答了提问（InboxService.butlerTyping）。
   */
  typing?(headId: string, phase: "start" | "sent" | "failed"): void;
  notify(): void;
  now(): number;
  newId?: () => string;
  log(msg: string, err?: unknown): void;
}

export interface SendInput {
  kind: MessageKind;
  /** 发送方 session；Butler 自己发的为 null。 */
  from: string | null;
  to: string;
  featureId: number | null;
  /** 已经渲染好的正文（各来源原来那段文字）。 */
  body: string;
  interrupt?: boolean;
  ref?: string;
  meta?: unknown;
}

/** 发出那一刻目标的状态：在忙（下一次工具调用时送）、停着（马上送）、关着（下次打开时送）。 */
export type TargetState = "busy" | "idle" | "closed";

const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());
const EXPECTS_REPLY: ReadonlySet<MessageKind> = new Set(["instruction", "butler"]);

export class Mailbox {
  private readonly fs: MailboxFs;
  /** 正在直接输入的终端：同一个终端不同时送两段。 */
  private readonly inputting = new Set<string>();
  /** 正在叫停送进去的消息：不往磁盘上投影（不让 hook 抢走）。 */
  private readonly interrupting = new Set<string>();
  /** 送达回调，按 ref 的前缀（`report:12` 的 `report`）。 */
  private readonly handlers = new Map<string, (m: SessionMessage) => void>();
  /** 每个 session（head）最后一次停下来的时间：送达记账晚于它停下来时补查回复。 */
  private readonly stoppedAt = new Map<string, number>();
  /** 排队时间严格递增：同一毫秒排的几条也按排的顺序送（磁盘上的文件名按它排序）。 */
  private lastQueuedAt = 0;

  constructor(private readonly d: MailboxDeps) {
    this.fs = d.fs ?? realMailboxFs;
  }

  /** 送达时调：按 ref 的前缀分发（汇报标成 answered、预审写 deliveredAt 之类）。 */
  on(prefix: string, fn: (m: SessionMessage) => void): void {
    this.handlers.set(prefix, fn);
  }

  private headOf(id: string): string {
    return this.d.head(id)?.id ?? id;
  }

  /** 排一条，马上试着送。永不抛（排队本身失败除外：那是库坏了）。 */
  send(input: SendInput): { id: string; state: TargetState } {
    const to = this.headOf(input.to);
    const msg: NewSessionMessage = {
      id: this.d.newId?.() ?? randomUUID(), kind: input.kind, fromSession: input.from === null ? null : this.headOf(input.from), toSession: to,
      featureId: input.featureId, body: input.body.slice(0, MAILBOX_BODY_LIMIT), queuedAt: (this.lastQueuedAt = Math.max(this.d.now(), this.lastQueuedAt + 1)),
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
    if (input.interrupt && term !== null && state === "busy" && this.d.canInterrupt(term)) {
      this.interrupting.add(id);
      void this.interruptAndSend(to, term, id);
    } else {
      if (term !== null) this.syncTerm(term);
      void this.flush(to);
    }
    this.d.notify();
    return { id, state };
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
  private queuedFor(headId: string): SessionMessage[] {
    return this.d.repo.queued().filter((m) => this.headOf(m.toSession) === headId);
  }

  private render(m: SessionMessage): string {
    const age = this.d.now() - m.queuedAt;
    return age > AGE_NOTE_MS ? `${M().mailboxAge(Math.round(age / 60_000))}\n${m.body}` : m.body;
  }

  /** 让这个终端的投影和库对上：缺的写上、不该有的 .json 删掉；一条都没有就把目录删掉（hook 的判断就是看目录在不在）。 */
  syncTerm(termId: string): void {
    try {
      const head = this.d.head(termId);
      const dir = this.dirOf(termId);
      const want = head ? this.queuedFor(head.id).filter((m) => !this.interrupting.has(m.id)) : [];
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
          const file: MailboxFile = { id: m.id, text: this.render(m), intro: M().mailboxIntro };
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
        if (m && m.status === "queued") changed = this.markDelivered(m, "hook", this.fileTime(file, now)) || changed;
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
    if (!this.d.repo.delivered(m.id, { at, via, toSession: target, baseReplyId: m.expectsReply ? (this.d.lastReply(target)?.id ?? null) : null })) return false;
    const prefix = m.ref?.split(":")[0];
    const fn = prefix ? this.handlers.get(prefix) : undefined;
    if (fn) {
      try {
        fn({ ...m, status: "delivered", deliveredAt: at, via });
      } catch (e) {
        this.d.log(`mailbox: delivered handler for ${m.ref} failed`, e);
      }
    }
    // 送达的记账晚于对方停下来（假 claude、很短的一轮）：马上补查一次回复。
    if (m.expectsReply && (this.stoppedAt.get(target) ?? -Infinity) >= at) {
      void this.checkReplies(target).catch((e: unknown) => this.d.log(`mailbox: late reply check for ${target} failed`, e));
    }
    return true;
  }

  /** 合成一段直接输入的正文；第一条总要送，放不下的留到下一次。 */
  private batch(list: SessionMessage[]): { text: string; ids: SessionMessage[] } {
    const parts: string[] = [];
    const ids: SessionMessage[] = [];
    let size = 0;
    for (const m of list) {
      const part = this.render(m);
      if (ids.length > 0 && size + part.length > INPUT_LIMIT) break;
      parts.push(part);
      ids.push(m);
      size += part.length + 8;
    }
    return { text: sanitizeTask([M().mailboxIntro.replace("{n}", String(ids.length)), ...parts].join("\n\n---\n\n")), ids };
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
    if (term === null || this.inputting.has(term)) return;
    const queued = this.queuedFor(head).filter((m) => !this.interrupting.has(m.id));
    if (queued.length === 0) return;
    const answer = queued.some((m) => m.kind === "answer");
    const gate = this.d.check(head, { answer });
    if (!gate.ok) return;
    await this.input(head, gate.termId, queued, this.d.recheckAfter(head, gate, { answer }));
  }

  private async input(head: string, term: string, queued: SessionMessage[], recheck: () => boolean, forced?: string): Promise<boolean> {
    this.inputting.add(term);
    const sent = new Set<string>();
    let files = new Map<string, string>();
    try {
      this.sweep(term);
      const fresh = queued.filter((m) => this.d.repo.get(m.id)?.status === "queued");
      const claimed = this.claim(term, fresh);
      files = claimed.files;
      if (claimed.mine.length === 0) return false;
      // 叫停的那一条排在最前，一定在这一批里。
      const list = forced ? [...claimed.mine.filter((m) => m.id === forced), ...claimed.mine.filter((m) => m.id !== forced)] : claimed.mine;
      const { text, ids } = this.batch(list);
      const at = this.d.now();
      this.d.typing?.(head, "start");
      const result = await this.d.deliver(term, text, recheck).catch((e: unknown) => {
        // 抛了也要收尾，不然那个 session 下一次 UserPromptSubmit 一直被当成 Butler 的。
        this.d.typing?.(head, "failed");
        throw e;
      });
      this.d.typing?.(head, result === "sent" ? "sent" : "failed");
      if (result !== "sent") {
        this.d.log(`mailbox: input to ${head}: ${result}`);
        return false;
      }
      for (const m of ids) if (this.markDelivered(m, "input", at)) sent.add(m.id);
      this.d.notify();
      return true;
    } catch (e) {
      this.d.log(`mailbox: input to ${head} failed`, e);
      return false;
    } finally {
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
      if (reply.id === x.baseReplyId || (reply.at !== null && reply.at < x.queuedAt)) continue;
      const text = reply.text.slice(-MESSAGE_LIMIT);
      if (!this.d.repo.replied(x.id, { text, at: reply.at ?? this.d.now() })) continue;
      changed = true;
      if (x.fromSession !== null) {
        this.send({ kind: "reply", from: head, to: x.fromSession, featureId: x.featureId, body: m.butlerReplyLine(this.d.nameOf(head), [x.id], text) });
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
      if (this.d.repo.prune(this.d.now() - MESSAGE_KEEP_MS) > 0) this.d.notify();
      const heads = new Set(this.d.repo.queued().map((m) => this.headOf(m.toSession)));
      for (const h of heads) await this.flush(h);
    } catch (e) {
      this.d.log("mailbox: tick failed", e);
    }
  }

  // ---- 界面 ----

  /** 一个 session（任何一个 id）发出或收到的最近几条；scope 见 MessageScope，butler 时给 Butler 总控的 session id 们。 */
  views(scope: MessageScope, butlerSessions: string[], limit = RECENT_MESSAGES): MessageView[] {
    const rows = "featureId" in scope ? this.d.repo.recent({ featureId: scope.featureId }, limit) : this.d.repo.recent({ sessions: butlerSessions }, limit);
    return rows.map((x) => ({
      id: x.id, kind: x.kind, from: this.d.nameOf(x.fromSession), to: this.d.nameOf(x.toSession), toSession: x.toSession, status: x.status, via: x.via,
      interrupt: x.interrupt, text: x.body, queuedAt: new Date(x.queuedAt).toISOString(), deliveredAt: iso(x.deliveredAt), reply: x.replyText, repliedAt: iso(x.repliedAt),
    }));
  }
}
