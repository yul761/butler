import { useEffect, useState } from "react";
import type { HealthReport } from "../../../shared/types";
import { api } from "../api";
import { S } from "../strings";
import { ClaudeAvailability } from "./ClaudeAvailability";

/**
 * 用量一行：读不到时省略。gh 装没装、登没登录在 report 里（BTL-249）。
 * 跟着 report 重取：点「重新检测」拿到新的 report 时一起更新。
 * 不用 useStateRefetch：它把每次读失败都弹成错误，而这里读不到只该省略。
 */
function useExtraHealth(report: HealthReport | null): { cachePct: number | null } {
  const [cachePct, setCachePct] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    api.usageSummary().then((u) => live && u.totalTokens > 0 && setCachePct(Math.round(u.cacheReadShare * 100)), () => undefined);
    return () => {
      live = false;
    };
  }, [report]);
  return { cachePct };
}

/** 「导出诊断」（BTL-242）：弹保存对话框，写一份性能诊断文件。 */
function DiagExport() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = () => {
    setBusy(true);
    setMsg(null);
    api.diagExport().then(
      (path) => path && setMsg({ ok: true, text: S.set.health.diagExported(path) }),
      (e: unknown) => setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }),
    ).finally(() => setBusy(false));
  };
  return (
    <div className="diag-export">
      <p className="muted">{S.set.health.diagExplain}</p>
      <div className="actions">
        <button disabled={busy} onClick={run} data-testid="diag-export">{busy ? S.set.health.diagExporting : S.set.health.diagExport}</button>
      </div>
      {msg && <p className={msg.ok ? "ok" : "error"} data-testid="diag-export-result">{msg.text}</p>}
    </div>
  );
}

/** 设置 › 健康检查：claude、hook、/handoff 命令、Butler 的目录、gh、用量，和安装或卸载 hook。 */
export function HealthSettings({
  report, busy, error, onRecheck, onInstall, onUninstall, scrollToAvailability,
}: {
  report: HealthReport | null;
  busy: boolean;
  error: string | null;
  onRecheck(): void;
  onInstall(): void;
  onUninstall(): void;
  scrollToAvailability: boolean;
}) {
  const { cachePct } = useExtraHealth(report);
  if (!report) return <p className="empty">{error ?? S.loading}</p>;
  const { claude } = report;
  return (
    <section className="settings-section">
      <h2>{S.health}</h2>
      <dl className="kv">
        <dt>{S.claudePath}</dt><dd>{claude.path ?? <span className="error">{S.notFound}</span>}</dd>
        <dt>{S.claudeVersion}</dt><dd>{claude.version ?? "—"}</dd>
        {claude.missingFlags.length > 0 && (<><dt>{S.missingFlags}</dt><dd className="error">{claude.missingFlags.join(" ")}</dd></>)}
        {claude.error && claude.error !== "claude_not_found" && (<><dt /><dd className="error">{claude.error}</dd></>)}
        {report.claudeLogin === "missing" && (<><dt /><dd className="error" data-testid="health-claude-login">{S.wizardClaudeLoginMissing}</dd></>)}
        <dt>{S.hooks}</dt><dd className={report.hooks === "installed" ? "ok" : "error"}>{S.hookStatus[report.hooks]}</dd>
        <dt>{S.handoffCommand}</dt><dd className={report.handoffCommand === "installed" ? "ok" : "error"}>{S.handoffCommandStatus[report.handoffCommand]}</dd>
        <dt>{S.butlerHome}</dt><dd>{report.butlerHome}</dd>
        <dt>{S.claudeSettings}</dt><dd>{report.claudeSettingsPath}</dd>
        <dt>{S.set.health.gh}</dt>
        <dd className={report.gh === "ok" ? "ok" : "error"} data-testid="health-gh">{report.gh === "ok" ? S.set.health.ghOk : report.gh === "logged_out" ? S.set.health.ghLoggedOut : S.set.health.ghMissing}</dd>
        {cachePct !== null && (<><dt>{S.set.health.usage}</dt><dd data-testid="health-usage">{S.set.health.usageValue(cachePct)}</dd></>)}
      </dl>
      <ClaudeAvailability scrollIntoView={scrollToAvailability} />
      <p className="muted">{S.hookExplain}</p>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button disabled={busy} onClick={onRecheck}>{S.recheck}</button>
        <button className="primary" disabled={busy || report.hooks === "settings_invalid"} onClick={onInstall}>{S.installHooks}</button>
        <button disabled={busy || report.hooks === "missing"} onClick={onUninstall}>{S.uninstallHooks}</button>
      </div>
      <DiagExport />
    </section>
  );
}
