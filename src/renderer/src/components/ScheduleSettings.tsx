import { useCallback, useEffect, useRef, useState } from "react";
import type { EditableSettingKey, EditableSettings } from "../../../shared/settings";
import { api, ButlerError } from "../api";
import { reportError } from "../errors";
import { jobResultMessage } from "../job-view";
import { hasDay, mergeTools, toggleDay, WEEK_ORDER } from "../settings-form";
import { S } from "../strings";
import { TrackerToolPicker } from "./TrackerToolPicker";

const THRESHOLDS = ["blockedDays", "reviewWaitDays", "staleDays"] as const;
const PROMPTS = ["handoffPrompt", "refreshPrompt"] as const;

export function ScheduleSettings() {
  const [values, setValues] = useState<EditableSettings | null>(null);
  const [draft, setDraft] = useState<Partial<EditableSettings>>({});
  const [error, setError] = useState<string | null>(null);
  const [nightlyBusy, setNightlyBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [daysBusy, setDaysBusy] = useState(false);
  const [nightlyMessage, setNightlyMessage] = useState<string | null>(null);
  /** 第一次加载成功之后，后续的刷新失败走全局错误条。 */
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      setValues(await api.settings());
      setLoadError(null);
      loadedOnce.current = true;
    } catch (e) {
      if (loadedOnce.current) reportError(e);
      else setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!values)
    return loadError ? (
      <p className="error">
        {S.loadFailed(loadError)} <button onClick={() => void load()}>{S.retry}</button>
      </p>
    ) : (
      <p className="muted">{S.loading}</p>
    );
  const current = values;
  const value = (k: EditableSettingKey): string => draft[k] ?? current[k];
  const edit = (k: EditableSettingKey, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const clearDraft = (k: EditableSettingKey) =>
    setDraft((d) => {
      const next = { ...d };
      delete next[k];
      return next;
    });

  /** 校验失败（invalid_setting）的 message 直接显示在表单里；其他失败走全局错误条。 */
  function writeFailed(e: unknown) {
    if (e instanceof ButlerError && e.code === "invalid_setting") setError(e.message);
    else reportError(e);
  }

  async function save(k: EditableSettingKey, v: string = value(k)) {
    setError(null);
    try {
      await api.setSetting(k, v);
      clearDraft(k);
      await load();
    } catch (e) {
      writeFailed(e);
    }
  }

  /** 失焦时只保存确实改过的字段。 */
  const saveIfEdited = (k: EditableSettingKey) => {
    if (draft[k] !== undefined && draft[k] !== current[k]) void save(k);
    else clearDraft(k);
  };

  async function reset(k: EditableSettingKey) {
    setError(null);
    try {
      await api.resetSetting(k);
      clearDraft(k);
      await load();
    } catch (e) {
      writeFailed(e);
    }
  }

  async function runNightly() {
    setNightlyBusy(true);
    setNightlyMessage(null);
    try {
      const job = await api.runNightly();
      if (job) setNightlyMessage(jobResultMessage(job));
    } catch (e) {
      reportError(e);
    } finally {
      setNightlyBusy(false);
    }
  }

  /** 保存完成（并重新读取）之前不接受下一次点击：第二次点击总是基于最新的值。 */
  async function toggleWorkingDay(day: number) {
    setDaysBusy(true);
    try {
      await save("workingDays", toggleDay(current.workingDays, day));
    } finally {
      setDaysBusy(false);
    }
  }


  return (
    <section className="settings-section">
      <h2>{S.schedule}</h2>
      <p className="muted">{S.scheduleNote}</p>
      {error && <p className="error">{error}</p>}

      <label className="field">
        {S.nightlyTime}
        <input type="time" value={value("nightlyTime")} onChange={(e) => edit("nightlyTime", e.target.value)} onBlur={() => saveIfEdited("nightlyTime")} />
      </label>

      <div className="field">
        {S.workingDays}
        <div className="row">
          {WEEK_ORDER.map((day) => (
            <label key={day} className="inline">
              <input type="checkbox" checked={hasDay(current.workingDays, day)} disabled={daysBusy} onChange={() => void toggleWorkingDay(day)} />
              {S.weekdayNames[day]}
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        {S.thresholds}
        <div className="row">
          {THRESHOLDS.map((k) => (
            <label key={k} className="inline">
              {S[k]}
              <input type="number" min={0} max={999} value={value(k)} onChange={(e) => edit(k, e.target.value)} onBlur={() => saveIfEdited(k)} />
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        {S.trackerTools}
        <textarea rows={4} className="mono" value={value("trackerTools")} onChange={(e) => edit("trackerTools", e.target.value)} onBlur={() => saveIfEdited("trackerTools")} />
        <p className="muted">{S.trackerHint}</p>
        <p className="muted">{S.trackerHintSources}</p>
        <label className="inline">
          <input type="checkbox" checked={current.headlessProjectMcp === "1"} onChange={(e) => void save("headlessProjectMcp", e.target.checked ? "1" : "0")} />
          {S.headlessProjectMcp}
        </label>
        <div className="actions">
          <button onClick={() => void save("trackerTools")}>{S.save}</button>
        </div>
        <TrackerToolPicker onSave={(picked) => save("trackerTools", mergeTools(value("trackerTools"), picked))} />
      </div>

      {PROMPTS.map((k) => (
        <div key={k} className="field">
          {S[k]}
          <textarea rows={10} className="mono" value={value(k)} onChange={(e) => edit(k, e.target.value)} />
          <div className="actions">
            <button onClick={() => void save(k)}>{S.save}</button>
            <button onClick={() => void reset(k)}>{S.resetDefault}</button>
          </div>
        </div>
      ))}

      <div className="actions">
        <button disabled={nightlyBusy} onClick={() => void runNightly()}>{nightlyBusy ? S.nightlyRunning : S.runNightlyNow}</button>
        {nightlyMessage && <span className="muted">{nightlyMessage}</span>}
      </div>
    </section>
  );
}
