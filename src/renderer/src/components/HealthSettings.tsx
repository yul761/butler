import { useEffect, useState } from "react";
import type { HealthReport } from "../../../shared/types";
import { api } from "../api";
import { S } from "../strings";
import { ClaudeAvailability } from "./ClaudeAvailability";

/** gh 和用量两行：读不到时 gh 显示「未知」（不当成没装），用量那一行省略。 */
function useExtraHealth(): { gh: boolean | null; cachePct: number | null } {
  const [gh, setGh] = useState<boolean | null>(null);
  const [cachePct, setCachePct] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    api.lessonsState().then((s) => live && setGh(s.ghAvailable), () => undefined);
    api.usageSummary().then((u) => live && u.totalTokens > 0 && setCachePct(Math.round(u.cacheReadShare * 100)), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  return { gh, cachePct };
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
  const { gh, cachePct } = useExtraHealth();
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
        <dt>{S.hooks}</dt><dd className={report.hooks === "installed" ? "ok" : "error"}>{S.hookStatus[report.hooks]}</dd>
        <dt>{S.handoffCommand}</dt><dd className={report.handoffCommand === "installed" ? "ok" : "error"}>{S.handoffCommandStatus[report.handoffCommand]}</dd>
        <dt>{S.butlerHome}</dt><dd>{report.butlerHome}</dd>
        <dt>{S.claudeSettings}</dt><dd>{report.claudeSettingsPath}</dd>
        <dt>{S.set.health.gh}</dt>
        <dd className={gh === null ? undefined : gh ? "ok" : "error"} data-testid="health-gh">{gh === null ? S.set.health.unknown : gh ? S.set.health.ghOk : S.set.health.ghMissing}</dd>
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
    </section>
  );
}
