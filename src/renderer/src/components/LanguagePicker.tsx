import { useEffect, useState } from "react";
import { LANG_SETTINGS } from "../../../shared/i18n";
import { api } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";

/**
 * 语言选择（设计文档 2026-10-26）：自动 / 中文 / English。保存之后整个窗口重新加载，所有文案换成新语言；
 * 终端的进程在主进程里，重新加载后照常接上。
 */
export function LanguagePicker() {
  const [value, setValue] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then((s) => setValue(s.language), reportError);
  }, []);

  async function change(next: string) {
    setValue(next);
    try {
      await api.setSetting("language", next);
      window.location.reload();
    } catch (e) {
      reportError(e);
    }
  }

  if (value === null) return null;
  return (
    <label className="language-picker">
      {S.language}
      <select value={value} onChange={(e) => void change(e.target.value)}>
        {LANG_SETTINGS.map((l) => <option key={l} value={l}>{S.languageOptions[l]}</option>)}
      </select>
      <span className="muted">{S.languageHint}</span>
    </label>
  );
}
