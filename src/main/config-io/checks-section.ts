import { z } from "zod";
import { ChecksRepo } from "../db/checks-repo";
import { fingerprint } from "./fingerprint";
import { emptyCounts, type ConfigSection, type ExportSelection, type SectionEnv } from "./registry";
import { CHECK_MODES, CHECK_SEVERITIES, CHECK_TYPES, normalizeCheckSlug, validateCheckInput, type CheckInput, type CheckRow, type CheckScope } from "../../shared/checks";
import type { FileScope, PreviewDiff, PreviewRow } from "../../shared/config-io";

const NAME = z.string().trim().min(1).max(200);
const SLUG = z.string().max(300).transform((s, c) => {
  const v = normalizeCheckSlug(s);
  if (v === null) {
    c.addIssue({ code: "custom", message: "invalid repo slug" });
    return z.NEVER;
  }
  return v;
});

/** 文件里的层：产品用名字（两台机器上 id 不同），仓库用 slug。 */
const CheckLayer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("product"), name: NAME }),
  z.object({ kind: z.literal("repo"), slug: SLUG }),
]);
type CheckLayer = z.infer<typeof CheckLayer>;

/** 一条检查（addendum 第 9 节）。字段再用 validateCheckInput 校验一遍：正则编不过、命令为空的进不来。 */
export const CheckItem = z
  .object({
    key: z.string().regex(/^[A-Za-z0-9_:.-]{1,80}$/),
    scope: CheckLayer,
    type: z.enum(CHECK_TYPES),
    name: z.string().max(200),
    params: z.record(z.string(), z.unknown()),
    globs: z.array(z.string().max(500)).max(50),
    excludeGlobs: z.array(z.string().max(500)).max(50),
    severity: z.enum(CHECK_SEVERITIES),
    mode: z.enum(CHECK_MODES),
    enabled: z.boolean(),
    message: z.string().max(4000),
  })
  .transform((v, c) => {
    const r = validateCheckInput(v);
    if (!r.ok) {
      c.addIssue({ code: "custom", message: r.error });
      return z.NEVER;
    }
    return { key: v.key, scope: v.scope, ...r.value };
  });
export type CheckItem = z.infer<typeof CheckItem>;

export const checkFingerprint = (key: string, scope: CheckLayer): string => fingerprint({ t: "check", key, scope });

const layerLabel = (l: CheckLayer) => (l.kind === "global" ? "global" : l.kind === "product" ? l.name : l.slug);

function localScope(l: CheckLayer, env: SectionEnv): CheckScope | null {
  if (l.kind === "global") return { kind: "global" };
  if (l.kind === "repo") return { kind: "repo", slug: l.slug };
  const p = env.repo.products().find((x) => x.name === l.name);
  return p ? { kind: "product", productId: p.id } : null;
}

function fileLayer(s: CheckScope, names: Map<number, string>): CheckLayer | null {
  if (s.kind === "global") return { kind: "global" };
  if (s.kind === "repo") return { kind: "repo", slug: s.slug };
  const n = names.get(s.productId);
  return n ? { kind: "product", name: n } : null;
}

/** 行为上的字段不同：冲突（要选用哪边）；只有名字 / 提示语不同：改动。模式不比：导入的一律进试运行（addendum 第 9 节）。 */
const BEHAVIOUR = ["type", "params", "globs", "excludeGlobs", "severity", "enabled"] as const;
const COSMETIC = ["name", "message"] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 一个范围包含哪些层：产品带上它的仓库（和导出的范围一样）。ExportSelection 也是这个形状。 */
type Selection = { kind: "all" } | { kind: "repo"; slug: string } | { kind: "product"; productId: number; slugs: string[] };

function inSelection(s: CheckScope, sel: Selection | ExportSelection): boolean {
  if (sel.kind === "all") return true;
  if (sel.kind === "repo") return s.kind === "repo" && s.slug === sel.slug;
  return (s.kind === "product" && s.productId === sel.productId) || (s.kind === "repo" && sel.slugs.includes(s.slug));
}

/** 文件的范围在本机对应哪些行（替换模式下文件里没有的就删）。起步包不删。 */
function fileSelection(fs: FileScope, env: SectionEnv): Selection | null {
  if (fs.kind === "all") return { kind: "all" };
  if (fs.kind === "repo") return { kind: "repo", slug: fs.slug };
  if (fs.kind === "product") {
    const p = env.repo.products().find((x) => x.name === fs.name);
    return p ? { kind: "product", productId: p.id, slugs: p.slugs } : null;
  }
  return null;
}

const toItem = (r: CheckRow, layer: CheckLayer): CheckItem => ({
  key: r.key, scope: layer, type: r.type, name: r.name, params: r.params, globs: r.globs, excludeGlobs: r.excludeGlobs,
  severity: r.severity, mode: r.mode, enabled: r.enabled, message: r.message,
});

const inputOf = (it: CheckItem, mode: CheckInput["mode"], enabled = it.enabled): CheckInput => ({
  type: it.type, name: it.name, params: it.params, globs: it.globs, excludeGlobs: it.excludeGlobs, severity: it.severity, mode, enabled, message: it.message,
});

const commandOf = (c: { type: string; params: Record<string, unknown> }): string | null => (c.type === "run_command" && typeof c.params.command === "string" ? c.params.command : null);

/**
 * 导入的命令检查执行的是别处写的 shell 命令，试运行也照样执行：新来的、命令文字变了的一律先关掉，看过再打开（审查发现）。
 * 命令没变（只改了 glob、严重程度之类）的照文件。
 */
const commandNeedsReview = (it: CheckItem, local: CheckRow | null): boolean => {
  const cmd = commandOf(it);
  return cmd !== null && (local === null || commandOf(local) !== cmd);
};

/** 预览里的标签：命令检查带上命令本身，导入前就能看到要执行什么。 */
const labelOf = (c: { type: string; name: string; params: Record<string, unknown> }, layer: CheckLayer): string => {
  const cmd = commandOf(c);
  return `${c.name || c.type} · ${layerLabel(layer)}${cmd === null ? "" : ` · $ ${cmd.length > 200 ? `${cmd.slice(0, 200)}…` : cmd}`}`;
};

/** 内置的检查是种子数据：替换导入也不删，只能改。 */
const isBuiltin = (key: string) => key.startsWith("builtin:");

export const checksSection: ConfigSection<CheckItem> = {
  id: "checks",
  order: 40,
  content: "checks",
  item: CheckItem as unknown as z.ZodType<CheckItem>,
  export(sel, { db, repo }) {
    const names = new Map(repo.products().map((p) => [p.id, p.name]));
    return new ChecksRepo(db).all().flatMap((r) => {
      if (!inSelection(r.scope, sel)) return [];
      const layer = fileLayer(r.scope, names);
      return layer ? [toItem(r, layer)] : [];
    });
  },
  diff(ctx) {
    const checks = new ChecksRepo(ctx.db);
    const rows: PreviewRow[] = [];
    const seen = new Set<string>();
    for (const it of ctx.items) {
      const fp = checkFingerprint(it.key, it.scope);
      if (seen.has(fp)) continue;
      seen.add(fp);
      const scope = localScope(it.scope, ctx);
      const local = scope ? checks.byKey(scope, it.key) : null;
      const label = labelOf(it, it.scope);
      if (!local) {
        rows.push({ fingerprint: fp, label, status: "added", diffs: [], reasons: [], localId: null });
        continue;
      }
      const diffs: PreviewDiff[] = [];
      const reasons: string[] = [];
      for (const f of [...BEHAVIOUR, ...COSMETIC]) {
        if (same(local[f], it[f])) continue;
        diffs.push({ field: f, local: local[f], incoming: it[f] });
        if ((BEHAVIOUR as readonly string[]).includes(f)) reasons.push(f);
      }
      const status: PreviewRow["status"] = reasons.length ? "conflicting" : diffs.length ? "changed" : "unchanged";
      rows.push({ fingerprint: fp, label, status, diffs, reasons, localId: local.id });
    }
    const sel = fileSelection(ctx.fileScope, ctx);
    if (sel) {
      const names = new Map(ctx.repo.products().map((p) => [p.id, p.name]));
      for (const r of checks.all()) {
        if (!inSelection(r.scope, sel)) continue;
        const layer = fileLayer(r.scope, names);
        if (!layer) continue;
        const fp = checkFingerprint(r.key, layer);
        if (!seen.has(fp)) rows.push({ fingerprint: fp, label: labelOf(r, layer), status: "removed", diffs: [], reasons: [], localId: r.id });
      }
    }
    return rows;
  },
  apply(ctx) {
    const counts = emptyCounts();
    const checks = new ChecksRepo(ctx.db);
    const items = new Map(ctx.items.map((i) => [checkFingerprint(i.key, i.scope), i]));
    for (const row of ctx.rows) {
      if ((row.status === "removed") !== (ctx.phase === "remove")) continue;
      if (row.status === "removed") {
        const local = row.localId === null ? null : checks.get(row.localId);
        if (ctx.mode !== "replace" || !local) continue;
        if (isBuiltin(local.key) || ctx.decide(row) === "local") {
          counts.kept++;
          continue;
        }
        ctx.batch.track("check", local.id);
        checks.remove(local.id);
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
      // 产品那一节先跑（order 10），文件里新建的产品这时已经在了；还是找不到就跳过。
      const scope = localScope(it.scope, ctx);
      if (!scope) {
        counts.skipped++;
        continue;
      }
      const local = checks.byKey(scope, it.key);
      if (!local) {
        // 新的检查一律进试运行：别处验证过的，在这台机器上也要先证明自己。
        const id = checks.insert(scope, it.key, inputOf(it, "shadow", commandNeedsReview(it, null) ? false : it.enabled), { lessonId: null, now: ctx.now });
        ctx.batch.created("check", id);
        counts.added++;
        continue;
      }
      ctx.batch.track("check", local.id);
      // 行为变了：回到试运行；只改了名字 / 提示语：模式照旧。
      checks.update(local.id, inputOf(it, row.status === "conflicting" ? "shadow" : local.mode, commandNeedsReview(it, local) ? false : it.enabled), ctx.now);
      counts.updated++;
    }
    return counts;
  },
};
