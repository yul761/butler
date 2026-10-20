import type { TicketView } from "../../../shared/types";
import { S, STATUS_LABEL } from "../strings";

export function HomePage({ tickets, onOpen }: { tickets: TicketView[]; onOpen: (key: string) => void }) {
  if (tickets.length === 0) return <p className="empty">{S.noTickets}</p>;
  const waiting = tickets.filter((t) => t.waiting);
  return (
    <div className="page">
      <h2>{S.waitingList}</h2>
      {waiting.length === 0 ? (
        <p className="empty">{S.nothingWaiting}</p>
      ) : (
        <ul className="card-list">
          {waiting.map((t) => (
            <li key={t.key}>
              <button className="card" onClick={() => onOpen(t.key)}>
                <span className="key">{t.key}</span>
                {t.title && <span className="title">{t.title}</span>}
                <span className="muted">{STATUS_LABEL[t.effectiveStatus]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
