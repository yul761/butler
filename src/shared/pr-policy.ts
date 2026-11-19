/**
 * 就绪度、证据、风险（工作流 G，设计 §6）的三层策略：扁平的点分键，每个键能在全局 / 产品 / 仓库任一层单独覆盖（契约 4.2）。
 * 路径类（`risk.paths.*`）的列表是**额外**的 glob：各层**取并集**加在内置列表上（风险路径常常是「这个仓库还多一个目录」）；
 * `risk.paths.<类>.builtin = false` 去掉内置列表（迁移那一类没有这个键：迁移一定是高风险，只能加路径）。
 */

export type PrPolicyGroup = "readiness" | "evidence" | "risk";
export const PR_POLICY_GROUPS: readonly PrPolicyGroup[] = ["readiness", "evidence", "risk"];

export type PrPolicyKeyDef =
  | { key: string; group: PrPolicyGroup; kind: "bool"; default: boolean }
  | { key: string; group: PrPolicyGroup; kind: "int"; min: number; max: number; default: number }
  | { key: string; group: PrPolicyGroup; kind: "enum"; options: readonly string[]; default: string }
  | { key: string; group: PrPolicyGroup; kind: "list"; union?: boolean; default: readonly string[] };

export const PR_LIST_MAX = 100;
export const PR_LIST_ITEM_MAX = 200;

/** 路径类别：内置 glob（代码里的默认，页面上显示）。 */
export const RISK_PATH_CLASSES = ["migration", "auth", "publicApi", "config", "ci", "lowRisk", "generated", "ui"] as const;
export type RiskPathClass = (typeof RISK_PATH_CLASSES)[number];

export const BUILTIN_RISK_PATHS: Readonly<Record<RiskPathClass, readonly string[]>> = {
  migration: ["**/migrations/**", "**/migrate/**", "**/*migration*", "**/*.sql", "**/schema.prisma", "**/alembic/**", "**/db/schema*"],
  auth: ["**/auth/**", "**/*auth*", "**/*permission*", "**/*acl*", "**/*rbac*", "**/security/**"],
  publicApi: ["**/api/**", "**/*.proto", "**/openapi*", "**/swagger*", "**/*.graphql", "**/public/**/*.d.ts"],
  config: ["**/.env*", "**/*secret*", "**/*credential*", "**/*.pem", "**/*.key", "**/config/**", "**/settings.*"],
  ci: [".github/workflows/**", ".gitlab-ci.yml", ".circleci/**", "azure-pipelines*.yml", "Jenkinsfile", ".buildkite/**"],
  lowRisk: ["**/*.test.*", "**/*.spec.*", "**/test/**", "**/tests/**", "**/__tests__/**", "**/*.md", "docs/**"],
  generated: ["**/*.lock", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "**/dist/**", "**/*.min.*", "**/*.snap"],
  ui: ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.css", "**/*.scss", "**/*.html", "**/components/**"],
};

/** 不能关内置列表的类别。 */
export const LOCKED_PATH_CLASSES: readonly RiskPathClass[] = ["migration"];

const b = (key: string, group: PrPolicyGroup, d: boolean): PrPolicyKeyDef => ({ key, group, kind: "bool", default: d });
const i = (key: string, group: PrPolicyGroup, d: number, min: number, max: number): PrPolicyKeyDef => ({ key, group, kind: "int", min, max, default: d });
const e = (key: string, group: PrPolicyGroup, options: readonly string[], d: string): PrPolicyKeyDef => ({ key, group, kind: "enum", options, default: d });
const l = (key: string, group: PrPolicyGroup, union = false): PrPolicyKeyDef => ({ key, group, kind: "list", union, default: [] });

export const REQUIRE_MODES = ["auto", "on", "off"] as const;
export type RequireMode = (typeof REQUIRE_MODES)[number];
export const RERUN_MODES = ["all", "fast", "off"] as const;
export type RerunMode = (typeof RERUN_MODES)[number];

export const PR_POLICY_KEYS = [
  b("readiness.checks.enabled", "readiness", true),
  b("readiness.pre_review.enabled", "readiness", true),
  b("readiness.evidence.enabled", "readiness", true),
  b("readiness.comments.enabled", "readiness", true),
  b("readiness.mergeable.enabled", "readiness", true),
  b("readiness.description.enabled", "readiness", true),
  b("readiness.shouldBlocks", "readiness", false),
  i("readiness.descriptionMinChars", "readiness", 80, 0, 5000),
  l("readiness.whatWords", "readiness"),
  l("readiness.whyWords", "readiness"),
  l("readiness.verifyWords", "readiness"),
  e("evidence.require.test", "evidence", REQUIRE_MODES, "auto"),
  e("evidence.require.lint", "evidence", REQUIRE_MODES, "auto"),
  e("evidence.require.typecheck", "evidence", REQUIRE_MODES, "auto"),
  e("evidence.require.build", "evidence", REQUIRE_MODES, "off"),
  e("evidence.rerun", "evidence", RERUN_MODES, "all"),
  i("evidence.rerunTimeoutSec", "evidence", 600, 10, 3600),
  l("risk.paths.migration", "risk", true),
  l("risk.paths.auth", "risk", true),
  l("risk.paths.publicApi", "risk", true),
  l("risk.paths.config", "risk", true),
  l("risk.paths.ci", "risk", true),
  l("risk.paths.lowRisk", "risk", true),
  l("risk.paths.generated", "risk", true),
  l("risk.paths.ui", "risk", true),
  b("risk.paths.auth.builtin", "risk", true),
  b("risk.paths.publicApi.builtin", "risk", true),
  b("risk.paths.config.builtin", "risk", true),
  b("risk.paths.ci.builtin", "risk", true),
  b("risk.paths.lowRisk.builtin", "risk", true),
  b("risk.paths.generated.builtin", "risk", true),
  b("risk.paths.ui.builtin", "risk", true),
  i("risk.size.smallLines", "risk", 100, 0, 100_000),
  i("risk.size.smallFiles", "risk", 8, 0, 10_000),
  i("risk.size.largeLines", "risk", 800, 1, 1_000_000),
  i("risk.size.largeFiles", "risk", 40, 1, 100_000),
  l("risk.types.labels", "risk"),
  l("risk.types.branchPrefixes", "risk"),
  l("risk.types.floors", "risk"),
] as const satisfies readonly PrPolicyKeyDef[];

export type PrPolicyKey = (typeof PR_POLICY_KEYS)[number]["key"];
export type PrValue = boolean | number | string | string[];

/** 生效的策略：扁平键 → 值（类型见 PR_POLICY_KEYS）。 */
export type PrPolicy = Record<PrPolicyKey, PrValue>;
export type PrPolicyOverrides = Partial<PrPolicy>;

const DEFS = new Map<string, PrPolicyKeyDef>(PR_POLICY_KEYS.map((d) => [d.key, d]));

export const PR_POLICY_DEFAULTS = Object.fromEntries(
  PR_POLICY_KEYS.map((d) => [d.key, d.kind === "list" ? [...d.default] : d.default]),
) as unknown as PrPolicy;

export function prKeyDef(key: string): PrPolicyKeyDef | undefined {
  return DEFS.get(key);
}

export class PrPolicyError extends Error {
  constructor(readonly key: string, readonly problem: "unknown_key" | "bad_value") {
    super(`${problem}: ${key}`);
  }
}

/** 类型映射三个列表的格式：`键=值`（label=type、prefix=type、type=level）。 */
export const TYPE_LEVELS = ["low", "medium", "high"] as const;
const TYPE_ITEM = /^[^=\s][^=]*=[^=\s][^=]*$/;

export function checkPrValue(key: string, v: unknown): PrValue {
  const d = DEFS.get(key);
  if (!d) throw new PrPolicyError(key, "unknown_key");
  switch (d.kind) {
    case "bool":
      if (typeof v !== "boolean") throw new PrPolicyError(key, "bad_value");
      return v;
    case "int":
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < d.min || v > d.max) throw new PrPolicyError(key, "bad_value");
      return v;
    case "enum":
      if (typeof v !== "string" || !d.options.includes(v)) throw new PrPolicyError(key, "bad_value");
      return v;
    case "list": {
      if (!Array.isArray(v) || v.length > PR_LIST_MAX) throw new PrPolicyError(key, "bad_value");
      const out: string[] = [];
      for (const x of v) {
        if (typeof x !== "string") throw new PrPolicyError(key, "bad_value");
        const s = x.trim();
        if (!s) continue;
        if (s.length > PR_LIST_ITEM_MAX) throw new PrPolicyError(key, "bad_value");
        if (key.startsWith("risk.types.") && !TYPE_ITEM.test(s)) throw new PrPolicyError(key, "bad_value");
        if (key === "risk.types.floors" && !(TYPE_LEVELS as readonly string[]).includes(s.split("=")[1]!.trim())) throw new PrPolicyError(key, "bad_value");
        if (!out.includes(s)) out.push(s);
      }
      return out;
    }
  }
}

export function parsePrOverrides(v: unknown): PrPolicyOverrides {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new PrPolicyError("", "bad_value");
  const out: Record<string, PrValue> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === undefined || x === null) continue;
    out[k] = checkPrValue(k, x);
  }
  return out as PrPolicyOverrides;
}

export function sanitizePrOverrides(v: unknown): PrPolicyOverrides {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, PrValue> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    try {
      out[k] = checkPrValue(k, x);
    } catch {
      // 跳过。
    }
  }
  return out as PrPolicyOverrides;
}

// ---------------------------------------------------------------- 给计算用的、已经展开的策略

/** 「改了什么 / 为什么 / 怎么验证」三组默认关键词（设计 §7 第 6 条）；策略里的词加在这些后面。 */
export const DEFAULT_DESCRIPTION_WORDS = {
  what: ["what", "changes", "summary", "改了", "改动", "做了什么", "变更"],
  why: ["why", "motivation", "context", "reason", "为什么", "原因", "背景", "动机"],
  verify: ["test", "verif", "how to", "验证", "测试"],
} as const;

/** 默认的 ticket 类型映射（设计 §5 R10）。 */
export const DEFAULT_TICKET_TYPES = {
  labels: { hotfix: "hotfix", security: "security", bug: "bug", documentation: "docs", docs: "docs", chore: "chore" } as Record<string, string>,
  branchPrefixes: { "hotfix/": "hotfix", "security/": "security", "fix/": "bug", "bugfix/": "bug", "docs/": "docs", "chore/": "chore" } as Record<string, string>,
  floors: { hotfix: "high", security: "high", bug: "medium" } as Record<string, "low" | "medium" | "high">,
};

export interface ResolvedPrPolicy {
  readiness: {
    enabled: Record<"checks" | "pre_review" | "evidence" | "comments" | "mergeable" | "description", boolean>;
    shouldBlocks: boolean;
    descriptionMinChars: number;
    words: { what: string[]; why: string[]; verify: string[] };
  };
  evidence: {
    require: Record<"test" | "lint" | "typecheck" | "build", RequireMode>;
    rerun: RerunMode;
    rerunTimeoutSec: number;
  };
  risk: {
    paths: Record<RiskPathClass, string[]>;
    size: { smallLines: number; smallFiles: number; largeLines: number; largeFiles: number };
    types: { labels: Record<string, string>; branchPrefixes: Record<string, string>; floors: Record<string, "low" | "medium" | "high"> };
  };
}

function pairs(list: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of list) {
    const at = s.indexOf("=");
    if (at <= 0) continue;
    out[s.slice(0, at).trim().toLowerCase()] = s.slice(at + 1).trim().toLowerCase();
  }
  return out;
}

/**
 * 扁平策略 → 计算用的结构。unions：路径类别各层的并集（PrPolicies 算好传进来；单测里可以省略，只用 flat 里的值）。
 */
export function expandPrPolicy(flat: PrPolicy, unions?: Partial<Record<RiskPathClass, string[]>>): ResolvedPrPolicy {
  const g = <T extends PrValue>(k: PrPolicyKey) => flat[k] as T;
  const paths = {} as Record<RiskPathClass, string[]>;
  for (const c of RISK_PATH_CLASSES) {
    const extra = unions?.[c] ?? (g<string[]>(`risk.paths.${c}` as PrPolicyKey) ?? []);
    const builtinOn = LOCKED_PATH_CLASSES.includes(c) ? true : g<boolean>(`risk.paths.${c}.builtin` as PrPolicyKey) !== false;
    paths[c] = [...new Set([...(builtinOn ? BUILTIN_RISK_PATHS[c] : []), ...extra])];
  }
  const floors: Record<string, "low" | "medium" | "high"> = { ...DEFAULT_TICKET_TYPES.floors };
  for (const [k, v] of Object.entries(pairs(g<string[]>("risk.types.floors")))) floors[k] = v as "low" | "medium" | "high";
  return {
    readiness: {
      enabled: {
        checks: g<boolean>("readiness.checks.enabled"),
        pre_review: g<boolean>("readiness.pre_review.enabled"),
        evidence: g<boolean>("readiness.evidence.enabled"),
        comments: g<boolean>("readiness.comments.enabled"),
        mergeable: g<boolean>("readiness.mergeable.enabled"),
        description: g<boolean>("readiness.description.enabled"),
      },
      shouldBlocks: g<boolean>("readiness.shouldBlocks"),
      descriptionMinChars: g<number>("readiness.descriptionMinChars"),
      words: {
        what: [...DEFAULT_DESCRIPTION_WORDS.what, ...g<string[]>("readiness.whatWords")],
        why: [...DEFAULT_DESCRIPTION_WORDS.why, ...g<string[]>("readiness.whyWords")],
        verify: [...DEFAULT_DESCRIPTION_WORDS.verify, ...g<string[]>("readiness.verifyWords")],
      },
    },
    evidence: {
      require: {
        test: g<RequireMode>("evidence.require.test"),
        lint: g<RequireMode>("evidence.require.lint"),
        typecheck: g<RequireMode>("evidence.require.typecheck"),
        build: g<RequireMode>("evidence.require.build"),
      },
      rerun: g<RerunMode>("evidence.rerun"),
      rerunTimeoutSec: g<number>("evidence.rerunTimeoutSec"),
    },
    risk: {
      paths,
      size: {
        smallLines: g<number>("risk.size.smallLines"),
        smallFiles: g<number>("risk.size.smallFiles"),
        largeLines: g<number>("risk.size.largeLines"),
        largeFiles: g<number>("risk.size.largeFiles"),
      },
      types: {
        labels: { ...DEFAULT_TICKET_TYPES.labels, ...pairs(g<string[]>("risk.types.labels")) },
        branchPrefixes: { ...DEFAULT_TICKET_TYPES.branchPrefixes, ...pairs(g<string[]>("risk.types.branchPrefixes")) },
        floors,
      },
    },
  };
}

/** 默认策略展开后的样子（单测和没有数据库时用）。 */
export const defaultPrPolicy = (): ResolvedPrPolicy => expandPrPolicy(PR_POLICY_DEFAULTS);

export type PrScope = { kind: "global" } | { kind: "product"; productId: number } | { kind: "repo"; slug: string };

export interface PrKeyView {
  key: PrPolicyKey;
  group: PrPolicyGroup;
  effective: PrValue;
  origin: { kind: "default" } | { kind: "global" } | { kind: "product"; productId: number; name: string } | { kind: "repo"; slug: string };
  override: PrValue | null;
}

export interface PrPolicyView {
  scope: PrScope;
  keys: PrKeyView[];
  /** 路径类别的内置 glob（页面上显示）。 */
  builtinPaths: Readonly<Record<RiskPathClass, readonly string[]>>;
  /** 路径类别各层并集后的额外 glob。 */
  unions: Record<RiskPathClass, string[]>;
  conflicts: { key: string; products: { id: number; name: string; value: PrValue }[] }[];
}
