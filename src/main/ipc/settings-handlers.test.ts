import { describe, expect, it, vi } from "vitest";
import { SETTING_DEFAULTS, SettingsRepo } from "../db/settings-repo";
import { SettingError } from "../settings/settings-values";
import { memDb } from "../test-utils";
import { settingsHandlers } from "./settings-handlers";

function setup() {
  const settings = new SettingsRepo(memDb());
  const notify = vi.fn();
  const toggled: boolean[] = [];
  const h = settingsHandlers({ settings, notify, memoryToggled: (on) => toggled.push(on) });
  return { settings, notify, toggled, h };
}

describe("settings IPC handlers", () => {
  it("saves a normalized value, notifies, and rejects keys that are not editable", () => {
    const { h, settings, notify } = setup();
    h.set("staleDays", " 7 ");
    expect(settings.get("staleDays")).toBe("7");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(() => h.set("notASetting", "x")).toThrow(SettingError);
    expect(() => h.reset(42)).toThrow(SettingError);
    expect(h.get().staleDays).toBe("7");
  });

  it("checks the branch template against the ticket pattern on reset too, as it does on save (final review 8)", () => {
    const { h, settings, notify } = setup();
    // 旧版本存下来的、互相不匹配的值：正则能匹配 "..-1"，任何模板代进去都有 ".."。
    settings.set("ticketPattern", "\\S+-\\d+");
    settings.set("branchTemplate", "work/{key}");
    expect(() => h.set("branchTemplate", "feature/{key}")).toThrow(SettingError);
    expect(() => h.reset("branchTemplate")).toThrow(SettingError);
    expect(settings.get("branchTemplate")).toBe("work/{key}");
    expect(notify).not.toHaveBeenCalled();

    // 正则恢复默认（和当前模板搭配合法）可以；之后模板也能恢复默认。
    h.reset("ticketPattern");
    expect(settings.get("ticketPattern")).toBe(SETTING_DEFAULTS.ticketPattern);
    h.reset("branchTemplate");
    expect(settings.get("branchTemplate")).toBe(SETTING_DEFAULTS.branchTemplate);
  });

  it("checks the ticket pattern against the current branch template on reset", () => {
    const { h, settings } = setup();
    // 存下来的模板只有在默认正则下才不合法（代入 PROJ-1 之后以 . 结尾）：恢复默认正则要被挡住。
    settings.set("branchTemplate", "{key}.");
    settings.set("ticketPattern", "\\d+");
    expect(() => h.reset("ticketPattern")).toThrow(SettingError);
    expect(settings.get("ticketPattern")).toBe("\\d+");
  });

  it("reports a real memory switch change, on save and on reset, and nothing else (final review 6)", () => {
    const { h, toggled } = setup();
    h.set("memoryEnabled", "1");
    expect(toggled).toEqual([]);
    h.set("memoryEnabled", "0");
    h.set("memoryEnabled", "0");
    h.set("staleDays", "3");
    expect(toggled).toEqual([false]);
    h.reset("memoryEnabled");
    expect(toggled).toEqual([false, true]);
  });
});
