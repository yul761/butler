import { createHash } from "node:crypto";
import { z } from "zod";
import { POLICIES, TASK_IDS, TIERS, isModelName, type LimitRule, type RegistryModel, type TaskRouteOverride, type Tier } from "../../shared/model-routing";
import type { PreviewDiff, PreviewRow } from "../../shared/config-io";
import { RoutingRepo } from "../db/routing-repo";
import { validateModel, validateRule } from "../routing/routing-service";
import { fingerprint } from "./fingerprint";
import { emptyCounts, type ConfigSection, type SectionEnv } from "./registry";

/**
 * 导出 / 导入（契约 4.3）里模型路由的一节 `models`（工作流 A）：注册表、每档顺序、任务覆盖、用户和学到的识别规则。
 * 只在「全部」导出里（content: "config"），也只跟整份（scope all）的文件比：模型和配额属于账号，不属于某个仓库或产品。
 *
 * 不导出：健康、事件、花费、未识别的报错（本机状态）；规则的 note（学到的规则的 note 是报错原文的一行，可能带路径或名字）。
 * 导入的模型和规则先停用（契约里的 pending）：导入之后行为不变，用户在「模型路由」页启用；本机已有的保留本机的启用状态。
 * 这些表不在批次撤销（4.4）的适配器里：合并只加停用的条目、默认留本地的；替换之前框架写的备份是回退手段。
 */

const LIMIT_KINDS = ["usage_limit", "rate_limit", "overloaded", "model_unavailable"] as const;
const RULE_KINDS = ["regex", "status", "field", "reset"] as const;
const MODEL_NAME = z.string().max(200).refine(isModelName, "invalid model name");
const PRICE = z.number().finite().min(0).nullable();
/** 以前有、现在没有的任务（epic_digest：旧 epic 层，BTL-246 去掉了）：旧文件里的这些路由照样能读进来，预览和导入时丢掉。 */
const RETIRED_TASKS = ["epic_digest"] as const;
const isRetired = (it: ModelsItem): boolean => it.kind === "task" && (RETIRED_TASKS as readonly string[]).includes(it.task);

const ModelItem = z.object({
  kind: z.literal("model"), name: MODEL_NAME, tier: z.enum(TIERS as [Tier, ...Tier[]]), account: z.string().max(100), priceIn: PRICE, priceOut: PRICE, note: z.string().max(500),
});
const ChainItem = z.object({ kind: z.literal("chain"), tier: z.enum(TIERS as [Tier, ...Tier[]]), models: z.array(MODEL_NAME).max(50) });
const TaskItem = z.object({
  kind: z.literal("task"),
  task: z.enum([...TASK_IDS, ...RETIRED_TASKS] as unknown as [string, ...string[]]),
  tier: z.enum(TIERS as [Tier, ...Tier[]]).nullable(),
  minTier: z.enum(TIERS as [Tier, ...Tier[]]).nullable(),
  policy: z.enum(POLICIES as unknown as [string, ...string[]]).nullable(),
  critical: z.boolean().nullable(),
});
const RuleItem = z.object({
  kind: z.literal("rule"), ruleKind: z.enum(RULE_KINDS), pattern: z.string().max(500), category: z.enum(LIMIT_KINDS).nullable(), accountLevel: z.boolean(),
  source: z.enum(["user", "learned"]),
});

export const ModelsItem = z.discriminatedUnion("kind", [ModelItem, ChainItem, TaskItem, RuleItem]).superRefine((v, c) => {
  if (v.kind === "model" && validateModel({ ...v, enabled: false }) !== null) c.addIssue({ code: "custom", message: "invalid model" });
  if (v.kind === "rule" && validateRule({ kind: v.ruleKind, pattern: v.pattern, category: v.category, accountLevel: v.accountLevel, note: "" }) !== null) {
    c.addIssue({ code: "custom", message: "invalid rule" });
  }
});
export type ModelsItem = z.infer<typeof ModelsItem>;
type ModelEntry = z.infer<typeof ModelItem>;
type ChainEntry = z.infer<typeof ChainItem>;
type TaskEntry = z.infer<typeof TaskItem>;
type RuleEntry = z.infer<typeof RuleItem>;

/** 同一种规则（种类 + 模式）导入后的 id：两台机器导入同一条得到同一个 id。 */
export const importedRuleId = (r: { ruleKind: string; pattern: string }): string =>
  `imported:${createHash("sha1").update(`${r.ruleKind}\n${r.pattern}`).digest("hex").slice(0, 12)}`;

/** 条目的指纹：只看身份（模型名、档位、任务、规则种类 + 模式），两台机器上同一条相同。 */
export function modelsFingerprint(it: ModelsItem): string {
  switch (it.kind) {
    case "model":
      return fingerprint({ t: "model", name: it.name });
    case "chain":
      return fingerprint({ t: "chain", tier: it.tier });
    case "task":
      return fingerprint({ t: "task", task: it.task });
    case "rule":
      return fingerprint({ t: "rule", kind: it.ruleKind, pattern: it.pattern });
  }
}

function label(it: ModelsItem): string {
  switch (it.kind) {
    case "model":
      return `model · ${it.name} (${it.tier})`;
    case "chain":
      return `chain · ${it.tier}: ${it.models.join(" → ") || "—"}`;
    case "task":
      return `task · ${it.task}`;
    case "rule":
      return `rule · ${it.ruleKind}: ${it.pattern.length > 120 ? `${it.pattern.slice(0, 120)}…` : it.pattern}`;
  }
}

const modelEntry = (m: RegistryModel): ModelEntry => ({ kind: "model", name: m.name, tier: m.tier, account: m.account, priceIn: m.priceIn, priceOut: m.priceOut, note: m.note });
const taskEntry = (o: TaskRouteOverride): TaskEntry => ({ kind: "task", task: o.task, tier: o.tier ?? null, minTier: o.minTier ?? null, policy: o.policy ?? null, critical: o.critical ?? null });
const ruleEntry = (r: LimitRule): RuleEntry => ({ kind: "rule", ruleKind: r.kind, pattern: r.pattern, category: r.category, accountLevel: r.accountLevel, source: r.source === "learned" ? "learned" : "user" });

/** 本机这一节的全部条目（顺序：模型、链、任务、规则）。 */
function localItems(repo: RoutingRepo): ModelsItem[] {
  const chains = repo.chains();
  return [
    ...repo.registry().map(modelEntry),
    ...TIERS.flatMap((t): ChainEntry[] => (chains[t].length ? [{ kind: "chain", tier: t, models: chains[t] }] : [])),
    ...repo.taskRoutes().map(taskEntry),
    ...repo.rules().filter((r) => r.source !== "builtin").map(ruleEntry),
  ];
}

/** 决定行为的字段（不同就是冲突，要选用哪边）；只有备注不同是改动。 */
const BEHAVIOUR: Record<ModelsItem["kind"], readonly string[]> = {
  model: ["tier", "account", "priceIn", "priceOut"],
  chain: ["models"],
  task: ["tier", "minTier", "policy", "critical"],
  rule: ["category", "accountLevel"],
};
const COSMETIC: Record<ModelsItem["kind"], readonly string[]> = { model: ["note"], chain: [], task: [], rule: ["source"] };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function write(repo: RoutingRepo, it: ModelsItem, now: number): void {
  switch (it.kind) {
    case "model": {
      const cur = repo.registry().find((m) => m.name === it.name);
      repo.upsertModel({ name: it.name, tier: it.tier, account: it.account, priceIn: it.priceIn, priceOut: it.priceOut, note: it.note, enabled: cur?.enabled ?? false });
      return;
    }
    case "chain":
      repo.setChain(it.tier, [...new Set(it.models)]);
      return;
    case "task":
      repo.setTaskRoute({ task: it.task as TaskRouteOverride["task"], tier: it.tier, minTier: it.minTier, policy: it.policy as TaskRouteOverride["policy"], critical: it.critical });
      return;
    case "rule": {
      const cur = repo.rules().find((r) => r.source !== "builtin" && r.kind === it.ruleKind && r.pattern === it.pattern);
      repo.addRule(
        { id: cur?.id ?? importedRuleId(it), kind: it.ruleKind, pattern: it.pattern, category: it.category, accountLevel: it.accountLevel, source: it.source, enabled: cur?.enabled ?? false, note: cur?.note ?? "" },
        now,
      );
      return;
    }
  }
}

function remove(repo: RoutingRepo, it: ModelsItem): void {
  switch (it.kind) {
    case "model":
      return repo.removeModel(it.name);
    case "chain":
      return repo.setChain(it.tier, []);
    case "task":
      return repo.clearTaskRoute(it.task as TaskRouteOverride["task"]);
    case "rule": {
      const cur = repo.rules().find((r) => r.source !== "builtin" && r.kind === it.ruleKind && r.pattern === it.pattern);
      if (cur) repo.removeRule(cur.id);
      return;
    }
  }
}

const isAll = (env: SectionEnv & { fileScope?: { kind: string } }) => env.fileScope === undefined || env.fileScope.kind === "all";

export const modelsSection: ConfigSection<ModelsItem> = {
  id: "models",
  order: 60,
  content: "config",
  item: ModelsItem as unknown as z.ZodType<ModelsItem>,
  export(sel, { db }) {
    return sel.kind === "all" ? localItems(new RoutingRepo(db)) : [];
  },
  diff(ctx) {
    const local = new Map(localItems(new RoutingRepo(ctx.db)).map((it) => [modelsFingerprint(it), it]));
    const rows: PreviewRow[] = [];
    const seen = new Set<string>();
    for (const it of ctx.items.filter((i) => !isRetired(i))) {
      const fp = modelsFingerprint(it);
      if (seen.has(fp)) continue;
      seen.add(fp);
      const cur = local.get(fp);
      if (!cur) {
        rows.push({ fingerprint: fp, label: label(it), status: "added", diffs: [], reasons: [], localId: null });
        continue;
      }
      const diffs: PreviewDiff[] = [];
      const reasons: string[] = [];
      const a = cur as Record<string, unknown>;
      const b = it as Record<string, unknown>;
      for (const f of [...BEHAVIOUR[it.kind], ...COSMETIC[it.kind]]) {
        if (same(a[f], b[f])) continue;
        diffs.push({ field: f, local: a[f], incoming: b[f] });
        if (BEHAVIOUR[it.kind].includes(f)) reasons.push(f);
      }
      rows.push({ fingerprint: fp, label: label(it), status: reasons.length ? "conflicting" : diffs.length ? "changed" : "unchanged", diffs, reasons, localId: null });
    }
    // 只有整份的文件才删本机多出来的（产品 / 仓库 / 起步包的文件里本来就没有这一节）。
    if (isAll(ctx)) {
      for (const [fp, it] of local) if (!seen.has(fp)) rows.push({ fingerprint: fp, label: label(it), status: "removed", diffs: [], reasons: [], localId: null });
    }
    return rows;
  },
  apply(ctx) {
    const counts = emptyCounts();
    const repo = new RoutingRepo(ctx.db);
    const incoming = new Map(ctx.items.filter((i) => !isRetired(i)).map((i) => [modelsFingerprint(i), i]));
    const local = new Map(localItems(repo).map((it) => [modelsFingerprint(it), it]));
    for (const row of ctx.rows) {
      if ((row.status === "removed") !== (ctx.phase === "remove")) continue;
      if (row.status === "unchanged") {
        counts.kept++;
        continue;
      }
      if (row.status === "removed") {
        const it = local.get(row.fingerprint);
        if (ctx.mode !== "replace" || !it) continue;
        if (ctx.decide(row) === "local") {
          counts.kept++;
          continue;
        }
        remove(repo, it);
        counts.removed++;
        continue;
      }
      const it = incoming.get(row.fingerprint);
      if (!it) continue;
      if (ctx.decide(row) === "local") {
        counts.kept++;
        continue;
      }
      write(repo, it, ctx.now);
      if (row.status === "added") counts.added++;
      else counts.updated++;
    }
    return counts;
  },
};
