import { useState, useSyncExternalStore } from "react";
import type { CostBreakerView } from "../../../shared/cost";
import { api } from "../api";
import { breakerFor, costAmount, costBreakerText } from "../cost-view";
import { reportError } from "../errors";
import { S } from "../strings";

/** 所有 session 行共用一份熔断列表：一次 stateChanged 只取一次（同 SessionLimit）。 */
let breakers: CostBreakerView[] = [];
const listeners = new Set<() => void>();
let off: (() => void) | null = null;
let seq = 0;
function load() {
  const n = ++seq;
  api.costBreakers().then((v) => {
    if (n !== seq) return;
    breakers = v;
    for (const l of listeners) l();
  }, reportError);
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!off) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = api.onStateChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, 80);
    });
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

/** session 行上的成本熔断提示（工作流 L）：状态、一句话（悬停看全），降档 / 暂停了有「继续并提高上限」。 */
export function SessionCost({ sessionId, ticketKey }: { sessionId: string; ticketKey: string | null }) {
  const all = useSyncExternalStore(subscribe, () => breakers);
  const b = breakerFor(all, sessionId, ticketKey);
  const [done, setDone] = useState<string | null>(null);
  if (!b) return null;
  const raise = () =>
    api.costResume(b.subjectKind, b.subjectId).then((r) => setDone(r.ok ? S.cs.raised(costAmount(r.cap, b.unit, S)) : S.cs.raiseGone), reportError);
  return (
    <span className="session-limit" data-testid="session-cost" title={costBreakerText(b, S)}>
      <span className={b.state === "paused" ? "pill changes" : "pill pending"}>{S.cs.state[b.state]} · {costAmount(b.spent, b.unit, S)} / {costAmount(b.cap, b.unit, S)}</span>
      {b.state !== "warned" && <button data-testid="session-cost-raise" onClick={() => void raise()}>{S.cs.raise}</button>}
      {done && <span className="muted">{done}</span>}
    </span>
  );
}
