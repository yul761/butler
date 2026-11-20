import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SETTING_DEFAULTS } from "../../../main/db/settings-repo";
import { FEATURE_IDS, featureRows, type FeatureRow } from "../../../shared/feature-rows";
import { S, STRINGS, setUiLang } from "../strings";
import { FeatureList } from "./FeatureSettings";

afterEach(() => setUiLang("zh"));

const HAN = /[一-鿿]/;
const EMPTY = { globals: {}, overrides: [] };
const defaults = () => featureRows(SETTING_DEFAULTS, EMPTY);
const render = (rows: FeatureRow[]) =>
  renderToStaticMarkup(createElement(FeatureList, { rows, busyId: null, onToggle: () => undefined, onOpenAdvanced: () => undefined }));
const patch = (id: FeatureRow["id"], p: Partial<FeatureRow>) => defaults().map((r) => (r.id === id ? { ...r, ...p } : r));
/** 一行的 HTML（从它的 testid 到下一行的 testid）。 */
function rowHtml(html: string, id: string): string {
  const start = html.indexOf(`data-testid="feature-row-${id}"`);
  const next = html.indexOf('data-testid="feature-row-', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

describe("settings › features", () => {
  it("renders 11 rows, all switches off, each with the 3.0 mark", () => {
    const html = render(defaults());
    for (const id of FEATURE_IDS) {
      const row = rowHtml(html, id);
      expect(row, id).toContain('data-state="off"');
      expect(row, id).toContain(S.set.new3);
    }
    expect(html.match(/data-testid="feature-row-/g)).toHaveLength(11);
    expect(html).not.toMatch(/checked=""/);
    expect(html).toContain('data-testid="feature-toggle-ci_triage"');
    expect(html).toContain('data-testid="feature-toggle-lessons_auto"');
  });

  it("shows a half-on row as partial with two buttons, not as a switch", () => {
    const html = render(patch("lessons_auto", { state: "partial", on: 1, total: 3 }));
    const row = rowHtml(html, "lessons_auto");
    expect(row).toContain('data-state="partial"');
    expect(row).toContain("1/3");
    expect(row).toContain('data-testid="feature-all-on-lessons_auto"');
    expect(row).toContain('data-testid="feature-all-off-lessons_auto"');
    expect(row).not.toContain('data-testid="feature-toggle-lessons_auto"');
  });

  it("says the feature is off but running somewhere", () => {
    const html = render(patch("ci_triage", { otherScopes: { repos: 2, products: 0, differing: 2 } }));
    const row = rowHtml(html, "ci_triage");
    expect(row).toContain(S.set.offButElsewhere(2));
    expect(row).toContain('data-testid="feature-others-ci_triage"');
  });

  it("links to advanced when other scopes exist, and not otherwise", () => {
    const plain = render(defaults());
    for (const id of FEATURE_IDS) expect(plain).not.toContain(`data-testid="feature-others-${id}"`);
    const html = render(patch("stacks", { state: "on", on: 1, otherScopes: { repos: 1, products: 1, differing: 0 } }));
    const row = rowHtml(html, "stacks");
    expect(row).toContain('data-testid="feature-others-stacks"');
    expect(row).toContain(S.set.otherRepos(1));
    expect(row).toContain(S.set.otherProducts(1));
    expect(row).not.toContain(S.set.offButElsewhere(0));
  });

  it("warns that intake is on but has no source", () => {
    const html = render(patch("intake", { state: "on", on: 1, needsSetup: "intake_source" }));
    expect(rowHtml(html, "intake")).toContain('data-testid="feature-setup-intake"');
    expect(rowHtml(html, "intake")).toContain(S.set.needsIntakeSource);
    expect(render(defaults())).not.toContain("feature-setup-");
  });

  it("disables the row that is being written", () => {
    const html = renderToStaticMarkup(createElement(FeatureList, { rows: defaults(), busyId: "hibernate", onToggle: () => undefined, onOpenAdvanced: () => undefined }));
    expect(rowHtml(html, "hibernate")).toMatch(/data-testid="feature-toggle-hibernate"[^>]*disabled|disabled=""[^>]*data-testid="feature-toggle-hibernate"/);
    expect(rowHtml(html, "shared_mcp")).not.toContain("disabled");
  });

  it("has no text in the row state: titles come from S", () => {
    setUiLang("en");
    const en = render(patch("lessons_auto", { state: "partial", on: 2, total: 3, otherScopes: { repos: 1, products: 0, differing: 1 } }));
    expect(HAN.test(en.replace(/<[^>]+>/g, ""))).toBe(false);
    setUiLang("zh");
    expect(render(defaults())).toContain(S.set.feat.ci_triage.title);
    for (const lang of ["zh", "en"] as const) expect(Object.keys(STRINGS[lang].set.feat).sort()).toEqual([...FEATURE_IDS].sort());
  });

  it("says review comments never post anything outside", () => {
    expect(STRINGS.zh.set.feat.review_comments.desc).toContain("不对外发任何东西");
    expect(STRINGS.en.set.feat.review_comments.desc).toContain("does not post anything outside");
  });
});
