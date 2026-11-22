import { useState, type FormEvent } from "react";
import { FEEDBACK_KINDS, type FeedbackKind } from "../../../shared/feedback";
import { api } from "../api";
import { openFeedback, type FeedbackRequest } from "../feedback-bus";
import { S } from "../strings";

type Step = { at: "form" } | { at: "preview"; text: string } | { at: "done"; savedName: string | null; truncated: boolean };

/**
 * 「发送反馈」（BTL-254）：选类型、写标题和描述，在浏览器里打开预填好的 GitHub issue 页。
 * 勾了「附上诊断」就先给用户看脱敏后的全文，确认了才存进下载目录、在文件夹里选中，再打开 issue 页。
 */
export function FeedbackDialog({ request, onClose }: { request: FeedbackRequest; onClose: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>(request.kind ?? "bug");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [attach, setAttach] = useState(false);
  const [step, setStep] = useState<Step>({ at: "form" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const openIssue = async (savedName: string | null) => {
    const r = await api.feedbackOpen({ kind, title, description, ...(request.step ? { step: request.step } : {}), attachDiagnostics: savedName !== null });
    setStep({ at: "done", savedName, truncated: r.truncated });
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    if (attach) void run(async () => setStep({ at: "preview", text: await api.feedbackDiagPreview() }));
    else void run(() => openIssue(null));
  }

  const confirmSave = () =>
    void run(async () => {
      const saved = await api.feedbackDiagSave();
      await openIssue(saved.name);
    });

  return (
    <div className="modal-backdrop">
      {step.at === "form" && (
        <form className="modal feedback-dialog" onSubmit={submit} data-testid="feedback-dialog">
          <h2>{S.feedback.title}</h2>
          <p className="muted">{S.feedback.intro}</p>
          <fieldset>
            <legend>{S.feedback.kind}</legend>
            {FEEDBACK_KINDS.map((k) => (
              <label key={k} className="inline">
                <input type="radio" name="feedback-kind" value={k} checked={kind === k} onChange={() => setKind(k)} data-testid={`feedback-kind-${k}`} />
                {S.feedback.kinds[k]}
              </label>
            ))}
          </fieldset>
          <label>{S.feedback.summary}<input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus data-testid="feedback-title" /></label>
          <label>
            {S.feedback.description}
            <textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={S.feedback.descriptionHint} data-testid="feedback-description" />
          </label>
          <p className="muted">{S.feedback.envNote}</p>
          <label className="inline">
            <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} data-testid="feedback-attach" />
            {S.feedback.attach}
          </label>
          {attach && <p className="muted">{S.feedback.attachHint}</p>}
          {error && <p className="error" data-testid="feedback-error">{error}</p>}
          <div className="actions">
            <button type="button" onClick={onClose}>{S.feedback.cancel}</button>
            <button type="submit" className="primary" disabled={busy} data-testid="feedback-submit">
              {busy ? S.feedback.building : attach ? S.feedback.next : S.feedback.openGithub}
            </button>
          </div>
        </form>
      )}
      {step.at === "preview" && (
        <div className="modal feedback-dialog wide" data-testid="feedback-preview">
          <h2>{S.feedback.previewTitle}</h2>
          <p className="muted">{S.feedback.previewIntro}</p>
          <pre className="feedback-preview" data-testid="feedback-preview-text">{step.text}</pre>
          {error && <p className="error" data-testid="feedback-error">{error}</p>}
          <div className="actions">
            <button type="button" onClick={() => setStep({ at: "form" })}>{S.feedback.back}</button>
            <button type="button" className="primary" disabled={busy} onClick={confirmSave} data-testid="feedback-save">
              {busy ? S.feedback.building : S.feedback.saveAndOpen}
            </button>
          </div>
        </div>
      )}
      {step.at === "done" && (
        <div className="modal feedback-dialog" data-testid="feedback-done">
          <h2>{S.feedback.title}</h2>
          <p className="ok">{S.feedback.opened}</p>
          {step.savedName && <p data-testid="feedback-saved">{S.feedback.savedTo(step.savedName)}</p>}
          {step.truncated && <p className="muted" data-testid="feedback-truncated">{S.feedback.truncated}</p>}
          <div className="actions">
            <button type="button" className="primary" onClick={onClose} autoFocus>{S.feedback.close}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 设置「关于」里的按钮。 */
export function FeedbackButton() {
  return <button onClick={() => openFeedback()} data-testid="feedback-open">{S.feedback.open}</button>;
}

/** 向导里某一步失败时的「卡住了？告诉我们」。 */
export function StuckLink({ step }: { step: string }) {
  return (
    <button type="button" className="link" onClick={() => openFeedback({ kind: "first-run", step })} data-testid="feedback-stuck">
      {S.feedback.stuck}
    </button>
  );
}
