import { Fragment, useEffect, useState } from "react";
import type { LessonQueueRowStatus } from "../../../shared/lessons";
import { api } from "../api";
import { reportError } from "../errors";
import { detailButtons, detailSections, openInClaudeOutcome, runDetailFacts, runErrorText } from "../lesson-runs-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

/** 一次分析运行的详情：日志、发给 Claude 的材料、产出的规矩和发现。queue 是这个 PR 的队列项（只有最近一次运行才有）。 */
export function LessonRunDetail({ runId, queue, onOpenSession }: {
  runId: number;
  queue: { queueId: number; status: LessonQueueRowStatus } | null;
  onOpenSession(id: string): void;
}) {
  /** 点“之前的尝试”看那一次；换了选中的运行就回到它。 */
  const [viewId, setViewId] = useState(runId);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setViewId(runId);
    setError(null);
  }, [runId]);
  const d = useStateRefetch(`lessons-run:${viewId}`, () => api.lessonsRun(viewId));
  if (!d || d.id !== viewId) return null;

  const sec = detailSections(d);
  const buttons = detailButtons(d, viewId === runId && queue ? queue.status : null);
  const act = async (a: { op: "retry" | "cancel"; queueId: number }) => {
    try {
      const r = await api.lessonsAct(a);
      setError(r.ok ? null : runErrorText(r.reason, S));
    } catch (e) {
      reportError(e);
    }
  };
  const openInClaude = async () => {
    try {
      const o = openInClaudeOutcome(await api.lessonsAct({ op: "openInClaude", runId: d.id }), S);
      setError(o.kind === "error" ? o.text : null);
      if (o.kind === "open") onOpenSession(o.sessionId);
    } catch (e) {
      reportError(e);
    }
  };
  const openPr = async (url: string) => {
    try {
      await api.prOpen(url);
    } catch (e) {
      reportError(e);
    }
  };
  const logBlock = (label: string, text: string | null, testid: string) =>
    text && (
      <details data-testid={testid}>
        <summary>{label}</summary>
        <pre className="raw">{text}</pre>
      </details>
    );

  return (
    <div className="lesson-run-detail" data-testid="lesson-run-detail">
      <h3>
        {d.prUrl ? (
          <button className="link" data-testid="lesson-run-detail-pr" onClick={() => void openPr(d.prUrl!)}>{d.slug}#{d.prNumber}</button>
        ) : (
          <span>{d.slug}#{d.prNumber}</span>
        )}
        {d.prTitle ? ` ${d.prTitle}` : ""} <span className="muted">{S.lessonRunOrigin[d.origin]}</span>
      </h3>
      <dl className="kv" data-testid="lesson-run-detail-facts">
        {runDetailFacts(d, S).map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
      <div className="lessons-row">
        {buttons.includes("retry") && queue && (
          <button data-testid="lesson-run-detail-retry" onClick={() => void act({ op: "retry", queueId: queue.queueId })}>{S.lessonRunRetry}</button>
        )}
        {buttons.includes("cancel") && queue && (
          <button data-testid="lesson-run-detail-cancel" onClick={() => void act({ op: "cancel", queueId: queue.queueId })}>{S.lessonRunCancel}</button>
        )}
        {buttons.includes("open") && (
          <button data-testid="lesson-run-detail-open" onClick={() => void openInClaude()}>{S.lessonRunOpenInClaude}</button>
        )}
      </div>
      {error && <p className="error lessons-error" role="alert" data-testid="lesson-run-detail-error">{error}</p>}
      {sec.message && (
        <>
          <h4>{S.lessonRunMessage}</h4>
          <pre className="raw" data-testid="lesson-run-detail-message">{sec.message}</pre>
        </>
      )}
      {logBlock(S.lessonRunStderr, sec.stderr, "lesson-run-detail-stderr")}
      {logBlock(S.lessonRunGhStderr, sec.ghStderr, "lesson-run-detail-gh-stderr")}
      {sec.lessons && (
        <>
          <h4>{S.lessonRunLessons}</h4>
          <ul className="lesson-run-lessons">
            {d.lessons.map((l) => (
              <li key={l.id}>
                <span className="lesson-text">{l.text}</span> <span className="pill none">{l.kind === "created" ? S.lessonRunCreated : S.lessonRunHit}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {sec.dropped && <p className="muted">{S.lessonRunDropped(d.dropped)}</p>}
      {sec.findings && (
        <>
          <h4>{S.lessonRunFindings}</h4>
          <ul className="lesson-run-findings" data-testid="lesson-run-detail-findings">
            {sec.findings.map((f, i) => (
              <li key={i}>
                <p className="lesson-text">{f.summary}</p>
                <p className="muted">{S.lessonRunAvoidable(f.avoidable)} · {S.lessonRunWhyMissed}: {f.whyMissed}</p>
                {f.rule && <p className="muted">{f.rule.text}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
      {logBlock(S.lessonRunMaterial, sec.material, "lesson-run-detail-material")}
      {logBlock(S.lessonRunRaw, sec.rawOutput, "lesson-run-detail-raw")}
      {sec.trimmedNote && <p className="muted" data-testid="lesson-run-detail-trimmed">{S.lessonRunTrimmed}</p>}
      {sec.attempts && (
        <>
          <h4>{S.lessonRunAttempts}</h4>
          <ul className="lesson-run-attempts">
            {d.attempts.map((a) => (
              <li key={a.id}>
                <button className="link" data-testid={`lesson-run-attempt-${a.id}`} onClick={() => setViewId(a.id)}>
                  {new Date(a.startedAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {S.lessonRunStatus[a.status === "aborted" ? "failed" : a.status]}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
