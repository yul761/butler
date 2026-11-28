// 信箱（BTL-245）的消息列表：Shipherd 总控页、feature 页「总控」tab 对话下面默认折起的「消息（N）」。
// 谁发给谁、种类、状态（已排队 / 已送达 / 已回复）、怎么送到的、正文和回复。新的在前。
// 还在排队的写出挡住它的原因（BTL-269），并给一个「现在送进去」按钮。
import { useState } from "react";
import type { DeliverNowResult, MessageView, MessageScope } from "../../../shared/types";
import { api } from "../api";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

const MESSAGE_SCOPES = ["data", "messages"] as const;

const shortTime = (iso: string) => new Date(iso).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function MessageListItems({ messages }: { messages: MessageView[] }) {
  if (messages.length === 0) return <p className="muted">{S.messagesNone}</p>;
  return (
    <ul className="message-list" data-testid="message-list">
      {messages.map((m) => (
        <li key={m.id} className={`message status-${m.status}`} data-status={m.status}>
          <div className="message-head">
            <strong>{m.from} → {m.to}</strong>
            <span className="muted">{S.messageKind[m.kind]}</span>
            {m.interrupt && <span className="muted">· {S.messageInterrupt}</span>}
            <span className={`badge status-${m.status}`}>{S.messageStatus[m.status]}</span>
            <span className="muted">
              {S.messageQueued} {shortTime(m.queuedAt)}
              {m.deliveredAt && ` · ${S.messageStatus.delivered} ${shortTime(m.deliveredAt)}`}
              {m.via && ` (${S.messageVia[m.via]})`}
            </span>
          </div>
          {m.status === "queued" && <QueuedLine m={m} />}
          {m.attempts > 0 && <p className="muted message-attempts" data-testid="message-attempts">{attemptsText(m)}</p>}
          <p className="message-text">{m.text}</p>
          {m.reply !== null && (
            <div className="message-reply">
              <span className="muted">{S.messageReply}{m.repliedAt ? ` · ${shortTime(m.repliedAt)}` : ""}</span>
              <p>{m.reply}</p>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 排队中：挡住它的原因和开始时间（没试过送的不写原因），加「现在送进去」。 */
function QueuedLine({ m }: { m: MessageView }) {
  const [state, setState] = useState<"idle" | "sending" | string>("idle");
  const L = S.mailboxBlocked;
  const deliver = (): void => {
    setState("sending");
    api.deliverNow(m.id).then((r) => setState(resultText(r)), () => setState(L.failed));
  };
  return (
    <div className="message-blocked" data-testid="message-blocked">
      {m.blocked && <span className="muted">{L.line(L.reason[m.blocked.reason], m.blocked.since ? shortTime(m.blocked.since) : null)}</span>}
      <button type="button" className="link" title={L.title} disabled={state === "sending"} onClick={deliver} data-testid="message-deliver-now">
        {state === "sending" ? L.sending : L.button}
      </button>
      {state !== "idle" && state !== "sending" && <span className="muted" role="status">{state}</span>}
    </div>
  );
}

/** 没送进去的尝试（BTL-279）：几次、最后一次的时间和结果。送到了也留着：看得出试了多久才进去。 */
function attemptsText(m: MessageView): string {
  const L = S.mailboxBlocked;
  const what = m.lastAttempt === null ? null : m.lastAttempt === "recheck" || m.lastAttempt === "exited" ? L.attempt[m.lastAttempt] : L.reason[m.lastAttempt];
  return L.attempts(m.attempts, m.lastAttemptAt ? shortTime(m.lastAttemptAt) : null, what);
}

function resultText(r: DeliverNowResult): string {
  const L = S.mailboxBlocked;
  if (r.delivered) return L.delivered;
  if (r.reason === "delivering") return L.delivering;
  if (r.reason === "gone") return L.gone;
  return r.reason === null ? L.failed : L.notNow(L.reason[r.reason]);
}

/** 默认折起的「消息（N）」；还没取到时整块不显示。 */
export function MessageListSummary({ messages }: { messages: MessageView[] | null }) {
  if (messages === null) return null;
  return (
    <details className="messages-box">
      <summary>{S.lay.messages(messages.length)}</summary>
      <MessageListItems messages={messages} />
    </details>
  );
}

export function Messages({ scope }: { scope: MessageScope }) {
  const key = "shipherd" in scope ? "messages:shipherd" : `messages:feature:${scope.featureId}`;
  // 重试次数、最后一次尝试只通知 messages（BTL-279）：别的变化照常走 data。
  const messages = useStateRefetch(key, () => api.messages(scope), { scopes: MESSAGE_SCOPES });
  return <MessageListSummary messages={messages} />;
}
