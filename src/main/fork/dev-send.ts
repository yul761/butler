import type { DevSendResult } from "../../shared/fork";
import type { Session } from "../../shared/types";
import type { DeliveryGuard } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";

/** 等输入框就绪的上限（跟 inbox 的回答投递一样）。 */
const DELIVER_TIMEOUT_MS = 60_000;

export interface DevSendDeps {
  sessions: { rootOf(id: string): string | null; head(id: string): Session | null };
  /** 用户自己的话：refreshing 挡，needsYou 不挡——就是 index.ts 里给 inbox 用的那个 answerGuard。 */
  guard: Pick<DeliveryGuard, "check" | "recheckAfter">;
  deliver: (termId: string, text: string, o: { singleLine: boolean; timeoutMs: number; recheck: () => boolean }) => Promise<DeliverResult>;
  sanitize: (text: string) => string;
  platform: NodeJS.Platform;
  now: () => number;
  log: (msg: string, err?: unknown) => void;
}

/** 把分叉的结论发进开发 session 的终端：过投递守卫、等输入框就绪、贴进去。永不 reject。 */
export class DevSender {
  /** 正在往里递的 head id。 */
  private readonly inFlight = new Set<string>();

  constructor(private readonly d: DevSendDeps) {}

  /** 发给 anyId 所在链现在的 head。同一个 head 有一条在途就返回 in_flight。 */
  async send(anyId: string, text: string): Promise<DevSendResult> {
    const root = this.d.sessions.rootOf(anyId);
    const head = root === null ? null : this.d.sessions.head(root);
    if (!head) return { ok: false, reason: "closed" };
    if (this.inFlight.has(head.id)) return { ok: false, reason: "in_flight" };
    // 同步记上：guard 和 deliver 之间有 await，连点的第二下不能溜进来。
    this.inFlight.add(head.id);
    try {
      const g = this.d.guard.check(head.id);
      if (!g.ok) return { ok: false, reason: g.block };
      const result = await this.d.deliver(g.termId, this.d.sanitize(text), {
        singleLine: this.d.platform === "win32",
        timeoutMs: DELIVER_TIMEOUT_MS,
        recheck: this.d.guard.recheckAfter(head.id, g),
      });
      return result === "sent" ? { ok: true, at: this.d.now() } : { ok: false, reason: result };
    } catch (e) {
      // 输入框的话（conv:send）和分叉的结论都走这里。
      this.d.log(`fork: sending to the dev session ${head.id} failed`, e);
      return { ok: false, reason: "blocked" };
    } finally {
      this.inFlight.delete(head.id);
    }
  }
}
