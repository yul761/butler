import { useState } from "react";
import type { BatchView } from "../../../shared/batches";
import { api } from "../api";
import { reportError } from "../errors";
import { batchTitle } from "../lessons-bulk-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

const PAGE = 50;
/** 主进程一页最多给 500 个。 */
const MAX = 500;
const formatTime = (ms: number) => new Date(ms).toLocaleString([], { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 一个批次的明细：每一行「文字 · 之前 → 之后」，能撤销时给撤销按钮。 */
function BatchDetailView({ id, onBack }: { id: number; onBack(): void }) {
  const detail = useStateRefetch(`batch-${id}`, () => api.lessonsBatch(id));
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const undo = async () => {
    try {
      const r = await api.lessonsAct({ op: "undoBatch", batchId: id });
      setMessage(r.ok ? { text: S.bulkUndone(r.affected ?? 0, r.skipped ?? 0), error: false } : { text: S.batchError[r.reason] ?? S.lessonsErrorGeneric, error: true });
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <div className="lesson-batch-detail" data-testid="batch-detail">
      <button className="link" data-testid="batch-back" onClick={onBack}>{S.batchBack}</button>
      {detail === null ? null : !detail ? (
        <p className="muted">{S.batchError.not_found}</p>
      ) : (
        <>
          <h3>#{detail.id} · {batchTitle(detail, S)}</h3>
          <p className="muted">
            {formatTime(detail.createdAt)} · {S.batchOrigin[detail.origin]} · {S.batchAffected(detail.affected)}
            {detail.undoneAt !== null && <> · {S.batchUndoneAt(formatTime(detail.undoneAt))}</>}
            {detail.undoOf !== null && <> · {S.batchUndoOf(detail.undoOf)}</>}
          </p>
          {detail.undoable && <button data-testid="batch-undo" onClick={() => void undo()}>{S.batchUndo}</button>}
          {message && <p className={message.error ? "error" : "muted"} role={message.error ? "alert" : "status"} data-testid="batch-message">{message.text}</p>}
          {detail.items.length === 0 ? (
            <p className="muted">{S.batchNoItems}</p>
          ) : (
            <ul className="lesson-batch-items">
              {detail.items.map((it) => (
                <li key={`${it.entity}-${it.entityId}`} data-testid={`batch-item-${it.entity}-${it.entityId}`}>
                  <span className="lesson-batch-label">{it.label}</span>
                  <span className="muted"> · {it.before ?? S.batchNone} → {it.after ?? S.batchNone}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** 批次历史（契约 4.4）：最新的在前，可以翻页；点一个看明细。 */
export function LessonBatches() {
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<number | null>(null);
  const list = useStateRefetch<BatchView[]>(`batches-${limit}`, () => api.lessonsBatches({ limit }));
  if (open !== null) return <BatchDetailView id={open} onBack={() => setOpen(null)} />;
  return (
    <div className="lesson-batches" data-testid="lesson-batches">
      <h3>{S.batchesTitle}</h3>
      <p className="muted">{S.batchesIntro}</p>
      {list && list.length === 0 && <p className="muted" data-testid="batches-empty">{S.batchesEmpty}</p>}
      <ul className="lesson-run-list">
        {(list ?? []).map((b) => (
          <li key={b.id} className={`lesson-run${b.undoneAt !== null ? " undone" : ""}`} data-testid={`batch-${b.id}`}>
            <button className="link lesson-run-title" data-testid={`batch-open-${b.id}`} onClick={() => setOpen(b.id)}>#{b.id} · {batchTitle(b, S)}</button>
            <span className="muted"> · {formatTime(b.createdAt)} · {S.batchOrigin[b.origin]} · {S.batchAffected(b.affected)}</span>
            {b.undoneAt !== null && <span className="pill none">{S.batchUndoneAt(formatTime(b.undoneAt))}</span>}
            {b.undoOf !== null && <span className="pill none">{S.batchUndoOf(b.undoOf)}</span>}
          </li>
        ))}
      </ul>
      {list && list.length >= limit && limit < MAX && <button data-testid="batches-more" onClick={() => setLimit((n) => Math.min(MAX, n + PAGE))}>{S.batchMore}</button>}
    </div>
  );
}
