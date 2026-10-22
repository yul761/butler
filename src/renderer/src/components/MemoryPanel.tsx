import { useCallback, useEffect, useState } from "react";
import type { MemoryView, WhyEntry } from "../../../shared/memory";
import { api } from "../api";
import { reportError } from "../errors";
import { memorySections, trailingDebounce, whyLines } from "../memory-view";
import { S } from "../strings";

/** stateChanged 很频繁（终端输出、hook 事件），重读记忆要打开 StateCore，所以合并成一次。 */
const RELOAD_DEBOUNCE_MS = 500;

function formatIso(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function MemoryPanel({ ticketKey }: { ticketKey: string }) {
  const [view, setView] = useState<MemoryView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [why, setWhy] = useState<{ id: string; chain: WhyEntry[] | null } | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.memoryView(ticketKey));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [ticketKey]);

  useEffect(() => {
    setView(null);
    setWhy(null);
    void load();
    const reload = trailingDebounce(() => void load(), RELOAD_DEBOUNCE_MS);
    const off = api.onStateChanged(reload);
    return () => {
      reload.cancel();
      off();
    };
  }, [load]);

  async function toggleWhy(id: string) {
    if (why?.id === id) {
      setWhy(null);
      return;
    }
    try {
      setWhy({ id, chain: await api.memoryWhy(ticketKey, id) });
    } catch (e) {
      reportError(e);
    }
  }

  function whyBlock(id: string) {
    if (why?.id !== id) return null;
    return (
      <div className="why-chain">
        <span className="muted">{S.memoryWhyTitle}</span>
        {why.chain === null ? (
          <p className="muted">{S.whyNone}</p>
        ) : (
          <ol>
            {whyLines(why.chain, formatIso).map((l, i) => (
              <li key={i} className={`why-${l.state}`}>
                <span>{l.text}</span>{" "}
                <span className="muted">
                  {l.when} · {S.whyState[l.state]}
                  {l.note ? ` · ${l.note}` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }

  if (!view) return loadError ? <p className="error">{S.memoryLoadFailed(loadError)}</p> : <p className="muted">{S.loading}</p>;
  if (!view.enabled) return <p className="muted">{S.memoryOff}</p>;
  const sections = memorySections(view.items);
  const handoff = view.handoff;
  const error = loadError ?? view.error;
  return (
    <div className="memory-panel">
      {error && <p className="error">{S.memoryLoadFailed(error)}</p>}
      <p className="muted">{S.memoryHint}</p>
      {handoff && (
        <div className="memory-handoff">
          <div className="actions">
            <strong>{S.memoryHandoff}</strong>
            <span className="muted">
              {formatIso(handoff.addedAt)} · {S.memoryVersions(handoff.versionCount)}
            </span>
            <button onClick={() => void toggleWhy(handoff.id)}>{S.memoryWhy}</button>
          </div>
          <pre className="raw">{handoff.content}</pre>
          {whyBlock(handoff.id)}
        </div>
      )}
      {!handoff && sections.length === 0 && !error && <p className="muted">{S.memoryEmpty}</p>}
      {sections.map((sec) => (
        <div key={sec.title} className="memory-section">
          <span className="muted">{sec.title}</span>
          {sec.rows.map(({ item, text }) => (
            <div key={item.factKey} className="memory-item">
              <div className="actions">
                <span className="text">{text}</span>
                {item.createdAt && <span className="muted">{formatIso(item.createdAt)}</span>}
                {item.factId && <button onClick={() => void toggleWhy(item.factId!)}>{S.memoryWhy}</button>}
              </div>
              {item.factId && whyBlock(item.factId)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
