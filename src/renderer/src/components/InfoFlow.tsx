// 信息流转（BTL-272）：从对话里抽出来的要点——记进了哪一级记忆、发给了谁、送到没有、同步了什么状态。点「看原话」看那一轮双方说的话。
// epic 页的「信息流转」tab、Shipherd 总控页对话下面默认折起的一块。新的在前。
import { useState } from "react";
import type { FlowItemView, FlowScope, FlowTurnText } from "../../../shared/infoflow";
import { api } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";
import { flowActionButtons, flowActionText, flowDeliveryText, flowMemoryText } from "../infoflow-view";
import { useStateRefetch } from "./useStateRefetch";

const shortTime = (iso: string) => new Date(iso).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function Original({ turnId }: { turnId: number }) {
  const [turn, setTurn] = useState<FlowTurnText | null | "loading">(null);
  const toggle = () => {
    if (turn !== null) return setTurn(null);
    setTurn("loading");
    api.infoflowTurn(turnId).then(setTurn, (e: unknown) => (setTurn(null), reportError(e)));
  };
  return (
    <div className="flow-original">
      <button className="link" data-testid="flow-original-toggle" onClick={toggle}>{turn === null ? S.infoflow.showOriginal : S.infoflow.hideOriginal}</button>
      {turn === "loading" && <p className="muted">{S.infoflow.loading}</p>}
      {turn !== null && turn !== "loading" && (
        turn.messages.length === 0 ? <p className="muted">{S.infoflow.noOriginal}</p> : (
          <div className="flow-original-text" data-testid="flow-original">
            {turn.messages.map((m, i) => (
              <div key={i} className={`flow-msg role-${m.role}`}>
                <span className="muted">{S.infoflow.roles[m.role]} · {shortTime(m.at)}</span>
                <p>{m.text}</p>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function FlowItem({ item: it }: { item: FlowItemView }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const act = (what: "apply" | "reject" | "undo" | "retry" | "accept") => {
    if (!it.action) return;
    setBusy(true);
    setFailed(false);
    api.infoflowAct(it.action.id, what).then((ok) => setFailed(!ok), reportError).finally(() => setBusy(false));
  };
  return (
    <li className={`flow-item kind-${it.kind}`} data-testid="flow-item" data-kind={it.kind}>
      <div className="message-head">
        <strong>{S.infoflow.kinds[it.kind]}</strong>
        <span className="muted">{S.infoflow.from(it.source)} · {S.infoflow.speaker[it.speaker]}</span>
        {it.importance !== "normal" && <span className={`badge importance-${it.importance}`}>{S.infoflow.importance[it.importance]}</span>}
        <span className="muted">{shortTime(it.createdAt)}</span>
      </div>
      <p className="message-text">{it.text}</p>
      <p className="muted" data-testid="flow-memory">{flowMemoryText(it, S)}</p>
      <p className="muted" data-testid="flow-deliveries">{flowDeliveryText(it, S)}</p>
      {it.action && (
        <div className="flow-action" data-testid="flow-action" data-state={it.action.state}>
          <span>{flowActionText(it.action, S)}</span>
          {flowActionButtons(it.action).map((b) => (
            <button key={b} disabled={busy} data-testid={`flow-${b}`} className={b === "apply" ? "primary" : undefined} onClick={() => act(b)}>{S.infoflow[b]}</button>
          ))}
          {failed && <span className="muted">{S.infoflow.actFailed}</span>}
        </div>
      )}
      <Original turnId={it.turnId} />
    </li>
  );
}

export function InfoFlowItems({ items }: { items: FlowItemView[] }) {
  if (items.length === 0) return <p className="muted">{S.infoflow.empty}</p>;
  return (
    <ul className="message-list flow-list" data-testid="flow-list">
      {items.map((it) => <FlowItem key={it.id} item={it} />)}
    </ul>
  );
}

const flowKey = (scope: FlowScope) => ("all" in scope ? "infoflow:all" : `infoflow:feature:${scope.featureId}`);

/** epic 页的「信息流转」tab：整页列表。 */
export function InfoFlowPanel({ scope }: { scope: FlowScope }) {
  const items = useStateRefetch(flowKey(scope), () => api.infoflowList(scope));
  return (
    <section className="flow-panel" data-testid="flow-panel">
      <p className="muted">{S.infoflow.help}</p>
      {items === null ? <p className="muted">{S.infoflow.loading}</p> : <InfoFlowItems items={items} />}
    </section>
  );
}

/** Shipherd 总控页对话下面默认折起的「信息流转（N）」；还没取到时不显示。 */
export function InfoFlowSummary({ scope }: { scope: FlowScope }) {
  const items = useStateRefetch(flowKey(scope), () => api.infoflowList(scope));
  if (items === null) return null;
  return (
    <details className="flow-summary" data-testid="flow-summary">
      <summary>{S.infoflow.summary(items.length)}</summary>
      <p className="muted">{S.infoflow.help}</p>
      <InfoFlowItems items={items} />
    </details>
  );
}
