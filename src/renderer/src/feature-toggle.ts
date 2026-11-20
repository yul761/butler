import { featureRows, type FeaturePolicyState, type FeatureRow, type FeatureWrite } from "../../shared/feature-rows";
import type { EditableSettings } from "../../shared/settings";

export type FeaturesView =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; rows: FeatureRow[] };

/**
 * 设置和覆盖都读到了才画开关。任何一个读失败都是 failed：只有设置、没有覆盖时画出来，
 * 会把「全局关着、某个仓库自己开着」显示成干净的「关」。
 */
export function featuresView(input: { settings: EditableSettings | null; policy: FeaturePolicyState | null; error: string | null }): FeaturesView {
  if (input.error !== null) return { kind: "failed", message: input.error };
  if (!input.settings || !input.policy) return { kind: "loading" };
  return { kind: "ready", rows: featureRows(input.settings, input.policy) };
}

/** 一个一个写，第一个失败就停（后面的不写），并说是第几个。 */
export async function runFeatureWrites(
  writes: FeatureWrite[],
  exec: (w: FeatureWrite) => Promise<void>,
): Promise<{ ok: true } | { ok: false; failedAt: number; error: unknown }> {
  for (let i = 0; i < writes.length; i++) {
    try {
      await exec(writes[i]!);
    } catch (error) {
      return { ok: false, failedAt: i, error };
    }
  }
  return { ok: true };
}
