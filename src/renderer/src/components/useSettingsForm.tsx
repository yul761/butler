import { useCallback, useEffect, useState, type ChangeEvent, type ReactElement } from "react";
import type { EditableSettingKey, EditableSettings } from "../../../shared/settings";
import { api, ShipherdError } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";

export interface SettingsForm {
  current: EditableSettings;
  /** 输入框里的值：有草稿用草稿，没有用已保存的值。 */
  value(k: EditableSettingKey): string;
  save(k: EditableSettingKey, v?: string): Promise<void>;
  reset(k: EditableSettingKey): Promise<void>;
  /** 一个开关（"0" / "1"）和它的说明。 */
  flagField(k: EditableSettingKey, label: string, help: string): ReactElement;
  /** 一个数字：离开输入框时保存，带「恢复默认」。 */
  numberField(k: EditableSettingKey, label: string, help?: string, range?: { min?: number; max?: number }): ReactElement;
  /** 文本或数字输入框的 value / onChange / onBlur：离开时有改动才保存。 */
  textBlur(k: EditableSettingKey): { value: string; onChange(e: ChangeEvent<HTMLInputElement>): void; onBlur(): void };
  /** 设置不合法时主进程给的说明（invalid_setting），其余错误走 reportError。 */
  error: string | null;
}

/**
 * 设置页各块共用的读、存、恢复默认和草稿（原来在 GeneralSettings 里）。还没读到时返回 null，
 * 读失败时 reportError，和原来一样不画任何开关。onSaved：保存或恢复默认成功之后。
 */
export function useSettingsForm(onSaved?: (k: EditableSettingKey) => void): SettingsForm | null {
  const [values, setValues] = useState<EditableSettings | null>(null);
  const [draft, setDraft] = useState<Partial<EditableSettings>>({});
  const [error, setError] = useState<string | null>(null);

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

  if (!values) return null;
  const current = values;
  const value = (k: EditableSettingKey): string => draft[k] ?? current[k];
  const clearDraft = (k: EditableSettingKey) =>
    setDraft((d) => {
      const next = { ...d };
      delete next[k];
      return next;
    });

  function failed(e: unknown) {
    if (e instanceof ShipherdError && e.code === "invalid_setting") setError(e.message);
    else reportError(e);
  }

  async function save(k: EditableSettingKey, v: string = value(k)) {
    setError(null);
    try {
      await api.setSetting(k, v);
      clearDraft(k);
      await load();
      onSaved?.(k);
    } catch (e) {
      failed(e);
    }
  }

  async function reset(k: EditableSettingKey) {
    setError(null);
    try {
      await api.resetSetting(k);
      clearDraft(k);
      await load();
      onSaved?.(k);
    } catch (e) {
      failed(e);
    }
  }

  const textBlur = (k: EditableSettingKey) => ({
    value: value(k),
    onChange: (e: ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [k]: e.target.value })),
    onBlur: () => {
      if (draft[k] !== undefined && draft[k] !== current[k]) void save(k);
      else clearDraft(k);
    },
  });

  const flagField = (k: EditableSettingKey, label: string, help: string) => (
    <div className="field">
      <label className="inline">
        <input type="checkbox" checked={current[k] !== "0"} onChange={(e) => void save(k, e.target.checked ? "1" : "0")} />
        {label}
      </label>
      <p className="muted">{help}</p>
    </div>
  );

  const numberField = (k: EditableSettingKey, label: string, help?: string, range: { min?: number; max?: number } = { min: 0 }) => (
    <div className="field">
      {label}
      <input className="mono" type="number" min={range.min} max={range.max} {...textBlur(k)} />
      {help && <p className="muted">{help}</p>}
      <div className="actions">
        <button onClick={() => void reset(k)}>{S.resetDefault}</button>
      </div>
    </div>
  );

  return { current, value, save, reset, flagField, numberField, textBlur, error };
}
