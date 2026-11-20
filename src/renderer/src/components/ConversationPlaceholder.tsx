// ticket 页「对话」页签的占位（UI 重做第 3 层）。第 5 层把 TicketPage 里的它换成 ConversationTab，props 一致。
import { S } from "../strings";

export interface ConversationTabProps {
  /** 这个 ticket 的 session 链根；第 5 层按它取整条对话。 */
  rootSessionId: string | null;
  sessions: { id: string; label: string }[];
}

export function ConversationPlaceholder({ sessions }: ConversationTabProps) {
  return (
    <div className="conv-placeholder">
      <p className="muted">{S.lay.convPlaceholder}</p>
      {sessions.length > 0 && (
        <ul className="day-list">
          {sessions.map((s) => <li key={s.id}>{s.label}</li>)}
        </ul>
      )}
    </div>
  );
}
