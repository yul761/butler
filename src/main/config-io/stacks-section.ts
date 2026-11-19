// 工作流 K 的导出部分（契约 4.3）：栈策略的三层覆盖（全局 / 产品 / 仓库），产品用名字。只在「全部」里，不进起步包。
// 栈本身（本地分支、PR 号）是本机状态，不导出。
import { z } from "zod";
import type { PreviewDiff, PreviewRow } from "../../shared/config-io";
import { parseStackOverrides, sanitizeStackOverrides, type StackPolicyOverrides } from "../../shared/stacks";
import type { CheckScope } from "../../shared/checks";
import { StackPolicyService } from "../stacks/stack-policy";
import { CheckLayer, fileLayer, fileSelection, inSelection, layerLabel, localScope } from "./checks-section";
import { fingerprint } from "./fingerprint";
import { emptyCounts, type ConfigSection, type SectionEnv } from "./registry";

export const StackPolicyItem = z.object({
  scope: CheckLayer,
  overrides: z.record(z.string(), z.unknown()).transform((v, c) => {
    try {
      return parseStackOverrides(v);
    } catch (e) {
      c.addIssue({ code: "custom", message: e instanceof Error ? e.message : "bad stack policy" });
      return z.NEVER;
    }
  }),
});
export type StackPolicyItem = z.infer<typeof StackPolicyItem>;

export const stackPolicyFingerprint = (scope: CheckLayer): string => fingerprint({ t: "stack_policy", scope });

/** 改本地分支的总开关：导入的值和本机不同一律算冲突，要人选（别处的文件不能悄悄打开它）。 */
const BEHAVIOUR = new Set(["autoRebase"]);

const service = (env: SectionEnv) => new StackPolicyService({ db: env.db, productsOf: () => [], productName: () => null, now: () => env.now });

const sorted = (o: StackPolicyOverrides) => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)) as [string, unknown][];

function localLayers(env: SectionEnv): { scope: CheckScope; overrides: StackPolicyOverrides }[] {
  return service(env)
    .layers()
    .map((l) => ({ scope: l.scope as CheckScope, overrides: sanitizeStackOverrides(l.overrides) }))
    .filter((l) => Object.keys(l.overrides).length > 0);
}

export const stacksSection: ConfigSection<StackPolicyItem> = {
  id: "stacks",
  order: 75,
  content: "config",
  item: StackPolicyItem as unknown as z.ZodType<StackPolicyItem>,
  export(sel, env) {
    const names = new Map(env.repo.products().map((p) => [p.id, p.name]));
    return localLayers(env).flatMap((l) => {
      if (!inSelection(l.scope, sel)) return [];
      const layer = fileLayer(l.scope, names);
      return layer ? [{ scope: layer, overrides: Object.fromEntries(sorted(l.overrides)) as StackPolicyOverrides }] : [];
    });
  },
  diff(ctx) {
    const svc = service(ctx);
    const rows: PreviewRow[] = [];
    const seen = new Set<string>();
    for (const it of ctx.items) {
      const fp = stackPolicyFingerprint(it.scope);
      if (seen.has(fp)) continue;
      seen.add(fp);
      const scope = localScope(it.scope, ctx);
      const local = scope ? svc.overrides(scope) : {};
      const diffs: PreviewDiff[] = [];
      const reasons: string[] = [];
      for (const [k, v] of sorted(it.overrides)) {
        const lv = (local as Record<string, unknown>)[k];
        if (lv === v) continue;
        diffs.push({ field: k, local: lv ?? null, incoming: v });
        if (lv !== undefined || BEHAVIOUR.has(k)) reasons.push(k);
      }
      const status: PreviewRow["status"] = reasons.length ? "conflicting" : diffs.length ? (Object.keys(local).length ? "changed" : "added") : "unchanged";
      rows.push({ fingerprint: fp, label: layerLabel(it.scope), status, diffs, reasons, localId: scope ? svc.rowId(scope) : null });
    }
    const sel = fileSelection(ctx.fileScope, ctx);
    if (sel) {
      const names = new Map(ctx.repo.products().map((p) => [p.id, p.name]));
      for (const l of localLayers(ctx)) {
        if (!inSelection(l.scope, sel)) continue;
        const layer = fileLayer(l.scope, names);
        if (!layer) continue;
        const fp = stackPolicyFingerprint(layer);
        if (!seen.has(fp)) rows.push({ fingerprint: fp, label: layerLabel(layer), status: "removed", diffs: [], reasons: [], localId: svc.rowId(l.scope) });
      }
    }
    return rows;
  },
  apply(ctx) {
    const counts = emptyCounts();
    const svc = service(ctx);
    const items = new Map(ctx.items.map((i) => [stackPolicyFingerprint(i.scope), i]));
    for (const row of ctx.rows) {
      if ((row.status === "removed") !== (ctx.phase === "remove")) continue;
      if (row.status === "removed") {
        if (ctx.mode !== "replace" || row.localId === null) continue;
        if (ctx.decide(row) === "local") {
          counts.kept++;
          continue;
        }
        ctx.batch.track("stack_policy", row.localId);
        ctx.db.prepare(`DELETE FROM stack_policies WHERE id = ?`).run(row.localId);
        counts.removed++;
        continue;
      }
      const it = items.get(row.fingerprint);
      if (!it || row.status === "unchanged") {
        if (row.status === "unchanged") counts.kept++;
        continue;
      }
      if (ctx.decide(row) === "local") {
        counts.kept++;
        continue;
      }
      const scope = localScope(it.scope, ctx);
      if (!scope) {
        counts.skipped++;
        continue;
      }
      const before = svc.rowId(scope);
      if (before !== null) ctx.batch.track("stack_policy", before);
      // 替换：这一层变成文件里的样子；合并：本地的键留着，文件里的覆盖上去。
      svc.setLayer(scope, ctx.mode === "replace" ? it.overrides : { ...svc.overrides(scope), ...it.overrides }, ctx.now);
      const after = svc.rowId(scope);
      if (before === null && after !== null) ctx.batch.created("stack_policy", after);
      if (row.status === "added") counts.added++;
      else counts.updated++;
    }
    return counts;
  },
};
