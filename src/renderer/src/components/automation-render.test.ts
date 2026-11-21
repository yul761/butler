import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationState } from "../../../shared/automation";
import { S, setUiLang } from "../strings";
import { EpicLevelPicker } from "./EpicLevel";
import { AutomationLevelView } from "./FeatureSettings";

afterEach(() => setUiLang("zh"));

const state = (p: Partial<AutomationState> = {}): AutomationState => ({ level: "manual", display: "manual", differs: [], intakeSourceSet: false, ...p });
const level = (s: AutomationState, busy = false) => renderToStaticMarkup(createElement(AutomationLevelView, { state: s, busy, onPick: () => undefined }));
/** 一个选项的 HTML（从它的 testid 到下一个 label 结束）。 */
const option = (html: string, id: string) => {
  const start = html.indexOf(`data-testid="automation-${id}"`);
  return start < 0 ? "" : html.slice(start, html.indexOf("</label>", start));
};

describe("settings › automation level (BTL-247)", () => {
  it("defaults to manual, shows full auto as later and not selectable, and no custom option", () => {
    const html = level(state());
    expect(option(html, "manual")).toContain('checked=""');
    expect(option(html, "semi")).not.toContain('checked=""');
    expect(option(html, "full")).toContain('disabled=""');
    expect(option(html, "full")).toContain(S.set.auto.levels.full.label);
    expect(html).not.toContain('data-testid="automation-custom"');
  });

  it("shows custom, with how many switches differ, once a governed switch was touched", () => {
    const html = level(state({ level: "semi", display: "custom", differs: ["externalForcePush", "loop:ci.enabled@o/r"] }));
    expect(option(html, "semi")).not.toContain('checked=""');
    expect(option(html, "custom")).toContain('checked=""');
    // 全局的一个点档位能恢复；仓库层的单独列出来，说明要去「高级」tab 改。
    expect(option(html, "custom")).toContain(S.set.auto.customHint(1));
    expect(option(html, "custom")).toContain(S.set.auto.customLayers("o/r"));
  });

  it("warns on semi when intake has no source", () => {
    expect(level(state({ level: "semi", display: "semi" }))).toContain('data-testid="automation-no-source"');
    expect(level(state({ level: "semi", display: "semi", intakeSourceSet: true }))).not.toContain('data-testid="automation-no-source"');
  });

  it("renders in English too", () => {
    setUiLang("en");
    const html = level(state());
    expect(html).toContain("Automation level");
    expect(html).toContain("Fully automatic (later)");
    expect(html).not.toMatch(/[一-鿿]/);
  });
});

describe("epic level dropdown (BTL-247)", () => {
  const picker = (value: "manual" | "semi" | null, globalLevel: "manual" | "semi" | "custom") =>
    renderToStaticMarkup(createElement(EpicLevelPicker, { value, globalLevel, onChange: () => undefined }));

  it("follows global by default and names the current global level", () => {
    const html = picker(null, "semi");
    expect(html).toContain(S.set.auto.epicLabel);
    expect(html).toMatch(/<option value="" selected="">[^<]*半自动/);
    expect(html).toMatch(/<option value="full" disabled="">/);
  });

  it("says custom when the global switches no longer match the saved level", () => {
    expect(picker(null, "custom")).toContain(S.set.auto.epicFollow(S.set.auto.custom));
  });

  it("shows the epic's own level", () => {
    expect(picker("manual", "semi")).toMatch(/<option value="manual" selected="">/);
  });
});
