import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { UPDATE_FAIL_REASONS, type ReleaseInfo } from "../../../shared/update";
import { S, setUiLang } from "../strings";
import { updateResultText } from "./AboutSettings";
import { UpdateBannerView } from "./UpdateBanner";

afterEach(() => setUiLang("zh"));

const HAN = /[一-鿿]/;
const rel = (notes: string): ReleaseInfo => ({ version: "4.1.0", tag: "v4.1.0", url: "https://github.com/yul761/shipherd/releases/tag/v4.1.0", publishedAt: 1, notes });

describe("update banner (BTL-253)", () => {
  it("shows the version, collapsed notes as plain text, download, skip and close", () => {
    const html = renderToStaticMarkup(createElement(UpdateBannerView, { release: rel("## Fixes\n<script>alert(1)</script>") }));
    expect(html).toContain(S.update.available("4.1.0"));
    for (const id of ["update-download", "update-skip", "update-close", "update-notes"]) expect(html).toContain(`data-testid="${id}"`);
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("says when a release has no notes, in English without Chinese", () => {
    setUiLang("en");
    const html = renderToStaticMarkup(createElement(UpdateBannerView, { release: rel("  ") }));
    expect(html).toContain(S.update.noNotes);
    expect(HAN.test(html.replace(/<[^>]+>/g, ""))).toBe(false);
  });

  it("words every manual check result in both languages", () => {
    for (const lang of ["zh", "en"] as const) {
      setUiLang(lang);
      expect(updateResultText({ kind: "latest", current: "4.0.0", latest: "4.0.0", at: 1 })).toContain("4.0.0");
      expect(updateResultText({ kind: "available", release: rel(""), at: 1 })).toContain("4.1.0");
      for (const reason of UPDATE_FAIL_REASONS) {
        const t = updateResultText({ kind: "failed", reason, detail: "", at: 1 });
        expect(t.length, `${lang}:${reason}`).toBeGreaterThan(S.update.resultFailed.length);
        if (lang === "en") expect(HAN.test(t), reason).toBe(false);
      }
    }
  });
});
