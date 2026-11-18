import { useCallback, useEffect, useRef, useState } from "react";
import type { ExternalActionEntry } from "../../../shared/external";
import type { AuditEntry, AuditPage as AuditPageData } from "../../../shared/llm";
import { api } from "../api";
import { auditSummary, blockedText, bodyHeading, bodyMaybeSent, prettyBody, prettyJson } from "../audit-view";
import { reportError } from "../errors";
import { formatUsd } from "../privacy-form";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

const formatTime = (ms: number) => new Date(ms).toLocaleString([], { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** 展开后才排版：几百 KB 的请求体不在列表渲染时处理。所有文本都只作为 React 文本子节点渲染。 */
function EntryDetail({ e }: { e: AuditEntry }) {
  return (
    <>
      {e.blockedReason && <p className="error">{S.auditBlocked(blockedText(e.blockedReason))}</p>}
      {e.error ? <p className="error">{e.error}</p> : e.status === "declined" && <p className="muted">{S.auditDeclined}</p>}
      {e.payloadSent && bodyMaybeSent(e.status) && <p className="muted">{S.auditMaybeSentNote}</p>}
      <h4>{bodyHeading(e.status)}</h4>
      <pre className="raw">{e.payloadSent ? prettyBody(e.payloadSent) : S.auditNothingSent}</pre>
      {e.response && (
        <>
          <h4>{S.auditResponse}</h4>
          <pre className="raw">{prettyJson(e.response)}</pre>
        </>
      )}
    </>
  );
}

export function AuditPage() {
  const [page, setPage] = useState<AuditPageData | null>(null);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const [failed, setFailed] = useState(false);
  /** 每次重新加载就加一；翻页请求回来时发现变了就丢弃。 */
  const gen = useRef(0);

  const load = useCallback(async () => {
    const g = ++gen.current;
    try {
      const p = await api.audit();
      if (g !== gen.current) return;
      setFailed(false);
      setPage(p);
      setEntries(p.entries);
      setHasMore(p.hasMore);
    } catch (e) {
      if (g !== gen.current) return;
      setFailed(true);
      reportError(e);
    }
  }, []);

  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

  async function more() {
    const last = entries[entries.length - 1];
    if (!last) return;
    const g = gen.current;
    setLoadingMore(true);
    try {
      const p = await api.audit(last.id);
      if (g !== gen.current) return;
      setEntries((cur) => {
        const seen = new Set(cur.map((x) => x.id));
        return [...cur, ...p.entries.filter((x) => !seen.has(x.id))];
      });
      setHasMore(p.hasMore);
    } catch (e) {
      reportError(e);
    } finally {
      setLoadingMore(false);
    }
  }

  if (!page) {
    return failed ? (
      <div className="empty">
        <p className="error">{S.auditLoadFailed}</p>
        <button onClick={() => void load()}>{S.retry}</button>
      </div>
    ) : (
      <p className="empty">{S.loading}</p>
    );
  }
  return (
    <div className="page">
      <h2>{S.audit}</h2>
      <p className="muted">{S.auditIntro}</p>
      <p>{S.monthSpend(formatUsd(page.monthCostUsd), formatUsd(page.budgetUsd))}</p>
      {entries.length === 0 && <p className="empty">{S.auditEmpty}</p>}
      {entries.map((e) => (
        <details
          key={e.id}
          className="audit-entry"
          open={open.has(e.id)}
          onToggle={(ev) => {
            const isOpen = ev.currentTarget.open;
            setOpen((cur) => {
              if (cur.has(e.id) === isOpen) return cur;
              const next = new Set(cur);
              if (isOpen) next.add(e.id);
              else next.delete(e.id);
              return next;
            });
          }}
        >
          <summary>
            <strong>{formatTime(e.ts)}</strong>
            <span>{e.provider} · {e.model}</span>
            <span className="muted">{auditSummary(e)}</span>
          </summary>
          {open.has(e.id) && <EntryDetail e={e} />}
        </details>
      ))}
      {hasMore && <button disabled={loadingMore} onClick={() => void more()}>{S.loadMore}</button>}
      <ExternalAudit />
    </div>
  );
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
            <td>{S.externalActions[e.kind].label}</td>
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

function ExternalAudit() {
  const entries = useStateRefetch("externalAudit", () => api.externalAudit());
  return (
    <section className="external-audit-section" data-testid="external-audit">
      <h3>{S.externalAuditHeading}</h3>
      {entries !== null && <ExternalAuditList entries={entries} />}
    </section>
  );
}
