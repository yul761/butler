import { z } from "zod";
import type { Lesson, LessonStatus } from "../../shared/lessons";
import { LESSON_ADMISSIONS, LESSON_CHECKABILITIES, LESSON_STATUSES, LESSON_STRENGTHS } from "../../shared/lessons";
import { parsePolicyOverrides, type AdmissionPolicyOverrides, type PolicyValue } from "../../shared/admission-policy";
import type { FileScope, PreviewDiff, PreviewRow } from "../../shared/config-io";
import type { ScopeRef } from "../scope/layered";
import { lessonFingerprint, policyFingerprint, productFingerprint, type LessonOwner, type PolicyLayerRef } from "./fingerprint";
import { removeLessonTracked } from "../lessons/lesson-batches";
import { emptyCounts, type ConfigSection, type DiffContext, type ExportSelection, type SectionEnv } from "./registry";

const LESSON_TEXT_LIMIT = 2000;
const NAME = z.string().trim().min(1).max(200);
const SLUG = z.string().regex(/^[^\s/]+\/[^\s/]+$/).max(300);
const TIME = z.number().int().nonnegative();

// ---------------------------------------------------------------- products

export const ProductItem = z.object({
  name: NAME,
  repos: z.array(SLUG).max(500),
});
export type ProductItem = z.infer<typeof ProductItem>;

const sortedSlugs = (s: readonly string[]) => [...new Set(s)].sort();

export const productsSection: ConfigSection<ProductItem> = {
  id: "products",
  order: 10,
  content: "lessons",
  item: ProductItem,
  export(sel, { repo }) {
    if (sel.kind === "repo") return [];
    const ps = sel.kind === "all" ? repo.products() : repo.products().filter((p) => p.id === sel.productId);
    return ps.map((p) => ({ name: p.name, repos: sortedSlugs(p.slugs) }));
  },
  diff({ items, repo, fileScope }) {
    const local = new Map(repo.products().map((p) => [p.name, p]));
    const seen = new Set<string>();
    const rows: PreviewRow[] = [];
    for (const it of items) {
      if (seen.has(it.name)) continue;
      seen.add(it.name);
      const l = local.get(it.name);
      const fp = productFingerprint(it.name);
      if (!l) {
        rows.push({ fingerprint: fp, label: it.name, status: "added", diffs: [], reasons: [], localId: null });
        continue;
      }
      const a = sortedSlugs(l.slugs);
      const b = sortedSlugs(it.repos);
      const same = a.length === b.length && a.every((x, i) => x === b[i]);
      rows.push({
        fingerprint: fp, label: it.name, status: same ? "unchanged" : "conflicting",
        diffs: same ? [] : [{ field: "repos", local: a, incoming: b }], reasons: same ? [] : ["repos"], localId: l.id,
      });
    }
    if (fileScope.kind === "all") {
      for (const l of local.values()) {
        if (!seen.has(l.name)) rows.push({ fingerprint: productFingerprint(l.name), label: l.name, status: "removed", diffs: [], reasons: [], localId: l.id });
      }
    }
    return rows;
  },
  apply(ctx) {
    const { items, rows, repo, batch, decide, mode, now, policies } = ctx;
    const counts = emptyCounts();
    const byName = new Map(items.map((i) => [i.name, i]));
    for (const row of rows) {
      if ((row.status === "removed") !== (ctx.phase === "remove")) continue;
      const it = byName.get(row.label);
      if (row.status === "added" && it) {
        if (decide(row) === "local") {
          counts.kept++;
          continue;
        }
        for (const s of it.repos) repo.ensureRepo(s, now);
        const id = repo.createProduct(it.name, sortedSlugs(it.repos), now);
        batch.created("product", id);
        counts.added++;
      } else if ((row.status === "conflicting" || row.status === "changed") && it && row.localId !== null) {
        if (decide(row) === "local") {
          counts.kept++;
          continue;
        }
        batch.track("product", row.localId);
        const current = repo.product(row.localId)?.slugs ?? [];
        for (const s of current) if (!it.repos.includes(s)) repo.removeFromProduct(row.localId, s);
        for (const s of it.repos) {
          repo.ensureRepo(s, now);
          repo.addToProduct(row.localId, s);
        }
        counts.updated++;
      } else if (row.status === "removed" && mode === "replace" && row.localId !== null) {
        if (decide(row) === "local") {
          counts.kept++;
          continue;
        }
        // 删产品会连带删掉它（剩下）的规矩和策略层：先都记下来，撤销时一起回来（倒序：先产品，后规矩）。
        for (const l of repo.lessons({ scope: { kind: "product", productId: row.localId }, includeMerged: true })) batch.track("lesson", l.id);
        const layer = policies.rowId({ kind: "product", productId: row.localId });
        if (layer !== null) batch.track("policy", layer);
        batch.track("product", row.localId);
        repo.deleteProduct(row.localId);
        if (layer !== null) policies.bumpVersion();
        counts.removed++;
      } else if (row.status === "unchanged") {
        counts.kept++;
      }
    }
    return counts;
  },
};

// ---------------------------------------------------------------- lessons

const Owner = z.union([z.object({ repo: SLUG }).strict(), z.object({ product: NAME }).strict()]);
const SourceItem = z.object({
  prNumber: z.number().int().positive(),
  url: z.string().max(1000).regex(/^https:\/\//).nullable(),
  repo: SLUG.nullable(),
  at: TIME,
});
export const LessonItem = z.object({
  text: z.string().trim().min(1).max(LESSON_TEXT_LIMIT),
  why: z.string().max(4000).default(""),
  owner: Owner.nullable(),
  status: z.enum(LESSON_STATUSES as [LessonStatus, ...LessonStatus[]]).optional(),
  admission: z.enum(LESSON_ADMISSIONS as [string, ...string[]]).optional(),
  scopeGlobs: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  scopeLang: z.string().max(50).nullable().default(null),
  scopeLayer: z.string().max(100).nullable().default(null),
  strength: z.enum(LESSON_STRENGTHS as ["must", "should"]).nullable().default(null),
  checkability: z.enum(LESSON_CHECKABILITIES as ["checkable", "prose", "converted", "covered"]).nullable().default(null),
  hits: z.number().int().min(1).max(1_000_000).optional(),
  sourceCount: z.number().int().nonnegative().optional(),
  prCount: z.number().int().nonnegative().optional(),
  firstSeenAt: TIME.optional(),
  lastSeenAt: TIME.optional(),
  sources: z.array(SourceItem).max(1000).optional(),
});
export type LessonItem = z.infer<typeof LessonItem>;

/** 语义冲突检测（D 提供）：给文件里的规矩和本地规矩，返回哪些文件里的规矩和哪条本地规矩说的是互相矛盾的事。 */
export type LessonConflictDetector = (
  incoming: { fingerprint: string; text: string; owner: LessonOwner }[],
  local: { id: number; text: string; owner: LessonOwner }[],
) => Promise<{ fingerprint: string; localId: number; reason: string }[]>;

function ownerOf(l: Lesson, productName: (id: number) => string | null): LessonOwner | null {
  if (l.scope.kind === "repo") return { repo: l.scope.slug };
  const n = productName(l.scope.productId);
  return n === null ? null : { product: n };
}

/** 在本机这一份里，文件范围覆盖的规矩（替换模式会删掉其中文件没有的）。 */
function inFileScope(owner: LessonOwner, scope: FileScope, productRepos: Map<string, Set<string>>): boolean {
  switch (scope.kind) {
    case "all":
      return true;
    case "starter":
      return false;
    case "repo":
      return "repo" in owner && owner.repo === scope.slug;
    case "product":
      return "product" in owner ? owner.product === scope.name : (productRepos.get(scope.name)?.has(owner.repo) ?? false);
  }
}

interface LocalLesson { lesson: Lesson; owner: LessonOwner; fp: string }

function localLessons(env: SectionEnv): LocalLesson[] {
  const names = new Map(env.repo.products().map((p) => [p.id, p.name]));
  const out: LocalLesson[] = [];
  for (const l of env.repo.lessons()) {
    const owner = ownerOf(l, (id) => names.get(id) ?? null);
    if (owner) out.push({ lesson: l, owner, fp: lessonFingerprint(l.text, owner, l.scopeGlobs) });
  }
  return out;
}

/** 文件里一条规矩的归属：起步包绑定到目标；普通文件用它自己写的。 */
const boundOwner = (it: LessonItem, ctx: DiffContext<LessonItem>): LessonOwner | null => (ctx.bound ?? it.owner ?? null);

export function lessonRowsKey(it: LessonItem, ctx: DiffContext<LessonItem>): string | null {
  const o = boundOwner(it, ctx);
  return o ? lessonFingerprint(it.text, o, it.scopeGlobs) : null;
}

const sourceKey = (s: { prNumber: number; url: string | null }) => `${s.prNumber} ${s.url ?? ""}`;

export const lessonsSection: ConfigSection<LessonItem> = {
  id: "lessons",
  order: 30,
  content: "lessons",
  item: LessonItem,
  inStarter: true,
  export(sel: ExportSelection, ctx) {
    const names = new Map(ctx.repo.products().map((p) => [p.id, p.name]));
    const all = ctx.repo.lessons();
    const pick = all.filter((l) => {
      if (sel.kind === "all") return true;
      if (sel.kind === "repo") return l.scope.kind === "repo" && l.scope.slug === sel.slug;
      return l.scope.kind === "product" ? l.scope.productId === sel.productId : sel.slugs.includes(l.scope.slug);
    });
    if (ctx.starter) {
      // 起步包：只要已确认的，不带归属、状态、hits 和出处；同一句话（不同仓库里各有一条）只留一条。
      const seen = new Set<string>();
      const out: LessonItem[] = [];
      for (const l of pick.filter((x) => x.status === "confirmed")) {
        const key = lessonFingerprint(l.text, { repo: "-/-" }, l.scopeGlobs);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          text: l.text, why: l.why, owner: null, scopeGlobs: l.scopeGlobs, scopeLang: l.scopeLang, scopeLayer: l.scopeLayer,
          strength: l.strength, checkability: l.checkability,
        });
      }
      return out;
    }
    return pick.flatMap((l): LessonItem[] => {
      const owner = ownerOf(l, (id) => names.get(id) ?? null);
      if (!owner) return [];
      const prs = new Set(l.sources.map((s) => `${s.slug ?? ""}#${s.prNumber}`));
      const item: LessonItem = {
        text: l.text, why: l.why, owner, status: l.status, admission: l.admission, scopeGlobs: l.scopeGlobs, scopeLang: l.scopeLang,
        scopeLayer: l.scopeLayer, strength: l.strength, checkability: l.checkability, hits: Math.max(1, l.hits), sourceCount: l.sources.length,
        prCount: prs.size, firstSeenAt: l.createdAt, lastSeenAt: l.lastSeenAt,
      };
      if (ctx.options.includeSourceUrls) {
        item.sources = l.sources.filter((s) => s.url === null || /^https:\/\//.test(s.url)).map((s) => ({ prNumber: s.prNumber, url: s.url, repo: s.slug, at: s.at }));
      }
      return [item];
    });
  },
  diff(ctx) {
    const local = localLessons(ctx);
    const byFp = new Map<string, LocalLesson>();
    for (const l of local) if (!byFp.has(l.fp)) byFp.set(l.fp, l);
    // 文件范围是一个产品时，它覆盖的仓库只按文件里的成员算：本机这个产品多出来的仓库文件根本没导出，
    // 不能因为文件里没有它们的规矩就在替换时删掉。
    const productRepos = new Map<string, Set<string>>();
    for (const raw of ctx.doc.products ?? []) {
      const p = ProductItem.safeParse(raw);
      if (p.success) for (const s of p.data.repos) (productRepos.get(p.data.name) ?? productRepos.set(p.data.name, new Set()).get(p.data.name)!).add(s);
    }
    const rows: PreviewRow[] = [];
    const seen = new Set<string>();
    for (const it of ctx.items) {
      const fp = lessonRowsKey(it, ctx);
      if (fp === null || seen.has(fp)) continue;
      seen.add(fp);
      const l = byFp.get(fp)?.lesson;
      if (!l) {
        rows.push({ fingerprint: fp, label: it.text, status: "added", diffs: [], reasons: [], localId: null });
        continue;
      }
      const decisions: PreviewDiff[] = [];
      if (it.status !== undefined && it.status !== l.status) decisions.push({ field: "status", local: l.status, incoming: it.status });
      if (it.strength !== null && l.strength !== null && it.strength !== l.strength) decisions.push({ field: "strength", local: l.strength, incoming: it.strength });
      if (it.checkability !== null && l.checkability !== null && it.checkability !== l.checkability) decisions.push({ field: "checkability", local: l.checkability, incoming: it.checkability });
      const other: PreviewDiff[] = [];
      if (it.why !== l.why) other.push({ field: "why", local: l.why, incoming: it.why });
      if (it.hits !== undefined && it.hits > l.hits) other.push({ field: "hits", local: l.hits, incoming: it.hits });
      for (const f of ["scopeLang", "scopeLayer", "strength", "checkability"] as const) {
        if (it[f] !== null && l[f] === null) other.push({ field: f, local: null, incoming: it[f] });
      }
      if (it.sources) {
        const have = new Set(l.sources.map(sourceKey));
        const extra = it.sources.filter((s) => !have.has(sourceKey(s))).length;
        if (extra > 0) other.push({ field: "sources", local: l.sources.length, incoming: l.sources.length + extra });
      }
      const status = decisions.length ? "conflicting" : other.length ? "changed" : "unchanged";
      rows.push({ fingerprint: fp, label: it.text, status, diffs: [...decisions, ...other], reasons: decisions.map((d) => d.field), localId: l.id });
    }
    for (const l of local) {
      if (!seen.has(l.fp) && inFileScope(l.owner, ctx.fileScope, productRepos)) {
        rows.push({ fingerprint: l.fp, label: l.lesson.text, status: "removed", diffs: [], reasons: [], localId: l.lesson.id });
      }
    }
    return rows;
  },
  apply(ctx) {
    const { repo, batch, now } = ctx;
    const counts = emptyCounts();
    const items = new Map<string, LessonItem>();
    for (const it of ctx.items) {
      const fp = lessonRowsKey(it, ctx);
      if (fp !== null && !items.has(fp)) items.set(fp, it);
    }
    const productIds = new Map(repo.products().map((p) => [p.name, p.id]));
    const scopeFor = (o: LessonOwner): Lesson["scope"] => {
      if ("repo" in o) {
        repo.ensureRepo(o.repo, now);
        return { kind: "repo", slug: o.repo };
      }
      let id = productIds.get(o.product);
      if (id === undefined) {
        id = repo.createProduct(o.product, [], now);
        batch.created("product", id);
        productIds.set(o.product, id);
      }
      return { kind: "product", productId: id };
    };
    const sources = (it: LessonItem) => (it.sources ?? []).map((s) => ({ prNumber: s.prNumber, url: s.url, slug: s.repo, at: s.at }));
    for (const row of ctx.rows) {
      if ((row.status === "removed") !== (ctx.phase === "remove")) continue;
      const it = items.get(row.fingerprint);
      // 和本地某条语义冲突的新规矩（localId 为空，relatedId 指向那条）：选「用导入的」就照样加进来待确认，本地那条不动。
      if ((row.status === "added" || (row.status === "conflicting" && row.localId === null)) && it) {
        if (ctx.decide(row) === "local") {
          counts.kept++;
          continue;
        }
        const owner = boundOwner(it, ctx);
        if (!owner) {
          counts.skipped++;
          continue;
        }
        // 导入的规矩先待确认；文件里拒绝了的照样拒绝（拒绝不会让任何东西进 session）。
        const rejected = it.status === "rejected" && ctx.bound === null;
        const id = repo.importLesson({
          scope: scopeFor(owner), text: it.text, why: it.why, status: rejected ? "rejected" : "pending", admission: rejected ? "manual" : "pending",
          hits: ctx.bound ? 1 : (it.hits ?? 1), lastSeenAt: it.lastSeenAt ?? now, createdAt: it.firstSeenAt ?? now, now,
          scopeGlobs: it.scopeGlobs, scopeLang: it.scopeLang, scopeLayer: it.scopeLayer, strength: it.strength, checkability: it.checkability,
          sources: sources(it),
        });
        batch.created("lesson", id);
        counts.added++;
      } else if ((row.status === "changed" || row.status === "conflicting") && it && row.localId !== null) {
        if (ctx.decide(row) === "local") {
          counts.kept++;
          continue;
        }
        batch.track("lesson", row.localId);
        const statusChange = row.status === "conflicting" && it.status !== undefined && row.diffs.some((d) => d.field === "status");
        repo.updateImported(row.localId, {
          why: it.why, hits: it.hits ?? 1, lastSeenAt: it.lastSeenAt ?? 0, sources: sources(it), status: statusChange ? it.status : undefined,
          fields: {
            ...(it.strength !== null ? { strength: it.strength } : {}),
            ...(it.checkability !== null ? { checkability: it.checkability } : {}),
            ...(it.scopeLang !== null ? { scopeLang: it.scopeLang } : {}),
            ...(it.scopeLayer !== null ? { scopeLayer: it.scopeLayer } : {}),
            ...(statusChange ? { admission: "manual" as const } : {}),
          },
        }, now);
        counts.updated++;
      } else if (row.status === "removed" && ctx.mode === "replace" && row.localId !== null) {
        if (ctx.decide(row) === "local") {
          counts.kept++;
          continue;
        }
        removeLessonTracked(batch, repo, row.localId);
        counts.removed++;
      } else if (row.status === "unchanged") {
        counts.kept++;
      }
    }
    return counts;
  },
};

// ---------------------------------------------------------------- policies

const LayerRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("product"), name: NAME }),
  z.object({ kind: z.literal("repo"), slug: SLUG }),
]);
export const PolicyItem = z.object({
  layer: LayerRef,
  overrides: z.record(z.string(), z.unknown()).transform((v, c) => {
    try {
      return parsePolicyOverrides(v);
    } catch (e) {
      c.addIssue({ code: "custom", message: e instanceof Error ? e.message : "bad policy" });
      return z.NEVER;
    }
  }),
});
export type PolicyItem = z.infer<typeof PolicyItem>;

const layerLabel = (l: PolicyLayerRef) => (l.kind === "global" ? "global" : l.kind === "product" ? l.name : l.slug);


function localRef(l: PolicyLayerRef, env: SectionEnv): ScopeRef | null {
  if (l.kind === "global") return { kind: "global" };
  if (l.kind === "repo") return { kind: "repo", slug: l.slug };
  const p = env.repo.products().find((x) => x.name === l.name);
  return p ? { kind: "product", productId: p.id } : null;
}

const sortedEntries = (o: AdmissionPolicyOverrides) => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)) as [string, PolicyValue][];

export const policiesSection: ConfigSection<PolicyItem> = {
  id: "policies",
  order: 20,
  content: "config",
  item: PolicyItem,
  export(sel, { repo, policies }) {
    const names = new Map(repo.products().map((p) => [p.id, p.name]));
    return policies.allLayers().flatMap(({ ref, overrides }): PolicyItem[] => {
      if (Object.keys(overrides).length === 0) return [];
      let layer: PolicyLayerRef;
      if (ref.kind === "global") layer = { kind: "global" };
      else if (ref.kind === "repo") layer = { kind: "repo", slug: ref.slug };
      else {
        const n = names.get(ref.productId);
        if (!n) return [];
        layer = { kind: "product", name: n };
      }
      const keep =
        sel.kind === "all" ||
        (sel.kind === "repo" && ref.kind === "repo" && ref.slug === sel.slug) ||
        (sel.kind === "product" && ((ref.kind === "product" && ref.productId === sel.productId) || (ref.kind === "repo" && sel.slugs.includes(ref.slug))));
      return keep ? [{ layer, overrides }] : [];
    });
  },
  diff(ctx) {
    const rows: PreviewRow[] = [];
    const seen = new Set<string>();
    for (const it of ctx.items) {
      const fp = policyFingerprint(it.layer);
      if (seen.has(fp)) continue;
      seen.add(fp);
      const ref = localRef(it.layer, ctx);
      const local = ref ? ctx.policies.overrides(ref) : {};
      const id = ref ? ctx.policies.rowId(ref) : null;
      const diffs: PreviewDiff[] = [];
      const reasons: string[] = [];
      for (const [k, v] of sortedEntries(it.overrides)) {
        const lv = (local as Record<string, PolicyValue | undefined>)[k];
        if (lv === undefined) diffs.push({ field: k, local: null, incoming: v });
        else if (lv !== v) {
          diffs.push({ field: k, local: lv, incoming: v });
          reasons.push(k);
        }
      }
      // 本地这一层还没有任何覆盖：整层是新加的；有键取值不同：冲突；只多了本地没有的键：改动。
      const status: PreviewRow["status"] =
        Object.keys(local).length === 0 ? (diffs.length ? "added" : "unchanged") : reasons.length ? "conflicting" : diffs.length ? "changed" : "unchanged";
      rows.push({ fingerprint: fp, label: layerLabel(it.layer), status, diffs, reasons, localId: id });
    }
    if (ctx.fileScope.kind === "all") {
      const names = new Map(ctx.repo.products().map((p) => [p.id, p.name]));
      for (const { ref, overrides } of ctx.policies.allLayers()) {
        if (Object.keys(overrides).length === 0) continue;
        const layer: PolicyLayerRef | null = ref.kind === "global" ? { kind: "global" } : ref.kind === "repo" ? { kind: "repo", slug: ref.slug } : names.has(ref.productId) ? { kind: "product", name: names.get(ref.productId)! } : null;
        if (!layer) continue;
        const fp = policyFingerprint(layer);
        if (!seen.has(fp)) rows.push({ fingerprint: fp, label: layerLabel(layer), status: "removed", diffs: [], reasons: [], localId: ctx.policies.rowId(ref) });
      }
    }
    return rows;
  },
  apply(ctx) {
    const counts = emptyCounts();
    const items = new Map(ctx.items.map((i) => [policyFingerprint(i.layer), i]));
    let touched = false;
    for (const row of ctx.rows) {
      if ((row.status === "removed") !== (ctx.phase === "remove")) continue;
      const it = items.get(row.fingerprint);
      if (row.status === "removed") {
        if (ctx.mode === "replace" && row.localId !== null && ctx.decide(row) === "local") counts.kept++;
        else if (ctx.mode === "replace" && row.localId !== null) {
          ctx.batch.track("policy", row.localId);
          ctx.db.prepare(`UPDATE admission_policies SET overrides = '{}', updated_at = ? WHERE id = ?`).run(ctx.now, row.localId);
          counts.removed++;
          touched = true;
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
      const local = ctx.policies.overrides(ref);
      // 替换：这一层变成文件里的样子；合并：本地的键留着，文件里的覆盖上去。
      const next = ctx.mode === "replace" ? it.overrides : { ...local, ...it.overrides };
      ctx.policies.write(ctx.batch, ref, next, ctx.now);
      if (row.status === "added") counts.added++;
      else counts.updated++;
      touched = true;
    }
    if (touched) ctx.policies.bumpVersion();
    return counts;
  },
};

