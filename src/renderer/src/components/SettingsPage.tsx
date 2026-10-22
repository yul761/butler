import { useEffect, useState } from "react";
import type { HealthReport } from "../../../shared/types";
import { api } from "../api";
import { S } from "../strings";
import { PrivacySettings } from "./PrivacySettings";
import { GeneralSettings } from "./GeneralSettings";
import { ScheduleSettings } from "./ScheduleSettings";

export function SettingsPage({ onRerunWizard }: { onRerunWizard: () => void }) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<HealthReport>) {
    setBusy(true);
    setError(null);
    try {
      setReport(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void run(api.health);
  }, []);

  if (!report) return <p className="empty">{error ?? S.loading}</p>;
  const { claude } = report;

  return (
    <div className="page">
      <h2>{S.health}</h2>
      <dl className="kv">
        <dt>{S.claudePath}</dt><dd>{claude.path ?? <span className="error">{S.notFound}</span>}</dd>
        <dt>{S.claudeVersion}</dt><dd>{claude.version ?? "—"}</dd>
        {claude.missingFlags.length > 0 && (<><dt>{S.missingFlags}</dt><dd className="error">{claude.missingFlags.join(" ")}</dd></>)}
        {claude.error && claude.error !== "claude_not_found" && (<><dt /><dd className="error">{claude.error}</dd></>)}
        <dt>{S.hooks}</dt><dd className={report.hooks === "installed" ? "ok" : "error"}>{S.hookStatus[report.hooks]}</dd>
        <dt>{S.handoffCommand}</dt><dd className={report.handoffCommand === "installed" ? "ok" : "error"}>{S.handoffCommandStatus[report.handoffCommand]}</dd>
        <dt>{S.butlerHome}</dt><dd>{report.butlerHome}</dd>
        <dt>{S.claudeSettings}</dt><dd>{report.claudeSettingsPath}</dd>
      </dl>
      <p className="muted">{S.hookExplain}</p>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button disabled={busy} onClick={() => void run(api.health)}>{S.recheck}</button>
        <button className="primary" disabled={busy || report.hooks === "settings_invalid"} onClick={() => void run(api.installHooks)}>{S.installHooks}</button>
        <button disabled={busy || report.hooks === "missing"} onClick={() => void run(api.uninstallHooks)}>{S.uninstallHooks}</button>
      </div>
      <GeneralSettings report={report} onHealth={setReport} onRerunWizard={onRerunWizard} />
      <ScheduleSettings />
      <PrivacySettings />
    </div>
  );
}
