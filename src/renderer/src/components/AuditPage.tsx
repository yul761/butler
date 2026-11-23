import type { ExternalActionEntry } from "../../../shared/external";
import { api } from "../api";
import { auditIsEmpty } from "../shipherd-self-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

const formatTime = (ms: number) => new Date(ms).toLocaleString([], { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** 审计页：只有 Shipherd 替你做过的对外动作（BTL-243 起 Shipherd 不再调用任何模型，没有模型调用的记录了）。 */
export function AuditPage() {
  const external = useStateRefetch("externalAudit", () => api.externalAudit());
  return (
    <div className="page">
      <h2>{S.audit}</h2>
      <p className="muted">{S.lay.auditLede}</p>
      {external !== null && auditIsEmpty(external.length) && <AuditEmptyNote />}
      <ExternalAudit entries={external} />
    </div>
  );
}

/** 一条记录都没有时的说明：Shipherd 默认不对外做事，所以空是正常的。 */
export function AuditEmptyNote() {
  return <p className="muted" data-testid="audit-empty-note">{S.lay.auditEmpty}</p>;
}

/** 对外动作的记录（契约 4.8，ws-b）：做了、失败、开关关着跳过的都在这里。新的在前，最多 200 条。 */
export function ExternalAuditList({ entries }: { entries: ExternalActionEntry[] }) {
  if (entries.length === 0) return <p className="muted">{S.externalAuditNone}</p>;
  const c = S.externalCols;
  return (
    <table className="ticket-table external-audit">
      <thead>
        <tr><th>{c.time}</th><th>{c.kind}</th><th>{c.where}</th><th>{c.target}</th><th>{c.summary}</th><th>{c.outcome}</th></tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id} className={`outcome-${e.outcome}`}>
            <td>{formatTime(e.ts)}</td>
            <td>{e.kind === "update_check" ? S.update.auditKind : S.externalActions[e.kind].label}</td>
            <td>{[e.repoSlug, e.ticketKey].filter(Boolean).join(" · ") || "—"}</td>
            <td>{e.target ?? "—"}</td>
            <td>
              {e.summary}
              {e.payload && (
                <details>
                  <summary className="muted">{c.payload}</summary>
                  <pre className="raw">{e.payload}</pre>
                </details>
              )}
            </td>
            <td className={e.outcome === "failed" ? "error" : undefined}>{e.error ? S.labelled(S.externalOutcome[e.outcome], e.error) : S.externalOutcome[e.outcome]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ExternalAudit({ entries }: { entries: ExternalActionEntry[] | null }) {
  return (
    <section className="external-audit-section" data-testid="external-audit">
      <h3>{S.externalAuditHeading}</h3>
      {entries !== null && <ExternalAuditList entries={entries} />}
    </section>
  );
}
