import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ADVANCED_GROUPS, SETTINGS_TABS } from "../../../shared/settings-layout";
import { S, setUiLang } from "../strings";
import { AdvancedSettings } from "./AdvancedSettings";

afterEach(() => setUiLang("zh"));

const HAN = /[一-鿿]/;
const render = (openGroup: (typeof ADVANCED_GROUPS)[number] | null) => renderToStaticMarkup(createElement(AdvancedSettings, { openGroup }));

describe("settings › advanced", () => {
  it("starts with every group collapsed and mounts no group body", () => {
    const html = render(null);
    for (const g of ADVANCED_GROUPS) {
      expect(html).toContain(`data-testid="adv-group-${g}"`);
      expect(html).not.toContain(`data-testid="adv-body-${g}"`);
    }
    expect(html).not.toContain('aria-expanded="true"');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(ADVANCED_GROUPS.length);
  });

  it("opens the group a link points at, and only that one", () => {
    const html = render("loop");
    expect(html).toMatch(/data-testid="adv-group-loop"[^>]*aria-expanded="true"|aria-expanded="true"[^>]*data-testid="adv-group-loop"/);
    expect(html).toContain('data-testid="adv-body-loop"');
    for (const g of ADVANCED_GROUPS) if (g !== "loop") expect(html).not.toContain(`data-testid="adv-body-${g}"`);
  });

  it("lists the groups in order with their names", () => {
    const html = render(null);
    let at = -1;
    for (const g of ADVANCED_GROUPS) {
      const i = html.indexOf(S.set.groups[g]);
      expect(i, g).toBeGreaterThan(at);
      at = i;
    }
  });

  it("has English group names without Chinese", () => {
    setUiLang("en");
    const html = render(null);
    for (const g of ADVANCED_GROUPS) expect(HAN.test(S.set.groups[g]), g).toBe(false);
    expect(HAN.test(html.replace(/<[^>]+>/g, ""))).toBe(false);
  });

  it("names every tab in both languages", () => {
    for (const lang of ["zh", "en"] as const) {
      setUiLang(lang);
      for (const t of SETTINGS_TABS) expect(S.set.tabs[t], `${lang}:${t}`).toBeTruthy();
      if (lang === "en") for (const t of SETTINGS_TABS) expect(HAN.test(S.set.tabs[t])).toBe(false);
    }
  });
});
