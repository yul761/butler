import { useCallback, useEffect, useState } from "react";
import type { TicketView, UnclaimedSession } from "../../../shared/types";
import { api } from "../api";
import { S } from "../strings";

export function UnclaimedPage({ tickets }: { tickets: TicketView[] }) {
  const [items, setItems] = useState<UnclaimedSession[] | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const load = useCallback(async () => setItems(await api.unclaimed()), []);

  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

  if (!items) return <p className="empty">{S.loading}</p>;
  if (items.length === 0) return <p className="empty">{S.noUnclaimed}</p>;

  return (
    <div className="page">
      <h2>{S.unclaimed}</h2>
      <p className="muted">{S.unclaimedHint}</p>
      <table className="table">
        <thead>
          <tr><th>{S.colWhere}</th><th>{S.colPrompt}</th><th>{S.colActivity}</th><th /></tr>
        </thead>
        <tbody>
          {items.map((s) => {
            const selected = choice[s.id] ?? (s.suggestionExists ? s.suggestedTicket! : "");
            return (
              <tr key={s.id}>
                <td><div>{s.cwd}</div><div className="muted">{s.gitBranch ?? ""}</div></td>
                <td>{s.firstPrompt ?? ""}</td>
                <td className="muted">{s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleString() : ""}</td>
                <td className="actions">
                  <select value={selected} onChange={(e) => setChoice({ ...choice, [s.id]: e.target.value })}>
                    <option value="">{S.chooseTicket}</option>
                    {tickets.map((t) => <option key={t.key} value={t.key}>{t.key}</option>)}
                  </select>
                  <button disabled={!selected} onClick={() => void api.claim(s.id, selected)}>{S.claim}</button>
                  <button onClick={() => void api.dismiss(s.id)}>{S.dismiss}</button>
                  {s.suggestedTicket && !s.suggestionExists && <span className="muted">{S.suggestCreate(s.suggestedTicket)}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
