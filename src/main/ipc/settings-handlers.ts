import { EDITABLE_SETTINGS, isEditableSetting, type EditableSettingKey, type EditableSettings } from "../../shared/settings";
import { SETTING_DEFAULTS, type SettingsRepo } from "../db/settings-repo";
import { checkBranchTemplateFits, memoryOn, normalizeSetting, SettingError } from "../settings/settings-values";
import { M } from "../strings";

interface Deps {
  settings: Pick<SettingsRepo, "get" | "set" | "reset">;
  notify: () => void;
  /** 记忆开关真的变了（保存或恢复默认）之后调用，on 是新的状态。 */
  memoryToggled: (on: boolean) => void;
  /** language 改了之后（在 notify 之前）重新解析当前语言。 */
  languageChanged?: () => void;
  /** 任何设置改了之后（在 notify 之前）：检查快照要跟着设置和语言重写。 */
  settingChanged?: (key: EditableSettingKey) => void;
  /** 共享 MCP 开关保存或恢复默认之后（WS-M H）：启动或停掉 hub。 */
  sharedMcpChanged?: () => void;
  /**
   * 选了全局自动化档位（BTL-247，保存或恢复默认）之后、在 notify 之前：把受管开关写成那一档的预设。
   * 再选一次同一档也会重写，所以「自定义」时点回原来那一档就是恢复预设。
   */
  applyAutomationLevel?: (level: string) => void;
}

/**
 * 设置 IPC。保存和恢复默认走同一套检查：分支名模板和 ticket 号正则改了其中一个，搭配另一个的当前值也要合法（最终审查 8）。
 * claudePath 改了不在这里重新探测 claude：界面保存之后马上会要一次 health 报告，那一次就是唯一的探测（最终审查 9，探测要开登录 shell，很慢）。
 */
export function settingsHandlers(d: Deps): {
  get: () => EditableSettings;
  set: (key: unknown, value: unknown) => void;
  reset: (key: unknown) => void;
} {
  const settingKey = (key: unknown): EditableSettingKey => {
    if (typeof key !== "string" || !isEditableSetting(key)) throw new SettingError(M().settingNotEditable(String(key)));
    return key;
  };
  /** 把 k 改成 next 之前检查，检查通过才 write；记忆开关变了就通知。 */
  const apply = (k: EditableSettingKey, next: string, write: () => void): void => {
    if (k === "branchTemplate") checkBranchTemplateFits(next, d.settings.get("ticketPattern"));
    if (k === "ticketPattern") checkBranchTemplateFits(d.settings.get("branchTemplate"), next);
    const memoryBefore = memoryOn(d.settings);
    write();
    const memoryAfter = memoryOn(d.settings);
    if (k === "language") d.languageChanged?.();
    try {
      // 预设写到一半失败（策略校验没过）也要通知：界面重读后显示「自定义」，别的页面也跟着刷新。
      if (k === "automationLevel") d.applyAutomationLevel?.(next);
    } finally {
      d.settingChanged?.(k);
      if (k === "sharedMcp") d.sharedMcpChanged?.();
      d.notify();
    }
    if (memoryAfter !== memoryBefore) d.memoryToggled(memoryAfter);
  };
  return {
    get: () => Object.fromEntries(EDITABLE_SETTINGS.map((k) => [k, d.settings.get(k)])) as EditableSettings,
    set(key, value) {
      const k = settingKey(key);
      const next = normalizeSetting(k, String(value ?? ""));
      apply(k, next, () => d.settings.set(k, next));
    },
    reset(key) {
      const k = settingKey(key);
      apply(k, SETTING_DEFAULTS[k], () => d.settings.reset(k));
    },
  };
}
