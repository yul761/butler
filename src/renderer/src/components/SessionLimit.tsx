import { useEffect, useState, useSyncExternalStore } from "react";
import type { SessionLimitView, SwitchModelResult } from "../../../shared/model-routing";
import { api } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";
import { LIVE_SCOPES } from "../state-bus";

/** 所有 session 行共用一份撞限列表：一次 stateChanged 只取一次。 */
let limits: SessionLimitView[] = [];
const listeners = new Set<() => void>();
let off: (() => void) | null = null;
let seq = 0;
function load() {
  const n = ++seq;
  api.sessionLimits().then((v) => {
    if (n !== seq) return;
    limits = v;
    for (const l of listeners) l();
  }, reportError);
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!off) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 撞限是活动的一部分（BTL-242）。
    const stop = api.onStateChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, 80);
    }, LIVE_SCOPES);
    off = () => {
      if (timer) clearTimeout(timer);
      stop();
    };
    load();
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && off) {
      off();
      off = null;
    }
  };
}

const REASON_MS = 5000;

/**
 * session 行上的撞限提示（3.0 模型路由）：哪个模型撞限，「换到 X 继续」按钮（结束终端，--resume + --model 接着）。
 * 没撞限时不显示。
 */
export function SessionLimit({ sessionId }: { sessionId: string }) {
  const all = useSyncExternalStore(subscribe, () => limits);
  const l = all.find((x) => x.sessionId === sessionId);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!failed) return;
    const t = setTimeout(() => setFailed(null), REASON_MS);
    return () => clearTimeout(t);
  }, [failed]);
  if (!l) return null;
  const sw = () =>
    api.switchModel(sessionId).then((r: SwitchModelResult) => {
      if (!r.ok) setFailed(r.reason);
    }, reportError);
  return (
    <span className="session-limit" data-testid="session-limit" title={l.message}>
      <span className="pill pending">{l.model ? S.rt.sessionLimit(l.model) : S.rt.sessionLimitNoModel}</span>
      {l.next ? (
        <button data-testid="session-switch" disabled={l.switching} onClick={() => void sw()}>{l.switching ? S.rt.switching : S.rt.switchNext(l.next)}</button>
      ) : <span className="muted">{S.rt.noNext}</span>}
      {failed && <span className="error">{S.rt.switchFailed(failed)}</span>}
      <button className="session-hide" title={S.rt.dismissLimit} aria-label={S.rt.dismissLimit} onClick={() => void api.dismissSessionLimit(sessionId).catch(reportError)}>×</button>
    </span>
  );
}
