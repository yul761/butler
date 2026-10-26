import { useCallback, useEffect, useState } from "react";
import type { EditableSettingKey, EditableSettings } from "../../../shared/settings";
import type { AutostartState, HealthReport } from "../../../shared/types";
import { api, ButlerError } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";
import { LanguagePicker } from "./LanguagePicker";

const TEXT_FIELDS = ["claudePath", "branchTemplate", "ticketPattern"] as const;

export function GeneralSettings({ report, onHealth, onRerunWizard }: { report: HealthReport; onHealth: (r: HealthReport) => void; onRerunWizard: () => void }) {
  const [values, setValues] = useState<EditableSettings | null>(null);
  const [draft, setDraft] = useState<Partial<EditableSettings>>({});
  const [autostart, setAutostart] = useState<AutostartState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [v, a] = await Promise.all([api.settings(), api.autostart()]);
      setValues(v);
      setAutostart(a);
    } catch (e) {
      reportError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!values) return <p className="muted">{S.loading}</p>;
  const current = values;
  const value = (k: EditableSettingKey): string => draft[k] ?? current[k];
  const clearDraft = (k: EditableSettingKey) =>
    setDraft((d) => {
      const next = { ...d };
      delete next[k];
      return next;
    });

  function failed(e: unknown) {
    if (e instanceof ButlerError && e.code === "invalid_setting") setError(e.message);
    else reportError(e);
  }

  async function save(k: EditableSettingKey, v: string = value(k)) {
    setError(null);
    try {
      await api.setSetting(k, v);
      clearDraft(k);
      await load();
      if (k === "claudePath" || k === "memoryEnabled") onHealth(await api.health());
    } catch (e) {
      failed(e);
    }
  }

  async function reset(k: EditableSettingKey) {
    setError(null);
    try {
      await api.resetSetting(k);
      clearDraft(k);
      await load();
      if (k === "claudePath") onHealth(await api.health());
    } catch (e) {
      failed(e);
    }
  }

  async function toggleAutostart(on: boolean) {
    try {
      setAutostart(await api.setAutostart(on));
    } catch (e) {
      reportError(e);
    }
  }

  const m = report.memory;
  return (
    <section className="settings-section">
      <h2>{S.general}</h2>
      <LanguagePicker />
      {error && <p className="error">{error}</p>}
      {TEXT_FIELDS.map((k) => (
        <div key={k} className="field">
          {S.generalFields[k]}
          <input
            className="mono"
            value={value(k)}
            placeholder={S.generalPlaceholders[k]}
            onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
            onBlur={() => {
              if (draft[k] !== undefined && draft[k] !== current[k]) void save(k);
              else clearDraft(k);
            }}
          />
          <p className="muted">{S.generalHelp[k]}</p>
          <div className="actions">
            <button onClick={() => void reset(k)}>{S.resetDefault}</button>
          </div>
        </div>
      ))}
      <label className="inline">
        <input type="checkbox" disabled={!autostart?.supported} checked={autostart?.enabled ?? false} onChange={(e) => void toggleAutostart(e.target.checked)} />
        {S.autostart}
      </label>
      {autostart && !autostart.supported && <p className="muted">{S.autostartUnsupported}</p>}

      <h2>{S.memorySettings}</h2>
      <label className="inline">
        <input type="checkbox" checked={current.memoryEnabled !== "0"} onChange={(e) => void save("memoryEnabled", e.target.checked ? "1" : "0")} />
        {S.memoryEnabled}
      </label>
      <dl className="kv">
        <dt>{S.memoryDataDir}</dt>
        <dd>{m.dataDir}</dd>
        <dt>{S.memoryMcp}</dt>
        <dd className={m.mcpBundle ? "ok" : "error"}>{m.mcpBundle ? S.memoryMcpReady : S.memoryMcpMissing}</dd>
      </dl>
      <p className="muted">{S.memoryExplain}</p>
      {m.statecorePlugin && <p className="error">{S.statecorePluginWarning}</p>}
      <div className="actions">
        <button onClick={() => api.setSetting("onboardingDone", "0").then(onRerunWizard, reportError)}>{S.rerunWizard}</button>
      </div>
    </section>
  );
}
