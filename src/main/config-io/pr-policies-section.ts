import { z } from "zod";
import { parsePrOverrides, type PrPolicyOverrides, type PrValue } from "../../shared/pr-policy";
import type { PreviewDiff, PreviewRow } from "../../shared/config-io";
import type { ScopeRef } from "../scope/layered";
import { PrPolicies } from "../assess/policies";
import { fingerprint, type PolicyLayerRef } from "./fingerprint";
import { emptyCounts, type ConfigSection, type SectionEnv } from "./registry";

/**
 * 导出 / 导入（契约 4.3）里就绪度、证据、风险策略的一节 `prPolicies`（工作流 G，设计 §6）：每一层的覆盖。
 * 只在「全部」导出里（content: "config"）。不在批次撤销（4.4）的适配器里：替换之前框架写的备份是回退手段（和 models 一样）。
 */

const NAME = z.string().trim().min(1).max(200);
const SLUG = z.string().regex(/^[^\s/]+\/[^\s/]+$/).max(300);
const LayerRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("product"), name: NAME }),
  z.object({ kind: z.literal("repo"), slug: SLUG }),
]);

export const PrPolicyItem = z.object({
  layer: LayerRef,
  overrides: z.record(z.string(), z.unknown()).transform((v, c) => {
    try {
      return parsePrOverrides(v);
    } catch (e) {
      c.addIssue({ code: "custom", message: e instanceof Error ? e.message : "bad policy" });
      return z.NEVER;
    }
  }),
});
export type PrPolicyItem = z.infer<typeof PrPolicyItem>;

export const prPolicyFingerprint = (layer: PolicyLayerRef): string => fingerprint({ t: "pr_policy", layer });
const layerLabel = (l: PolicyLayerRef) => (l.kind === "global" ? "global" : l.kind === "product" ? l.name : l.slug);
const same = (a: PrValue | undefined, b: PrValue): boolean => JSON.stringify(a) === JSON.stringify(b);
const sortedEntries = (o: PrPolicyOverrides) => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)) as [string, PrValue][];

function policies(env: SectionEnv): PrPolicies {
  return new PrPolicies({ db: env.db, products: { productsOf: (s) => env.repo.productsOf(s), product: (id) => env.repo.product(id) }, now: () => env.now });
}

function localRef(l: PolicyLayerRef, env: SectionEnv): ScopeRef | null {
  if (l.kind === "global") return { kind: "global" };
  if (l.kind === "repo") return { kind: "repo", slug: l.slug };
  const p = env.repo.products().find((x) => x.name === l.name);
  return p ? { kind: "product", productId: p.id } : null;
}

function toLayer(ref: ScopeRef, names: Map<number, string>): PolicyLayerRef | null {
  if (ref.kind === "global") return { kind: "global" };
  if (ref.kind === "repo") return { kind: "repo", slug: ref.slug };
  const n = names.get(ref.productId);
  return n ? { kind: "product", name: n } : null;
}

function rowId(env: SectionEnv, ref: ScopeRef): number | null {
  const [w, args]: [string, (string | number)[]] =
    ref.kind === "global" ? [`scope_kind = 'global'`, []] : ref.kind === "product" ? [`scope_kind = 'product' AND product_id = ?`, [ref.productId]] : [`scope_kind = 'repo' AND repo_slug = ?`, [ref.slug]];
  const r = env.db.prepare(`SELECT id FROM pr_policies WHERE ${w}`).get(...args) as { id: number } | undefined;
  return r?.id ?? null;
}

export const prPoliciesSection: ConfigSection<PrPolicyItem> = {
  id: "prPolicies",
  order: 25,
  content: "config",
  item: PrPolicyItem,
  export(sel, env) {
    const names = new Map(env.repo.products().map((p) => [p.id, p.name]));
    return policies(env).allLayers().flatMap(({ ref, overrides }): PrPolicyItem[] => {
      if (Object.keys(overrides).length === 0) return [];
      const layer = toLayer(ref, names);
      if (!layer) return [];
      const keep =
        sel.kind === "all" ||
        (sel.kind === "repo" && ref.kind === "repo" && ref.slug === sel.slug) ||
        (sel.kind === "product" && ((ref.kind === "product" && ref.productId === sel.productId) || (ref.kind === "repo" && sel.slugs.includes(ref.slug))));
      return keep ? [{ layer, overrides }] : [];
    });
  },
  diff(ctx) {
    const pol = policies(ctx);
    const rows: PreviewRow[] = [];
    const seen = new Set<string>();
    for (const it of ctx.items) {
      const fp = prPolicyFingerprint(it.layer);
      if (seen.has(fp)) continue;
      seen.add(fp);
      const ref = localRef(it.layer, ctx);
      const local = ref ? pol.overrides(ref) : {};
      const diffs: PreviewDiff[] = [];
      const reasons: string[] = [];
      for (const [k, v] of sortedEntries(it.overrides)) {
        const lv = (local as Record<string, PrValue | undefined>)[k];
        if (lv === undefined) diffs.push({ field: k, local: null, incoming: v });
        else if (!same(lv, v)) {
          diffs.push({ field: k, local: lv, incoming: v });
          reasons.push(k);
        }
      }
      const status: PreviewRow["status"] =
        Object.keys(local).length === 0 ? (diffs.length ? "added" : "unchanged") : reasons.length ? "conflicting" : diffs.length ? "changed" : "unchanged";
      rows.push({ fingerprint: fp, label: `pr policy · ${layerLabel(it.layer)}`, status, diffs, reasons, localId: ref ? rowId(ctx, ref) : null });
    }
    if (ctx.fileScope.kind === "all") {
      const names = new Map(ctx.repo.products().map((p) => [p.id, p.name]));
      for (const { ref, overrides } of pol.allLayers()) {
        if (Object.keys(overrides).length === 0) continue;
        const layer = toLayer(ref, names);
        if (!layer) continue;
        const fp = prPolicyFingerprint(layer);
        if (!seen.has(fp)) rows.push({ fingerprint: fp, label: `pr policy · ${layerLabel(layer)}`, status: "removed", diffs: [], reasons: [], localId: rowId(ctx, ref) });
      }
    }
    return rows;
  },
  apply(ctx) {
    const pol = policies(ctx);
    const counts = emptyCounts();
    const items = new Map(ctx.items.map((i) => [prPolicyFingerprint(i.layer), i]));
    for (const row of ctx.rows) {
      if ((row.status === "removed") !== (ctx.phase === "remove")) continue;
      const it = items.get(row.fingerprint);
      if (row.status === "removed") {
        if (ctx.mode === "replace" && row.localId !== null && ctx.decide(row) === "local") counts.kept++;
        else if (ctx.mode === "replace" && row.localId !== null) {
          ctx.db.prepare(`UPDATE pr_policies SET overrides = '{}', updated_at = ? WHERE id = ?`).run(ctx.now, row.localId);
          counts.removed++;
        }
        continue;
      }
      if (!it || row.status === "unchanged") {
        if (row.status === "unchanged") counts.kept++;
        continue;
      }
      if (ctx.decide(row) === "local") {
        counts.kept++;
        continue;
      }
      const ref = localRef(it.layer, ctx);
      if (!ref) {
        counts.skipped++;
        continue;
      }
      const next = ctx.mode === "replace" ? it.overrides : { ...pol.overrides(ref), ...it.overrides };
      pol.setLayer(ref, next);
      if (row.status === "added") counts.added++;
      else counts.updated++;
    }
    return counts;
  },
};
