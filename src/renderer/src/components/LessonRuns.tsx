import { useEffect, useState } from "react";
import type { LessonAction } from "../../../shared/lessons";
import { api } from "../api";
import { reportError } from "../errors";
import { reasonText, runErrorText, retryAllCount, rowButtons, runCountsText, runningTicker, runSelectable, runStatusPill, TONE_PILL } from "../lesson-runs-view";
import { S } from "../strings";
import { LessonRunDetail } from "./LessonRunDetail";
import { useStateRefetch } from "./useStateRefetch";

const formatTime = (ms: number) => new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 一个仓库的分析记录：每个 PR 一行，带状态、原因、重试和取消。 */
export function LessonRuns({ slug, selectedRunId, onSelect, onOpenSession }: { slug: string; selectedRunId: number | null; onSelect(runId: number | null): void; onOpenSession(id: string): void }) {
  const rows = useStateRefetch(`lessons-runs:${slug}`, () => api.lessonsRuns(slug));
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const anyRunning = rows?.some((r) => r.status === "running") ?? false;

  // 选中的那次运行被清理掉了：不要留着一个指向空的选中。
  useEffect(() => {
    if (rows && selectedRunId !== null && !rows.some((r) => r.lastRun?.id === selectedRunId)) onSelect(null);
  }, [rows]);

  // 有行在分析：每 30 秒重画一次，已用时间往前走；没有了（或卸载）就停。只在“有没有在分析”变了时重设。
  useEffect(() => runningTicker(rows ?? [], () => setTick((t) => t + 1)), [anyRunning]);

  if (!rows) return null;
  const now = Date.now();
  const act = async (a: LessonAction) => {
    try {
      const r = await api.lessonsAct(a);
      setError(r.ok ? null : runErrorText(r.reason, S));
    } catch (e) {
      reportError(e);
    }
  };
  const failed = retryAllCount(rows);
  const selectedRow = rows.find((r) => r.lastRun?.id === selectedRunId);
  const detailQueue = selectedRow ? { queueId: selectedRow.queueId, status: selectedRow.status } : null;
  return (
    <div className="lesson-runs" data-testid="lesson-runs">
      {failed > 0 && (
        <div className="lessons-row">
          <button data-testid="lesson-runs-retry-failed" onClick={() => void act({ op: "retryFailed", slug })}>{S.lessonRunRetryFailed(failed)}</button>
        </div>
      )}
      {error && <p className="error lessons-error" role="alert">{error}</p>}
      {rows.length === 0 && <p className="muted">{S.lessonRunsEmpty}</p>}
      <ul className="lesson-run-list">
        {rows.map((r) => {
          const pill = runStatusPill(r, S, now);
          const reason = reasonText(r.reason ?? r.lastRun?.reason ?? null, S);
          const selectable = runSelectable(r);
          const buttons = rowButtons(r.status);
          return (
            <li key={r.queueId} className={`lesson-run${r.lastRun && r.lastRun.id === selectedRunId ? " selected" : ""}`} data-testid={`lesson-run-${r.queueId}`}>
              <div className="lessons-row">
                {selectable ? (
                  <button className="link lesson-run-title" data-testid={`lesson-run-select-${r.queueId}`} onClick={() => r.lastRun && onSelect(r.lastRun.id)}>
                    #{r.prNumber}{r.prTitle ? ` ${r.prTitle}` : ""}
                  </button>
                ) : (
                  <span className="lesson-run-title">#{r.prNumber}{r.prTitle ? ` ${r.prTitle}` : ""}</span>
                )}
                <span className="muted">{S.lessonRunOrigin[r.origin]}</span>
                <span className={`pill ${TONE_PILL[pill.tone]}`}>{pill.text}</span>
                {reason && <span className="muted">{reason}</span>}
                <span className="muted">{formatTime(r.finishedAt ?? r.lastRun?.startedAt ?? r.enqueuedAt)}</span>
                {r.lastRun && <span className="muted">{runCountsText(r.lastRun, S)}</span>}
                {buttons.includes("retry") && (
                  <button data-testid={`lesson-run-retry-${r.queueId}`} onClick={() => void act({ op: "retry", queueId: r.queueId })}>{S.lessonRunRetry}</button>
                )}
                {buttons.includes("cancel") && (
                  <button data-testid={`lesson-run-cancel-${r.queueId}`} onClick={() => void act({ op: "cancel", queueId: r.queueId })}>{S.lessonRunCancel}</button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {selectedRunId !== null && (
        <LessonRunDetail key={selectedRunId} runId={selectedRunId} queue={detailQueue} onOpenSession={onOpenSession} />
      )}
    </div>
  );
}
