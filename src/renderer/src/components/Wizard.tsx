import { useEffect, useRef, useState } from "react";
import type { HealthReport } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { savedWizardStep, saveWizardStep, setWizardSkipped } from "../local-prefs";
import { S } from "../strings";
import { LanguagePicker } from "./LanguagePicker";
import { canAdvance, nextStep, prevStep, stepNumber, type WizardStep } from "../wizard";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ghText = (g: HealthReport["gh"]) => (g === "ok" ? S.set.health.ghOk : g === "logged_out" ? S.set.health.ghLoggedOut : S.set.health.ghMissing);

export function Wizard({ onDone }: { onDone: () => void }) {
  // 上次退出时停在哪一步就从哪一步继续（只记在这台机器上）。
  const [step, setStep] = useState<WizardStep>(() => savedWizardStep() ?? "claude");
  const [report, setReport] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [claudePath, setClaudePath] = useState("");
  const [savedClaudePath, setSavedClaudePath] = useState("");
  /** 点过「安装并继续」但没装上：给一个「下一步」，不让人只能「稍后再说」。 */
  const [installFailed, setInstallFailed] = useState(false);

  // 只采用最近一次检测的结果：启动时的检测在 Windows 上可能很慢（经 cmd.exe 跑 claude --version / --help），
  // 用户在它返回之前改了 claude 路径并重新检测时，晚到的旧结果不能盖掉新结果。
  const runSeq = useRef(0);
  async function run(fn: () => Promise<HealthReport>) {
    const seq = ++runSeq.current;
    setBusy(true);
    setMessage(null);
    try {
      const r = await fn();
      if (seq === runSeq.current) setReport(r);
    } catch (e) {
      if (seq === runSeq.current) setMessage(errorText(e));
    } finally {
      if (seq === runSeq.current) setBusy(false);
    }
  }

  useEffect(() => {
    void run(api.health);
    api.settings().then((s) => { setClaudePath(s.claudePath); setSavedClaudePath(s.claudePath); }, reportError);
  }, []);

  // 换步骤时清掉上一步的提示（如“已保存”），并记下当前步骤。
  useEffect(() => {
    setMessage(null);
    saveWizardStep(step);
  }, [step]);

  /** skipped：点的是“稍后再说”（记在本地；「现在」页顶上据此提醒还没设置完）。 */
  async function finish(skipped: boolean) {
    try {
      await api.setSetting("onboardingDone", "1");
      saveWizardStep(null);
      setWizardSkipped(skipped);
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

  /** 装好了要看 hook 和 /handoff 两样；/handoff 是用户自己的同名文件（conflict）时不覆盖，也算能继续。 */
  const hooksReady = report !== null && report.hooks === "installed" && report.handoffCommand !== "missing" && report.handoffCommand !== "stale";

  async function installAndContinue() {
    const seq = ++runSeq.current;
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.installHooks();
      if (seq !== runSeq.current) return;
      setReport(r);
      // 装的时候用户可能已经点了「上一步」：只在还停在 hook 这一步时往前走。
      if (r.hooks === "installed") setStep((cur) => (cur === "hooks" ? nextStep("hooks") : cur));
      else {
        setInstallFailed(true);
        setMessage(S.wizardHooksNotInstalled);
      }
    } catch (e) {
      if (seq === runSeq.current) setMessage(errorText(e));
    } finally {
      if (seq === runSeq.current) setBusy(false);
    }
  }

  const { n, total } = stepNumber(step);

  return (
    <div className="page wizard" data-testid="wizard">
      <h2>{S.wizardTitle}</h2>
      <LanguagePicker hint={S.languageHintWizard} />
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
              <dt>{S.set.health.gh}</dt>
              <dd className={report.gh === "ok" ? "ok" : "error"} data-testid="wizard-gh">{ghText(report.gh)}</dd>
            </dl>
          )}
          {!canAdvance("claude", report) && !busy && <p className="error">{S.wizardClaudeMissing}</p>}
          {report?.claudeLogin === "missing" && !busy && <p className="error" data-testid="wizard-claude-login">{S.wizardClaudeLoginMissing}</p>}
          {report && report.gh !== "ok" && <p className="muted">{S.wizardGhHelp}</p>}
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
          <p className="muted">{S.wizardHooksHelp(report?.butlerHome ?? "~/.butler")}</p>
          {report && (
            <dl className="kv">
              <dt>{S.hooks}</dt>
              <dd className={report.hooks === "installed" ? "ok" : "error"}>{S.hookStatus[report.hooks]}</dd>
              <dt>{S.handoffCommand}</dt>
              <dd className={report.handoffCommand === "installed" ? "ok" : "error"}>{S.handoffCommandStatus[report.handoffCommand]}</dd>
            </dl>
          )}
          {/* 还没装时底下的主按钮就是「安装并继续」；这里留着给已经装过、要修复的情况。 */}
          {hooksReady && (
            <div className="actions">
              <button disabled={busy} onClick={() => void run(api.installHooks)}>{S.installHooks}</button>
            </div>
          )}
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
        {step !== "claude" && step !== "done" && <button disabled={busy} onClick={() => setStep(prevStep(step))}>{S.wizardBack}</button>}
        {step === "done" ? (
          <button className="primary" onClick={() => void finish(false)}>{S.wizardFinish}</button>
        ) : step === "hooks" && !hooksReady ? (
          // 不装 hook，「轮到你」和状态都不工作（BTL-249）：主按钮先装再走。装不上（或 settings.json 读不了）时再给一个「下一步」。
          <>
            <button className="primary" disabled={busy || report?.hooks === "settings_invalid"} onClick={() => void installAndContinue()}>
              {S.wizardHooksInstallNext}
            </button>
            {(installFailed || report?.hooks === "settings_invalid") && (
              <button disabled={busy} onClick={() => setStep(nextStep(step))}>{S.wizardNext}</button>
            )}
          </>
        ) : (
          <button className="primary" disabled={busy || !canAdvance(step, report)} onClick={() => setStep(nextStep(step))}>
            {S.wizardNext}
          </button>
        )}
        {step !== "done" && <button onClick={() => void finish(true)}>{S.wizardSkip}</button>}
      </div>
    </div>
  );
}
