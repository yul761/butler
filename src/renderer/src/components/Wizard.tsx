import { useEffect, useState } from "react";
import type { HealthReport } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { mergeTools } from "../settings-form";
import { S } from "../strings";
import { canAdvance, nextStep, prevStep, stepNumber, type WizardStep } from "../wizard";
import { PrivacySettings } from "./PrivacySettings";
import { TrackerToolPicker } from "./TrackerToolPicker";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Wizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<WizardStep>("claude");
  const [report, setReport] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [claudePath, setClaudePath] = useState("");
  const [savedClaudePath, setSavedClaudePath] = useState("");

  async function run(fn: () => Promise<HealthReport>) {
    setBusy(true);
    setMessage(null);
    try {
      setReport(await fn());
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void run(api.health);
    api.settings().then((s) => { setClaudePath(s.claudePath); setSavedClaudePath(s.claudePath); }, reportError);
  }, []);

  // 换步骤时清掉上一步的提示（如“已保存”）。
  useEffect(() => {
    setMessage(null);
  }, [step]);

  async function finish() {
    try {
      await api.setSetting("onboardingDone", "1");
      onDone();
    } catch (e) {
      reportError(e);
    }
  }

  async function saveClaudePath() {
    setMessage(null);
    try {
      await api.setSetting("claudePath", claudePath.trim());
      setSavedClaudePath(claudePath.trim());
      await run(api.health);
    } catch (e) {
      setMessage(errorText(e));
    }
  }

  async function saveTools(picked: string[]) {
    setMessage(null);
    try {
      const current = await api.settings();
      await api.setSetting("trackerTools", mergeTools(current.trackerTools, picked));
      setMessage(S.wizardTrackerSaved);
    } catch (e) {
      setMessage(errorText(e));
    }
  }

  const { n, total } = stepNumber(step);

  return (
    <div className="page wizard" data-testid="wizard">
      <h2>{S.wizardTitle}</h2>
      {step !== "done" && <p className="muted">{S.wizardStep(n, total)}</p>}

      {step === "claude" && (
        <section className="settings-section">
          <h3>{S.wizardClaudeTitle}</h3>
          <p className="muted">{S.wizardClaudeHelp}</p>
          {report && (
            <dl className="kv">
              <dt>{S.claudePath}</dt>
              <dd>{report.claude.path ?? <span className="error">{S.notFound}</span>}</dd>
              <dt>{S.claudeVersion}</dt>
              <dd>{report.claude.version ?? "—"}</dd>
              {report.claude.missingFlags.length > 0 && (
                <>
                  <dt>{S.missingFlags}</dt>
                  <dd className="error">{report.claude.missingFlags.join(" ")}</dd>
                </>
              )}
            </dl>
          )}
          {!canAdvance("claude", report) && !busy && <p className="error">{S.wizardClaudeMissing}</p>}
          <div className="field">
            {S.generalFields.claudePath}
            <input className="mono" value={claudePath} placeholder={S.generalPlaceholders.claudePath} onChange={(e) => setClaudePath(e.target.value)} />
            {claudePath.trim() === "" && <p className="muted">{S.wizardClaudePathEmptyHint}</p>}
            <div className="actions">
              <button disabled={claudePath.trim() === savedClaudePath} onClick={() => void saveClaudePath()}>{S.save}</button>
              <button disabled={busy} onClick={() => void run(api.health)}>{S.recheck}</button>
            </div>
          </div>
        </section>
      )}

      {step === "hooks" && (
        <section className="settings-section">
          <h3>{S.wizardHooksTitle}</h3>
          <p className="muted">{S.wizardHooksHelp}</p>
          {report && (
            <dl className="kv">
              <dt>{S.hooks}</dt>
              <dd className={report.hooks === "installed" ? "ok" : "error"}>{S.hookStatus[report.hooks]}</dd>
              <dt>{S.handoffCommand}</dt>
              <dd className={report.handoffCommand === "installed" ? "ok" : "error"}>{S.handoffCommandStatus[report.handoffCommand]}</dd>
            </dl>
          )}
          <div className="actions">
            <button className="primary" disabled={busy || report?.hooks === "settings_invalid"} onClick={() => void run(api.installHooks)}>
              {S.installHooks}
            </button>
          </div>
        </section>
      )}

      {step === "tracker" && (
        <section className="settings-section">
          <h3>{S.wizardTrackerTitle}</h3>
          <p className="muted">{S.wizardTrackerHelp}</p>
          <TrackerToolPicker onDetect={() => setMessage(null)} onSave={saveTools} />
        </section>
      )}

      {step === "privacy" && (
        <section className="settings-section">
          <h3>{S.wizardPrivacyTitle}</h3>
          <p className="muted">{S.wizardPrivacyHelp}</p>
          <PrivacySettings />
        </section>
      )}

      {step === "done" && (
        <section className="settings-section">
          <h3>{S.wizardDoneTitle}</h3>
          <p>{S.wizardDoneHelp}</p>
        </section>
      )}

      {message && <p className="muted">{message}</p>}
      <div className="actions">
        {step !== "claude" && step !== "done" && <button onClick={() => setStep(prevStep(step))}>{S.wizardBack}</button>}
        {step === "done" ? (
          <button className="primary" onClick={() => void finish()}>{S.wizardFinish}</button>
        ) : (
          <button className="primary" disabled={busy || !canAdvance(step, report)} onClick={() => setStep(nextStep(step))}>
            {S.wizardNext}
          </button>
        )}
        {step !== "done" && <button onClick={() => void finish()}>{S.wizardSkip}</button>}
      </div>
    </div>
  );
}
