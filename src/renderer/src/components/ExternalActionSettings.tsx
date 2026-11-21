import { useCallback, useEffect, useState } from "react";
import { EXTERNAL_ACTIONS, EXTERNAL_ACTION_SETTINGS } from "../../../shared/external";
import type { EditableSettings } from "../../../shared/settings";
import { api } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";
import { useSettingsForm } from "./useSettingsForm";

/**
 * 设置里的「对外动作」（契约 4.8，ws-b）：每种对外动作一个开关，默认全关。
 * 只有开关和说明；真正用到开关的功能以后接入（src/main/external/actions.ts）。
 */
export function ExternalActionSettings() {
  const [values, setValues] = useState<EditableSettings | null>(null);

  const load = useCallback(async () => {
    try {
      setValues(await api.settings());
    } catch (e) {
      reportError(e);
    }
  }, []);

  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

  if (!values) return null;
  const current = values;

  async function toggle(key: (typeof EXTERNAL_ACTION_SETTINGS)[keyof typeof EXTERNAL_ACTION_SETTINGS], on: boolean) {
    try {
      await api.setSetting(key, on ? "1" : "0");
      await load();
    } catch (e) {
      reportError(e);
    }
  }

  return (
    <section className="external-actions" data-testid="external-actions">
      <h2>{S.externalHeading}</h2>
      <p className="muted">{S.externalIntro}</p>
      {EXTERNAL_ACTIONS.map((kind) => {
        const key = EXTERNAL_ACTION_SETTINGS[kind];
        return (
          <div key={kind} className="external-action">
            <label className="inline">
              <input type="checkbox" data-testid={`external-${kind}`} checked={current[key] === "1"} onChange={(e) => void toggle(key, e.target.checked)} />
              {S.externalActions[kind].label}
            </label>
            <span className="muted"> {S.externalActions[kind].hint}</span>
          </div>
        );
      })}
      <AuditRetentionField />
    </section>
  );
}

/** 审计保留天数（BTL-243 从原来的隐私分组搬过来）：对外动作审计和外部通知记录都按它清理。 */
function AuditRetentionField() {
  const form = useSettingsForm();
  if (!form) return null;
  return (
    <div data-testid="audit-retention">
      {form.error && <p className="error">{form.error}</p>}
      {form.numberField("auditRetentionDays", S.externalAuditRetention, S.externalAuditRetentionHelp, { min: 1, max: 3650 })}
    </div>
  );
}
