/**
 * 设置 › 功能（UI 重做 spec §5.3）：每个 3.0 功能一行。一行只是现有全局开关的视图，
 * 不新加总开关、不迁移；一行对应几个开关时一起开、一起关。仓库、产品层的覆盖只数个数、不改。
 * 这里只有状态和要写的键，文案由渲染进程按 id 从 S 取（切换语言会整窗重载）。
 */
import type { PolicyScope } from "./admission-policy";
import type { EditableSettingKey, EditableSettings } from "./settings";
import type { AdvancedGroupId } from "./settings-layout";

export const FEATURE_IDS = [
  "ci_triage", "review_comments", "stacks", "prereview", "intake", "lessons_auto", "fewer_interrupts", "hibernate", "routing_switch", "mem_relief", "shared_mcp",
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];

export type PolicyFamily = "loop" | "stacks" | "intake";
export const POLICY_FAMILIES: readonly PolicyFamily[] = ["loop", "stacks", "intake"];

export type FeatureSwitch = { kind: "setting"; key: EditableSettingKey } | { kind: "policy"; family: PolicyFamily; key: string };

const set = (key: EditableSettingKey): FeatureSwitch => ({ kind: "setting", key });
const pol = (family: PolicyFamily, key: string): FeatureSwitch => ({ kind: "policy", family, key });

export const FEATURES: Record<FeatureId, { switches: readonly FeatureSwitch[]; group: AdvancedGroupId }> = {
  ci_triage: { switches: [pol("loop", "ci.enabled")], group: "loop" },
  review_comments: { switches: [pol("loop", "comments.enabled")], group: "loop" },
  stacks: { switches: [pol("stacks", "autoRebase")], group: "stacks" },
  prereview: { switches: [set("preReviewEnabled")], group: "review" },
  intake: { switches: [pol("intake", "enabled")], group: "intake" },
  lessons_auto: { switches: [set("lessonsAutoAdmit"), set("lessonsPrinciples"), set("lessonsCoreGuide")], group: "lessons" },
  // interruptChoiceDefaults（按你设的默认答案替你答）不进这一行，留在高级。
  fewer_interrupts: { switches: [set("interruptChoiceRule"), set("interruptSelfServe")], group: "interrupts" },
  hibernate: { switches: [set("hibernateEnabled")], group: "sessions" },
  routing_switch: { switches: [set("routingAutoSwitch")], group: "routing" },
  mem_relief: { switches: [set("backgroundPriority"), set("memoryPressureEnabled")], group: "sessions" },
  shared_mcp: { switches: [set("sharedMcp")], group: "sessions" },
};

/** 每个策略家族里，哪些键是功能页的开关（主进程只为这些键读覆盖、只允许改这些键）。 */
export const FEATURE_POLICY_KEYS: Record<PolicyFamily, readonly string[]> = {
  loop: ["ci.enabled", "comments.enabled"],
  stacks: ["autoRebase"],
  intake: ["enabled"],
};

export interface PolicyOverrideEntry {
  family: PolicyFamily;
  key: string;
  scope: PolicyScope;
  /** 仓库层是 slug，产品层是产品名。 */
  label: string;
  value: boolean;
}

/** globals 的键是 `${family}:${key}`；没有这一项 = 默认值 false。 */
export interface FeaturePolicyState {
  globals: Record<string, boolean>;
  overrides: PolicyOverrideEntry[];
}

export type FeatureOnState = "off" | "on" | "partial";

export interface FeatureRow {
  id: FeatureId;
  state: FeatureOnState;
  /** 开着几个、一共几个键。 */
  on: number;
  total: number;
  /** differing：覆盖值和全局值不一样的层数。 */
  otherScopes: { repos: number; products: number; differing: number };
  needsSetup: "intake_source" | null;
  /** 「点进高级」去哪个分组。 */
  group: AdvancedGroupId;
}

export const policyGlobalKey = (family: PolicyFamily, key: string): string => `${family}:${key}`;

function scopeId(s: PolicyScope): string {
  return s.kind === "global" ? "g" : s.kind === "product" ? `p:${s.productId}` : `r:${s.slug}`;
}

export function featureRows(settings: EditableSettings, policy: FeaturePolicyState): FeatureRow[] {
  // 先按「家族:键」把覆盖分好，免得每一行都扫一遍全部覆盖。
  const byKey = new Map<string, PolicyOverrideEntry[]>();
  for (const o of policy.overrides) {
    if (o.scope.kind === "global") continue;
    const k = policyGlobalKey(o.family, o.key);
    const list = byKey.get(k);
    if (list) list.push(o);
    else byKey.set(k, [o]);
  }
  const globalOn = (family: PolicyFamily, key: string): boolean => policy.globals[policyGlobalKey(family, key)] === true;

  return FEATURE_IDS.map((id) => {
    const def = FEATURES[id];
    let on = 0;
    const scopes = new Map<string, { kind: "repo" | "product"; differs: boolean }>();
    for (const sw of def.switches) {
      if (sw.kind === "setting") {
        if (settings[sw.key] === "1") on++;
        continue;
      }
      const g = globalOn(sw.family, sw.key);
      if (g) on++;
      for (const o of byKey.get(policyGlobalKey(sw.family, sw.key)) ?? []) {
        const sid = scopeId(o.scope);
        const prev = scopes.get(sid);
        const differs = o.value !== g;
        scopes.set(sid, { kind: o.scope.kind === "product" ? "product" : "repo", differs: (prev?.differs ?? false) || differs });
      }
    }
    let repos = 0;
    let products = 0;
    let differing = 0;
    for (const s of scopes.values()) {
      if (s.kind === "repo") repos++;
      else products++;
      if (s.differs) differing++;
    }
    const total = def.switches.length;
    const state = on === 0 ? "off" : on === total ? "on" : "partial";
    const needsSetup = id === "intake" && state !== "off" && (settings.intakeSource ?? "none") === "none" ? "intake_source" : null;
    return { id, state, on, total, otherScopes: { repos, products, differing }, needsSetup, group: def.group };
  });
}

export type FeatureWrite =
  | { kind: "setting"; key: EditableSettingKey; value: "1" | "0" }
  | { kind: "policy"; family: PolicyFamily; key: string; value: boolean };

/** 打开或关闭一行要写的键，按 FEATURES 里的顺序。只写全局，不碰覆盖。 */
export function applyFeatureToggle(id: FeatureId, on: boolean): FeatureWrite[] {
  return FEATURES[id].switches.map((sw): FeatureWrite =>
    sw.kind === "setting" ? { kind: "setting", key: sw.key, value: on ? "1" : "0" } : { kind: "policy", family: sw.family, key: sw.key, value: on },
  );
}
