import { useCallback, useEffect, useState } from "react";
import type { EditableSettingKey, EditableSettings } from "../../../shared/settings";
import type { McpProbe } from "../../../shared/types";
import { api, ButlerError } from "../api";
import { reportError } from "../errors";
import { hasDay, mergeTools, probeIncomplete, toggleDay, WEEK_ORDER } from "../settings-form";
import { S } from "../strings";

const THRESHOLDS = ["blockedDays", "reviewWaitDays", "staleDays"] as const;
const PROMPTS = ["handoffPrompt", "refreshPrompt"] as const;

export function ScheduleSettings() {
  const [values, setValues] = useState<EditableSettings | null>(null);
  const [draft, setDraft] = useState<Partial<EditableSettings>>({});
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<McpProbe | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [nightlyBusy, setNightlyBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setValues(await api.settings());
    } catch (e) {
      reportError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!values) return <p className="muted">{S.loading}</p>;
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

  async function detect() {
    setDetecting(true);
    setError(null);
    try {
      const p = await api.detectTrackerTools();
      setProbe(p);
      setPicked(p.suggested);
    } catch (e) {
      reportError(e);
    } finally {
      setDetecting(false);
    }
  }

  async function runNightly() {
    setNightlyBusy(true);
    try {
      await api.runNightly();
    } catch (e) {
      reportError(e);
    } finally {
      setNightlyBusy(false);
    }
  }

  const togglePick = (t: string) => setPicked(picked.includes(t) ? picked.filter((x) => x !== t) : [...picked, t]);

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
              <input type="checkbox" checked={hasDay(current.workingDays, day)} onChange={() => void save("workingDays", toggleDay(current.workingDays, day))} />
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
        <textarea rows={4} className="mono" value={value("trackerTools")} onChange={(e) => edit("trackerTools", e.target.value)} />
        <p className="muted">{S.trackerHint}</p>
        <div className="actions">
          <button onClick={() => void save("trackerTools")}>{S.save}</button>
          <button disabled={detecting} onClick={() => void detect()}>{detecting ? S.detecting : S.detectTools}</button>
        </div>
        {probe && probeIncomplete(probe) && <p className="muted">{S.probeIncomplete}</p>}
        {probe && probe.tools.length === 0 && <p className="muted">{S.noDetectedTools}</p>}
        {probe && probe.tools.length > 0 && (
          <div className="probe">
            <p className="muted">{S.detectedTools(probe.tools.length, probe.suggested.length)}</p>
            {probe.tools.map((t) => (
              <label key={t} className="inline">
                <input type="checkbox" checked={picked.includes(t)} onChange={() => togglePick(t)} />
                <code>{t}</code>
              </label>
            ))}
            <div className="actions">
              <button className="primary" disabled={picked.length === 0} onClick={() => void save("trackerTools", mergeTools(value("trackerTools"), picked))}>
                {S.addSelected}
              </button>
            </div>
          </div>
        )}
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
      </div>
    </section>
  );
}
