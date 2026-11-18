// Butler 总控 send_message 的回复回流（设计文档 2026-11-17 ws-b 第 2 节）：目标停下来时把它最后一条回复送回发消息的总控。
import { randomUUID } from "node:crypto";
import { MESSAGE_LIMIT, sanitizeTask, TASK_LIMIT } from "../../shared/control";
import type { Session } from "../../shared/types";
import type { ButlerMessage, ButlerMessagesRepo } from "../db/butler-messages-repo";
import type { DeliveryGuard } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import { M } from "../strings";

/** 送到之后这么久没回复就不再等。 */
export const MESSAGE_WAIT_MS = 24 * 3600_000;
/** 回复这么久没能送回总控（总控一直关着、一直在忙）就不送了，和递汇报一样。 */
export const REPLY_DELIVERY_MAX_AGE_MS = 6 * 3600_000;
/** list_inbox 里带最近几条。 */
export const RECENT_MESSAGES = 30;

export interface ButlerMessagesDeps {
  repo: ButlerMessagesRepo;
  head(sessionId: string): Session | null;
  /** 目标最后一条回复（ActivityMonitor.lastReplyOf）：at 是那条记录的时间，没有时间戳为 null。 */
  lastReply(sessionId: string): { id: string; text: string; at: number | null } | null;
  /** 跑着这个 session（链上任何一个 id）的终端；没有为 null。 */
  termOf(sessionId: string): string | null;
  /** 和递汇报同一道 guard：总控在忙、用户在打字、有草稿时不贴。 */
  guard: Pick<DeliveryGuard, "check" | "recheckAfter">;
  deliver(termId: string, text: string, recheck: () => boolean): Promise<DeliverResult>;
  /**
   * 给 workstream M 留的钩子：送消息之前、送回回复之前各调一次，确保这个 session 在跑（M 在这里唤醒休眠的 session）。
   * 不给时只看终端开没开。返回 false：现在送不了（send_message 走打开终端的流程，回复留到下一次）。
   */
  ensureRunning?(sessionId: string): Promise<boolean>;
  /** 给总控看的目标名字："feature 登录改版的总控"之类。 */
  targetName(m: Pick<ButlerMessage, "featureId" | "epicId">): string;
  notify(): void;
  now(): number;
  newId?: () => string;
  log(msg: string, err?: unknown): void;
}

/** list_inbox 里的一条。 */
export interface ButlerMessageView {
  requestId: string;
  target: string;
  targetSession: string | null;
  status: ButlerMessage["status"];
  error: string | null;
  text: string;
  queuedAt: string;
  reply: string | null;
  repliedAt: string | null;
  deliveredAt: string | null;
}

const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());

export class ButlerMessages {
  /** 正在往这个总控送回复：同一个总控不同时送两段。 */
  private readonly busy = new Set<string>();

  constructor(private readonly d: ButlerMessagesDeps) {}

  /** 默认的 ensureRunning：终端开着就算在跑。 */
  ensureRunning(sessionId: string): Promise<boolean> {
    if (this.d.ensureRunning) return this.d.ensureRunning(sessionId);
    return Promise.resolve(this.d.termOf(sessionId) !== null);
  }

  /**
   * send_message 交消息之前记一行（sending）。target：已知的目标 session（终端开着，或者要接着的那个），
   * 它当前的最后一条回复记成 base_reply_id。返回 requestId。
   */
  begin(m: { from: string; target: string | null; featureId: number | null; epicId: number | null; text: string }): string {
    const id = this.d.newId?.() ?? randomUUID();
    const head = m.target === null ? null : (this.d.head(m.target)?.id ?? m.target);
    this.d.repo.insert({
      id, fromSession: this.d.head(m.from)?.id ?? m.from, targetSession: head, featureId: m.featureId, epicId: m.epicId,
      text: m.text.slice(0, MESSAGE_LIMIT), baseReplyId: head === null ? null : (this.d.lastReply(head)?.id ?? null), queuedAt: this.d.now(),
    });
    return id;
  }

  /** 没送进去（guard 不让、打开终端失败、deliver 出错）。 */
  failed(id: string, error: string): void {
    this.d.repo.failed(id, error);
    this.d.notify();
  }

  /** deliver / submit 的结果回来了。sent：开始等回复；否则记失败。 */
  settled(id: string, targetSession: string, result: DeliverResult | "error"): void {
    const head = this.d.head(targetSession)?.id ?? targetSession;
    if (result === "sent") this.d.repo.sent(id, head);
    else this.d.repo.failed(id, result);
    this.d.notify();
  }

  /**
   * 一个 session 停下来了（sessionStopped，活动已经重读过）：它是哪些消息的目标，最后一条回复是新的（id 和送之前不同、
   * 时间不早于交消息的时间），就记成回复。之后送回总控。
   */
  async targetStopped(sessionId: string): Promise<void> {
    const head = this.d.head(sessionId)?.id ?? sessionId;
    const waiting = this.d.repo.withStatus("waiting").filter((m) => m.targetSession !== null && (this.d.head(m.targetSession)?.id ?? m.targetSession) === head);
    if (waiting.length === 0) return;
    const reply = this.d.lastReply(head);
    if (!reply) return;
    let changed = false;
    for (const m of waiting) {
      // resume 之后第一次 Stop 看到的可能是上一次对话的最后一条回复：要比交消息晚才算。
      if (reply.id === m.baseReplyId || (reply.at !== null && reply.at < m.queuedAt)) continue;
      this.d.repo.replied(m.id, { id: reply.id, text: reply.text.slice(-MESSAGE_LIMIT), at: reply.at ?? this.d.now() });
      changed = true;
    }
    if (!changed) return;
    this.d.notify();
    await this.flush();
  }

  /** 过期的不再等；拿到的回复按发消息的总控合成一条送回去。和递汇报一样每个 tick、总控停下来时调。永不 reject。 */
  async flush(): Promise<void> {
    try {
      if (this.d.repo.expire(this.d.now(), MESSAGE_WAIT_MS, REPLY_DELIVERY_MAX_AGE_MS) > 0) this.d.notify();
      const byFrom = new Map<string, ButlerMessage[]>();
      for (const m of this.d.repo.withStatus("replied")) {
        const from = this.d.head(m.fromSession)?.id ?? m.fromSession;
        byFrom.set(from, [...(byFrom.get(from) ?? []), m]);
      }
      for (const [from, list] of byFrom) await this.deliverReplies(from, list);
    } catch (e) {
      this.d.log("butler messages: flush failed", e);
    }
  }

  private async deliverReplies(from: string, list: ButlerMessage[]): Promise<void> {
    if (this.busy.has(from)) return;
    this.busy.add(from);
    try {
      if (!(await this.ensureRunning(from))) return;
      const gate = this.d.guard.check(from);
      if (!gate.ok) return;
      const m = M();
      // 同一个目标的几条消息拿的是同一条回复：回复只贴一次，前面列出是哪几条消息。
      const byReply = new Map<string, ButlerMessage[]>();
      for (const x of list) byReply.set(`${x.targetSession}\u0000${x.replyId}`, [...(byReply.get(`${x.targetSession}\u0000${x.replyId}`) ?? []), x]);
      const parts: string[] = [];
      const sent: string[] = [];
      let size = 0;
      for (const group of byReply.values()) {
        const part = m.butlerReplyLine(this.d.targetName(group[0]), group.map((x) => x.id), group[0].replyText ?? "");
        // 第一段总要送；后面的放不下就留到下一次。
        if (sent.length > 0 && size + part.length > TASK_LIMIT - 1000) break;
        parts.push(part);
        sent.push(...group.map((x) => x.id));
        size += part.length;
      }
      const result = await this.d.deliver(gate.termId, sanitizeTask(parts.join("\n\n")), this.d.guard.recheckAfter(from, gate));
      if (result === "sent") {
        this.d.repo.delivered(sent, this.d.now());
        this.d.notify();
      } else this.d.log(`butler messages: replies for ${from}: ${result}`);
    } catch (e) {
      this.d.log(`butler messages: replies for ${from} failed`, e);
    } finally {
      this.busy.delete(from);
    }
  }

  /** list_inbox 和 Butler 页"回复"tab 用：最近的几条，新的在前。 */
  recent(limit = RECENT_MESSAGES): ButlerMessageView[] {
    return this.d.repo.recent(limit).map((x) => ({
      requestId: x.id, target: this.d.targetName(x), targetSession: x.targetSession, status: x.status, error: x.error, text: x.text,
      queuedAt: new Date(x.queuedAt).toISOString(), reply: x.replyText, repliedAt: iso(x.repliedAt), deliveredAt: iso(x.deliveredAt),
    }));
  }
}
