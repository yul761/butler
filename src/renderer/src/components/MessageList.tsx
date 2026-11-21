// 信箱（BTL-245）的消息列表：Butler 总控页、feature 页「总控」tab 对话下面默认折起的「消息（N）」。
// 谁发给谁、种类、状态（已排队 / 已送达 / 已回复）、怎么送到的、正文和回复。新的在前。
import type { MessageScope, MessageView } from "../../../shared/types";
import { api } from "../api";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

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
  const key = "butler" in scope ? "messages:butler" : `messages:feature:${scope.featureId}`;
  const messages = useStateRefetch(key, () => api.messages(scope));
  return <MessageListSummary messages={messages} />;
}
