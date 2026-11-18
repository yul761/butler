import { useCallback, useEffect, useState } from "react";
import type { EditableSettingKey, EditableSettings } from "../../../shared/settings";
import type { AutostartState, HealthReport } from "../../../shared/types";
import { api, ButlerError, platform } from "../api";
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

  /** 一个开关（"0" / "1"）和它的说明。 */
  const flagField = (k: EditableSettingKey, label: string, help: string) => (
    <div className="field">
      <label className="inline">
        <input type="checkbox" checked={current[k] !== "0"} onChange={(e) => void save(k, e.target.checked ? "1" : "0")} />
        {label}
      </label>
      <p className="muted">{help}</p>
    </div>
  );

  /** 一个数字：离开输入框时保存，带「恢复默认」。 */
  const numberField = (k: EditableSettingKey, label: string, help?: string, range: { min?: number; max?: number } = { min: 0 }) => (
    <div className="field">
      {label}
      <input
        className="mono"
        type="number"
        min={range.min}
        max={range.max}
        value={value(k)}
        onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
        onBlur={() => {
          if (draft[k] !== undefined && draft[k] !== current[k]) void save(k);
          else clearDraft(k);
        }}
      />
      {help && <p className="muted">{help}</p>}
      <div className="actions">
        <button onClick={() => void reset(k)}>{S.resetDefault}</button>
      </div>
    </div>
  );

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
      {/* 换新要靠记忆接上，所以放在记忆这一节（计划 16）。 */}
      <div className="field">
        {S.refreshThreshold}
        <input
          className="mono"
          type="number"
          min={0}
          step={10000}
          value={value("refreshThresholdTokens")}
          onChange={(e) => setDraft((d) => ({ ...d, refreshThresholdTokens: e.target.value }))}
          onBlur={() => {
            if (draft.refreshThresholdTokens !== undefined && draft.refreshThresholdTokens !== current.refreshThresholdTokens) void save("refreshThresholdTokens");
            else clearDraft("refreshThresholdTokens");
          }}
        />
        <p className="muted">{S.refreshThresholdHelp}</p>
        <div className="actions">
          <button onClick={() => void reset("refreshThresholdTokens")}>{S.resetDefault}</button>
        </div>
      </div>
      {/* 闲置关闭先写 handoff（BTL-190 第 8 点），和换新放在一起。 */}
      <div className="field">
        {S.idleCloseMinutes}
        <input
          className="mono"
          type="number"
          min={0}
          step={30}
          value={value("idleCloseMinutes")}
          onChange={(e) => setDraft((d) => ({ ...d, idleCloseMinutes: e.target.value }))}
          onBlur={() => {
            if (draft.idleCloseMinutes !== undefined && draft.idleCloseMinutes !== current.idleCloseMinutes) void save("idleCloseMinutes");
            else clearDraft("idleCloseMinutes");
          }}
        />
        <p className="muted">{S.idleCloseMinutesHelp}</p>
        <div className="actions">
          <button onClick={() => void reset("idleCloseMinutes")}>{S.resetDefault}</button>
        </div>
      </div>
      {m.statecorePlugin && <p className="error">{S.statecorePluginWarning}</p>}

      {/* 内存与性能（WS-M）：三个开关、按内存换新的阈值，和 Butler 管不了的建议（J）。 */}
      <h2>{S.perf.section}</h2>
      {(["memoryMonitor", "backgroundPriority", "orphanCleanup"] as const).map((k) => (
        <div key={k} className="field">
          <label className="inline">
            <input type="checkbox" checked={current[k] !== "0"} onChange={(e) => void save(k, e.target.checked ? "1" : "0")} />
            {S.perf[k]}
          </label>
          <p className="muted">{perfHelp(k)}</p>
        </div>
      ))}
      <div className="field">
        {S.perf.refreshMemoryMb}
        <input
          className="mono"
          type="number"
          min={0}
          step={256}
          value={value("refreshMemoryMb")}
          onChange={(e) => setDraft((d) => ({ ...d, refreshMemoryMb: e.target.value }))}
          onBlur={() => {
            if (draft.refreshMemoryMb !== undefined && draft.refreshMemoryMb !== current.refreshMemoryMb) void save("refreshMemoryMb");
            else clearDraft("refreshMemoryMb");
          }}
        />
        <p className="muted">{S.perf.refreshMemoryMbHelp}</p>
        <div className="actions">
          <button onClick={() => void reset("refreshMemoryMb")}>{S.resetDefault}</button>
        </div>
      </div>
      {/* 休眠（WS-M B、C）：开关、四种等待各自的分钟数、要不要结束 watcher；内存紧张时休眠和它的比例。 */}
      {flagField("hibernateEnabled", S.hib.settings.enabled, S.hib.settings.enabledHelp)}
      {numberField("hibernateYouMinutes", S.hib.settings.you)}
      {numberField("hibernateCiMinutes", S.hib.settings.ci)}
      {numberField("hibernateReviewMinutes", S.hib.settings.review)}
      {numberField("hibernateIdleMinutes", S.hib.settings.idle, S.hib.settings.minutesHelp)}
      {flagField("hibernateEndWatchers", S.hib.settings.endWatchers, S.hib.settings.endWatchersHelp)}
      {flagField("memoryPressureEnabled", S.hib.settings.pressure, S.hib.settings.pressureHelp)}
      {numberField("memoryPressureFreePercent", S.hib.settings.pressureFree, undefined, { min: 1, max: 50 })}
      <h3>{S.perf.tipsTitle}</h3>
      <ul className="perf-tips">
        {perfTips().map((t) => <li key={t}>{t}</li>)}
        <li>{S.perf.tipsMcp}</li>
      </ul>
      <div className="actions">
        <button onClick={() => api.setSetting("onboardingDone", "0").then(onRerunWizard, reportError)}>{S.rerunWizard}</button>
      </div>
    </section>
  );
}

/** 这个平台的说明：没有专门一份的平台用 other。 */
const byPlatform = <T,>(r: Record<string, T>): T => r[platform()] ?? r.other;

function perfHelp(k: "memoryMonitor" | "backgroundPriority" | "orphanCleanup"): string {
  if (k === "backgroundPriority") return byPlatform(S.perf.backgroundPriorityHelp);
  return k === "memoryMonitor" ? S.perf.memoryMonitorHelp : S.perf.orphanCleanupHelp;
}

const perfTips = (): string[] => byPlatform(S.perf.tips);
