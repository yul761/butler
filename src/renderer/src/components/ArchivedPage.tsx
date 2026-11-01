import { useCallback, useEffect, useState } from "react";
import type { Epic, Feature, Ticket } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { lastSegment, repoWhere } from "../repos";
import { S } from "../strings";

interface Props {
  onRestored: (key: string) => void;
  onFeatureRestored: (id: number) => void;
  onEpicRestored: (id: number) => void;
}

/** 已归档的 ticket、feature 和 epic：恢复后回到侧栏，并打开它。 */
export function ArchivedPage({ onRestored, onFeatureRestored, onEpicRestored }: Props) {
  const [items, setItems] = useState<Ticket[] | null>(null);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [epics, setEpics] = useState<Epic[]>([]);
  const load = useCallback(async () => {
    try {
      const [t, f, e] = await Promise.all([api.archivedTickets(), api.archivedFeatures(), api.archivedEpics()]);
      setItems(t);
      setFeatures(f);
      setEpics(e);
    } catch (e) {
      reportError(e);
    }
  }, []);

  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

  /** 恢复成功后交给 App 重读列表并打开它。 */
  async function restore(unarchive: () => Promise<void>, opened: () => void) {
    try {
      await unarchive();
      opened();
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
                <td className="actions"><button onClick={() => void restore(() => api.unarchive(t.key), () => onRestored(t.key))}>{S.unarchive}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ArchivedTable title={S.archivedFeatures} nameColumn={S.colFeature} rows={features} onRestore={(id) => void restore(() => api.unarchiveFeature(id), () => onFeatureRestored(id))} />
      <ArchivedTable title={S.archivedEpics} nameColumn={S.colEpic} rows={epics} onRestore={(id) => void restore(() => api.unarchiveEpic(id), () => onEpicRestored(id))} />
    </div>
  );
}

interface ArchivedTableProps {
  title: string;
  nameColumn: string;
  rows: Pick<Epic | Feature, "id" | "name" | "workspaceDir" | "repos" | "archivedAt">[];
  onRestore: (id: number) => void;
}

/** 已归档的 feature 或 epic：两者显示的内容一样，没有就不显示。 */
function ArchivedTable({ title, nameColumn, rows, onRestore }: ArchivedTableProps) {
  if (rows.length === 0) return null;
  return (
    <>
      <h3>{title}</h3>
      <table className="table">
        <thead>
          <tr><th>{nameColumn}</th><th>{S.featureRepos}</th><th>{S.colArchivedAt}</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><div>{r.name}</div><div className="muted">{r.workspaceDir}</div></td>
              <td>{r.repos.map((x) => lastSegment(x.repoPath)).join(", ")}</td>
              <td className="muted">{r.archivedAt ? new Date(r.archivedAt).toLocaleString() : ""}</td>
              <td className="actions"><button onClick={() => onRestore(r.id)}>{S.unarchive}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
