import { useState } from "react";
import type { EpicFeatureRow } from "../../../shared/types";
import { S } from "../strings";

const formatTime = (ms: number): string => new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * epic 的「AI 总结」页签：每个没归档的 feature 一节（最新汇总、生成时间、卡住的地方），各自一个「立即更新」。
 * 没有一份 epic 整体的总结：每个 feature 各自更新，免得一下点出 N 次模型调用。onRun 返回给人看的结果。
 */
export function EpicSummaryTab({ rows, onRun }: { rows: EpicFeatureRow[]; onRun: (featureId: number) => Promise<string> }) {
  const live = rows.filter((r) => r.status !== "archived");
  if (live.length === 0) return <p className="muted">{S.noEpicFeatures}</p>;
  return <>{live.map((r) => <FeatureSummary key={r.id} row={r} onRun={() => onRun(r.id)} />)}</>;
}

/** 一节：更新中按钮不可点，连点也只发一次。 */
function FeatureSummary({ row, onRun }: { row: EpicFeatureRow; onRun: () => Promise<string> }) {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function run() {
    setRunning(true);
    setMessage(null);
    try {
      setMessage(await onRun());
    } finally {
      setRunning(false);
    }
  }
  return (
    <section className="epic-summary">
      <h3>{row.name}</h3>
      <div className="feature-summary">
        {row.summary === null ? <p className="muted">{S.epicNoSummary}</p> : <p>{row.summary}</p>}
        {row.blockers.map((b, n) => <p key={n} className="blocker">{S.labelled(S.featureBlocked, b)}</p>)}
      </div>
      <div className="summary-meta">
        {row.summaryAt !== null && <span className="muted summary-at">{formatTime(row.summaryAt)}</span>}
        <button disabled={running} onClick={() => void run()}>{running ? S.featureSummaryRunning : S.runFeatureSummary}</button>
        {message && <span className="muted">{message}</span>}
      </div>
    </section>
  );
}
