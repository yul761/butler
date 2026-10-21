import { useCallback, useEffect, useState } from "react";
import type { AuditEntry, AuditPage as AuditPageData } from "../../../shared/llm";
import { api } from "../api";
import { auditSummary, blockedText, prettyBody, prettyJson } from "../audit-view";
import { reportError } from "../errors";
import { formatUsd } from "../privacy-form";
import { S } from "../strings";

const formatTime = (ms: number) => new Date(ms).toLocaleString([], { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 展开后才排版：几百 KB 的请求体不在列表渲染时处理。所有文本都只作为 React 文本子节点渲染。 */
function EntryDetail({ e }: { e: AuditEntry }) {
  return (
    <>
      {e.blockedReason && <p className="error">{S.auditBlocked(blockedText(e.blockedReason))}</p>}
      {e.error && <p className="error">{e.error}</p>}
      <h4>{S.auditPayload}</h4>
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

  const load = useCallback(async () => {
    try {
      const p = await api.audit();
      setPage(p);
      setEntries(p.entries);
      setHasMore(p.hasMore);
    } catch (e) {
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
    setLoadingMore(true);
    try {
      const p = await api.audit(last.id);
      setEntries((cur) => [...cur, ...p.entries]);
      setHasMore(p.hasMore);
    } catch (e) {
      reportError(e);
    } finally {
      setLoadingMore(false);
    }
  }

  if (!page) return <p className="empty">{S.loading}</p>;
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
    </div>
  );
}
