import { useCallback, useEffect, useRef, useState } from "react";
import { PRIVACY_LEVELS, type LlmStatus, type PrivacyLevel } from "../../../shared/llm";
import type { EditableSettingKey, EditableSettings } from "../../../shared/settings";
import { api, ButlerError } from "../api";
import { reportError } from "../errors";
import { formatUsd, llmWarnings, parseTermsText, termsText } from "../privacy-form";
import { S } from "../strings";

const TEXT_FIELDS = ["llmBaseUrl", "llmModel", "llmMonthlyBudgetUsd", "auditRetentionDays"] as const;

export function PrivacySettings() {
  const [values, setValues] = useState<EditableSettings | null>(null);
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [draft, setDraft] = useState<Partial<EditableSettings>>({});
  /** 已保存的人名数量（不是文本框里正在编辑的），用于 redacted 档位的提示。 */
  const [savedPeopleCount, setSavedPeopleCount] = useState(0);
  const [terms, setTerms] = useState<{ people: string; others: string } | null>(null);
  /** key 输入框不受控：key 只在提交的瞬间从 DOM 读出，不放进 React state。 */
  const keyRef = useRef<HTMLInputElement>(null);
  const [hasKeyInput, setHasKeyInput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [termsMessage, setTermsMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [v, s, t] = await Promise.all([api.settings(), api.llmStatus(), api.terms()]);
      setValues(v);
      setStatus(s);
      setSavedPeopleCount(t.filter((x) => x.category === "person").length);
      // 敏感词只在第一次加载时填进文本框：之后的刷新不覆盖用户正在编辑的内容。
      setTerms((cur) => cur ?? { people: termsText(t, "person"), others: termsText(t, "term") });
    } catch (e) {
      reportError(e);
    }
  }, []);

  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

  if (!values || !status || !terms) return <p className="muted">{S.loading}</p>;
  const current = values;
  const currentStatus = status;
  const currentTerms = terms;
  const level = current.llmLevel as PrivacyLevel;
  const value = (k: EditableSettingKey): string => draft[k] ?? current[k];
  const edit = (k: EditableSettingKey, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const clearDraft = (k: EditableSettingKey) =>
    setDraft((d) => {
      const next = { ...d };
      delete next[k];
      return next;
    });

  /** 校验失败（invalid_setting）的 message 显示在表单里；其他失败走全局错误条。 */
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

  const saveIfEdited = (k: EditableSettingKey) => {
    if (draft[k] !== undefined && draft[k] !== current[k]) void save(k);
    else clearDraft(k);
  };

  async function saveKey() {
    const input = keyRef.current;
    if (!input) return;
    const key = input.value;
    // 不管成功还是失败，先清空输入框。
    input.value = "";
    setHasKeyInput(false);
    setError(null);
    try {
      setStatus(await api.saveApiKey(key));
    } catch (e) {
      writeFailed(e);
    }
  }

  async function clearKey() {
    try {
      setStatus(await api.clearApiKey());
    } catch (e) {
      reportError(e);
    }
  }

  async function saveTerms() {
    setError(null);
    setTermsMessage(null);
    try {
      const saved = await api.saveTerms(parseTermsText(currentTerms.people, currentTerms.others));
      setSavedPeopleCount(saved.filter((x) => x.category === "person").length);
      setTerms({ people: termsText(saved, "person"), others: termsText(saved, "term") });
      setTermsMessage(S.termsSaved);
    } catch (e) {
      writeFailed(e);
    }
  }

  return (
    <section className="settings-section">
      <h2>{S.privacy}</h2>
      <p className="muted">{S.privacyIntro}</p>
      {llmWarnings(currentStatus, level, savedPeopleCount).map((w) => (
        <p key={w} className="notice-line">{w}</p>
      ))}
      {error && <p className="error">{error}</p>}

      <div className="field">
        {S.privacyLevel}
        {PRIVACY_LEVELS.map((l) => (
          <label key={l} className="inline">
            <input type="radio" name="llmLevel" checked={level === l} onChange={() => void save("llmLevel", l)} />
            <strong>{S.privacyLevels[l]}</strong>
            <span className="muted">{S.privacyLevelHelp[l]}</span>
          </label>
        ))}
      </div>

      {TEXT_FIELDS.map((k) => (
        <label key={k} className="field">
          {S.llmFields[k]}
          <input value={value(k)} placeholder={S.llmPlaceholders[k]} onChange={(e) => edit(k, e.target.value)} onBlur={() => saveIfEdited(k)} />
        </label>
      ))}

      <div className="field">
        {S.apiKey}
        <div className="row">
          <span className="muted">{currentStatus.keySaved ? (currentStatus.keyMasked ?? S.apiKeyUnreadable) : S.apiKeyNone}</span>
          <input ref={keyRef} type="password" autoComplete="new-password" spellCheck={false} placeholder={S.apiKeyPlaceholder} onChange={(e) => setHasKeyInput(e.target.value.trim() !== "")} />
          <button disabled={!hasKeyInput || !currentStatus.encryptionAvailable} onClick={() => void saveKey()}>{S.save}</button>
          {currentStatus.keySaved && <button onClick={() => void clearKey()}>{S.clearKey}</button>}
        </div>
        <p className="muted">{S.apiKeyHint}</p>
      </div>

      <div className="field">
        {S.llmFields.llmPrices}
        <textarea rows={4} className="mono" value={value("llmPrices")} onChange={(e) => edit("llmPrices", e.target.value)} onBlur={() => saveIfEdited("llmPrices")} />
        <p className="muted">{S.llmPricesHint}</p>
      </div>
      <p className="muted">{S.monthSpend(formatUsd(currentStatus.monthCostUsd), formatUsd(currentStatus.budgetUsd))}</p>

      <label className="inline">
        <input type="checkbox" checked={current.llmConfirm === "1"} onChange={(e) => void save("llmConfirm", e.target.checked ? "1" : "0")} />
        {S.llmConfirm}
      </label>

      <div className="field">
        {S.sensitiveTerms}
        <div className="row">
          <label className="field">
            {S.termsPeople}
            <textarea rows={5} value={currentTerms.people} onChange={(e) => setTerms({ ...currentTerms, people: e.target.value })} />
            <span className="muted">{S.privacyPeopleWarning}</span>
          </label>
          <label className="field">
            {S.termsOthers}
            <textarea rows={5} value={currentTerms.others} onChange={(e) => setTerms({ ...currentTerms, others: e.target.value })} />
          </label>
        </div>
        <p className="muted">{S.termsHint}</p>
        <div className="actions">
          <button onClick={() => void saveTerms()}>{S.save}</button>
          {termsMessage && <span className="muted">{termsMessage}</span>}
        </div>
      </div>
    </section>
  );
}
