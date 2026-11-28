import { useState } from "react";
import {
  MERGE_BY, NOTE_LIMIT, NOTES_LIMIT, REVIEW_BOTS, RE_REVIEW_MAX_ROUNDS, WORKFLOW_PRESETS, WORKFLOW_SCOPE_KINDS, presetOf, presetWorkflow, sameWorkflowScope,
  type FeatureWorkflowView, type TicketWorkflowView, type Workflow, type WorkflowLayerView, type WorkflowScope, type WorkflowScopeKind,
  type WorkflowSettingsView, type WorkflowStep, type WorkflowStepId, workflowWantsComments,
} from "../../../shared/workflow";
import { api } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";
import { addableSteps, insertStep, layerTitle, moveStep, removeStep, scopeFor, setStepOption } from "../workflow-edit";
import { useStateRefetch } from "./useStateRefetch";

/**
 * 工作流程（BTL-273）的界面：步骤条（ticket 首页、epic 页）、设置页的分层编辑器。
 */

/** 一排步骤：做完的打勾，当前这一步高亮。 */
export function WorkflowSteps({ steps, current }: { steps: { id: WorkflowStepId; state?: "done" | "current" | "todo"; doneAt?: number | null; rounds?: number }[]; current?: WorkflowStepId | null }) {
  const t = S.workflow;
  return (
    <ol className="workflow-steps" data-testid="workflow-steps">
      {steps.map((s) => {
        const state = s.state ?? (s.id === current ? "current" : "todo");
        const title = [s.doneAt ? t.doneAt(new Date(s.doneAt).toLocaleString()) : null, s.rounds ? t.rounds_(s.rounds) : null].filter(Boolean).join(" · ");
        return (
          <li key={s.id} className={`workflow-step ${state}`} data-step={s.id} data-state={state} title={title || undefined}>
            {state === "done" ? "✓ " : ""}{t.steps[s.id]}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * 流程里有 review 类的步骤时，评论闭环会被打开（overrides.ts 的 loopWithWorkflow，和主进程同一个判断）。
 * 说清楚：评论会转给 session，但回不回 GitHub 还按用户自己的对外动作开关。
 */
export function WorkflowLoopNote({ workflow }: { workflow: Workflow | null }) {
  if (!workflowWantsComments(workflow)) return null;
  return <p className="muted workflow-loop-note" data-testid="workflow-loop-note">{S.workflow.loopOn}</p>;
}

/** ticket 首页的流程条（纯视图）：没有流程时什么都不画。 */
export function TicketWorkflowStrip({ view }: { view: TicketWorkflowView | null }) {
  if (!view?.workflow) return null;
  const t = S.workflow;
  const where = view.source ? layerTitle(view.source.scope, view.source.label) : "";
  return (
    <section className="workflow-strip" data-testid="ticket-workflow">
      <span className="muted">{t.strip}</span>
      <WorkflowSteps steps={view.steps} />
      <span className="muted">{view.current ? `${t.current}${t.steps[view.current]}` : t.allDone}{where ? ` · ${t.from(where)}` : ""}</span>
      <WorkflowLoopNote workflow={view.workflow} />
    </section>
  );
}

export function TicketWorkflow({ ticketKey }: { ticketKey: string }) {
  const view = useStateRefetch(`workflow-ticket:${ticketKey}`, () => api.workflowTicket(ticketKey));
  return <TicketWorkflowStrip view={view} />;
}

/** epic 页的流程条（纯视图）：epic 自己设的（或「按上层的」），每个有流程的 ticket 走到哪。都没有时不画。 */
export function FeatureWorkflowStrip({ view, onOpenSettings }: { view: FeatureWorkflowView | null; onOpenSettings?: () => void }) {
  if (!view || (view.own === null && view.tickets.length === 0)) return null;
  const t = S.workflow;
  return (
    <section className="workflow-strip feature" data-testid="feature-workflow">
      <span className="muted">{view.own ? t.epicOwn : t.epicInherit}</span>
      {view.own && <WorkflowSteps steps={view.own.steps} />}
      {onOpenSettings && <button className="link" onClick={onOpenSettings}>{t.setHere}</button>}
      {view.tickets.length > 0 && (
        <ul className="workflow-tickets" data-testid="feature-workflow-tickets" aria-label={t.epicTickets}>
          {view.tickets.map((x) => (
            <li key={x.key}>
              <strong>{x.key}</strong> {x.current ? t.steps[x.current] : t.allDone} <span className="muted">{t.progress(x.done, x.total)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function FeatureWorkflow({ featureId, onOpenSettings }: { featureId: number; onOpenSettings?: () => void }) {
  const view = useStateRefetch(`workflow-feature:${featureId}`, () => api.workflowFeature(featureId));
  return <FeatureWorkflowStrip view={view} onOpenSettings={onOpenSettings} />;
}

// ---------------------------------------------------------------- 设置页

/** 一步的选项：只画这一步用得上的。 */
function StepOptions({ step, onChange }: { step: WorkflowStep; onChange(p: Partial<WorkflowStep>): void }) {
  const t = S.workflow;
  return (
    <span className="workflow-step-options">
      {step.id === "open_pr" && (
        <label><input type="checkbox" checked={step.draft === true} onChange={(e) => onChange({ draft: e.target.checked })} /> {t.draft}</label>
      )}
      {(step.id === "bot_review" || step.id === "re_review") && (
        <label>
          {t.bot}{" "}
          <select value={step.bot ?? "copilot"} onChange={(e) => onChange({ bot: e.target.value as WorkflowStep["bot"] })}>
            {REVIEW_BOTS.map((b) => <option key={b} value={b}>{b === "copilot" ? "Copilot" : "Codex"}</option>)}
          </select>
        </label>
      )}
      {step.id === "re_review" && (
        <label>
          {t.rounds}{" "}
          <select value={step.maxRounds ?? 2} onChange={(e) => onChange({ maxRounds: Number(e.target.value) })}>
            {Array.from({ length: RE_REVIEW_MAX_ROUNDS }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
      {step.id === "merge" && (
        <select value={step.mergeBy ?? "coordinator"} onChange={(e) => onChange({ mergeBy: e.target.value as WorkflowStep["mergeBy"] })} data-testid="workflow-merge-by">
          {MERGE_BY.map((m) => <option key={m} value={m}>{t.mergeBy[m]}</option>)}
        </select>
      )}
    </span>
  );
}

/**
 * 要求和说明的字数：快到上限（八成）时显示字数，超了说明原因。不用 maxLength：粘贴超长的文字会被浏览器悄悄截掉后半段，
 * 用户不知道；主进程 parseWorkflow 本来就会拒绝超长的，这里提前说、并禁用保存。
 */
function LengthHint({ text, max, testId }: { text: string; max: number; testId: string }) {
  if (text.length < max * 0.8) return null;
  const over = text.length > max;
  const t = S.workflow;
  return (
    <span className={over ? "error workflow-length" : "muted workflow-length"} role={over ? "alert" : undefined} data-testid={testId} data-over={over}>
      {over ? t.tooLong(text.length, max) : t.count(text.length, max)}
    </span>
  );
}

/** 一份流程的编辑器：从预设开始，加、移、删步骤，每一步的选项和要求，整体说明。保存交给调用方（主进程再验一次）。 */
export function WorkflowEditor({ initial, busy, error, onSave, onCancel }: { initial: Workflow; busy: boolean; error: string | null; onSave(w: Workflow): void; onCancel(): void }) {
  const t = S.workflow;
  const [steps, setSteps] = useState<WorkflowStep[]>(initial.steps);
  const [notes, setNotes] = useState(initial.notes);
  const preset = presetOf({ steps, notes: "" });
  const addable = addableSteps(steps);
  const tooLong = notes.length > NOTES_LIMIT || steps.some((s) => (s.note ?? "").length > NOTE_LIMIT);
  return (
    <div className="workflow-editor" data-testid="workflow-editor">
      <div className="row">
        <span className="muted">{t.startFrom}</span>
        {WORKFLOW_PRESETS.map((p) => (
          <button key={p} className={preset === p ? "active" : ""} title={t.preset[p]} data-testid={`workflow-preset-${p}`} onClick={() => setSteps(presetWorkflow(p).steps)}>
            {t.presetName[p]}
          </button>
        ))}
        {preset === null && <span className="muted">{t.custom}</span>}
      </div>
      <ol className="workflow-edit-steps">
        {steps.map((s, i) => (
          <li key={s.id} data-step={s.id}>
            <strong>{t.steps[s.id]}</strong>
            <StepOptions step={s} onChange={(p) => setSteps(setStepOption(steps, i, p))} />
            <input className="workflow-note" placeholder={t.note} value={s.note ?? ""} onChange={(e) => setSteps(setStepOption(steps, i, { note: e.target.value }))} />
            <LengthHint text={s.note ?? ""} max={NOTE_LIMIT} testId="workflow-note-length" />
            <button className="icon" title={t.up} aria-label={t.up} disabled={i === 0} onClick={() => setSteps(moveStep(steps, i, -1))}>↑</button>
            <button className="icon" title={t.down} aria-label={t.down} disabled={i === steps.length - 1} onClick={() => setSteps(moveStep(steps, i, 1))}>↓</button>
            <button className="icon" title={t.remove} aria-label={t.remove} onClick={() => setSteps(removeStep(steps, i))}>×</button>
          </li>
        ))}
      </ol>
      {addable.length > 0 && (
        <div className="row">
          <span className="muted">{t.addStep}</span>
          {addable.map((id) => <button key={id} data-testid={`workflow-add-${id}`} onClick={() => setSteps(insertStep(steps, id))}>+ {t.steps[id]}</button>)}
        </div>
      )}
      {steps.length > 0 && !steps.some((s) => s.id === "merge") && <p className="muted" data-testid="workflow-no-merge">{t.noMerge}</p>}
      <WorkflowLoopNote workflow={{ steps, notes }} />
      <textarea className="workflow-notes" placeholder={t.notes} value={notes} rows={2} onChange={(e) => setNotes(e.target.value)} />
      <LengthHint text={notes} max={NOTES_LIMIT} testId="workflow-notes-length" />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button className="primary" disabled={busy || steps.length === 0 || tooLong} data-testid="workflow-save" onClick={() => onSave({ steps, notes })}>{t.save}</button>
        <button disabled={busy} onClick={onCancel}>{t.cancel}</button>
      </div>
    </div>
  );
}

/** 「加一层」：选种类和目标；已经设过的层不再列出来（去改那一层）。 */
function targetsOf(kind: WorkflowScopeKind, v: WorkflowSettingsView): { value: string; label: string }[] {
  const x = v.targets;
  if (kind === "product") return x.products.map((p) => ({ value: String(p.id), label: p.name }));
  if (kind === "repo") return x.repos.map((r) => ({ value: r, label: r }));
  if (kind === "feature") return x.features.map((f) => ({ value: String(f.id), label: f.name }));
  if (kind === "ticket") return x.tickets.map((tk) => ({ value: tk.key, label: tk.title ? `${tk.key} ${tk.title}` : tk.key }));
  return [];
}

type Editing = { scope: WorkflowScope; label: string; workflow: Workflow } | null;

/** 设置 › 工作流程（纯视图 + 本地编辑状态）：各层的列表、改、清掉、加一层、用 Claude 设置。 */
export function WorkflowSettingsView({ view, onSet, onAskClaude }: {
  view: WorkflowSettingsView;
  onSet(scope: WorkflowScope, w: Workflow | null): Promise<{ ok: true; changed: boolean } | { ok: false; message: string }>;
  onAskClaude(): void;
}) {
  const t = S.workflow;
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [kind, setKind] = useState<WorkflowScopeKind>("global");
  const [target, setTarget] = useState("");

  const run = async (scope: WorkflowScope, w: Workflow | null) => {
    setBusy(true);
    setError(null);
    try {
      const r = await onSet(scope, w);
      if (!r.ok) setError(r.message);
      else {
        setEditing(null);
        setNote(r.changed ? t.saved : t.unchanged);
      }
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const isSet = (s: WorkflowScope) => view.layers.some((l) => sameWorkflowScope(l.scope, s));
  const options = targetsOf(kind, view).filter((o) => {
    const s = scopeFor(kind, o.value);
    return s !== null && !isSet(s);
  });
  const newScope = scopeFor(kind, target);
  const canAdd = newScope !== null && !isSet(newScope);
  const startNew = () => {
    if (!newScope) return;
    const label = kind === "global" ? "" : (options.find((o) => o.value === target)?.label ?? target);
    setError(null);
    setNote(null);
    setEditing({ scope: newScope, label, workflow: presetWorkflow("fast") });
  };
  const edit = (l: WorkflowLayerView) => {
    setError(null);
    setNote(null);
    setEditing({ scope: l.scope, label: l.label, workflow: l.workflow });
  };

  return (
    <div className="settings-section workflow-settings" data-testid="workflow-settings">
      <p className="muted">{t.intro}</p>
      <div className="row">
        <button className="primary" title={t.askClaudeHint} data-testid="workflow-ask-claude" onClick={onAskClaude}>{t.askClaude}</button>
      </div>
      {view.layers.length === 0 && !editing && <p className="empty">{t.none}</p>}
      <ul className="card-list workflow-layers">
        {view.layers.map((l) => {
          const mine = editing !== null && sameWorkflowScope(editing.scope, l.scope);
          const p = presetOf(l.workflow);
          return (
            <li key={JSON.stringify(l.scope)} className="workflow-layer" data-testid="workflow-layer" data-scope={l.scope.kind}>
              <div className="row">
                <strong>{layerTitle(l.scope, l.label)}</strong>
                {p && <span className="pill none">{t.presetName[p]}</span>}
                {!mine && <button disabled={busy} onClick={() => edit(l)}>{t.edit}</button>}
                {!mine && <button disabled={busy} data-testid="workflow-clear" onClick={() => void run(l.scope, null)}>{t.clear}</button>}
              </div>
              {mine ? (
                <WorkflowEditor initial={editing.workflow} busy={busy} error={error} onSave={(w) => void run(l.scope, w)} onCancel={() => setEditing(null)} />
              ) : (
                <>
                  <WorkflowSteps steps={l.workflow.steps} />
                  {l.workflow.notes && <p className="muted">{l.workflow.notes}</p>}
                  <WorkflowLoopNote workflow={l.workflow} />
                </>
              )}
            </li>
          );
        })}
      </ul>
      {editing && !isSet(editing.scope) && (
        <div className="workflow-layer" data-testid="workflow-new-layer">
          <strong>{layerTitle(editing.scope, editing.label)}</strong>
          <WorkflowEditor initial={editing.workflow} busy={busy} error={error} onSave={(w) => void run(editing.scope, w)} onCancel={() => setEditing(null)} />
        </div>
      )}
      {!editing && (
        <div className="row workflow-add">
          <select value={kind} data-testid="workflow-add-kind" onChange={(e) => { setKind(e.target.value as WorkflowScopeKind); setTarget(""); }}>
            {WORKFLOW_SCOPE_KINDS.map((k) => <option key={k} value={k}>{t.scope[k]}</option>)}
          </select>
          {kind !== "global" && (
            <select value={target} data-testid="workflow-add-target" onChange={(e) => setTarget(e.target.value)}>
              <option value="">{options.length ? t.pickTarget : t.noTargets}</option>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          <button disabled={!canAdd || busy} data-testid="workflow-add" onClick={startNew}>{t.add}</button>
        </div>
      )}
      {note && <p className="muted" role="status">{note}</p>}
    </div>
  );
}

/** 设置页的「工作流程」tab：读各层，改了重读；「用 Claude 设置」打开 Shipherd 总控并带上开头的话。 */
export function WorkflowSettings({ onAskClaude }: { onAskClaude(): void }) {
  const view = useStateRefetch("workflow-settings", () => api.workflowState());
  if (!view) return <p className="empty">{S.loading}</p>;
  return <WorkflowSettingsView view={view} onSet={(s, w) => api.workflowSet(s, w)} onAskClaude={onAskClaude} />;
}
