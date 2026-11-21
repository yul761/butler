// 复盘规矩页的默认视图（BTL-244）：跨所有仓库和产品的待确认列表，每条可以确认、编辑后确认、驳回。
// 其余的（按仓库看、筛选、批量、批次和撤销、准入、产品、导入导出、向导、校准、回测）都在「高级」里。
import { useState } from "react";
import type { Lesson, LessonAction, LessonsState } from "../../../shared/lessons";
import { sourceLabel } from "../lesson-runs-view";
import { allPending, scopeLabel } from "../lessons-view";
import { S } from "../strings";

export interface PendingLessonsProps {
  s: Pick<LessonsState, "lessons" | "products">;
  /** 发一个操作，失败原因记在 key 下；成功返回 true（数据等 stateChanged 重取）。 */
  act: (key: string, a: LessonAction) => Promise<boolean>;
  /** key 下记着的失败原因。 */
  error: (key: string) => string | undefined;
}

export const pendingKey = (id: number) => `pending-lesson-${id}`;

export function PendingLessons({ s, act, error }: PendingLessonsProps) {
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const pending = allPending(s);
  // 编辑中的那条已经不在待确认里了（别处处理掉了）：编辑框跟着消失。
  const edit = editing && pending.some((l) => l.id === editing.id) ? editing : null;
  const row = (l: Lesson) => {
    const key = pendingKey(l.id);
    const msg = error(key);
    return (
      <div key={l.id} className="lesson pending-lesson" data-testid={`pending-lesson-${l.id}`}>
        <p className="lesson-text">{l.text}</p>
        <p className="muted">
          <span className="pill" data-testid={`pending-lesson-scope-${l.id}`}>{scopeLabel(l, s)}</span>
          {l.sources.length > 0 && (
            <span className="lesson-sources">
              {l.sources.map((src) => (
                <button key={src.id} className="link lesson-source" data-testid={`pending-lesson-source-${src.id}`} onClick={() => void act(key, { op: "openSource", sourceId: src.id })}>
                  {sourceLabel(src, l.scope)}
                </button>
              ))}
            </span>
          )}
        </p>
        {l.why && <p className="muted">{S.lessonsWhy(l.why)}</p>}
        {edit?.id === l.id ? (
          <div className="lesson-editor">
            <textarea data-testid={`pending-lesson-text-${l.id}`} value={edit.text} onChange={(e) => setEditing({ id: l.id, text: e.target.value })} rows={3} />
            <div className="lessons-row">
              <button
                className="primary"
                data-testid={`pending-lesson-save-${l.id}`}
                disabled={!edit.text.trim()}
                onClick={async () => {
                  if (await act(key, { op: "confirm", id: l.id, text: edit.text.trim() })) setEditing(null);
                }}
              >
                {S.lessonsSaveConfirm}
              </button>
              <button onClick={() => setEditing(null)}>{S.lessonsCancel}</button>
            </div>
          </div>
        ) : (
          <div className="lessons-row">
            <button className="primary" data-testid={`pending-lesson-confirm-${l.id}`} onClick={() => void act(key, { op: "confirm", id: l.id })}>{S.lessonsConfirm}</button>
            <button data-testid={`pending-lesson-edit-${l.id}`} onClick={() => setEditing({ id: l.id, text: l.text })}>{S.lessonsEditConfirm}</button>
            <button data-testid={`pending-lesson-reject-${l.id}`} onClick={() => void act(key, { op: "reject", id: l.id })}>{S.lessonsReject}</button>
          </div>
        )}
        {msg && <p className="error lessons-error" role="alert">{msg}</p>}
      </div>
    );
  };
  return (
    <section className="lessons-pending-all" data-testid="pending-lessons">
      <h3>{S.lessonsPendingTitle}{pending.length > 0 && <span className="count">{pending.length}</span>}</h3>
      {pending.length === 0 ? <p className="muted" data-testid="pending-lessons-none">{S.lessonsNoPending}</p> : pending.map(row)}
    </section>
  );
}
