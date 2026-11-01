import { useState } from "react";
import type { EpicFeatureRow, EpicView } from "../../../shared/types";
import { api } from "../api";
import { S } from "../strings";
import { epicErrorText, epicOpenError, epicRowText } from "./epic-row";
import { NewFeatureDialog } from "./NewFeatureDialog";
import { useCollapsed } from "./useCollapsed";
import { SessionArea, useSessionPanes, WorkspaceHeader } from "./WorkspaceParts";

interface Props {
  epic: EpicView;
  onOpenFeature: (id: number) => void;
  /** 新建的 feature：重读列表后跳过去。 */
  onFeatureCreated: (id: number) => void;
}

/**
 * epic 页（设计文档 2026-11-01，草图 A）：从上到下是名字和工作区、一行一个 feature（一句进度和状态，不列 ticket），
 * 然后是仓库、epic session 和它们的终端，布局和 feature 页一样。
 */
export function EpicPage({ epic, onOpenFeature, onFeatureCreated }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [newFeature, setNewFeature] = useState(false);
  const errorText = (e: unknown) => epicErrorText(e, S);
  const showError = (e: unknown) => setError(errorText(e));
  const panes = useSessionPanes(epic.sessions, {
    openSession: (sessionId) => api.openEpicSession({ epicId: epic.id, sessionId }),
    openFailure: (reason) => epicOpenError(reason, S),
    errorText,
    setError,
  });

  const live = epic.features.filter((f) => f.status !== "archived");
  const archived = epic.features.filter((f) => f.status === "archived");

  return (
    <div className="ticket-page epic-page">
      <WorkspaceHeader
        name={epic.name}
        nameLabel={S.epicName}
        workspaceDir={epic.workspaceDir}
        onRename={(name) => api.renameEpic(epic.id, name)}
        archiveLabel={S.archiveEpic}
        archivingLabel={live.length > 0 ? S.archivingSummaries : S.archiving}
        onArchive={() => api.archiveEpic(epic.id)}
        onError={showError}
      />

      <div className="feature-overview">
        <section className="epic-features">
          <h3>{S.features}<span className="muted">{live.length}</span></h3>
          {live.length === 0 ? (
            <p className="muted">{S.noEpicFeatures}</p>
          ) : (
            <table className="ticket-table">
              <tbody>
                {live.map((f) => <FeatureRow key={f.id} row={f} onOpen={() => onOpenFeature(f.id)} />)}
              </tbody>
            </table>
          )}
          <button onClick={() => setNewFeature(true)}>+ {S.newFeature}</button>
        </section>
        {archived.length > 0 && <ArchivedFeatures epicId={epic.id} rows={archived} />}
      </div>
      {newFeature && (
        <NewFeatureDialog
          epicId={epic.id}
          onClose={() => setNewFeature(false)}
          onCreated={(id) => (setNewFeature(false), onFeatureCreated(id))}
        />
      )}

      <SessionArea
        repos={epic.repos}
        reposHint={S.epicReposHint}
        onAddRepo={(path) => api.addEpicRepo(epic.id, path)}
        onRemoveRepo={(id) => api.removeEpicRepo(id)}
        sessions={epic.sessions}
        hiddenSessions={epic.hiddenSessions}
        panes={panes}
        placeOf={() => S.epicSession}
        noSessions={S.noEpicSessions}
        newSession={S.newEpicSession}
        newSessionHint={S.epicSessionHint}
        error={error}
        onError={showError}
      />
    </div>
  );
}

/** 已归档的 feature 没有 feature 页，所以点不进去：不给 onOpen。 */
function FeatureRow({ row, onOpen }: { row: EpicFeatureRow; onOpen?: () => void }) {
  const text = epicRowText(row, S);
  return (
    <tr className={onOpen ? undefined : "archived"} onClick={onOpen}>
      <td className="name">{onOpen ? <button className="chip">{row.name}</button> : row.name}</td>
      <td className="progress muted">{text.progress}</td>
      <td className={text.stuck ? "status stuck" : "status"}>
        {text.stuck && <span className="stuck-mark">●</span>}
        {row.status === "waiting" && <span className="badge">●</span>}
        {text.status}
      </td>
    </tr>
  );
}

/** 默认收起：这里的“收起”记号在存储里的意思是“展开了”（和 TicketRow 的面板一样）。 */
function ArchivedFeatures({ epicId, rows }: { epicId: number; rows: EpicFeatureRow[] }) {
  const [open, toggle] = useCollapsed(`epic-archived-open:${epicId}`);
  return (
    <section className="epic-archived">
      <h3>
        <button className="section-toggle" aria-expanded={open} onClick={toggle}>
          <span className="twisty">{open ? "▾" : "▸"}</span>
          {S.archived}
          <span className="muted">{rows.length}</span>
        </button>
      </h3>
      {open && (
        <table className="ticket-table">
          <tbody>
            {rows.map((f) => <FeatureRow key={f.id} row={f} />)}
          </tbody>
        </table>
      )}
    </section>
  );
}
