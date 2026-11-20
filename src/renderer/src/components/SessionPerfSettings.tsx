import { platform } from "../api";
import { S } from "../strings";
import { useSettingsForm } from "./useSettingsForm";

const SESSION_FIELDS = [
  { k: "sessionMemoryReserveMb", help: "sessionMemoryReserveMbHelp", step: 256, min: 0 },
  { k: "sessionMemoryEstimateMb", help: "sessionMemoryEstimateMbHelp", step: 128, min: 64 },
  { k: "sessionMaxRunning", help: "sessionMaxRunningHelp", step: 1, min: 0 },
] as const;

/** 设置 › 高级 › Session 与内存：同时开几个、闲置关闭、内存与性能、休眠、共享 MCP。 */
export function SessionPerfSettings() {
  const form = useSettingsForm();
  if (!form) return <p className="muted">{S.loading}</p>;
  const { current, save, reset, textBlur, flagField, numberField } = form;

  return (
    <section className="settings-section">
      {form.error && <p className="error">{form.error}</p>}
      {/* 按内存决定能同时开几个 session（工作流 W）。 */}
      <h2>{S.sessionSettings}</h2>
      {SESSION_FIELDS.map(({ k, help, step, min }) => (
        <div key={k} className="field">
          {S[k]}
          <input
            className="mono"
            type="number"
            min={min}
            step={step}
            placeholder={k === "sessionMemoryReserveMb" ? S.sessionMemoryReserveAuto : undefined}
            {...textBlur(k)}
          />
          <p className="muted">{S[help]}</p>
          <div className="actions">
            <button onClick={() => void reset(k)}>{S.resetDefault}</button>
          </div>
        </div>
      ))}
      {/* 闲置关闭先写 handoff（BTL-190 第 8 点）。 */}
      <div className="field">
        {S.idleCloseMinutes}
        <input className="mono" type="number" min={0} step={30} {...textBlur("idleCloseMinutes")} />
        <p className="muted">{S.idleCloseMinutesHelp}</p>
        <div className="actions">
          <button onClick={() => void reset("idleCloseMinutes")}>{S.resetDefault}</button>
        </div>
      </div>

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
        <input className="mono" type="number" min={0} step={256} {...textBlur("refreshMemoryMb")} />
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
      {/* 共享 MCP（WS-M H）。 */}
      {flagField("sharedMcp", S.perf.sharedMcp, S.perf.sharedMcpHelp)}
      <h3>{S.perf.tipsTitle}</h3>
      <ul className="perf-tips">
        {perfTips().map((t) => <li key={t}>{t}</li>)}
        <li>{S.perf.tipsMcp}</li>
      </ul>
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
