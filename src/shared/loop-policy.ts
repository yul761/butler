/**
 * 评论闭环和 CI 分类（工作流 I）的策略：扁平的点分键，每个键能在全局 / 产品 / 仓库任一层单独覆盖（契约 4.2）。
 * 两个总开关默认关：什么都不配置的用户看到的和 2.1.0 一样（Shipherd 3 总设计的反目标）。
 */

export type LoopPolicyGroup = "comments" | "ci";
export const LOOP_POLICY_GROUPS: readonly LoopPolicyGroup[] = ["comments", "ci"];

export type LoopPolicyKeyDef =
  | { key: string; group: LoopPolicyGroup; kind: "bool"; default: boolean }
  | { key: string; group: LoopPolicyGroup; kind: "int"; min: number; max: number; default: number }
  | { key: string; group: LoopPolicyGroup; kind: "enum"; options: readonly string[]; default: string }
  | { key: string; group: LoopPolicyGroup; kind: "list"; default: readonly string[] };

/** 列表键最多几条、每条多长。 */
export const LOOP_LIST_MAX = 100;
export const LOOP_LIST_ITEM_MAX = 200;

const b = (key: string, group: LoopPolicyGroup, d: boolean): LoopPolicyKeyDef => ({ key, group, kind: "bool", default: d });
const i = (key: string, group: LoopPolicyGroup, d: number, min: number, max: number): LoopPolicyKeyDef => ({ key, group, kind: "int", min, max, default: d });
const e = (key: string, group: LoopPolicyGroup, options: readonly string[], d: string): LoopPolicyKeyDef => ({ key, group, kind: "enum", options, default: d });
const l = (key: string, group: LoopPolicyGroup): LoopPolicyKeyDef => ({ key, group, kind: "list", default: [] });

export const ATTRIBUTION_MODES = ["auto", "review", "off"] as const;
export type AttributionMode = (typeof ATTRIBUTION_MODES)[number];

export const LOOP_POLICY_KEYS = [
  b("comments.enabled", "comments", false),
  e("comments.copilot", "comments", ATTRIBUTION_MODES, "auto"),
  e("comments.human", "comments", ATTRIBUTION_MODES, "review"),
  e("comments.questions", "comments", ["user", "session"], "user"),
  b("comments.useModel", "comments", true),
  l("comments.ignorePatterns", "comments"),
  i("comments.maxPerDelivery", "comments", 10, 1, 50),
  b("comments.reply", "comments", true),
  b("comments.resolve", "comments", true),
  e("comments.replyLanguage", "comments", ["en", "zh"], "en"),
  b("ci.enabled", "ci", false),
  i("ci.maxReruns", "ci", 2, 0, 5),
  b("ci.useModel", "ci", true),
  l("ci.envPatterns", "ci"),
  l("ci.codePatterns", "ci"),
  l("ci.flakyTests", "ci"),
  i("ci.autoListThreshold", "ci", 3, 1, 100),
  i("ci.autoListDays", "ci", 30, 1, 365),
] as const satisfies readonly LoopPolicyKeyDef[];

export type LoopPolicyKey = (typeof LOOP_POLICY_KEYS)[number]["key"];
export type LoopValue = boolean | number | string | string[];

export interface LoopPolicy {
  "comments.enabled": boolean;
  "comments.copilot": AttributionMode;
  "comments.human": AttributionMode;
  "comments.questions": "user" | "session";
  "comments.useModel": boolean;
  "comments.ignorePatterns": string[];
  "comments.maxPerDelivery": number;
  "comments.reply": boolean;
  "comments.resolve": boolean;
  "comments.replyLanguage": "en" | "zh";
  "ci.enabled": boolean;
  "ci.maxReruns": number;
  "ci.useModel": boolean;
  "ci.envPatterns": string[];
  "ci.codePatterns": string[];
  "ci.flakyTests": string[];
  "ci.autoListThreshold": number;
  "ci.autoListDays": number;
}
export type LoopPolicyOverrides = Partial<LoopPolicy>;

const DEFS = new Map<string, LoopPolicyKeyDef>(LOOP_POLICY_KEYS.map((d) => [d.key, d]));

export const LOOP_POLICY_DEFAULTS = Object.fromEntries(
  LOOP_POLICY_KEYS.map((d) => [d.key, d.kind === "list" ? [...d.default] : d.default]),
) as unknown as LoopPolicy;

export function loopKeyDef(key: string): LoopPolicyKeyDef | undefined {
  return DEFS.get(key);
}

export class LoopPolicyError extends Error {
  constructor(readonly key: string, readonly problem: "unknown_key" | "bad_value" | "bad_pattern") {
    super(`${problem}: ${key}`);
  }
}

/** `/…/` 或 `/…/i` 包起来的按正则，其余按不区分大小写的子串。坏的正则返回 null。 */
export function compilePattern(p: string): ((text: string) => boolean) | null {
  const m = /^\/(.+)\/([imsu]*)$/s.exec(p);
  if (m) {
    try {
      const re = new RegExp(m[1], m[2].includes("i") ? m[2] : `${m[2]}i`);
      return (t) => re.test(t);
    } catch {
      return null;
    }
  }
  const needle = p.toLowerCase();
  return (t) => t.toLowerCase().includes(needle);
}

/** 一个值合不合法；合法时返回规范后的值。列表去掉空白项和重复项。 */
export function checkLoopValue(key: string, v: unknown): LoopValue {
  const d = DEFS.get(key);
  if (!d) throw new LoopPolicyError(key, "unknown_key");
  switch (d.kind) {
    case "bool":
      if (typeof v !== "boolean") throw new LoopPolicyError(key, "bad_value");
      return v;
    case "int":
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < d.min || v > d.max) throw new LoopPolicyError(key, "bad_value");
      return v;
    case "enum":
      if (typeof v !== "string" || !d.options.includes(v)) throw new LoopPolicyError(key, "bad_value");
      return v;
    case "list": {
      if (!Array.isArray(v) || v.length > LOOP_LIST_MAX) throw new LoopPolicyError(key, "bad_value");
      const out: string[] = [];
      for (const x of v) {
        if (typeof x !== "string") throw new LoopPolicyError(key, "bad_value");
        const s = x.trim();
        if (!s) continue;
        if (s.length > LOOP_LIST_ITEM_MAX) throw new LoopPolicyError(key, "bad_value");
        if (!compilePattern(s)) throw new LoopPolicyError(key, "bad_pattern");
        if (!out.includes(s)) out.push(s);
      }
      return out;
    }
  }
}

/** 一层的覆盖：不认识的键、越界的值都拒绝；undefined / null = 不覆盖（继承）。 */
export function parseLoopOverrides(v: unknown): LoopPolicyOverrides {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new LoopPolicyError("", "bad_value");
  const out: Record<string, LoopValue> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === undefined || x === null) continue;
    out[k] = checkLoopValue(k, x);
  }
  return out as LoopPolicyOverrides;
}

/** 存在库里的覆盖读回来：坏的键和值丢掉。 */
export function sanitizeLoopOverrides(v: unknown): LoopPolicyOverrides {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, LoopValue> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    try {
      out[k] = checkLoopValue(k, x);
    } catch {
      // 跳过。
    }
  }
  return out as LoopPolicyOverrides;
}

export type LoopScope = { kind: "global" } | { kind: "product"; productId: number } | { kind: "repo"; slug: string };

export interface LoopKeyView {
  key: LoopPolicyKey;
  effective: LoopValue;
  origin: { kind: "default" } | { kind: "global" } | { kind: "product"; productId: number; name: string } | { kind: "repo"; slug: string };
  override: LoopValue | null;
}

export interface LoopPolicyView {
  scope: LoopScope;
  keys: LoopKeyView[];
  conflicts: { key: string; products: { id: number; name: string; value: LoopValue }[] }[];
}
