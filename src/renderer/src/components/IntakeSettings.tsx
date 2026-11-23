import { useCallback, useEffect, useState } from "react";
import type { PolicyScope } from "../../../shared/admission-policy";
import { INTAKE_SOURCES } from "../../../shared/intake";
import type { EditableSettingKey, EditableSettings } from "../../../shared/settings";
import { api, ShipherdError } from "../api";
import { reportError } from "../errors";
import { INTAKE_ENUMS, intakeInputValue, intakeOverridesFromDraft, intakeValueText, parseIntakeInput, type IntakeDraft } from "../intake-view";
import { policyScopeFromKey, policyScopeKey } from "../policy-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

const TEXT_KEYS = ["intakeTrackerQuery", "intakeTrackerDir", "intakeFilePath", "intakePollMinutes"] as const satisfies readonly EditableSettingKey[];

/** 来源：从哪拉、tracker 查询、文件路径、间隔、仓库映射（普通设置项，失焦保存）。 */
function IntakeSource() {
  const [values, setValues] = useState<EditableSettings | null>(null);
  const [draft, setDraft] = useState<Partial<EditableSettings>>({});
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.settings().then(setValues, reportError), []);
  useEffect(() => void load(), [load]);
  const save = async (k: EditableSettingKey, v: string) => {
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
      if (e instanceof ShipherdError && e.code === "invalid_setting") setError(e.message);
      else reportError(e);
    }
  };
  if (!values) return <p className="muted">{S.loading}</p>;
  const value = (k: EditableSettingKey) => draft[k] ?? values[k];
  const blur = (k: EditableSettingKey) => draft[k] !== undefined && draft[k] !== values[k] && void save(k, draft[k]);
  const label: Record<(typeof TEXT_KEYS)[number], [string, string | null]> = {
    intakeTrackerQuery: [S.ik.query, S.ik.queryHint],
    intakeTrackerDir: [S.ik.trackerDir, S.ik.trackerDirHint],
    intakeFilePath: [S.ik.filePath, S.ik.filePathHint],
    intakePollMinutes: [S.ik.pollMinutes, null],
  };
  const source = values.intakeSource;
  const shown = TEXT_KEYS.filter((k) => k === "intakePollMinutes" || (source === "tracker" ? k !== "intakeFilePath" : source === "file" ? k === "intakeFilePath" : false));
  return (
    <div className="field" data-testid="intake-source">
      <h3>{S.ik.sourceTitle}</h3>
      {error && <p className="error" role="alert" data-testid="intake-setting-error">{error}</p>}
      <label className="field">
        {S.ik.sourceLabel}
        <select data-testid="setting-intakeSource" value={source} onChange={(e) => void save("intakeSource", e.target.value)}>
          {INTAKE_SOURCES.map((s) => <option key={s} value={s}>{S.ik.source[s]}</option>)}
        </select>
      </label>
      {shown.map((k) => (
        <label key={k} className="field">
          {label[k][0]}
          <input data-testid={`setting-${k}`} value={value(k)} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} onBlur={() => blur(k)} />
          {label[k][1] && <span className="muted">{label[k][1]}</span>}
        </label>
      ))}
      <label className="field">
        {S.ik.repoMap}
        <textarea
          data-testid="setting-intakeRepoMap" rows={5} spellCheck={false} value={value("intakeRepoMap")}
          onChange={(e) => setDraft((d) => ({ ...d, intakeRepoMap: e.target.value }))} onBlur={() => blur("intakeRepoMap")}
        />
        <span className="muted">{S.ik.repoMapHint}</span>
      </label>
    </div>
  );
}

/** 策略的三层编辑器（同花费上限）：总开关、自动开工的上限、并行数、冲突、缺信息时怎么办、档位。 */
function IntakePolicyEditor() {
  const lessons = useStateRefetch("intake-layers", api.lessonsState);
  const [scope, setScope] = useState<PolicyScope>({ kind: "global" });
  const key = policyScopeKey(scope);
  const view = useStateRefetch(`intake-policy-${key}`, () => api.intakePolicyGet(scope));
  const [draft, setDraft] = useState<IntakeDraft>({});
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const current = view && policyScopeKey(view.scope) === key ? view : null;

  const write = async (overrides: Parameters<typeof api.intakePolicySet>[1]) => {
    setBusy(true);
    try {
      const r = await api.intakePolicySet(scope, overrides);
      if (r.ok) {
        setDraft({});
        setMessage({ text: S.policySaved, error: false });
      } else setMessage({ text: S.policyBadValue(r.key), error: true });
    } catch (e) {
      if (e instanceof ShipherdError) setMessage({ text: e.message, error: true });
      else reportError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (!current) return;
    const r = intakeOverridesFromDraft(current, draft);
    if (!r.ok) return setMessage({ text: S.policyBadValue(r.badKey), error: true });
    if (!r.changed) return setMessage({ text: S.policyNoChange, error: false });
    void write(r.overrides);
  };

  return (
    <div className="field" data-testid="intake-policy">
      <h3>{S.ik.policyTitle}</h3>
      <p className="muted">{S.ik.policyIntro}</p>
      <label className="inline">
        {S.policyLayer}
        <select
          data-testid="intake-layer" value={key}
          onChange={(e) => {
            setScope(policyScopeFromKey(e.target.value));
            setDraft({});
            setMessage(null);
          }}
        >
          <option value="global">{S.policyLayerGlobal}</option>
          {(lessons?.products ?? []).map((p) => <option key={`p${p.id}`} value={`product:${p.id}`}>{S.policyLayerProduct(p.name)}</option>)}
          {(lessons?.repos ?? []).map((r) => <option key={`r${r.slug}`} value={`repo:${r.slug}`}>{S.policyLayerRepo(r.slug)}</option>)}
        </select>
      </label>
      {current && (
        <>
          <table className="policy-table">
            <thead>
              <tr><th>{S.policyKeyCol}</th><th>{S.policyEffective}</th><th>{S.policyFrom}</th><th>{S.policyOverride}</th></tr>
            </thead>
            <tbody>
              {current.keys.map((k) => {
                const raw = draft[k.key] ?? intakeInputValue(k.set, k.override);
                const bad = draft[k.key] !== undefined && parseIntakeInput(k.key, raw) === undefined;
                const set = (v: string) => setDraft((d) => ({ ...d, [k.key]: v }));
                const options = INTAKE_ENUMS[k.key];
                return (
                  <tr key={k.key} data-testid={`intake-policy-row-${k.key}`}>
                    <td className="policy-key">{S.ik.key[k.key] ?? k.key}<br /><code className="muted">{k.key}</code></td>
                    <td data-testid={`intake-effective-${k.key}`}>{intakeValueText(k.effective, S)}</td>
                    <td className="muted">{S.policyOrigin(k.origin)}</td>
                    <td>
                      {options ? (
                        <select aria-label={k.key} data-testid={`intake-input-${k.key}`} value={raw} onChange={(e) => set(e.target.value)}>
                          <option value="">{S.policyInherit}</option>
                          {options.map((o) => <option key={o} value={o}>{S.ik.option[o] ?? o}</option>)}
                        </select>
                      ) : (
                        <input
                          aria-label={k.key} aria-invalid={bad || undefined} className={bad ? "invalid" : undefined}
                          data-testid={`intake-input-${k.key}`} placeholder={S.policyInherit} value={raw} onChange={(e) => set(e.target.value)}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="actions">
            <button className="primary" data-testid="intake-policy-save" disabled={busy} onClick={save}>{S.policySave}</button>
            <button disabled={busy || Object.keys(draft).length === 0} onClick={() => setDraft({})}>{S.policyDiscard}</button>
            <button disabled={busy || current.keys.every((k) => !k.set)} onClick={() => void write({})}>{S.policyClear}</button>
          </div>
          {message && <p className={message.error ? "error" : "muted"} role={message.error ? "alert" : "status"} data-testid="intake-policy-message">{message.text}</p>}
        </>
      )}
    </div>
  );
}

/** 设置页「自动接活」（工作流 N）。 */
export function IntakeSettings() {
  return (
    <section className="settings-section" data-testid="intake-settings">
      <h2>{S.set.groups.intake}</h2>
      <p className="muted">{S.ik.intro}</p>
      <IntakeSource />
      <IntakePolicyEditor />
    </section>
  );
}
