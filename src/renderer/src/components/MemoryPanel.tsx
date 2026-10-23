import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryView, WhyEntry } from "../../../shared/memory";
import { api } from "../api";
import { memoryChangeConcerns, memorySections, trailingDebounce, whyLines } from "../memory-view";
import { S } from "../strings";

/** 启动补同步、打开记忆时的全量同步会连着来很多次记忆事件；重读要打开 StateCore，所以合并成一次。 */
const RELOAD_DEBOUNCE_MS = 500;
/** 记忆标签开着时多久重读一次（claude 在 session 里写的记忆）。 */
const MEMORY_POLL_MS = 30_000;

function formatIso(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function MemoryPanel({ ticketKey }: { ticketKey: string }) {
  const [view, setView] = useState<MemoryView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [why, setWhy] = useState<{ id: string; chain: WhyEntry[] | null } | null>(null);

  const [whyError, setWhyError] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const whySeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const v = await api.memoryView(ticketKey);
      if (seq !== loadSeq.current) return;
      setView(v);
      setLoadError(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [ticketKey]);

  useEffect(() => {
    setView(null);
    setWhy(null);
    setWhyError(null);
    void load();
    const reload = trailingDebounce(() => void load(), RELOAD_DEBOUNCE_MS);
    // 只听记忆专用的事件（最终审查 4）：stateChanged 在 session 进行中很频繁，每次都重新打开 StateCore 会和 claude 里挂的 MCP 抢写锁。
    const off = api.onMemoryChanged((changed) => {
      if (memoryChangeConcerns(changed, ticketKey)) reload();
    });
    // claude 在 session 里经 MCP 写的记忆不会触发 memory:changed：标签开着时，回到窗口就重读，另外每 30 秒（窗口可见时）重读一次。
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, MEMORY_POLL_MS);
    return () => {
      loadSeq.current++; // 卸载或换 ticket 后，在途的响应不再写状态
      whySeq.current++;
      reload.cancel();
      off();
      window.removeEventListener("focus", onFocus);
      clearInterval(poll);
    };
  }, [load, ticketKey]);

  async function toggleWhy(id: string) {
    setWhyError(null);
    if (why?.id === id) {
      whySeq.current++;
      setWhy(null);
      return;
    }
    const seq = ++whySeq.current;
    try {
      const chain = await api.memoryWhy(ticketKey, id);
      if (seq === whySeq.current) setWhy({ id, chain });
    } catch (e) {
      if (seq === whySeq.current) setWhyError(e instanceof Error ? e.message : String(e));
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
      {whyError && <p className="error">{S.memoryLoadFailed(whyError)}</p>}
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
