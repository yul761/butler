import { useCallback, useEffect, useState } from "react";
import { EXTERNAL_ACTION_SETTINGS } from "../../../shared/external";
import type { EditableSettings } from "../../../shared/settings";
import type { PolicyScope } from "../../../shared/admission-policy";
import type { StackActionResult, StackPolicyOverrides, StackView, StacksFilter } from "../../../shared/stacks";
import { api } from "../api";
import { reportError } from "../errors";
import { policyScopeFromKey, policyScopeKey } from "../policy-view";
import { isBottom, lastRunLines, layerActions, stackAutoRebaseNote, stackEpicLines, stackInputValue, stackKeyKind, stackOverridesFromDraft, stackShown, type StackDraft } from "../stack-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

const STATE_PILL: Record<string, string> = { branch_only: "none", draft: "pending", ready: "approved", merged: "merged" };

/** 全部工作页「更多」里的「栈」区块（工作流 K）：Shipherd 管的栈，从下到上每一层，最近一次 rebase，和几个按钮。 */
export function ManagedStacks({ filter, onOpenTicket }: { filter: StacksFilter; onOpenTicket: (key: string) => void }) {
  const view = useStateRefetch(`stacks:${filter.featureId ?? ""}`, () => api.stacks(filter));
  if (!view) return null;
  return (
    <section className="managed-stacks" data-testid="managed-stacks">
      <h3>{S.sk.title}</h3>
      <p className="muted">{S.sk.intro}</p>
      {view.updateRefs === false && <p className="muted" data-testid="stacks-no-update-refs">{S.sk.noUpdateRefs}</p>}
      {view.stacks.length === 0 ? (
        <p className="muted" data-testid="stacks-none">{S.sk.none}</p>
      ) : (
        view.stacks.map((s) => <StackCard key={s.id} stack={s} onOpenTicket={onOpenTicket} />)
      )}
    </section>
  );
}

function StackCard({ stack: s, onOpenTicket }: { stack: StackView; onOpenTicket: (key: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const act = (fn: () => Promise<StackActionResult>) => {
    setBusy(true);
    setResult(null);
    void fn()
      .then((r) => setResult(r.ok ? { text: r.message ?? S.sk.done, error: false } : { text: r.message, error: true }), reportError)
      .finally(() => setBusy(false));
  };
  const now = Date.now();
  // 从上往下画：栈顶在上，栈底在下，和 git log 一样。
  const layers = [...s.layers].reverse();
  const note = stackAutoRebaseNote(s, S);
  return (
    <div className="stack-card" data-testid={`stack-${s.id}`}>
      <div className="stack-head">
        <strong>{s.name}</strong>
        <span className="muted"> {S.sk.repoTrunk(s.repoSlug ?? s.repoPath, s.trunk)} · {S.sk.source[s.source]}</span>
      </div>
      {note && <p className="muted" data-testid={`stack-${s.id}-${s.autoRebase ? "on" : "off"}`}>{note}</p>}
      <ol className="stack-layers" reversed>
        {layers.map((l) => (
          <li key={l.id} className={`stack-layer state-${l.state}`} data-testid={`stack-layer-${l.branch}`}>
            <span className={`pill ${STATE_PILL[l.state] ?? "none"}`} data-testid={`stack-layer-${l.branch}-state`}>{S.sk.state[l.state]}</span>
            <code>{l.branch}</code>
            {isBottom(s, l) && <span className="muted"> · {S.sk.bottom}</span>}
            {l.ticketKey && <> <button className="chip" onClick={() => onOpenTicket(l.ticketKey!)}>{l.ticketKey}</button></>}
            {l.prUrl && <> <button className="link" title={l.prUrl} onClick={() => void api.prOpen(l.prUrl!).catch(reportError)}>#{l.prNumber}</button></>}
            {l.behind !== null && l.behind > 0 && <span className="muted"> · {S.sk.behind(l.behind)}</span>}
            {l.unpushed && <span className="error" data-testid={`stack-layer-${l.branch}-unpushed`}> · {S.sk.unpushed}</span>}
            {layerActions(s, l).map((a) => (
              <button key={a} className="stack-layer-action" data-testid={`stack-layer-${l.branch}-${a}`} disabled={busy} onClick={() => act(() => api.stacksLayerMode(l.id, a === "toDraft" ? "draft" : "branch"))}>
                {S.sk[a]}
              </button>
            ))}
          </li>
        ))}
      </ol>
      {lastRunLines(s.lastRun, S, now).map((line, i) => <p key={i} className={i > 0 && s.lastRun?.outcome === "conflict" ? "error" : "muted"}>{line}</p>)}
      <div className="actions">
        <button data-testid={`stack-${s.id}-rebase`} disabled={busy || !s.autoRebase} onClick={() => act(() => api.stacksRebase(s.id))}>{S.sk.rebaseNow}</button>
        {s.restorable && <button data-testid={`stack-${s.id}-restore`} disabled={busy} onClick={() => act(() => api.stacksRestore(s.id))}>{S.sk.restore}</button>}
        {confirmRemove ? (
          <button className="danger" data-testid={`stack-${s.id}-remove-confirm`} disabled={busy} onClick={() => (setConfirmRemove(false), act(() => api.stacksRemove(s.id)))}>{S.sk.removeConfirm}</button>
        ) : (
          <button data-testid={`stack-${s.id}-remove`} disabled={busy} onClick={() => setConfirmRemove(true)}>{S.sk.remove}</button>
        )}
      </div>
      {result && <p className={result.error ? "error" : "muted"} role="status" data-testid={`stack-${s.id}-result`}>{result.text}</p>}
    </div>
  );
}

/** 栈用到的对外动作：rebase 后强推，第一次推一层，开 PR 和 draft，改 PR 标题和描述（栈的位置、依赖行），draft 的 label，总览发 issue。 */
const STACK_ACTIONS = ["force_push", "branch_push", "pr_open", "pr_title_edit", "pr_description_edit", "pr_label", "issue_post"] as const;

/** 设置 →「栈」：三层策略和用到的对外动作开关。 */
export function StackSettings() {
  return (
    <section className="stack-settings" data-testid="stack-settings">
      <h2>{S.sk.title}</h2>
      <p className="muted">{S.sk.settingsIntro}</p>
      <StackPolicyEditor />
      <StackExternalSwitches />
    </section>
  );
}

function StackPolicyEditor() {
  const lessons = useStateRefetch("stack-layers", api.lessonsState);
  const [scope, setScope] = useState<PolicyScope>({ kind: "global" });
  const key = policyScopeKey(scope);
  const view = useStateRefetch(`stack-policy-${key}`, () => api.stacksPolicyGet(scope));
  const [draft, setDraft] = useState<StackDraft>({});
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const current = view && policyScopeKey(view.scope) === key ? view : null;

  const pick = (v: string) => {
    setScope(policyScopeFromKey(v));
    setDraft({});
    setMessage(null);
  };
  const write = async (overrides: StackPolicyOverrides) => {
    setBusy(true);
    try {
      const r = await api.stacksPolicySet(scope, overrides);
      if (r.ok) {
        setDraft({});
        setMessage({ text: S.lp.saved, error: false });
      } else {
        const k = r.key as keyof typeof S.sk.key;
        setMessage({ text: S.sk.badValue(S.sk.key[k] ?? r.key, S.sk.policyError[r.message as keyof typeof S.sk.policyError] ?? r.message), error: true });
      }
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (!current) return;
    const r = stackOverridesFromDraft(current, draft);
    if (!r.ok) return setMessage({ text: S.sk.badValue(S.sk.key[r.key], S.sk.policyError[r.code]), error: true });
    if (!r.changed) return setMessage({ text: S.lp.noChange, error: false });
    void write(r.overrides);
  };

  return (
    <div className="field" data-testid="stack-policy-editor">
      <label className="inline">
        {S.lp.layer}
        <select data-testid="stack-layer" value={key} onChange={(e) => pick(e.target.value)}>
          <option value="global">{S.lp.layerGlobal}</option>
          {(lessons?.products ?? []).map((p) => <option key={`p${p.id}`} value={`product:${p.id}`}>{S.lp.layerProduct(p.name)}</option>)}
          {(lessons?.repos ?? []).map((r) => <option key={`r${r.slug}`} value={`repo:${r.slug}`}>{S.lp.layerRepo(r.slug)}</option>)}
        </select>
      </label>
      {current && (
        <>
          <table className="policy-table">
            <thead>
              <tr><th>{S.lp.colKey}</th><th>{S.lp.colEffective}</th><th>{S.lp.colFrom}</th><th>{S.lp.colOverride}</th></tr>
            </thead>
            <tbody>
              {current.keys.map((k) => {
                const kind = stackKeyKind(k.key);
                const raw = draft[k.key] ?? stackInputValue(k.override);
                const set = (v: string) => setDraft((d) => ({ ...d, [k.key]: v }));
                const common = { "aria-label": k.key, "data-testid": `stack-input-${k.key}` };
                return (
                  <tr key={k.key} data-testid={`stack-row-${k.key}`}>
                    <td className="policy-key">{S.sk.key[k.key]}<br /><code className="muted">{k.key}</code></td>
                    <td data-testid={`stack-effective-${k.key}`}>{stackShown(k, S)}</td>
                    <td className="muted">{S.lp.origin(k.origin)}</td>
                    <td>
                      {kind.kind === "bool" || kind.kind === "enum" ? (
                        <select {...common} value={raw} onChange={(e) => set(e.target.value)}>
                          <option value="">{S.lp.inherit}</option>
                          {(kind.kind === "bool" ? ["true", "false"] : kind.options).map((o) => (
                            <option key={o} value={o}>{kind.kind === "bool" ? S.lp.bool(o === "true") : (S.sk.option[o] ?? o)}</option>
                          ))}
                        </select>
                      ) : (
                        <input {...common} inputMode={kind.kind === "int" ? "numeric" : undefined} placeholder={S.lp.inherit}
                          title={kind.kind === "int" ? S.lp.range(kind.min, kind.max) : undefined} value={raw} onChange={(e) => set(e.target.value)} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {stackEpicLines(current.epic, S).map((line, i) => <p key={i} className="muted" data-testid="stack-policy-epic">{line}</p>)}
          <div className="actions">
            <button className="primary" data-testid="stack-save" disabled={busy} onClick={save}>{S.lp.save}</button>
            <button data-testid="stack-discard" disabled={busy || Object.keys(draft).length === 0} onClick={() => setDraft({})}>{S.lp.discard}</button>
            <button data-testid="stack-clear" disabled={busy || current.keys.every((k) => k.override === null)} onClick={() => void write({})}>{S.lp.clear}</button>
          </div>
          {message && <p className={message.error ? "error" : "muted"} role="status" data-testid="stack-message">{message.text}</p>}
        </>
      )}
    </div>
  );
}

function StackExternalSwitches() {
  const [values, setValues] = useState<EditableSettings | null>(null);
  const load = useCallback(async () => {
    try {
      setValues(await api.settings());
    } catch (e) {
      reportError(e);
    }
  }, []);
  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);
  if (!values) return null;
  const current = values;
  const toggle = async (kind: (typeof STACK_ACTIONS)[number], on: boolean) => {
    setValues({ ...current, [EXTERNAL_ACTION_SETTINGS[kind]]: on ? "1" : "0" });
    try {
      await api.setSetting(EXTERNAL_ACTION_SETTINGS[kind], on ? "1" : "0");
    } catch (e) {
      reportError(e);
    }
    await load();
  };
  return (
    <div className="field" data-testid="stack-external">
      <h3>{S.sk.externalTitle}</h3>
      <p className="muted">{S.sk.externalIntro}</p>
      {STACK_ACTIONS.map((kind) => (
        <div key={kind} className="external-action">
          <label className="inline">
            <input type="checkbox" data-testid={`stack-external-${kind}`} checked={current[EXTERNAL_ACTION_SETTINGS[kind]] === "1"} onChange={(e) => void toggle(kind, e.target.checked)} />
            {S.externalActions[kind].label}
          </label>
          <span className="muted"> {S.externalActions[kind].hint}</span>
        </div>
      ))}
    </div>
  );
}
