import { useState } from "react";
import type { CalibrationMark, CalibrationSample } from "../../../shared/lesson-admission";
import type { LessonsState } from "../../../shared/lessons";
import { api } from "../api";
import { admissionScopeFromKey, admissionScopeKey, bandAgreement, pct } from "../admission-view";
import { reportError } from "../errors";
import { formatScore } from "../lessons-bulk-view";
import { S } from "../strings";
import { PolicyEditor } from "./LessonsSettings";
import { useStateRefetch } from "./useStateRefetch";

const MARKS: readonly CalibrationMark[] = ["good", "bad", "skip"];

/**
 * 校准页（addendum 第 9 节）：每个分数段抽几条让人判该不该接受，判的结果记成 score_calibration 样本；
 * 下面是各段的一致率、全部样本的一致率、评分的权重和线（就地改），以及「记为已校准」。
 */
export function CalibrationPanel({ lessons }: { lessons: LessonsState }) {
  const [scopeKey, setScopeKey] = useState("all");
  const [sample, setSample] = useState<CalibrationSample | null>(null);
  const since = sample?.drawnAt ?? null;
  const stats = useStateRefetch(`calibration-stats-${since ?? "none"}`, () => api.calibrationStats(since));
  const [error, setError] = useState<string | null>(null);
  /** 跳过的不记样本（主进程只删掉之前的判断）：按钮的按下状态在页面上记。 */
  const [skipped, setSkipped] = useState<number[]>([]);
  const text = (id: number) => lessons.lessons.find((l) => l.id === id)?.text ?? `#${id}`;

  const draw = async () => {
    try {
      setSample(await api.calibrationSample(admissionScopeFromKey(scopeKey)));
      setSkipped([]);
      setError(null);
    } catch (e) {
      reportError(e);
    }
  };
  const send = async (a: Parameters<typeof api.calibrationAct>[0]) => {
    try {
      const r = await api.calibrationAct(a);
      setError(r.ok ? null : S.wizardActFailed(r.reason));
      if (r.ok && a.op === "mark") setSkipped((xs) => (a.mark === "skip" ? [...new Set([...xs, a.lessonId])] : xs.filter((x) => x !== a.lessonId)));
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <div className="calibration-panel" data-testid="calibration-panel">
      <p className="muted">{S.calibrationIntro}</p>
      <div className="lessons-row">
        <label className="inline">
          {S.wizardScope}
          <select data-testid="calibration-scope" value={scopeKey} onChange={(e) => setScopeKey(e.target.value)}>
            <option value="all">{S.wizardScopeAll}</option>
            {lessons.products.map((p) => <option key={`p${p.id}`} value={admissionScopeKey({ kind: "product", productId: p.id })}>{S.wizardScopeProduct(p.name)}</option>)}
            {lessons.repos.map((r) => <option key={`r${r.slug}`} value={admissionScopeKey({ kind: "repo", slug: r.slug })}>{S.wizardScopeRepo(r.slug)}</option>)}
          </select>
        </label>
        <button className="primary" data-testid="calibration-draw" onClick={() => void draw()}>{sample ? S.calibrationRedraw : S.calibrationDraw}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {sample && sample.items.length === 0 && <p className="muted" data-testid="calibration-empty">{S.calibrationEmpty}</p>}
      {sample && sample.items.length > 0 && (
        <ul className="calibration-items" data-testid="calibration-items">
          {sample.items.map((it) => {
            const mine = skipped.includes(it.lessonId) ? "skip" : stats?.marks[it.lessonId];
            return (
              <li key={it.lessonId} className="lesson" data-testid={`calibration-item-${it.lessonId}`}>
                <span className="lesson-text">{text(it.lessonId)}</span>
                <div className="lessons-row">
                  <span className="pill none">{S.calibrationBand[it.band]}</span>
                  <span className="muted">{S.lessonScoreTag(formatScore(it.score))} · {S.calibrationAuto[it.auto]}</span>
                  {MARKS.map((m) => (
                    <button
                      key={m}
                      className={mine === m ? "primary" : undefined}
                      aria-pressed={mine === m}
                      data-testid={`calibration-mark-${it.lessonId}-${m}`}
                      onClick={() => void send({ op: "mark", lessonId: it.lessonId, mark: m, since: sample.drawnAt })}
                    >
                      {S.calibrationMark[m]}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {stats && (
        <div className="calibration-stats" data-testid="calibration-stats">
          {sample && (
            <>
              <h3>{S.calibrationBandsTitle}</h3>
              <table className="policy-table">
                <thead>
                  <tr><th>{S.calibrationBandCol}</th><th>{S.calibrationMarkedCol}</th><th>{S.calibrationGoodCol}</th></tr>
                </thead>
                <tbody>
                  {stats.latest.bands.map((b) => (
                    <tr key={b.band} data-testid={`calibration-band-${b.band}`}>
                      <td>{S.calibrationBand[b.band]}</td>
                      <td>{b.marked}</td>
                      <td>{pct(bandAgreement(b))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p data-testid="calibration-agreement">{S.calibrationAgreement(pct(stats.latest.agreement))}</p>
            </>
          )}
          <p className="muted" data-testid="calibration-all">{S.calibrationAllTime(pct(stats.all.agreement), stats.all.marked, stats.all.review, stats.all.override)}</p>
          <div className="lessons-row">
            <span className="muted" data-testid="calibration-at">{stats.calibratedAt ? S.calibrationCalibratedAt(new Date(stats.calibratedAt).toLocaleString()) : S.calibrationNever}</span>
            <button data-testid="calibration-mark-calibrated" onClick={() => void send({ op: "markCalibrated" })}>{S.calibrationMarkCalibrated}</button>
          </div>
        </div>
      )}
      <PolicyEditor groups={["score"]} title={S.calibrationWeightsTitle} />
    </div>
  );
}
