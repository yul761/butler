import { useEffect, useState } from "react";
import type { AutostartState, HealthReport } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";
import { LanguagePicker } from "./LanguagePicker";
import { useSettingsForm } from "./useSettingsForm";

const TEXT_FIELDS = ["claudePath", "branchTemplate", "ticketPattern"] as const;

/** 设置 › 基本：语言、claude 路径、分支和 ticket 号、检查更新、开机启动、显示 Shipherd 之外开的 session、记忆、换新阈值、重新运行向导。 */
export function BasicSettings({ report, onHealth, onRerunWizard }: { report: HealthReport; onHealth: (r: HealthReport) => void; onRerunWizard: () => void }) {
  const [autostart, setAutostart] = useState<AutostartState | null>(null);
  const form = useSettingsForm((k) => {
    if (k === "claudePath" || k === "memoryEnabled") api.health().then(onHealth, reportError);
  });

  useEffect(() => {
    api.autostart().then(setAutostart, reportError);
  }, []);

  if (!form) return <p className="muted">{S.loading}</p>;
  const { current, save, reset, textBlur } = form;

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
      {form.error && <p className="error">{form.error}</p>}
      {TEXT_FIELDS.map((k) => (
        <div key={k} className="field">
          {S.generalFields[k]}
          <input className="mono" placeholder={S.generalPlaceholders[k]} {...textBlur(k)} />
          <p className="muted">{S.generalHelp[k]}</p>
          {k === "claudePath" && (
            <dl className="kv">
              <dt>{S.claudePath}</dt><dd>{report.claude.path ?? <span className="error">{S.notFound}</span>}</dd>
              <dt>{S.claudeVersion}</dt><dd>{report.claude.version ?? "—"}</dd>
              {report.claude.missingFlags.length > 0 && (<><dt>{S.missingFlags}</dt><dd className="error">{report.claude.missingFlags.join(" ")}</dd></>)}
            </dl>
          )}
          <div className="actions">
            <button onClick={() => void reset(k)}>{S.resetDefault}</button>
          </div>
        </div>
      ))}
      <label className="inline">
        <input type="checkbox" data-testid="setting-updateCheckEnabled" checked={current.updateCheckEnabled !== "0"} onChange={(e) => void save("updateCheckEnabled", e.target.checked ? "1" : "0")} />
        {S.update.checkEnabled}
      </label>
      <p className="muted">{S.update.checkEnabledHelp}</p>
      <label className="inline">
        <input type="checkbox" disabled={!autostart?.supported} checked={autostart?.enabled ?? false} onChange={(e) => void toggleAutostart(e.target.checked)} />
        {S.autostart}
      </label>
      {autostart && !autostart.supported && <p className="muted">{S.autostartUnsupported}</p>}
      <label className="inline">
        <input type="checkbox" data-testid="setting-showOutsideSessions" checked={current.showOutsideSessions === "1"} onChange={(e) => void save("showOutsideSessions", e.target.checked ? "1" : "0")} />
        {S.showOutsideSessions}
      </label>
      <p className="muted">{S.showOutsideSessionsHelp}</p>
      <label className="inline">
        <input type="checkbox" data-testid="setting-autoResumeAfterRestart" checked={current.autoResumeAfterRestart === "1"} onChange={(e) => void save("autoResumeAfterRestart", e.target.checked ? "1" : "0")} />
        {S.autoResumeAfterRestart}
      </label>
      <p className="muted">{S.autoResumeAfterRestartHelp}</p>

      <h2>{S.memorySettings}</h2>
      <label className="inline">
        <input type="checkbox" checked={current.memoryEnabled !== "0"} onChange={(e) => void save("memoryEnabled", e.target.checked ? "1" : "0")} />
        {S.memoryEnabled}
      </label>
      <label className="inline">
        <input type="checkbox" data-testid="setting-flowExtract" checked={current.flowExtract !== "0"} onChange={(e) => void save("flowExtract", e.target.checked ? "1" : "0")} />
        {S.infoflow.extract}
      </label>
      <p className="muted">{S.infoflow.extractHelp}</p>
      <label className="inline">
        <input
          type="checkbox"
          data-testid="setting-flowAutoApply"
          disabled={current.flowExtract === "0"}
          checked={current.flowAutoApply !== "0"}
          onChange={(e) => void save("flowAutoApply", e.target.checked ? "1" : "0")}
        />
        {S.infoflow.autoApply}
      </label>
      <p className="muted">{S.infoflow.autoApplyHelp}</p>
      <div className="field">
        {S.infoflow.dailyAsks}
        <input className="mono" type="number" min={1} max={10000} step={1} data-testid="setting-flowDailyAsks" disabled={current.flowExtract === "0"} {...textBlur("flowDailyAsks")} />
        <p className="muted">{S.infoflow.dailyAsksHelp}</p>
        <div className="actions">
          <button onClick={() => void reset("flowDailyAsks")}>{S.resetDefault}</button>
        </div>
      </div>
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
        <input className="mono" type="number" min={0} step={10000} {...textBlur("refreshThresholdTokens")} />
        <p className="muted">{S.refreshThresholdHelp}</p>
        <div className="actions">
          <button onClick={() => void reset("refreshThresholdTokens")}>{S.resetDefault}</button>
        </div>
      </div>
      {m.statecorePlugin && <p className="error">{S.statecorePluginWarning}</p>}
      <div className="actions">
        <button onClick={() => api.setSetting("onboardingDone", "0").then(onRerunWizard, reportError)}>{S.rerunWizard}</button>
      </div>
    </section>
  );
}
