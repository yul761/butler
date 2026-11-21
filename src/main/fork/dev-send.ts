import type { DevSendResult } from "../../shared/fork";
import type { Session } from "../../shared/types";
import type { Mailbox } from "../mailbox/mailbox";

export interface DevSendDeps {
  sessions: { rootOf(id: string): string | null; head(id: string): Session | null };
  mailbox: Pick<Mailbox, "send">;
  sanitize: (text: string) => string;
  now: () => number;
  log: (msg: string, err?: unknown) => void;
}

/**
 * 对话 tab 里用户发给开发 session 的话、分叉的结论：排进它的信箱（kind user，BTL-248）。
 * 不再等它停下：在忙的下一次调用工具时读到，停着的马上原样输入，关着的下次打开时读到。永不 reject。
 */
export class DevSender {
  constructor(private readonly d: DevSendDeps) {}

  /** 发给 anyId 所在链现在的 head。 */
  async send(anyId: string, text: string): Promise<DevSendResult> {
    const root = this.d.sessions.rootOf(anyId);
    const head = root === null ? null : this.d.sessions.head(root);
    if (!head) return { ok: false, reason: "not_found" };
    try {
      const { state } = this.d.mailbox.send({ kind: "user", from: null, to: head.id, featureId: head.featureId ?? null, body: this.d.sanitize(text) });
      return { ok: true, at: this.d.now(), state };
    } catch (e) {
      this.d.log(`fork: queueing for the dev session ${head.id} failed`, e);
      return { ok: false, reason: "failed" };
    }
  }
}
