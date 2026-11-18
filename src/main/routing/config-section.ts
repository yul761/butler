import { createHash } from "node:crypto";
import type { LimitKind } from "../../shared/availability";
import {
  isModelName, isTaskId, isTier, POLICIES, TIERS, type LimitPolicy, type LimitRule, type LimitRuleKind, type RegistryModel, type TaskRouteOverride, type Tier,
} from "../../shared/model-routing";
import type { RoutingRepo } from "../db/routing-repo";
import { validateModel, validateRule } from "./routing-service";

/**
 * 导出 / 导入（契约 4.3）里模型路由的一节 `models`：注册表、每档顺序、任务覆盖、用户和学到的识别规则。
 * 框架（4.3，C 提供）负责整份文件、formatVersion、备份和批次；这里只管这一节的 export / preview / apply。
 * 下面的 ConfigSection 接口照契约写，C 合并后换成它的类型；A、C 谁后合并谁把这一节登记上去。
 *
 * 不导出：健康、事件、花费、未识别的报错（本机状态）；规则的 note（学到的规则的 note 是报错原文的一行，可能带路径或名字）。
 * 导入的模型和规则先停用（契约里的 pending）：导入之后行为不变，用户在「模型路由」页启用。顺序和任务覆盖直接写，没有启用的模型时它们不起作用。
 */

export const MODELS_SECTION_ID = "models";
export const MODELS_SECTION_VERSION = 1;

export type ImportMode = "merge" | "replace";

/** 一节的预览：按内容指纹分的新增、改动（本机是默认值）、冲突（本机也改过，merge 时保留本机）。 */
export interface SectionPreview {
  added: string[];
  changed: string[];
  conflicting: string[];
  unchanged: number;
  /** 认不出、格式不对的条目（不导入）。 */
  invalid: string[];
}

export interface SectionApplyResult extends SectionPreview {
  /** replace 删掉的本机条目。 */
  removed: string[];
}

export interface ConfigSection<T> {
  id: string;
  export(scope: unknown): T;
  preview(incoming: unknown): SectionPreview;
  apply(incoming: unknown, mode: ImportMode): SectionApplyResult;
}

export type ExportedRule = { kind: LimitRuleKind; pattern: string; category: LimitKind | null; accountLevel: boolean; source: "user" | "learned" };
export type ExportedModel = Omit<RegistryModel, "enabled">;

export interface ModelsSectionData {
  version: number;
  registry: ExportedModel[];
  chains: Record<Tier, string[]>;
  taskRoutes: TaskRouteOverride[];
  rules: ExportedRule[];
}

/** 条目的键：在 preview 里给用户看，也用来对上本机的同一条。 */
const key = {
  model: (name: string) => `model:${name}`,
  chain: (t: Tier) => `chain:${t}`,
  route: (task: string) => `task:${task}`,
  rule: (r: Pick<ExportedRule, "kind" | "pattern">) => `rule:${r.kind}:${r.pattern}`,
};

/** 同一种规则（种类 + 模式）导入后的 id：两台机器导入同一条得到同一个 id。 */
export const importedRuleId = (r: Pick<ExportedRule, "kind" | "pattern">): string =>
  `imported:${createHash("sha1").update(`${r.kind}\n${r.pattern}`).digest("hex").slice(0, 12)}`;

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const exportModel = (m: RegistryModel): ExportedModel => ({ name: m.name, tier: m.tier, account: m.account, priceIn: m.priceIn, priceOut: m.priceOut, note: m.note });
const exportRoute = (o: TaskRouteOverride): TaskRouteOverride => ({ task: o.task, tier: o.tier ?? null, minTier: o.minTier ?? null, policy: o.policy ?? null, critical: o.critical ?? null });
const ruleContent = (r: ExportedRule) => ({ category: r.category, accountLevel: r.accountLevel });

interface Parsed {
  registry: ExportedModel[];
  chains: Partial<Record<Tier, string[]>>;
  taskRoutes: TaskRouteOverride[];
  rules: ExportedRule[];
  invalid: string[];
}

const nullable = <T>(v: unknown, ok: (x: unknown) => x is T): T | null | undefined => (v === null || v === undefined ? null : ok(v) ? v : undefined);
const isPolicy = (v: unknown): v is LimitPolicy => typeof v === "string" && (POLICIES as readonly string[]).includes(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/** 进来的这一节：一条一条检查，格式不对的记进 invalid，不让整节失败。 */
export function parseModelsSection(v: unknown): Parsed {
  const out: Parsed = { registry: [], chains: {}, taskRoutes: [], rules: [], invalid: [] };
  if (typeof v !== "object" || v === null) {
    out.invalid.push("section");
    return out;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.version === "number" && o.version > MODELS_SECTION_VERSION) out.invalid.push(`version:${o.version}`);
  const seenModels = new Set<string>();
  for (const [i, m] of (Array.isArray(o.registry) ? o.registry : []).entries()) {
    const r = m as Partial<ExportedModel> | null;
    const model: RegistryModel = {
      name: String(r?.name ?? ""), tier: r?.tier as Tier, enabled: false, account: typeof r?.account === "string" ? r.account : "default",
      priceIn: typeof r?.priceIn === "number" ? r.priceIn : null, priceOut: typeof r?.priceOut === "number" ? r.priceOut : null, note: typeof r?.note === "string" ? r.note : "",
    };
    if (validateModel(model) !== null || seenModels.has(model.name)) {
      out.invalid.push(`registry[${i}]`);
      continue;
    }
    seenModels.add(model.name);
    out.registry.push(exportModel(model));
  }
  const chains = (typeof o.chains === "object" && o.chains !== null ? o.chains : {}) as Record<string, unknown>;
  for (const [t, list] of Object.entries(chains)) {
    if (!isTier(t) || !Array.isArray(list) || !list.every(isModelName)) {
      out.invalid.push(`chains.${t}`);
      continue;
    }
    out.chains[t] = [...new Set(list)];
  }
  const seenTasks = new Set<string>();
  for (const [i, x] of (Array.isArray(o.taskRoutes) ? o.taskRoutes : []).entries()) {
    const r = (x ?? {}) as Record<string, unknown>;
    const route = { task: r.task, tier: nullable(r.tier, isTier), minTier: nullable(r.minTier, isTier), policy: nullable(r.policy, isPolicy), critical: nullable(r.critical, isBool) };
    if (!isTaskId(route.task) || seenTasks.has(route.task) || [route.tier, route.minTier, route.policy, route.critical].includes(undefined)) {
      out.invalid.push(`taskRoutes[${i}]`);
      continue;
    }
    seenTasks.add(route.task);
    out.taskRoutes.push(route as TaskRouteOverride);
  }
  const seenRules = new Set<string>();
  for (const [i, x] of (Array.isArray(o.rules) ? o.rules : []).entries()) {
    const r = (x ?? {}) as Record<string, unknown>;
    const rule: ExportedRule = {
      kind: r.kind as LimitRuleKind, pattern: String(r.pattern ?? ""), category: (r.category ?? null) as LimitKind | null,
      accountLevel: r.accountLevel === true, source: r.source === "learned" ? "learned" : "user",
    };
    if (validateRule({ ...rule, note: "" }) !== null || seenRules.has(key.rule(rule))) {
      out.invalid.push(`rules[${i}]`);
      continue;
    }
    seenRules.add(key.rule(rule));
    out.rules.push(rule);
  }
  return out;
}

type Verdict = "added" | "changed" | "conflicting" | "unchanged";

interface Plan {
  items: { key: string; verdict: Verdict; write: () => void }[];
  removals: { key: string; remove: () => void }[];
  invalid: string[];
}

export class ModelsConfigSection implements ConfigSection<ModelsSectionData> {
  readonly id = MODELS_SECTION_ID;

  constructor(private readonly d: { repo: RoutingRepo; now: () => number; onApplied: () => void }) {}

  export(): ModelsSectionData {
    const { repo } = this.d;
    return {
      version: MODELS_SECTION_VERSION,
      registry: repo.registry().map(exportModel),
      chains: repo.chains(),
      taskRoutes: repo.taskRoutes().map(exportRoute),
      rules: repo.rules().flatMap((r) => (r.source === "builtin" ? [] : [{ kind: r.kind, pattern: r.pattern, category: r.category, accountLevel: r.accountLevel, source: r.source }])),
    };
  }

  preview(incoming: unknown): SectionPreview {
    return summarize(this.plan(parseModelsSection(incoming), "merge"));
  }

  apply(incoming: unknown, mode: ImportMode): SectionApplyResult {
    const plan = this.plan(parseModelsSection(incoming), mode);
    const result = { ...summarize(plan), removed: plan.removals.map((r) => r.key) };
    this.d.repo.transaction(() => {
      for (const r of plan.removals) r.remove();
      for (const it of plan.items) {
        if (it.verdict === "added" || it.verdict === "changed" || (it.verdict === "conflicting" && mode === "replace")) it.write();
      }
    });
    this.d.onApplied();
    return result;
  }

  /** 每一条和本机比：新增、改动（本机是默认值）、冲突（本机也有自己的）、一样。replace 另外列出要删的本机条目。 */
  private plan(p: Parsed, mode: ImportMode): Plan {
    const { repo } = this.d;
    const now = this.d.now();
    const items: Plan["items"] = [];
    const removals: Plan["removals"] = [];

    const local = new Map(repo.registry().map((m) => [m.name, m]));
    for (const m of p.registry) {
      const cur = local.get(m.name);
      const verdict: Verdict = !cur ? "added" : sameJson(exportModel(cur), m) ? "unchanged" : "conflicting";
      // 已登记的模型保留本机的启用状态；新的先停用。
      items.push({ key: key.model(m.name), verdict, write: () => repo.upsertModel({ ...m, enabled: cur?.enabled ?? false }) });
    }
    if (mode === "replace") {
      const incoming = new Set(p.registry.map((m) => m.name));
      for (const name of local.keys()) if (!incoming.has(name)) removals.push({ key: key.model(name), remove: () => repo.removeModel(name) });
    }

    const chains = repo.chains();
    for (const t of TIERS) {
      const inc = p.chains[t];
      if (inc === undefined) {
        if (mode === "replace" && chains[t].length > 0) removals.push({ key: key.chain(t), remove: () => repo.setChain(t, []) });
        continue;
      }
      const verdict: Verdict = sameJson(chains[t], inc) ? "unchanged" : chains[t].length === 0 ? (inc.length === 0 ? "unchanged" : "added") : "conflicting";
      items.push({ key: key.chain(t), verdict, write: () => repo.setChain(t, inc) });
    }

    const routes = new Map(repo.taskRoutes().map((o) => [o.task, exportRoute(o)]));
    for (const r of p.taskRoutes) {
      const cur = routes.get(r.task);
      const verdict: Verdict = !cur ? "changed" : sameJson(cur, r) ? "unchanged" : "conflicting";
      items.push({ key: key.route(r.task), verdict, write: () => repo.setTaskRoute(r) });
    }
    if (mode === "replace") {
      const incoming = new Set(p.taskRoutes.map((r) => r.task));
      for (const task of routes.keys()) if (!incoming.has(task)) removals.push({ key: key.route(task), remove: () => repo.clearTaskRoute(task) });
    }

    const rules = repo.rules().filter((r) => r.source !== "builtin");
    const byKey = new Map(rules.map((r) => [key.rule(r), r]));
    for (const r of p.rules) {
      const cur = byKey.get(key.rule(r));
      const verdict: Verdict = !cur ? "added" : sameJson(ruleContent({ ...cur, source: r.source }), ruleContent(r)) ? "unchanged" : "conflicting";
      const rule: LimitRule = { id: cur?.id ?? importedRuleId(r), kind: r.kind, pattern: r.pattern, category: r.category, accountLevel: r.accountLevel, source: r.source, enabled: cur?.enabled ?? false, note: cur?.note ?? "" };
      items.push({ key: key.rule(r), verdict, write: () => repo.addRule(rule, now) });
    }
    if (mode === "replace") {
      const incoming = new Set(p.rules.map(key.rule));
      for (const r of rules) if (!incoming.has(key.rule(r))) removals.push({ key: key.rule(r), remove: () => repo.removeRule(r.id) });
    }
    return { items, removals, invalid: p.invalid };
  }
}

function summarize(plan: Plan): SectionPreview {
  const pick = (v: Verdict) => plan.items.filter((i) => i.verdict === v).map((i) => i.key);
  return { added: pick("added"), changed: pick("changed"), conflicting: pick("conflicting"), unchanged: pick("unchanged").length, invalid: plan.invalid };
}
