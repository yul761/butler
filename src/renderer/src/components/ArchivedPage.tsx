import { useCallback, useEffect, useState } from "react";
import type { Ticket } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { repoWhere } from "../repos";
import { S } from "../strings";

/** 已归档的 ticket：恢复后回到侧栏，并打开它。 */
export function ArchivedPage({ onRestored }: { onRestored: (key: string) => void }) {
  const [items, setItems] = useState<Ticket[] | null>(null);
  const load = useCallback(async () => {
    try {
      setItems(await api.archivedTickets());
    } catch (e) {
      reportError(e);
    }
  }, []);

  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

  async function restore(key: string) {
    try {
      await api.unarchive(key);
      onRestored(key);
    } catch (e) {
      reportError(e);
    }
  }

  if (!items) return <p className="empty">{S.loading}</p>;

  return (
    <div className="page">
      <h2>{S.archived}</h2>
      <p className="muted">{S.archivedHint}</p>
      {items.length === 0 ? (
        <p className="empty">{S.noArchived}</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>{S.colTicket}</th><th>{S.colWhere}</th><th>{S.colArchivedAt}</th><th /></tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.key}>
                <td><div>{t.key}</div><div className="muted">{t.title ?? ""}</div></td>
                <td>{t.repos.map((r) => <div key={r.id}>{repoWhere(r)}</div>)}</td>
                <td className="muted">{t.archivedAt ? new Date(t.archivedAt).toLocaleString() : ""}</td>
                <td className="actions"><button onClick={() => void restore(t.key)}>{S.unarchive}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
