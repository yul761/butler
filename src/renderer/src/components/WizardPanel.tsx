import { useEffect, useState } from "react";
import type { AdmissionScope, WizardAction, WizardEstimate, WizardRunView } from "../../../shared/lesson-admission";
import type { LessonsState } from "../../../shared/lessons";
import { api } from "../api";
import { admissionScopeFromKey, admissionScopeKey, blockedText, durationText, latestRunFor, noteText, pct, shelvedGroups, wizardLive } from "../admission-view";
import { reportError } from "../errors";
import { S } from "../strings";
import type { BatchNoticeState } from "./LessonBulkBar";
import { useStateRefetch } from "./useStateRefetch";

const formatTime = (ms: number) => new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * 初始化向导（addendum 第 8 节）：选范围、看估算、开始；进行中显示阶段、进度和调用次数；
 * 等接受时显示总结、抽查的指标、搁置的分组（可以拉回）、没做完的（可以重试），以及一键接受（整批可撤销）。
 */
export function WizardPanel({ lessons, onNotice }: { lessons: LessonsState; onNotice(n: BatchNoticeState): void }) {
  const page = useStateRefetch("admission-state", api.admissionState);
  const [scopeKey, setScopeKey] = useState("all");
  const scope: AdmissionScope = admissionScopeFromKey(scopeKey);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = page ? latestRunFor(page.runs, scope) : null;
  const live = run !== null && wizardLive(run.state);
  // 估算要问 gh：只在换范围、运行结束（或开始）时重取，不跟着每次状态变化。
  const [estimate, setEstimate] = useState<WizardEstimate | null>(null);
  useEffect(() => {
    let alive = true;
    api.wizardEstimate(admissionScopeFromKey(scopeKey)).then((e) => alive && setEstimate(e), reportError);
    return () => {
      alive = false;
    };
  }, [scopeKey, live]);

  const act = async (a: WizardAction): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await api.wizardAct(a);
      if (!r.ok) {
        setError(S.wizardActFailed(r.reason));
        return false;
      }
      setError(null);
      if (a.op === "accept") onNotice({ batchId: r.batchId ?? null, text: S.wizardAccepted });
      return true;
    } catch (e) {
      reportError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wizard-panel" data-testid="wizard-panel">
      <p className="muted">{S.wizardIntro}</p>
      <label className="inline">
        {S.wizardScope}
        <select data-testid="wizard-scope" value={scopeKey} onChange={(e) => setScopeKey(e.target.value)}>
          <option value="all">{S.wizardScopeAll}</option>
          {lessons.products.map((p) => <option key={`p${p.id}`} value={admissionScopeKey({ kind: "product", productId: p.id })}>{S.wizardScopeProduct(p.name)}</option>)}
          {lessons.repos.map((r) => <option key={`r${r.slug}`} value={admissionScopeKey({ kind: "repo", slug: r.slug })}>{S.wizardScopeRepo(r.slug)}</option>)}
        </select>
      </label>
      {error && <p className="error" role="alert" data-testid="wizard-error">{error}</p>}
      {run && wizardLive(run.state) ? (
        <RunView run={run} lessons={lessons} busy={busy} act={act} />
      ) : (
        <>
          {run && <RunView run={run} lessons={lessons} busy={busy} act={act} />}
          <div className="wizard-estimate" data-testid="wizard-estimate">
            <h3>{S.wizardEstimateTitle}</h3>
            {estimate && (
              <>
                <ul>
                  {estimate.repos.map((r) => (
                    <li key={r.slug} data-testid={`wizard-estimate-repo-${r.slug}`}>
                      {S.wizardEstimateRepo(r.slug, r.merged, r.analysed)}
                      {!r.cloned && <span className="pill none"> {S.wizardNotCloned}</span>}
                      {r.setUp && <span className="pill approved" data-testid={`wizard-estimate-setup-${r.slug}`}> {S.wizardSetUp}</span>}
                    </li>
                  ))}
                </ul>
                <p className="muted" data-testid="wizard-estimate-totals">{S.wizardEstimateTotals(estimate.expectedCalls, durationText(estimate.expectedMs, S), estimate.pendingLessons, estimate.enrichNeeding)}</p>
              </>
            )}
            <button className="primary" data-testid="wizard-start" disabled={busy} onClick={() => void act({ op: "start", scope })}>
              {estimate?.liveRunId ? S.wizardResume : S.wizardStart}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function RunView({ run, lessons, busy, act }: { run: WizardRunView; lessons: LessonsState; busy: boolean; act(a: WizardAction): Promise<boolean> }) {
  const text = (id: number) => lessons.lessons.find((l) => l.id === id)?.text ?? `#${id}`;
  const sum = run.summary;
  const blocked = run.review ? blockedText(run.review, S) : null;
  const acceptable = run.verdicts.filter((v) => v.verdict === "admit" || v.verdict === "merged").length;
  // 拉回、驳回、在别处确认过的不再列（结论表还记着搁置）。
  const stillShelved = (id: number) => {
    const l = lessons.lessons.find((x) => x.id === id);
    return !l || (l.status === "pending" && l.mergedInto === null && l.admission === "shelved");
  };
  const groups = shelvedGroups(run.verdicts.filter((v) => stillShelved(v.lessonId)));
  return (
    <div className="wizard-run" data-testid="wizard-run" data-state={run.state}>
      <div className="lessons-row">
        <span className="pill" data-testid="wizard-state">{S.wizardState[run.state]}</span>
        {run.progress.prs.total > 0 && <span className="muted" data-testid="wizard-progress-prs">{S.wizardProgressPrs(run.progress.prs.done, run.progress.prs.total)}</span>}
        {run.progress.enrich.total > 0 && <span className="muted">{S.wizardProgressEnrich(run.progress.enrich.done, run.progress.enrich.total)}</span>}
        <span className="muted" data-testid="wizard-calls">{S.wizardCalls(run.calls)}</span>
      </div>
      {run.error && <p className="error" role="alert">{S.wizardRunError(run.error)}</p>}
      {run.notes.length > 0 && (
        <ul className="wizard-notes muted" data-testid="wizard-notes">
          {run.notes.map((n, i) => <li key={i}>{noteText(n, S)}</li>)}
        </ul>
      )}
      {sum && (
        <div className="wizard-summary" data-testid="wizard-summary">
          <h3>{S.wizardSummaryTitle}</h3>
          <ul>
            <li data-testid="wizard-summary-prs">{S.wizardSummaryPrs(sum.prs.total, sum.prs.analysed, sum.prs.failed, sum.prs.skipped)}</li>
            <li data-testid="wizard-summary-candidates">{S.wizardSummaryCandidates(sum.candidates)}</li>
            <li data-testid="wizard-summary-admitted">{S.wizardSummaryAdmitted(sum.admitted.prose, sum.admitted.checks)}</li>
            {sum.merged > 0 && <li>{S.wizardSummaryMerged(sum.merged)}</li>}
            <li data-testid="wizard-summary-shelved">{S.wizardSummaryShelved(Object.values(sum.shelved).reduce((a, b) => a + b, 0))}</li>
            {sum.covered > 0 && <li>{S.wizardSummaryCovered(sum.covered)}</li>}
            {sum.unfinished > 0 && <li data-testid="wizard-summary-unfinished">{S.wizardSummaryUnfinished(sum.unfinished)}</li>}
            <li>
              {S.wizardSummaryPassRate(pct(sum.passRate))}
              {sum.sameModelReview && <span className="muted"> · {S.wizardSameModel}</span>}
            </li>
            {!sum.backtested && <li data-testid="wizard-summary-not-backtested"><span className="pill changes">{S.wizardNotBacktested}</span></li>}
            <li className="muted">{S.wizardCalls(sum.calls)}</li>
          </ul>
        </div>
      )}
      {run.state === "awaiting_accept" && (
        <div className="lessons-row">
          {blocked ? (
            <p className="lessons-suggest" role="status" data-testid="wizard-blocked">{blocked}</p>
          ) : (
            <button className="primary" data-testid="wizard-accept" disabled={busy || acceptable === 0} onClick={() => void act({ op: "accept", runId: run.id })}>{S.wizardAccept(acceptable)}</button>
          )}
          <button data-testid="wizard-recalculate" title={S.wizardRecalculateTitle} disabled={busy} onClick={() => void act({ op: "recalculate", runId: run.id })}>{S.wizardRecalculate}</button>
          <button data-testid="wizard-cancel" disabled={busy} onClick={() => void act({ op: "cancel", runId: run.id })}>{S.wizardCancel}</button>
        </div>
      )}
      {wizardLive(run.state) && run.state !== "awaiting_accept" && (
        <button data-testid="wizard-cancel" disabled={busy} onClick={() => void act({ op: "cancel", runId: run.id })}>{S.wizardCancel}</button>
      )}
      {run.state === "accepted" && run.acceptBatch !== null && <AcceptedBatch batchId={run.acceptBatch} />}
      {run.state === "awaiting_accept" && groups.length > 0 && (
        <div className="wizard-shelved" data-testid="wizard-shelved">
          <h3>{S.wizardShelvedTitle}</h3>
          {groups.map((g) => (
            <details key={g.reason} data-testid={`wizard-shelved-${g.reason}`}>
              <summary>{S.wizardShelvedGroup(S.shelvedReasonLabel[g.reason] ?? g.reason, g.lessonIds.length)}</summary>
              <div className="lessons-row">
                <button data-testid={`wizard-pull-group-${g.reason}`} disabled={busy} onClick={() => void act({ op: "pullBack", runId: run.id, lessonIds: g.lessonIds })}>{S.wizardPullBackGroup}</button>
                <button data-testid={`wizard-reject-group-${g.reason}`} disabled={busy} onClick={() => void act({ op: "rejectGroup", runId: run.id, lessonIds: g.lessonIds })}>{S.wizardRejectGroup}</button>
              </div>
              <ul>
                {g.lessonIds.map((id) => (
                  <li key={id} className="lessons-row">
                    <span>{text(id)}</span>
                    <button className="link" data-testid={`wizard-pull-${id}`} disabled={busy} onClick={() => void act({ op: "pullBack", runId: run.id, lessonIds: [id] })}>{S.wizardPullBack}</button>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
      {run.failed.length > 0 && wizardLive(run.state) && (
        <div className="wizard-failed" data-testid="wizard-failed">
          <h3>{S.wizardUnfinishedTitle}</h3>
          <ul>
            {run.failed.map((f) => (
              <li key={`${f.kind}:${f.key}`}>
                {S.wizardFailedItem(f.kind, f.key, f.attempts)} · <span className="muted">{f.retryAt === null ? S.wizardNoAutoRetry : S.wizardRetryAt(formatTime(f.retryAt))}</span>
                {f.error && <span className="muted"> · {f.error}</span>}
              </li>
            ))}
          </ul>
          <button data-testid="wizard-retry" disabled={busy} onClick={() => void act({ op: "retry", runId: run.id })}>{S.wizardRetry}</button>
        </div>
      )}
    </div>
  );
}

/** 接受之后（重启以后也在）：整批撤销。 */
function AcceptedBatch({ batchId }: { batchId: number }) {
  const batch = useStateRefetch(`wizard-accept-${batchId}`, () => api.lessonsBatch(batchId));
  const [error, setError] = useState<string | null>(null);
  if (!batch) return null;
  const undo = async () => {
    try {
      const r = await api.lessonsAct({ op: "undoBatch", batchId });
      setError(r.ok ? null : (S.batchError[r.reason] ?? S.lessonsErrorGeneric));
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <div className="lessons-row" data-testid="wizard-accepted">
      <span>{batch.undoneAt !== null ? S.wizardUndone : S.wizardAccepted}</span>
      {batch.undoable && <button data-testid="wizard-undo-accept" onClick={() => void undo()}>{S.wizardUndoAccept}</button>}
      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}
