import { useState } from "react";
import type { EpicFeatureRow, EpicView, InboxItemView, NowTarget } from "../../../shared/types";
import { api } from "../api";
import { S } from "../strings";
import { epicErrorText, epicOpenError, epicRowText } from "./epic-row";
import { inboxTabs, useInbox } from "./InboxPanes";
import { NewFeatureDialog } from "./NewFeatureDialog";
import { PageTabs } from "./PageTabs";
import { EpicPrStages } from "./PrStages";
import { PrStuckBlock } from "./ProgressPage";
import { useCollapsed } from "./useCollapsed";
import { SessionArea, useSessionPanes, WorkspaceHeader } from "./WorkspaceParts";

interface Props {
  epic: EpicView;
  onOpenFeature: (id: number) => void;
  /** PR 进度表里点 ticket：打开它的页面。 */
  onOpenTicket: (key: string) => void;
  /** 新建的 feature：重读列表后跳过去。 */
  onFeatureCreated: (id: number) => void;
  /** 打开时先切到这个 session 的终端（从「现在」页点进来时）。 */
  focusSession?: string | null;
  /** 「待你决定」卡片上的「去终端」：问题不是 epic session 提的时跳到提问的 session 的页面。 */
  onOpenTarget: (t: NowTarget) => void;
}

/**
 * epic 页（设计文档 2026-11-01，草图 A）：从上到下是名字和工作区，一排 tab（feature 列表：一行一个 feature，一句进度和状态，
 * 不列 ticket；汇报；待你决定），然后是仓库、epic session 和它们的终端，布局和 feature 页一样。
 */
export function EpicPage({ epic, onOpenFeature, onOpenTicket, onFeatureCreated, focusSession, onOpenTarget }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [newFeature, setNewFeature] = useState(false);
  const errorText = (e: unknown) => epicErrorText(e, S);
  const showError = (e: unknown) => setError(errorText(e));
  const panes = useSessionPanes(epic.sessions, {
    openSession: (sessionId) => api.openEpicSession({ epicId: epic.id, sessionId }),
    openFailure: (reason) => epicOpenError(reason, S),
    errorText,
    setError,
    initialActive: focusSession,
  });

  /** 「去终端」：epic session 就地切过去，终端关着就打开；feature、ticket 的 session 跳到它的页面。 */
  function goTo(item: InboxItemView) {
    const t = item.target;
    if (t.page !== "epic" || t.id !== epic.id) return onOpenTarget(t);
    const termId = epic.sessions.find((s) => s.id === item.sessionId)?.termId;
    if (termId) panes.show(termId);
    else void panes.open(item.sessionId);
  }

  const inbox = useInbox({ epicId: epic.id });
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

      <PageTabs
        page={`epic:${epic.id}`}
        defaultTab="features"
        actions={<button onClick={() => setNewFeature(true)}>+ {S.newFeature}</button>}
        tabs={[
          {
            id: "features",
            // tab 上留着数量和等待、卡住的记号，和 feature 页的 ticket tab 一样。
            label: (
              <>
                {S.features}
                <span className="muted">{live.length}</span>
                {live.some((f) => f.status === "waiting") && <span className="badge" title={S.waiting}>●</span>}
                {live.some((f) => f.status === "stuck") && <span className="stuck-mark" title={S.stuckDot}>●</span>}
              </>
            ),
            content: (
              <>
                <section className="epic-features">
                  {live.length === 0 ? (
                    <p className="muted">{S.noEpicFeatures}</p>
                  ) : (
                    <table className="ticket-table">
                      <tbody>
                        {live.map((f) => <FeatureRow key={f.id} row={f} onOpen={() => onOpenFeature(f.id)} />)}
                      </tbody>
                    </table>
                  )}
                </section>
                {archived.length > 0 && <ArchivedFeatures epicId={epic.id} rows={archived} />}
              </>
            ),
          },
          { id: "stages", label: S.prStagesTab, content: (
              <>
                <PrStuckBlock epicId={epic.id} onOpenTicket={onOpenTicket} />
                <EpicPrStages epicId={epic.id} features={live.map((f) => ({ id: f.id, name: f.name }))} onOpenTicket={onOpenTicket} />
              </>
            ),
          },
          ...inboxTabs(inbox, goTo),
        ]}
      />
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
