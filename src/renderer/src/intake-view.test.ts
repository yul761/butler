import { afterEach, describe, expect, it } from "vitest";
import type { IntakeItemView, IntakePolicyView } from "../../shared/intake";
import { intakeItemActions, intakeNoticeActions, intakeNoticeText, intakeOverridesFromDraft, intakeRecentText, intakeStateText, parseIntakeInput } from "./intake-view";
import { S, setUiLang } from "./strings";

afterEach(() => setUiLang("zh"));

const view = (over: Partial<Record<string, { set: boolean; override: unknown }>> = {}): IntakePolicyView => ({
  scope: { kind: "global" },
  layers: [],
  keys: (["enabled", "maxParallel", "tierSmall"] as const).map((key) => ({
    key, effective: key === "enabled" ? false : key === "maxParallel" ? 2 : "mid", origin: { kind: "default" },
    set: over[key]?.set ?? false, override: (over[key]?.override ?? null) as never,
  })),
});

describe("intake policy input", () => {
  it("parses by key and rejects bad values", () => {
    expect(parseIntakeInput("enabled", "true")).toBe(true);
    expect(parseIntakeInput("maxParallel", "3")).toBe(3);
    expect(parseIntakeInput("maxParallel", "0")).toBeUndefined();
    expect(parseIntakeInput("tierSmall", "low")).toBe("low");
    expect(parseIntakeInput("tierSmall", "huge")).toBeUndefined();
    expect(parseIntakeInput("uncertainBelow", " ")).toBeNull();
  });

  it("merges the draft into the layer", () => {
    expect(intakeOverridesFromDraft(view({ maxParallel: { set: true, override: 4 } }), { enabled: "true" })).toEqual({ ok: true, changed: true, overrides: { enabled: true, maxParallel: 4 } });
    expect(intakeOverridesFromDraft(view({ maxParallel: { set: true, override: 4 } }), { maxParallel: "" })).toEqual({ ok: true, changed: true, overrides: {} });
    expect(intakeOverridesFromDraft(view({ maxParallel: { set: true, override: 4 } }), { maxParallel: "4" })).toEqual({ ok: true, changed: false, overrides: { maxParallel: 4 } });
    expect(intakeOverridesFromDraft(view(), { maxParallel: "x" })).toEqual({ ok: false, badKey: "maxParallel" });
  });
});

describe("intake notices and rows", () => {
  const notice = { key: "A-1", title: "Fix it", state: "needs_clarification" as const, reason: null, detail: "acceptance_criteria, repro_steps", url: null };

  it("says what is missing, in both languages", () => {
    expect(intakeNoticeText(notice, S)).toBe("自动接活：A-1「Fix it」 缺验收标准、复现步骤");
    setUiLang("en");
    expect(intakeNoticeText(notice, S)).toBe('Intake: A-1 "Fix it" is missing acceptance criteria, repro steps');
    expect(intakeNoticeText({ ...notice, state: "waiting", reason: "conflict", detail: "A-2: src/a.ts" }, S)).toContain("(A-2: src/a.ts)");
  });

  it("offers the right buttons", () => {
    expect(intakeNoticeActions(notice)).toEqual(["intakeStart", "intakeSkip", "intake"]);
    expect(intakeNoticeActions({ ...notice, state: "waiting", reason: "conflict" })).toEqual(["intakeParallel", "intake"]);
    expect(intakeNoticeActions({ ...notice, state: "needs_repo" })).toEqual(["intake"]);
    const item = { state: "waiting", waitReason: "conflict", allowParallel: false } as IntakeItemView;
    expect(intakeItemActions(item)).toEqual(["allowParallel", "start", "skip"]);
    expect(intakeItemActions({ ...item, allowParallel: true })).toEqual(["start", "skip"]);
    expect(intakeItemActions({ ...item, state: "started" })).toEqual([]);
    expect(intakeItemActions({ ...item, state: "failed" })).toEqual(["retry", "skip"]);
  });

  it("writes states and recent entries", () => {
    expect(intakeStateText({ state: "waiting", waitReason: "parallel" }, S)).toBe("等着 · 名额满了");
    expect(intakeRecentText({ at: 1, key: "A-1", what: "started", detail: "high" }, S)).toBe("A-1 · 自动开工 · 高");
    expect(intakeRecentText({ at: 1, key: "A-1", what: "queued", detail: null }, S)).toBe("A-1 · 排队");
  });
});
