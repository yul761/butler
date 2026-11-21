/**
 * 自动化档位（BTL-247，Butler 4.0 W7）：全局一个档位，每个 epic 可以另选。
 * 档位不是新的权限，只是一组「受管开关」的预设：选全局档位时把这些开关写成预设；
 * epic 另选了档位时，它的 ticket 的受管行为按那一档的预设，盖过全局、产品、仓库三层。
 * 设计：docs/superpowers/specs/2026-11-20-btl-247-automation-levels-design.md。
 */
import type { ExternalActionSetting } from "./external";
import { INTAKE_POLICY_DEFAULTS, type IntakePolicy } from "./intake";
import { LOOP_POLICY_DEFAULTS, type LoopPolicy } from "./loop-policy";
import { STACK_POLICY_DEFAULTS, type StackPolicy } from "./stacks";

/** 能选的档位。「全自动」这次不做，界面上只显示「以后」。 */
export const AUTOMATION_LEVELS = ["manual", "semi"] as const;
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];
/** 界面上显示的全局档位：受管开关和存的档位的预设对不上就是「自定义」。 */
export type AutomationDisplay = AutomationLevel | "custom";

export function isAutomationLevel(v: unknown): v is AutomationLevel {
  return typeof v === "string" && (AUTOMATION_LEVELS as readonly string[]).includes(v);
}

/** 受管的设置项（都是 "1"/"0" 的开关）。 */
export const GOVERNED_SETTINGS = [
  "preReviewEnabled",
  "externalCommentReply",
  "externalCommentResolve",
  "externalCiRerun",
  "externalBranchPush",
  "externalForcePush",
  "externalPrOpen",
] as const;
export type GovernedSetting = (typeof GOVERNED_SETTINGS)[number];

export type GovernedFamily = "loop" | "stacks" | "intake";
export const GOVERNED_FAMILIES: readonly GovernedFamily[] = ["loop", "stacks", "intake"];

/** 三族策略里受管的键。 */
export const GOVERNED_POLICY_KEYS = {
  loop: ["comments.enabled", "comments.reply", "comments.resolve", "ci.enabled", "ci.maxReruns"],
  stacks: ["autoRebase"],
  intake: ["enabled", "autoStart"],
} as const satisfies Record<GovernedFamily, readonly string[]>;

type LoopKey = (typeof GOVERNED_POLICY_KEYS.loop)[number];
type StackKey = (typeof GOVERNED_POLICY_KEYS.stacks)[number];
type IntakeKey = (typeof GOVERNED_POLICY_KEYS.intake)[number];

export interface AutomationPreset {
  settings: Record<GovernedSetting, "0" | "1">;
  loop: Pick<LoopPolicy, LoopKey>;
  stacks: Pick<StackPolicy, StackKey>;
  intake: Pick<IntakePolicy, IntakeKey>;
}

const pick = <T extends object, K extends keyof T>(o: T, keys: readonly K[]): Pick<T, K> =>
  Object.fromEntries(keys.map((k) => [k, o[k]])) as Pick<T, K>;

const allOff = Object.fromEntries(GOVERNED_SETTINGS.map((k) => [k, "0"])) as Record<GovernedSetting, "0" | "1">;

/**
 * 手动 = 什么都不配置时的默认值（等于 4.0 以前的默认）。
 * 半自动：评论送回 session 但不回复、不 resolve；CI 分类，偶发失败重跑一次；栈自动 rebase，栈要用的推送、强推、开 PR；
 * 预审；配了来源的自动接活自动开工。合并永远要人点（Butler 没有替你合并的动作）。
 */
export const AUTOMATION_PRESETS: Record<AutomationLevel, AutomationPreset> = {
  manual: {
    settings: allOff,
    loop: pick(LOOP_POLICY_DEFAULTS, GOVERNED_POLICY_KEYS.loop),
    stacks: pick(STACK_POLICY_DEFAULTS, GOVERNED_POLICY_KEYS.stacks),
    intake: pick(INTAKE_POLICY_DEFAULTS, GOVERNED_POLICY_KEYS.intake),
  },
  semi: {
    settings: { ...allOff, preReviewEnabled: "1", externalCiRerun: "1", externalBranchPush: "1", externalForcePush: "1", externalPrOpen: "1" },
    loop: { "comments.enabled": true, "comments.reply": false, "comments.resolve": false, "ci.enabled": true, "ci.maxReruns": 1 },
    stacks: { autoRebase: true },
    intake: { enabled: true, autoStart: true },
  },
};

const FAMILY_DEFAULTS: Record<GovernedFamily, Record<string, unknown>> = {
  loop: LOOP_POLICY_DEFAULTS as unknown as Record<string, unknown>,
  stacks: STACK_POLICY_DEFAULTS as unknown as Record<string, unknown>,
  intake: INTAKE_POLICY_DEFAULTS as unknown as Record<string, unknown>,
};

function presetValue(level: AutomationLevel, family: GovernedFamily, key: string): unknown {
  return (AUTOMATION_PRESETS[level][family] as Record<string, unknown>)[key];
}

/**
 * 选了全局档位以后，一族策略的全局层要写成什么：同层别的键原样保留；受管键等于默认值的删掉覆盖，
 * 不等的写成预设值。手动档就是把受管键的覆盖都删掉。
 */
export function presetLayer(family: GovernedFamily, existing: Record<string, unknown>, level: AutomationLevel): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  for (const key of GOVERNED_POLICY_KEYS[family]) {
    const v = presetValue(level, family, key);
    if (v === FAMILY_DEFAULTS[family][key]) delete next[key];
    else next[key] = v;
  }
  return next;
}

/** 一族策略的一层：全局层的 label 是空串。values 只放这一层自己设了的键。 */
export interface GovernedLayer {
  family: GovernedFamily;
  scope: "global" | "product" | "repo";
  label: string;
  values: Record<string, unknown>;
}

/** 受管开关现在的值：设置项，加上三族策略各层自己设了的受管键。 */
export interface GovernedCurrent {
  settings: Record<GovernedSetting, string>;
  layers: GovernedLayer[];
}

export interface AutomationState {
  /** 存的全局档位。 */
  level: AutomationLevel;
  display: AutomationDisplay;
  /**
   * 和预设对不上的受管开关：设置项是它的键（preReviewEnabled），策略是 `族:键`（loop:ci.enabled），
   * 产品、仓库层再加 `@名字`（loop:ci.enabled@org/repo）。
   */
  differs: string[];
  /** 自动接活有没有配来源（半自动档下没配，「自动化」页提示一句）。 */
  intakeSourceSet: boolean;
}

/** 全局档位显示成什么：受管开关全都等于存的档位的预设才显示它，否则是「自定义」。 */
export function automationDisplay(level: AutomationLevel, current: GovernedCurrent): { display: AutomationDisplay; differs: string[] } {
  const p = AUTOMATION_PRESETS[level];
  const differs: string[] = [];
  for (const k of GOVERNED_SETTINGS) if ((current.settings[k] ?? "0").trim() !== p.settings[k]) differs.push(k);
  for (const family of GOVERNED_FAMILIES) {
    const global = current.layers.find((l) => l.family === family && l.scope === "global")?.values ?? {};
    for (const key of GOVERNED_POLICY_KEYS[family]) {
      const want = presetValue(level, family, key);
      const have = Object.hasOwn(global, key) ? global[key] : FAMILY_DEFAULTS[family][key];
      if (have !== want) differs.push(`${family}:${key}`);
      for (const l of current.layers) {
        if (l.family !== family || l.scope === "global" || !Object.hasOwn(l.values, key)) continue;
        if (l.values[key] !== want) differs.push(`${family}:${key}@${l.label}`);
      }
    }
  }
  return { display: differs.length === 0 ? level : "custom", differs };
}

/** epic 另选了档位（level 不为 null）时，在三层的结果上盖它的预设。 */
export function overlayLoop(p: LoopPolicy, level: AutomationLevel | null): LoopPolicy {
  return level ? { ...p, ...AUTOMATION_PRESETS[level].loop } : p;
}

export function overlayStack(p: StackPolicy, level: AutomationLevel | null): StackPolicy {
  return level ? { ...p, ...AUTOMATION_PRESETS[level].stacks } : p;
}

/**
 * Jira 接进来、父 epic 在 Butler 里另选了档位的 ticket：接活策略按 BTL-246 §7 的手动 / 半自动（BTL-247）。
 * 半自动 = 半自动档的预设（接活开、自动开工）。手动只关自动开工：仓库的接活开着时照样拉进来、建进 epic 整理，只是不开工；
 * 不用手动档的预设（接活整个关掉），否则 epic 选了手动反而连整理都不做了。
 */
export function overlayIntake(p: IntakePolicy, level: AutomationLevel | null): IntakePolicy {
  if (level === "semi") return { ...p, ...AUTOMATION_PRESETS.semi.intake };
  if (level === "manual") return { ...p, autoStart: false };
  return p;
}

/** epic 档位下这个对外开关的值；不是受管的或 epic 没另选，返回 undefined（回到原来的设置）。 */
export function externalOverride(level: AutomationLevel | null, key: ExternalActionSetting): "0" | "1" | undefined {
  if (!level || !(GOVERNED_SETTINGS as readonly string[]).includes(key)) return undefined;
  return AUTOMATION_PRESETS[level].settings[key as GovernedSetting];
}

/** 预审开没开：epic 另选了就按它，否则按全局设置。 */
export function preReviewOn(level: AutomationLevel | null, globalOn: boolean): boolean {
  return level ? AUTOMATION_PRESETS[level].settings.preReviewEnabled === "1" : globalOn;
}

/**
 * 一个栈跨几层、几个 ticket：任何一层的 epic 选了手动 → 手动；每一层都在选了半自动的 epic 里 → 半自动；
 * 其他情况（有的层跟随全局、没有 epic）不盖，按仓库原来的策略。
 */
export function stackLevel(levels: readonly (AutomationLevel | null)[]): AutomationLevel | null {
  if (levels.includes("manual")) return "manual";
  if (levels.length > 0 && levels.every((l) => l === "semi")) return "semi";
  return null;
}
