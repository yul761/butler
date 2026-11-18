import { useCallback, useEffect, useState } from "react";
import type { PolicyGroup, PolicyScope } from "../../../shared/admission-policy";
import type { EditableSettingKey, EditableSettings } from "../../../shared/settings";
import { api, ButlerError } from "../api";
import { reportError } from "../errors";
import { parsePolicyInput, policyGroups, policyInputValue, policyOverridesFromDraft, policyScopeFromKey, policyScopeKey, type PolicyDraft } from "../policy-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

const BACKUP_KEYS = ["configBackupIntervalDays", "configBackupKeep", "configExportReminderDays"] as const satisfies readonly EditableSettingKey[];
const TOGGLE_KEYS = ["lessonsAutoAdmit", "lessonsPrinciples", "lessonsCoreGuide"] as const satisfies readonly EditableSettingKey[];

/** 原则：现有几条，「现在归组」（一个可撤销的批次）。 */
function Principles() {
  const page = useStateRefetch("admission-state", api.admissionState);
  const [result, setResult] = useState<string | null>(null);
  const running = page?.principles.running ?? false;
  const regroup = async () => {
    try {
      const r = await api.principlesRegroup();
      setResult(S.principlesResult(r.principles, r.lessons, r.failed));
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <div className="lessons-row" data-testid="principles">
      <span className="muted" data-testid="principles-count">{S.principlesCount(page?.principles.count ?? 0)}</span>
      <button data-testid="principles-regroup" disabled={running} onClick={() => void regroup()}>{running ? S.principlesRunning : S.principlesRegroup}</button>
      {result && <span className="muted" role="status" data-testid="principles-result">{result}</span>}
    </div>
  );
}

/** 三层准入策略编辑器（契约 4.2）：选一层，看每个键的生效值和来源，改这一层自己的覆盖。groups：只显示这几组（校准页只放评分）。 */
export function PolicyEditor({ groups, title }: { groups?: readonly PolicyGroup[]; title?: string } = {}) {
  const lessons = useStateRefetch("policy-layers", api.lessonsState);
  const [scope, setScope] = useState<PolicyScope>({ kind: "global" });
  const key = policyScopeKey(scope);
  const view = useStateRefetch(`policy-${key}`, () => api.policiesGet(scope));
  const [draft, setDraft] = useState<PolicyDraft>({});
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = (v: string) => {
    setScope(policyScopeFromKey(v));
    setDraft({});
    setMessage(null);
  };

  const write = async (overrides: Parameters<typeof api.policiesSet>[1]) => {
    setBusy(true);
    try {
      const r = await api.policiesSet(scope, overrides);
      setDraft({});
      setMessage({ text: r.batchId === null ? S.policyNoChange : S.policySaved, error: false });
    } catch (e) {
      if (e instanceof ButlerError) setMessage({ text: e.message, error: true });
      else reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!view) return;
    const r = policyOverridesFromDraft(view, draft);
    if (!r.ok) return setMessage({ text: S.policyBadValue(r.badKey), error: true });
    if (!r.changed) return setMessage({ text: S.policyNoChange, error: false });
    void write(r.overrides);
  };

  // 换层后旧层的视图可能还在：只用和选中层一致的那份。
  const current = view && policyScopeKey(view.scope) === key ? view : null;
  return (
    <div className="field" data-testid="policy-editor">
      <h3>{title ?? S.policyTitle}</h3>
      <p className="muted">{S.policyIntro}</p>
      <label className="inline">
        {S.policyLayer}
        <select data-testid="policy-layer" value={key} onChange={(e) => pick(e.target.value)}>
          <option value="global">{S.policyLayerGlobal}</option>
          {(lessons?.products ?? []).map((p) => <option key={`p${p.id}`} value={`product:${p.id}`}>{S.policyLayerProduct(p.name)}</option>)}
          {(lessons?.repos ?? []).map((r) => <option key={`r${r.slug}`} value={`repo:${r.slug}`}>{S.policyLayerRepo(r.slug)}</option>)}
        </select>
      </label>
      {current && (
        <>
          <p className="muted">
            {!current.calibrated && <span data-testid="policy-uncalibrated">{S.policyUncalibrated} </span>}
            {S.policyVersion(current.version)}
          </p>
          {current.conflicts.length > 0 && (
            <div className="lessons-suggest" role="status" data-testid="policy-conflicts">
              <span>{S.policyConflicts}</span>
              <ul>
                {current.conflicts.map((c) => (
                  <li key={c.key}>{S.policyConflict(c.key, c.products.map((p) => `${p.name} = ${String(p.value)}`).join(", "))}</li>
                ))}
              </ul>
            </div>
          )}
          {policyGroups(current).filter((g) => !groups || groups.includes(g.group)).map((g) => (
            <div key={g.group}>
              <h4 className="policy-group">{S.policyGroup[g.group]}</h4>
              <table className="policy-table">
                <thead>
                  <tr><th>{S.policyKeyCol}</th><th>{S.policyEffective}</th><th>{S.policyFrom}</th><th>{S.policyOverride}</th></tr>
                </thead>
                <tbody>
                  {g.keys.map((k) => {
                    const raw = draft[k.key] ?? policyInputValue(k.override);
                    const bad = draft[k.key] !== undefined && parsePolicyInput(k.key, raw) === undefined;
                    const set = (v: string) => setDraft((d) => ({ ...d, [k.key]: v }));
                    const shown = (v: unknown) => (typeof v === "boolean" ? S.policyBool(v) : String(v));
                    return (
                      <tr key={k.key} data-testid={`policy-row-${k.key}`}>
                        <td className="policy-key">{(S.policyKey as Record<string, string>)[k.key] ?? k.key}<br /><code className="muted">{k.key}</code></td>
                        <td data-testid={`policy-effective-${k.key}`}>{shown(k.effective)}</td>
                        <td className="muted">{S.policyOrigin(k.origin)}</td>
                        <td>
                          {k.def.kind === "bool" || k.def.kind === "enum" ? (
                            <select aria-label={k.key} data-testid={`policy-input-${k.key}`} value={raw} onChange={(e) => set(e.target.value)}>
                              <option value="">{S.policyInherit}</option>
                              {(k.def.kind === "bool" ? ["true", "false"] : k.def.options).map((o) => (
                                <option key={o} value={o}>{k.def.kind === "bool" ? S.policyBool(o === "true") : o}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              aria-label={k.key}
                              aria-invalid={bad || undefined}
                              className={bad ? "invalid" : undefined}
                              data-testid={`policy-input-${k.key}`}
                              inputMode="decimal"
                              placeholder={S.policyInherit}
                              title={S.policyRange(k.def.min, k.def.max)}
                              value={raw}
                              onChange={(e) => set(e.target.value)}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
          <div className="actions">
            <button className="primary" data-testid="policy-save" disabled={busy} onClick={save}>{S.policySave}</button>
            <button data-testid="policy-discard" disabled={busy || Object.keys(draft).length === 0} onClick={() => setDraft({})}>{S.policyDiscard}</button>
            <button data-testid="policy-clear" disabled={busy || current.keys.every((k) => k.override === null)} onClick={() => void write({})}>{S.policyClear}</button>
          </div>
          {message && <p className={message.error ? "error" : "muted"} role={message.error ? "alert" : "status"} data-testid="policy-message">{message.text}</p>}
        </>
      )}
    </div>
  );
}

/** 设置页的「复盘规矩」一节：自动备份、导出提醒，加上准入策略编辑器。 */
export function LessonsSettings() {
  const [values, setValues] = useState<EditableSettings | null>(null);
  const [draft, setDraft] = useState<Partial<EditableSettings>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setValues(await api.settings());
    } catch (e) {
      reportError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const saveValue = async (k: EditableSettingKey, v: string) => {
    setError(null);
    try {
      await api.setSetting(k, v);
      await load();
    } catch (e) {
      if (e instanceof ButlerError && e.code === "invalid_setting") setError(e.message);
      else reportError(e);
    }
  };
  const save = async (k: EditableSettingKey) => {
    const v = draft[k];
    if (v === undefined || !values || v === values[k]) return;
    setError(null);
    try {
      await api.setSetting(k, v);
      setDraft((d) => {
        const next = { ...d };
        delete next[k];
        return next;
      });
      await load();
    } catch (e) {
      if (e instanceof ButlerError && e.code === "invalid_setting") setError(e.message);
      else reportError(e);
    }
  };

  return (
    <section className="settings-section" data-testid="lessons-settings">
      <h2>{S.lessonsSettings}</h2>
      <p className="muted">{S.lessonsSettingsNote}</p>
      {error && <p className="error">{error}</p>}
      {values &&
        BACKUP_KEYS.map((k) => (
          <label key={k} className="field">
            {S[k]}
            <input type="number" min={0} data-testid={`setting-${k}`} value={draft[k] ?? values[k]} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} onBlur={() => void save(k)} />
          </label>
        ))}
      {values &&
        TOGGLE_KEYS.map((k) => (
          <label key={k} className="inline">
            <input type="checkbox" data-testid={`setting-${k}`} checked={values[k] === "1"} onChange={(e) => void saveValue(k, e.target.checked ? "1" : "0")} />
            {S[k]}
          </label>
        ))}
      <Principles />
      <PolicyEditor />
    </section>
  );
}
