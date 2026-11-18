import { describe, expect, it } from "vitest";
import { adoption, checksErrorText, draftErrorText, emptyForm, formFromInput, inputFromForm, livePickedChecks, paramsSummary, parseScopeKey, scopeKey, scopeOptions, splitLines } from "./checks-view";
import { STRINGS } from "./strings";
import type { CheckInput, ChecksView } from "../../shared/checks";

const S = STRINGS.en;
const base = (over: Partial<CheckInput>): CheckInput => ({ type: "forbidden_pattern", name: "n", params: {}, globs: [], excludeGlobs: [], severity: "block", mode: "shadow", enabled: true, message: "", ...over });

describe("checks form", () => {
  it("round-trips every type through the form", () => {
    const inputs: CheckInput[] = [
      base({ params: { pattern: "foo\\(", flags: "i" }, globs: ["src/**", "lib/**"], message: "use bar" }),
      base({ params: { pattern: "console.log", literal: true }, mode: "enforce", severity: "warn" }),
      base({ type: "import_boundary", params: { forbid: ["electron", "src/main/**"], allow: ["src/main/shared/**"] }, excludeGlobs: ["**/*.test.ts"] }),
      base({ type: "comment_policy", params: { keywords: ["hack", "临时"], ticketPattern: "BTL-\\d+" }, enabled: false }),
      base({ type: "run_command", params: { command: "pnpm eslint {file}", stage: "edit", timeoutMs: 2500 } }),
      base({ type: "run_command", params: { command: "pnpm test", stage: "push" } }),
    ];
    for (const i of inputs) {
      const out = inputFromForm(formFromInput(i));
      expect(out.type).toBe(i.type);
      expect(out.globs).toEqual(i.globs);
      expect(out.excludeGlobs).toEqual(i.excludeGlobs);
      expect({ severity: out.severity, mode: out.mode, enabled: out.enabled, message: out.message }).toEqual({ severity: i.severity, mode: i.mode, enabled: i.enabled, message: i.message });
      for (const [k, v] of Object.entries(i.params)) expect(out.params[k], `${i.type}.${k}`).toEqual(v);
    }
  });

  it("only sends the params of the chosen type and splits lists on any newline", () => {
    const f = { ...emptyForm("import_boundary"), pattern: "left over", forbid: " electron \r\n\r\nnode:*\n", allow: "" };
    expect(inputFromForm(f).params).toEqual({ forbid: ["electron", "node:*"], allow: [] });
    expect(splitLines("a\r\n b \n\n")).toEqual(["a", "b"]);
  });

  it("turns seconds into milliseconds and keeps a bad time for the server to reject", () => {
    expect(inputFromForm({ ...emptyForm("run_command"), command: "x", timeoutSec: "1.5" }).params.timeoutMs).toBe(1500);
    expect(inputFromForm({ ...emptyForm("run_command"), command: "x", timeoutSec: "soon" }).params.timeoutMs).toBe(-1);
    expect(inputFromForm({ ...emptyForm("run_command"), command: "x" }).params).not.toHaveProperty("timeoutMs");
  });

  it("new checks start in shadow mode, blocking, on", () => {
    expect(emptyForm()).toMatchObject({ mode: "shadow", severity: "block", enabled: true });
  });
});

describe("checks view helpers", () => {
  it("encodes layers for the picker and falls back to global", () => {
    for (const s of [{ kind: "global" as const }, { kind: "product" as const, productId: 3 }, { kind: "repo" as const, slug: "acme/web" }]) expect(parseScopeKey(scopeKey(s))).toEqual(s);
    expect(parseScopeKey("product:x")).toEqual({ kind: "global" });
    expect(parseScopeKey("repo:")).toEqual({ kind: "global" });
    expect(scopeOptions({ products: [{ id: 2, name: "shop" }], repos: ["acme/web"] }, S).map((o) => o.label)).toEqual(["Global", "Product: shop", "Repository: acme/web"]);
  });

  it("adoption is the share of hits fixed afterwards, hidden before any hit", () => {
    expect(adoption({ fails: 0, resolved: 0 })).toBeNull();
    expect(adoption({ fails: 4, resolved: 3 })).toBe("75%");
    expect(adoption({ fails: 2, resolved: 5 })).toBe("100%");
  });

  it("summarises params", () => {
    expect(paramsSummary("forbidden_pattern", { pattern: "a+", flags: "i" }, S)).toBe("/a+/i");
    expect(paramsSummary("forbidden_pattern", { pattern: "x", literal: true }, S)).toBe('"x"');
    expect(paramsSummary("import_boundary", { forbid: ["electron"], allow: ["a/**"] }, S)).toBe("✗ electron · ✓ a/**");
    expect(paramsSummary("run_command", { command: "pnpm lint", stage: "push" }, S)).toBe("pnpm lint · Before a push (once)");
  });

  it("explains failures by field", () => {
    expect(checksErrorText({ ok: false, reason: "invalid", message: "pattern_invalid" }, S)).toBe(S.checksInvalid.pattern_invalid);
    expect(checksErrorText({ ok: false, reason: "invalid", message: "weird" }, S)).toBe(S.checksError.invalid);
    expect(checksErrorText({ ok: false, reason: "boom" }, S)).toBe(S.checksErrorGeneric);
    expect(draftErrorText({ ok: false, reason: "claude_missing" }, S)).toBe(S.lessonDraftNoClaude);
    expect(draftErrorText({ ok: false, reason: "bad_output", message: "no json" }, S)).toContain("no json");
  });

  it("keeps only this layer's live rows picked", () => {
    const row = (id: number) => ({ id }) as never;
    const v = { checks: [{ own: row(1) }, { own: null }, { own: row(3) }] } as unknown as ChecksView;
    expect(livePickedChecks([1, 2, 3], v)).toEqual([1, 3]);
  });

  it("has every key in both languages", () => {
    expect(Object.keys(STRINGS.en.checksInvalid).sort()).toEqual(Object.keys(STRINGS.zh.checksInvalid).sort());
    expect(Object.keys(STRINGS.en.checksError).sort()).toEqual(Object.keys(STRINGS.zh.checksError).sort());
  });
});
