import { describe, expect, it } from "vitest";
import { resolveLang } from "./i18n";

describe("resolveLang", () => {
  it("follows the system language when the setting is auto: Chinese for any zh locale, English otherwise", () => {
    expect(resolveLang("auto", ["zh-Hans-CN"])).toBe("zh");
    expect(resolveLang("auto", ["zh-TW"])).toBe("zh");
    expect(resolveLang("auto", ["zh"])).toBe("zh");
    expect(resolveLang("auto", ["en-US", "zh-CN"])).toBe("en");
    expect(resolveLang("auto", ["fr-FR"])).toBe("en");
    expect(resolveLang("auto", [])).toBe("en");
  });

  it("uses an explicit setting, and a broken one counts as auto", () => {
    expect(resolveLang("zh", ["en-US"])).toBe("zh");
    expect(resolveLang("en", ["zh-CN"])).toBe("en");
    expect(resolveLang("garbage", ["zh-CN"])).toBe("zh");
  });

  it("lets BUTLER_LANG override everything, ignoring values it doesn't know", () => {
    expect(resolveLang("zh", ["zh-CN"], "en")).toBe("en");
    expect(resolveLang("en", ["en-US"], "zh")).toBe("zh");
    expect(resolveLang("zh", ["en-US"], "fr")).toBe("zh");
    expect(resolveLang("zh", ["en-US"], "")).toBe("zh");
  });
});
