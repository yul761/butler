import type { PolicyScope } from "../../shared/admission-policy";
import { FEATURE_POLICY_KEYS, type FeaturePolicyState, type PolicyFamily } from "../../shared/feature-rows";
import type { IntakePolicySetResult, IntakePolicyView } from "../../shared/intake";
import type { LoopPolicyOverrides, LoopPolicyView, LoopScope } from "../../shared/loop-policy";
import type { StackPolicySetResult, StackPolicyView } from "../../shared/stacks";
import { SettingError } from "../settings/settings-values";

export interface FeaturePolicyDeps {
  read(): FeaturePolicyState;
  /** 全局层现有的覆盖（没覆盖的键不在里面）。 */
  globalLayer(family: PolicyFamily): Record<string, unknown>;
  /** 调用现有的 policySet，把整层换掉；失败抛错。 */
  writeLayer(family: PolicyFamily, layer: Record<string, unknown>): void;
  notify(): void;
}

/** 三族策略现有的读写入口（和 register 的 deps 同形）。 */
export interface FeaturePolicyServices {
  loop: { policyView(scope: LoopScope): LoopPolicyView; policySet(scope: LoopScope, overrides: LoopPolicyOverrides): void };
  stacks: { policyView(scope: PolicyScope): StackPolicyView; policySet(scope: PolicyScope, overrides: Record<string, unknown>): StackPolicySetResult };
  intake: { policyView(scope: PolicyScope): IntakePolicyView; policySet(scope: PolicyScope, overrides: Record<string, unknown>): IntakePolicySetResult };
}

const GLOBAL = { kind: "global" } as const;

/**
 * 全局层的读和整层写。loop 的视图里没覆盖的键 override 是 null；stacks 和 intake 用 set 标出本层设过的键。
 * 读错了一种，写回时就会把同层的其他覆盖（ci.maxReruns 等）冲掉，所以单独导出来测。
 */
export function featurePolicyLayers(s: FeaturePolicyServices): Pick<FeaturePolicyDeps, "globalLayer" | "writeLayer"> {
  const own = (keys: { key: string; override: unknown; set?: boolean }[], useSet: boolean): Record<string, unknown> =>
    Object.fromEntries(keys.filter((k) => (useSet ? k.set === true : k.override !== null)).map((k) => [k.key, k.override]));
  return {
    globalLayer: (family) =>
      family === "loop"
        ? own(s.loop.policyView(GLOBAL).keys, false)
        : own((family === "stacks" ? s.stacks.policyView(GLOBAL) : s.intake.policyView(GLOBAL)).keys, true),
    writeLayer: (family, layer) => {
      if (family === "loop") {
        s.loop.policySet(GLOBAL, layer as LoopPolicyOverrides);
        return;
      }
      const r = family === "stacks" ? s.stacks.policySet(GLOBAL, layer) : s.intake.policySet(GLOBAL, layer);
      if (!r.ok) throw new SettingError(`${family}.${r.key}: ${r.message}`);
    },
  };
}

/** 渲染进程不可信：只认功能页的那几个策略开关，值必须是布尔。 */
function patchArg(raw: unknown): { family: PolicyFamily; key: string; value: boolean } {
  if (!raw || typeof raw !== "object") throw new SettingError("invalid feature policy patch");
  const { family, key, value } = raw as Record<string, unknown>;
  if (typeof family !== "string" || !Object.hasOwn(FEATURE_POLICY_KEYS, family)) throw new SettingError(`unknown policy family: ${String(family)}`);
  const fam = family as PolicyFamily;
  if (typeof key !== "string" || !FEATURE_POLICY_KEYS[fam].includes(key)) throw new SettingError(`not a feature switch: ${String(key)}`);
  if (typeof value !== "boolean") throw new SettingError("feature switch value must be boolean");
  return { family: fam, key, value };
}

/**
 * 设置 › 功能页的策略开关。现有的 policySet 是把一层整个换掉，所以这里先取全局层现有的覆盖，
 * 只改这一个键再写回，同层的其他覆盖（ci.maxReruns 等）原样保留。
 */
export function featurePolicyHandlers(d: FeaturePolicyDeps): { get(): FeaturePolicyState; patch(raw: unknown): void } {
  return {
    get: () => d.read(),
    patch(raw) {
      const { family, key, value } = patchArg(raw);
      d.writeLayer(family, { ...d.globalLayer(family), [key]: value });
      d.notify();
    },
  };
}
