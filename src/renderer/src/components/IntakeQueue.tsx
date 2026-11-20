import { useState } from "react";
import { INTAKE_RISKS, INTAKE_SIZES, type IntakeAction, type IntakeEffect, type IntakeItemView, type IntakeRisk, type IntakeSize, type IntakeView } from "../../../shared/intake";
import { api } from "../api";
import { reportError } from "../errors";
import { intakeActError, intakeItemActions, intakeStateText } from "../intake-view";
import { shortTime } from "../progress-ui";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

/** 全部工作页「更多」里的「自动接活」队列（工作流 N）：拉来的 ticket、分类、状态和操作。总开关关着、也没拉来过东西时不显示。 */
export function IntakeQueue({ onOpenTicket }: { onOpenTicket: (key: string) => void }) {
  const view = useStateRefetch("intake-view", api.intakeView);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  if (!view || (!view.active && view.items.length === 0)) return null;
  const poll = () => {
    setMessage(null);
    void api.intakePoll().then((r) => r.ok || setMessage({ text: S.ik.pollFailed(r.message), error: true }), reportError);
  };
  return (
    <section className="progress-intake" data-testid="progress-intake">
      <h3>{S.ik.queueTitle}</h3>
      <p className="muted" data-testid="intake-status">
        {view.active ? S.ik.running(view.running) : S.ik.inactive}
        {" · "}
        {view.polling ? S.ik.polling : view.lastPollAt === null ? S.ik.neverPolled : S.ik.lastPoll(shortTime(view.lastPollAt))}
        {view.lastPollError && <span className="error"> · {S.ik.lastPollError(view.lastPollError)}</span>}
      </p>
      {view.active && !view.preReviewOn && <p className="muted" data-testid="intake-prereview-off">{S.ik.preReviewOff}</p>}
      <div className="actions">
        <button data-testid="intake-poll" disabled={!view.active || view.polling} onClick={poll}>{S.ik.pollNow}</button>
      </div>
      {message && <p className={message.error ? "error" : "muted"} role={message.error ? "alert" : "status"} data-testid="intake-message">{message.text}</p>}
      {view.items.length === 0 ? <p className="muted">{S.ik.queueEmpty}</p> : (
        <table className="ticket-table" data-testid="intake-queue">
          <thead>
            <tr>
              <th>{S.ik.cols.ticket}</th><th>{S.ik.cols.repo}</th><th>{S.ik.cols.size}</th><th>{S.ik.cols.risk}</th><th>{S.ik.cols.clarify}</th>
              <th>{S.ik.cols.state}</th><th>{S.ik.cols.tier}</th><th>{S.ik.cols.pr}</th><th>{S.ik.cols.actions}</th>
            </tr>
          </thead>
          <tbody>
            {view.items.map((i) => <IntakeRow key={i.key} item={i} view={view} onOpenTicket={onOpenTicket} onMessage={setMessage} />)}
          </tbody>
        </table>
      )}
    </section>
  );
}

function IntakeRow({ item: i, view, onOpenTicket, onMessage }: {
  item: IntakeItemView; view: IntakeView; onOpenTicket: (key: string) => void; onMessage: (m: { text: string; error: boolean } | null) => void;
}) {
  const [repo, setRepo] = useState("");
  const c = i.classification;
  const fixed = i.state === "started" || i.state === "split";
  const edited = (d: "size" | "risk" | "clarify") => (i.userDims.includes(d) ? <span className="muted"> · {S.ik.edited}</span> : null);
  const done = (r: { ok: true } | { ok: false; message: string }) => (r.ok ? onMessage(null) : onMessage({ text: intakeActError(r.message, S), error: true }));
  const act = (op: IntakeAction["op"]) => {
    if (op === "setRepo") {
      if (!repo) return onMessage({ text: S.ik.pickRepo, error: true });
      return void api.intakeAct({ op, key: i.key, repoPath: repo }).then(done, reportError);
    }
    void api.intakeAct({ op, key: i.key } as IntakeAction).then(done, reportError);
  };
  const classify = (patch: { size?: IntakeSize; risk?: IntakeRisk; clarify?: boolean }) => void api.intakeClassify({ key: i.key, ...patch }).then(done, reportError);
  const actions = intakeItemActions(i);
  return (
    <tr data-testid={`intake-row-${i.key}`} data-state={i.state}>
      <td>
        {i.ticketKey ? <button className="chip" onClick={() => onOpenTicket(i.ticketKey!)}>{i.key}</button> : <code>{i.key}</code>}{" "}
        <span>{i.title}</span>
        {i.parentKey && <span className="muted"> · {i.parentKey}{i.layer !== null ? ` #${i.layer}` : ""}</span>}
        <details>
          <summary className="muted">{S.ik.reasonsTitle} · {S.ik.classSource[c.source] ?? c.source}{c.confidence !== null ? ` ${c.confidence.toFixed(2)}` : ""}</summary>
          <ul>
            {c.reasons.map((r, n) => <li key={n} className="muted">{r.dim} · {r.rule}{r.detail ? ` · ${r.detail}` : ""}</li>)}
          </ul>
          {c.expectedPaths.length > 0 && <p className="muted">{S.ik.expectedPaths(c.expectedPaths.join(", "))}</p>}
          {i.detail && <p className="muted">{i.detail}</p>}
        </details>
      </td>
      <td className="muted">{i.repoSlug ?? i.repoPath ?? S.ik.unknown}</td>
      <td>
        <select aria-label={S.ik.cols.size} data-testid={`intake-size-${i.key}`} disabled={fixed} value={c.size ?? ""} onChange={(e) => classify({ size: e.target.value as IntakeSize })}>
          {c.size === null && <option value="">{S.ik.unknown}</option>}
          {INTAKE_SIZES.map((s) => <option key={s} value={s}>{S.ik.size[s]}</option>)}
        </select>
        {edited("size")}
      </td>
      <td>
        <select aria-label={S.ik.cols.risk} data-testid={`intake-risk-${i.key}`} disabled={fixed} value={c.risk ?? ""} onChange={(e) => classify({ risk: e.target.value as IntakeRisk })}>
          {c.risk === null && <option value="">{S.ik.unknown}</option>}
          {INTAKE_RISKS.map((r) => <option key={r} value={r}>{S.ik.risk[r]}</option>)}
        </select>
        {edited("risk")}
      </td>
      <td>
        <select aria-label={S.ik.cols.clarify} data-testid={`intake-clarify-${i.key}`} disabled={fixed} value={c.clarify ? "1" : "0"} onChange={(e) => classify({ clarify: e.target.value === "1" })}>
          <option value="0">{S.ik.complete}</option>
          <option value="1">{S.ik.incomplete}</option>
        </select>
        {edited("clarify")}
      </td>
      <td data-testid={`intake-state-${i.key}`}>{intakeStateText(i, S)}</td>
      <td className="muted">{i.tier ? `${i.tier}${i.model ? ` · ${i.model}` : ""}` : S.ik.unknown}</td>
      <td>
        {i.pr ? (
          <span>
            #{i.pr.number}
            {i.pr.risk && <span className="muted"> · {S.rv.riskBadge(S.rv.level[i.pr.risk])}</span>}
            {i.pr.ready !== null && <span className="muted"> · {i.pr.ready ? S.rv.ready : S.rv.notReady}</span>}
          </span>
        ) : S.ik.unknown}
      </td>
      <td>
        {actions.includes("setRepo") && (
          <select aria-label={S.ik.pickRepo} data-testid={`intake-repo-${i.key}`} value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="">{S.ik.pickRepo}</option>
            {view.repos.map((r) => <option key={r.path} value={r.path}>{r.slug ?? r.path}</option>)}
          </select>
        )}
        {actions.map((op) => <button key={op} data-testid={`intake-${op}-${i.key}`} className={op === "start" ? "primary" : undefined} onClick={() => act(op)}>{S.ik.actions[op]}</button>)}
      </td>
    </tr>
  );
}

/** 「效果」页的「自动接活」卡片：分类、自动开工、叫你决定、你改分类的比例（工作流 N）。 */
export function IntakeEffectSection({ e }: { e: IntakeEffect }) {
  if (e.classified === 0 && e.decisions === 0) return null;
  const dim = (d: "size" | "risk" | "clarify") => e.byDim.find((x) => x.dim === d)?.n ?? 0;
  const card = (testId: string, title: string, value: string, sub: string) => (
    <div className="effect-card" data-testid={testId}>
      <div className="effect-card-title">{title}</div>
      <div className="effect-card-value">{value}</div>
      <div className="effect-card-sub muted">{sub}</div>
    </div>
  );
  return (
    <section className="effect-section" data-testid="effect-intake">
      <h3>{S.ik.effTitle}</h3>
      <p className="muted">{S.ik.effIntro}</p>
      <div className="effect-cards">
        {card("effect-intake-classified", S.ik.effClassified, String(e.classified), S.ik.effClassifiedSub(e.clarify))}
        {card("effect-intake-started", S.ik.effStarted, String(e.autoStarted), S.ik.effStartedSub(e.manualStarted))}
        {card("effect-intake-decisions", S.ik.effDecisions, String(e.decisions), S.ik.effDecisionsSub)}
        {card(
          "effect-intake-override", S.ik.effOverride, e.overrideRate === null ? S.ik.unknown : `${Math.round(e.overrideRate * 100)}%`,
          S.ik.effOverrideSub(e.overriddenItems, dim("size"), dim("risk"), dim("clarify")),
        )}
      </div>
    </section>
  );
}
