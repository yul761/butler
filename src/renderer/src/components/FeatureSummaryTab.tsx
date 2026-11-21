import { useState } from "react";
import type { FeatureView } from "../../../shared/types";
import { S } from "../strings";
import { useCollapsed } from "./useCollapsed";

/** 一次「立即更新」的结果：bad 为真时标红（失败、限流、降级）。 */
export interface SummaryRunMessage { text: string; bad: boolean }

/** 这一页签要的 feature 字段（便于测试）。 */
export type FeatureSummaryFeature = Pick<FeatureView, "id" | "summary" | "brief"> & { tickets: Pick<FeatureView["tickets"][number], "key">[] };

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * feature 的「AI 总结」页签（设计文档 2026-10-28）：最新一份 feature 汇总的那段话、卡住的地方、下一步，
 * 以及生成时间、来源和「立即更新」按钮；下面是 epic session 写的规划。只显示最新一份，不做历史。
 * onRun 返回给人看的结果，不应 reject（reject 了也只显示通用错误）。
 */
export function FeatureSummaryTab({ feature, onOpenTicket, onRun }: {
  feature: FeatureSummaryFeature; onOpenTicket: (key: string) => void; onRun: () => Promise<SummaryRunMessage>;
}) {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<SummaryRunMessage | null>(null);
  const summary = feature.summary;
  // 汇总里的 ticket 后来可能归档了：只有还在这个 feature 下的才能点。
  const keys = new Set(feature.tickets.map((t) => t.key));

  async function runNow() {
    setRunning(true);
    setMessage(null);
    try {
      setMessage(await onRun());
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), bad: true });
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="feature-progress">
      {!summary ? (
        <p className="muted">{S.featureSummaryNone}</p>
      ) : summary.payload ? (
        <div className="feature-summary">
          <p>{summary.payload.summary}</p>
          {summary.payload.blockers.map((b, n) => (
            <p key={n} className="blocker">{S.labelled(S.featureBlocked, b)}</p>
          ))}
          {summary.payload.next_steps.length > 0 && (
            <>
              <strong>{S.nextSteps}</strong>
              <ul>
                {summary.payload.next_steps.map((step, n) => (
                  <li key={n}>
                    {step.ticket && (keys.has(step.ticket) ? (
                      <button className="chip" onClick={() => onOpenTicket(step.ticket!)}>{step.ticket}</button>
                    ) : (
                      <span className="key">{step.ticket}</span>
                    ))}
                    {step.ticket && " "}
                    {step.text}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        <div className="feature-summary">
          <p className="error">{S.featureSummaryDegraded}</p>
          <pre className="raw">{summary.rawText ?? ""}</pre>
        </div>
      )}
      <div className="summary-meta">
        {summary && (
          <span className="muted">
            {formatTime(summary.createdAt)} · {S.featureSummaryTrigger[summary.trigger]} · {S.featureSummaryPrAsOf(formatTime(summary.prStatusAt ?? summary.createdAt))}
          </span>
        )}
        <button disabled={running} onClick={() => void runNow()}>{running ? S.featureSummaryRunning : S.runFeatureSummary}</button>
        {message && <span className={message.bad ? "error" : "muted"}>{message.text}</span>}
      </div>
      {feature.brief && <FeatureBrief featureId={feature.id} brief={feature.brief} />}
    </section>
  );
}

/** epic session 建 feature 时写的规划。收起也按 feature 记。规划是数据，只当文字显示。 */
function FeatureBrief({ featureId, brief }: { featureId: number; brief: string }) {
  const [collapsed, toggle] = useCollapsed(`brief:${featureId}`);
  return (
    <div className="feature-brief">
      <button className="section-toggle" aria-expanded={!collapsed} onClick={toggle}>
        <span className="twisty">{collapsed ? "▸" : "▾"}</span>
        {S.featureBrief}
      </button>
      {!collapsed && <p>{brief}</p>}
    </div>
  );
}
