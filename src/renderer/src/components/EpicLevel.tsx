import { useEffect, useState } from "react";
import { AUTOMATION_LEVELS, isAutomationLevel, type AutomationDisplay, type AutomationLevel } from "../../../shared/automation";
import { api } from "../api";
import { S } from "../strings";

/** 下拉框里「跟随全局」那一项的值（不是档位）。 */
const FOLLOW = "";
/** 「全自动（以后）」：先显示，不能选。 */
const FULL = "full";

/** epic 档位下拉框的纯视图（测试直接渲染）。value：这个 epic 自己选的档位，null 是跟随全局。 */
export function EpicLevelPicker({ value, globalLevel, disabled = false, onChange }: {
  value: AutomationLevel | null;
  /** 全局现在显示成什么：开关改过、和存的档位对不上时是 custom。 */
  globalLevel: AutomationDisplay;
  disabled?: boolean;
  onChange(level: AutomationLevel | null): void;
}) {
  const t = S.set.auto;
  return (
    <label className="epic-level" title={t.epicHint} data-testid="epic-level">
      {t.epicLabel}
      <select
        value={value ?? FOLLOW}
        disabled={disabled}
        data-testid="epic-level-select"
        onChange={(e) => {
          const v = e.target.value;
          if (v === FOLLOW) onChange(null);
          else if (isAutomationLevel(v)) onChange(v);
        }}
      >
        <option value={FOLLOW}>{t.epicFollow(globalLevel === "custom" ? t.custom : t.levels[globalLevel].label)}</option>
        {AUTOMATION_LEVELS.map((l) => <option key={l} value={l}>{t.levels[l].label}</option>)}
        <option value={FULL} disabled>{t.levels.full.label}</option>
      </select>
    </label>
  );
}

/** epic 页标题右边：读全局档位（「跟随全局」后面显示它），选了就写这个 epic 的档位。 */
export function EpicLevel({ featureId, value, onError }: { featureId: number; value: AutomationLevel | null; onError(e: unknown): void }) {
  const [globalLevel, setGlobalLevel] = useState<AutomationDisplay>("manual");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => void api.automationState().then((s) => live && setGlobalLevel(s.display), () => undefined);
    load();
    // 状态一变就通知、一次操作常常连着好几下：合成一次再读（automationState 要扫三张策略表）。
    const off = api.onStateChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, 300);
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      off();
    };
  }, []);
  return (
    <EpicLevelPicker
      value={value}
      globalLevel={globalLevel}
      disabled={busy}
      onChange={(level) => {
        setBusy(true);
        api.setFeatureAutomationLevel(featureId, level).catch(onError).finally(() => setBusy(false));
      }}
    />
  );
}
