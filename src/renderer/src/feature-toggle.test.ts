import { describe, expect, it, vi } from "vitest";
import type { FeatureWrite } from "../../shared/feature-rows";
import { SETTING_DEFAULTS } from "../../main/db/settings-repo";
import { featuresView, runFeatureWrites } from "./feature-toggle";

const EMPTY = { globals: {}, overrides: [] };
const W: FeatureWrite[] = [
  { kind: "setting", key: "lessonsAutoAdmit", value: "1" },
  { kind: "setting", key: "lessonsPrinciples", value: "1" },
  { kind: "setting", key: "lessonsCoreGuide", value: "1" },
];

describe("featuresView", () => {
  it("never shows switches when settings could not be read", () => {
    expect(featuresView({ settings: null, policy: null, error: "boom" })).toEqual({ kind: "failed", message: "boom" });
    // 只有设置、没有覆盖信息时也不能画：会漏掉「仓库自己开着」。
    expect(featuresView({ settings: SETTING_DEFAULTS, policy: null, error: "boom" })).toEqual({ kind: "failed", message: "boom" });
    expect(featuresView({ settings: null, policy: EMPTY, error: "boom" })).toEqual({ kind: "failed", message: "boom" });
    expect(featuresView({ settings: null, policy: null, error: null })).toEqual({ kind: "loading" });
    expect(featuresView({ settings: SETTING_DEFAULTS, policy: null, error: null })).toEqual({ kind: "loading" });
  });

  it("is ready with one row per feature when both are read", () => {
    const v = featuresView({ settings: SETTING_DEFAULTS, policy: EMPTY, error: null });
    expect(v.kind).toBe("ready");
    if (v.kind === "ready") expect(v.rows).toHaveLength(11);
  });
});

describe("runFeatureWrites", () => {
  it("stops at the first failed write and says which one", async () => {
    const err = new Error("nope");
    const exec = vi.fn(async (w: FeatureWrite) => {
      if (w.kind === "setting" && w.key === "lessonsPrinciples") throw err;
    });
    expect(await runFeatureWrites(W, exec)).toEqual({ ok: false, failedAt: 1, error: err });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("runs the writes in order", async () => {
    const seen: string[] = [];
    let inFlight = 0;
    const exec = async (w: FeatureWrite) => {
      inFlight++;
      expect(inFlight).toBe(1);
      await Promise.resolve();
      seen.push(w.kind === "setting" ? w.key : w.key);
      inFlight--;
    };
    expect(await runFeatureWrites(W, exec)).toEqual({ ok: true });
    expect(seen).toEqual(["lessonsAutoAdmit", "lessonsPrinciples", "lessonsCoreGuide"]);
  });
});
