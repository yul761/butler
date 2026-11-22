import { useState } from "react";
import type { UpdateCheckResult } from "../../../shared/update";
import { api } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

const formatTime = (ms: number) => new Date(ms).toLocaleString([], { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 手动检查的结果，一句话。 */
export function updateResultText(r: UpdateCheckResult): string {
  if (r.kind === "latest") return S.update.resultLatest(r.current, r.latest);
  if (r.kind === "available") return S.update.resultAvailable(r.release.version);
  return S.update.resultFailed + S.update.reasons[r.reason];
}

/** 设置 › 关于（BTL-253）：当前版本、上次检查、手动检查更新和结果。BTL-254 在这里加「发送反馈」。 */
export function AboutSettings() {
  const view = useStateRefetch("update", api.updateState);
  const [busy, setBusy] = useState(false);
  if (!view) return <p className="muted">{S.loading}</p>;
  const checking = busy || view.checking;
  const result = view.lastManual;
  async function check() {
    setBusy(true);
    try {
      await api.checkUpdates();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section" data-testid="settings-about">
      <h2>{S.update.aboutHeading}</h2>
      <dl className="kv">
        <dt>{S.update.currentVersion}</dt>
        <dd className="mono" data-testid="about-version">{view.current}</dd>
        <dt>{S.update.lastChecked}</dt>
        <dd>{view.lastCheckedAt ? formatTime(view.lastCheckedAt) : S.update.never}</dd>
      </dl>
      <div className="actions">
        <button data-testid="update-check-now" disabled={checking} onClick={() => void check()}>{checking ? S.update.checking : S.update.checkNow}</button>
      </div>
      {!checking && result && (
        <p data-testid="update-check-result" className={result.kind === "failed" ? "error" : undefined}>
          {updateResultText(result)}
          {result.kind === "failed" && result.detail && <span className="muted"> ({result.detail})</span>}
        </p>
      )}
      {!view.enabled && <p className="muted">{S.update.autoOff}</p>}
    </section>
  );
}
