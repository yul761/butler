import { useState } from "react";
import type { PrAssessmentView, ReviewActResult } from "../../../shared/prereview";
import { api } from "../api";
import { reportError } from "../errors";
import { shortTime } from "../progress-ui";
import { assessmentTitle, riskPill } from "../review-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";
import { PrPreReviewChip } from "./PreReviewChip";

const R = () => S.rv;

/** ticket 页「Review」标签（工作流 G）：每个 PR（和还没开 PR、交过证据的分支）的就绪、风险、预审、证据、简报。 */
export function TicketReview({ ticketKey }: { ticketKey: string }) {
  const view = useStateRefetch(`review-${ticketKey}`, () => api.prAssessment(ticketKey));
  if (view === null) return null;
  const all = [...view.prs, ...view.branches];
  if (all.length === 0) return <p className="empty" data-testid="ticket-review-empty">{R().none}</p>;
  return (
    <div className="ticket-review" data-testid="ticket-review">
      {!all[0]!.preReviewEnabled && <p className="muted">{R().off}</p>}
      {all.map((a) => <Assessment key={a.prId ?? `b:${a.target?.repoSlug}:${a.target?.branch}`} a={a} />)}
    </div>
  );
}

function Assessment({ a }: { a: PrAssessmentView }) {
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<ReviewActResult>, done: string) => {
    setBusy(true);
    setNote(null);
    fn()
      .then((r) => setNote(r.ok ? { text: done, error: false } : { text: [R().actFail[r.reason] ?? r.reason, r.detail].filter(Boolean).join(": "), error: true }), reportError)
      .finally(() => setBusy(false));
  };
  const copy = (text: string) => api.clipboardWrite(text).then(() => setNote({ text: R().copied, error: false }), reportError);
  const prId = a.prId;
  return (
    <div className="review-pr" data-testid={a.number !== null ? `review-pr-${a.number}` : "review-branch"}>
      <h4 className="policy-group">
        {a.url ? <a href={a.url} onClick={(e) => (e.preventDefault(), void api.prOpen(a.url!).catch(reportError))}>{assessmentTitle(a)}</a> : assessmentTitle(a)}
        {a.prId === null && <span className="muted"> · {R().noPr}</span>}
        {a.draft && <span className="muted"> · {R().draft}</span>}
        {a.risk && <span className={`pill ${riskPill(a.risk.level)}`} data-testid="review-risk-badge"> {R().riskBadge(R().level[a.risk.level])}</span>}
        {a.readiness && <span className={a.readiness.ready ? "pill approved" : "pill pending"} data-testid="review-ready-badge"> {a.readiness.ready ? R().ready : R().notReady}</span>}
      </h4>
      <div className="actions">
        {prId !== null && <button data-testid="review-rerun" disabled={busy} onClick={() => act(() => api.preReviewRun(prId), R().rerunQueued)}>{R().rerun}</button>}
        {prId !== null && <button data-testid="review-regenerate" disabled={busy} onClick={() => act(() => api.briefRegenerate(prId), R().regenerated)}>{R().regenerate}</button>}
      </div>
      {note && <p className={note.error ? "error" : "muted"} role="status" data-testid="review-note">{note.text}</p>}

      <Readiness a={a} />
      <RiskBlock a={a} />
      <PreReviewBlock a={a} />
      <EvidenceBlock a={a} />

      <h5>{R().brief}</h5>
      {a.brief ? (
        <div data-testid="review-brief">
          <pre className="review-brief">{a.brief.markdown}</pre>
          <div className="actions">
            <button data-testid="review-copy" onClick={() => void copy(a.brief!.markdown)}>{R().copy}</button>
            {a.canPost && prId !== null && <button data-testid="review-post" disabled={busy} onClick={() => act(() => api.briefPost(prId), R().postedDone)}>{R().post}</button>}
            {a.brief.postedAt !== null && <span className="muted">{R().posted(shortTime(a.brief.postedAt))}</span>}
          </div>
        </div>
      ) : <p className="muted">{R().briefNone}</p>}
    </div>
  );
}

function Readiness({ a }: { a: PrAssessmentView }) {
  return (
    <>
      <h5>{R().readiness}</h5>
      {!a.readiness ? <p className="muted">{R().notAssessed}</p> : (
        <ul className="review-conditions" data-testid="review-conditions">
          {a.readiness.conditions.map((c) => (
            <li key={c.key} data-state={c.state}>
              {R().cond[c.key]}{R().colon}<span className={c.state === "fail" ? "error" : c.state === "pass" ? "" : "muted"}>{R().condState[c.state]}</span>
              {c.detail && <span className="muted"> · {c.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function RiskBlock({ a }: { a: PrAssessmentView }) {
  return (
    <>
      <h5>{R().risk}</h5>
      {!a.risk ? <p className="muted">{R().notAssessed}</p> : (
        <ul data-testid="review-risk">
          {a.risk.reasons.map((r, i) => (
            <li key={`${r.rule}-${i}`}>
              {R().rule[r.rule]} · {R().level[r.level]}
              {r.files && r.files.length > 0 && <span className="muted"> · {r.files.slice(0, 5).join(", ")}{r.files.length > 5 ? " …" : ""}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function PreReviewBlock({ a }: { a: PrAssessmentView }) {
  const p = a.preReview;
  const add = p?.files.reduce((n, f) => n + f.added, 0) ?? 0;
  const del = p?.files.reduce((n, f) => n + f.deleted, 0) ?? 0;
  return (
    <>
      <h5>{R().preReview} {a.prId !== null && <PrPreReviewChip prId={a.prId} />}</h5>
      {!p ? <p className="muted">{R().preReviewNone}</p> : (
        <div data-testid="review-prereview" data-status={p.status}>
          <p>
            {R().status[p.status]}{p.verdict && <> · <strong>{R().verdict[p.verdict]}</strong></>}
            <span className="muted"> · {R().trigger[p.trigger]} · {shortTime(p.finishedAt ?? p.createdAt)}{p.files.length > 0 && ` · ${R().files(p.files.length, add, del)}`}</span>
          </p>
          {p.summary && <p>{p.summary}</p>}
          {p.detail && <p className="muted">{p.detail}</p>}
          {p.violations.length > 0 && (
            <ul data-testid="review-violations">
              {p.violations.map((v, i) => (
                <li key={i}>
                  <span className={v.severity === "must" ? "pill changes" : "pill pending"}>{R().severity[v.severity]}</span>{" "}
                  <code>{v.file}{v.line !== null ? `:${v.line}` : ""}</code> {v.what}
                  {v.fix && <><br /><span className="muted">{v.fix}</span></>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

function EvidenceBlock({ a }: { a: PrAssessmentView }) {
  const p = a.preReview;
  if (!p) return null;
  return (
    <>
      <h5>{R().evidence}</h5>
      {p.evidence.length === 0 ? <p className="muted">{R().evidenceNone}</p> : (
        <table className="policy-table" data-testid="review-evidence">
          <tbody>
            {p.evidence.map((e) => (
              <tr key={e.id} data-verified={e.verified}>
                <td>{R().kind[e.kind]}</td>
                <td>{e.name}{e.command && <><br /><code className="muted">{e.command}</code></>}</td>
                <td>{e.kind === "not_run" ? e.summary : R().verified[e.verified]}{e.verifyDetail && <><br /><span className="muted">{e.verifyDetail}</span></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {p.missingEvidence.length > 0 && (
        <>
          <h5>{R().gaps}</h5>
          <ul data-testid="review-gaps">
            {p.missingEvidence.map((g, i) => (
              <li key={i}>{R().gapCategory[g.category] ?? g.category}{R().colon}{R().gapState[g.state]}{g.detail && <span className="muted"> · {g.detail}</span>}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
