// 测试用的假信箱：canDeliver() 为真时排进去随后就送到（调 deliver、调送达回调），否则留着排队，deliverQueued 再送。
import type { SessionMessage } from "../db/session-messages-repo";
import type { Mailbox, SendInput } from "./mailbox";

export interface FakeMailbox extends Pick<Mailbox, "send" | "on" | "queuedByRef" | "withdraw" | "queuedRefs"> {
  deliverQueued(): void;
  queued: Map<string, SessionMessage>;
}

export function fakeMailbox(o: { canDeliver: () => boolean; deliver: (to: string, body: string) => void; now?: () => number }): FakeMailbox {
  const handlers = new Map<string, (m: SessionMessage) => void>();
  const queued = new Map<string, SessionMessage>();
  let n = 0;
  const deliverQueued = () => {
    if (!o.canDeliver()) return;
    for (const [key, m] of [...queued]) {
      queued.delete(key);
      o.deliver(m.toSession, m.body);
      if (m.ref) handlers.get(m.ref.split(":")[0])?.({ ...m, status: "delivered", deliveredAt: o.now?.() ?? 1000, via: "input" });
    }
  };
  return {
    queued,
    deliverQueued,
    on: (prefix, fn) => void handlers.set(prefix, fn),
    queuedByRef: (ref) => queued.get(ref) ?? null,
    withdraw: (ref) => void queued.delete(ref),
    queuedRefs: (prefix) => [...queued.keys()].filter((k) => k.startsWith(`${prefix}:`)),
    send: (x: SendInput) => {
      const key = x.ref ?? `m${++n}`;
      const id = queued.get(key)?.id ?? key;
      queued.set(key, {
        id, kind: x.kind, fromSession: x.from, toSession: x.to, featureId: x.featureId, body: x.body, interrupt: x.interrupt === true, ref: x.ref ?? null,
        meta: x.meta ?? null, status: "queued", via: null, expectsReply: false, baseReplyId: null, replyText: null, queuedAt: o.now?.() ?? 1000, deliveredAt: null, repliedAt: null,
        blockedReason: null, blockedSince: null, stuckReceiptAt: null, attempts: 0, lastAttemptAt: null, lastAttempt: null,
      });
      // 和真信箱一样：send 当场只是排队，送到在之后（直接输入是异步的）。
      queueMicrotask(deliverQueued);
      return { id, state: "idle" };
    },
  };
}
