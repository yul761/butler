// 工作流 E2 的两个导出部分（契约 4.3，设计 §10）：
// - baseline_rules：标记文件表的用户层（全局 / 产品 / 仓库），产品用名字；随「全部」和「只导出检查」一起走。
// - baselines：各仓库最近一次的现状扫描，要勾选「带上仓库现状」才导出；不带本地路径、输入文件哈希和导出记录，
//   教训（pitfalls）也不带（那是规矩的文字）。导入的记为 imported、标为过期，本机第一次扫描就把它换掉。
import { z } from "zod";
import { BaselinesRepo } from "../db/baselines-repo";
import { BUILTIN_RULES, validateRule } from "../baselines/rules";
import { BASELINE_CATEGORIES, REPO_STAGES, type RepoBaseline } from "../../shared/baselines";
import type { CheckScope } from "../../shared/checks";
import type { PreviewDiff, PreviewRow } from "../../shared/config-io";
import { fingerprint } from "./fingerprint";
import { emptyCounts, type ConfigSection, type ExportSelection } from "./registry";
import { CheckLayer, fileLayer, fileSelection, inSelection, layerLabel, localScope } from "./checks-section";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- 标记文件表

export const BaselineRuleItem = z.object({
  key: z.string().min(1).max(60),
  scope: CheckLayer,
  /** 这一层存的字段（覆盖内置规则时只有要改的那几个）。 */
  rule: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
});
export type BaselineRuleItem = z.infer<typeof BaselineRuleItem>;

export const baselineRuleFingerprint = (key: string, scope: CheckLayer): string => fingerprint({ t: "baseline_rule", key, scope });

const BUILTIN = new Map(BUILTIN_RULES.map((r) => [r.key, r]));

/** 和内置规则（有的话）合起来是一条有效规则才收；停用的行不用是完整规则。 */
function ruleValid(it: BaselineRuleItem): boolean {
  if (!it.enabled) return true;
  const base = BUILTIN.get(it.key);
  return !("error" in validateRule({ ...(base ?? {}), ...it.rule, key: it.key }));
}

const parseRule = (raw: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export const baselineRulesSection: ConfigSection<BaselineRuleItem> = {
  id: "baseline_rules",
  order: 45,
  content: ["config", "checks"],
  item: BaselineRuleItem,
  export(sel, { db, repo }) {
    const names = new Map(repo.products().map((p) => [p.id, p.name]));
    return new BaselinesRepo(db).allRules().flatMap((r) => {
      if (!inSelection(r.scope, sel)) return [];
      const layer = fileLayer(r.scope, names);
      return layer ? [{ key: r.key, scope: layer, rule: parseRule(r.rule), enabled: r.enabled }] : [];
    });
  },
  diff(ctx) {
    const repo = new BaselinesRepo(ctx.db);
    const rows: PreviewRow[] = [];
    const seen = new Set<string>();
    for (const it of ctx.items) {
      const fp = baselineRuleFingerprint(it.key, it.scope);
      if (seen.has(fp) || !ruleValid(it)) continue;
      seen.add(fp);
      const label = `${it.key} · ${layerLabel(it.scope)}`;
      const scope = localScope(it.scope, ctx);
      const local = scope ? repo.rulesInLayer(scope).find((r) => r.key === it.key) : undefined;
      if (!local) {
        rows.push({ fingerprint: fp, label, status: "added", diffs: [], reasons: [], localId: null });
        continue;
      }
      const diffs: PreviewDiff[] = [];
      const rule = parseRule(local.rule);
      if (!same(rule, it.rule)) diffs.push({ field: "rule", local: rule, incoming: it.rule });
      if (local.enabled !== it.enabled) diffs.push({ field: "enabled", local: local.enabled, incoming: it.enabled });
      // 规则是数据，不碰 agent 的行为：不同就是「改动」，不算冲突。
      rows.push({ fingerprint: fp, label, status: diffs.length ? "changed" : "unchanged", diffs, reasons: [], localId: scope ? repo.ruleId(scope, it.key) : null });
    }
    const sel = fileSelection(ctx.fileScope, ctx);
    if (sel) {
      const names = new Map(ctx.repo.products().map((p) => [p.id, p.name]));
      for (const r of repo.allRules()) {
        if (!inSelection(r.scope, sel)) continue;
        const layer = fileLayer(r.scope, names);
        if (!layer) continue;
        const fp = baselineRuleFingerprint(r.key, layer);
        if (!seen.has(fp)) rows.push({ fingerprint: fp, label: `${r.key} · ${layerLabel(layer)}`, status: "removed", diffs: [], reasons: [], localId: repo.ruleId(r.scope, r.key) });
      }
    }
    return rows;
  },
  apply(ctx) {
    const counts = emptyCounts();
    const repo = new BaselinesRepo(ctx.db);
    const items = new Map(ctx.items.map((i) => [baselineRuleFingerprint(i.key, i.scope), i]));
    if (ctx.phase === "upsert") counts.skipped += ctx.items.filter((i) => !ruleValid(i)).length;
    for (const row of ctx.rows) {
      if ((row.status === "removed") !== (ctx.phase === "remove")) continue;
      if (row.status === "removed") {
        if (ctx.mode !== "replace" || row.localId === null) continue;
        if (ctx.decide(row) === "local") {
          counts.kept++;
          continue;
        }
        const r = ctx.db.prepare("SELECT id FROM baseline_rules WHERE id = ?").get(row.localId);
        if (!r) continue;
        ctx.batch.track("baseline_rule", row.localId);
        ctx.db.prepare("DELETE FROM baseline_rules WHERE id = ?").run(row.localId);
        counts.removed++;
        continue;
      }
      const it = items.get(row.fingerprint);
      if (!it || row.status === "unchanged" || ctx.decide(row) === "local") {
        if (row.status === "unchanged" || (it && ctx.decide(row) === "local")) counts.kept++;
        continue;
      }
      const scope: CheckScope | null = localScope(it.scope, ctx);
      if (!scope) {
        counts.skipped++;
        continue;
      }
      const before = repo.ruleId(scope, it.key);
      if (before !== null) ctx.batch.track("baseline_rule", before);
      repo.upsertRule(scope, it.key, JSON.stringify(it.rule), it.enabled, ctx.now);
      if (before === null) {
        ctx.batch.created("baseline_rule", repo.ruleId(scope, it.key)!);
        counts.added++;
      } else counts.updated++;
    }
    return counts;
  },
};

// ---------------------------------------------------------------- 仓库现状

const STR = z.string().max(1000);
const DIR = z.string().max(500).refine((d) => !/^([a-zA-Z]:)?[\\/]/.test(d) && !d.split("/").includes(".."), "relative dir");
const CMD = z.string().max(1000).nullable();
const CATEGORY = z.enum(BASELINE_CATEGORIES);

const ProjectItem = z.object({ dir: DIR, langs: z.array(z.string().max(40)).max(20), markers: z.array(z.string().max(60)).max(60), pm: z.string().max(30).optional() });
const CheckItemSchema = z.object({
  id: z.string().max(700), dir: DIR, category: CATEGORY, tool: z.string().max(60), command: STR, fileCommand: STR.optional(), testOne: STR.optional(),
  stages: z.array(z.enum(REPO_STAGES)).max(3), changedFiles: z.boolean(), butlerStage: z.enum(["edit", "push"]),
  source: z.enum(["marker", "ci", "inferred"]), confidence: z.enum(["high", "medium", "low"]),
  evidence: z.array(STR).max(30), facts: z.array(z.string().max(200)).max(500), exts: z.array(z.string().max(10)).max(30).optional(),
});
const ProfileProjectItem = z.object({
  dir: DIR, langs: z.array(z.string().max(40)).max(20), install: CMD, build: CMD, testAll: CMD, testOne: CMD, fastest: CMD, lint: CMD, typecheck: CMD,
  inferred: z.array(z.string().max(30)).max(10),
});

export const BaselineItem = z.object({
  slug: z.string().regex(/^[^\s/]+\/[^\s/]+$/).max(300),
  scannedAt: z.number().int().nonnegative(),
  status: z.enum(["ok", "partial"]),
  projects: z.array(ProjectItem).max(500),
  checks: z.array(CheckItemSchema).max(2000),
  advice: z.array(z.object({ dir: DIR, missing: z.array(CATEGORY).max(6) })).max(500),
  profile: z.object({
    projects: z.array(ProfileProjectItem).max(500),
    dirs: z.array(STR).max(50),
    ci: z.array(z.object({ category: z.union([CATEGORY, z.literal("other")]), command: STR, dir: DIR })).max(200),
  }),
  inferred: z.enum(["none", "ran", "failed", "skipped_off"]),
});
export type BaselineItem = z.infer<typeof BaselineItem>;

export const baselineFingerprint = (slug: string): string => fingerprint({ t: "baseline", slug });

const slugsOf = (sel: ExportSelection, repo: BaselinesRepo): string[] =>
  sel.kind === "all" ? repo.slugs() : sel.kind === "repo" ? [sel.slug] : [...new Set(sel.slugs)].sort();

export function baselineItem(b: RepoBaseline): BaselineItem {
  return {
    slug: b.slug, scannedAt: b.scannedAt, status: b.status === "partial" ? "partial" : "ok", projects: b.projects, checks: b.checks, advice: b.advice,
    profile: { projects: b.profile.projects, dirs: b.profile.dirs, ci: b.profile.ci }, inferred: b.inferred,
  };
}

export const baselinesSection: ConfigSection<BaselineItem> = {
  id: "baselines",
  order: 90,
  content: ["config", "checks"],
  item: BaselineItem,
  include: (o) => o.includeBaselines === true,
  export(sel, { db }) {
    const repo = new BaselinesRepo(db);
    return slugsOf(sel, repo).flatMap((slug) => {
      const b = repo.latestUsable(slug);
      return b ? [baselineItem(b)] : [];
    });
  },
  diff(ctx) {
    const repo = new BaselinesRepo(ctx.db);
    const rows: PreviewRow[] = [];
    const seen = new Set<string>();
    for (const it of ctx.items) {
      const fp = baselineFingerprint(it.slug);
      if (seen.has(fp)) continue;
      seen.add(fp);
      const local = repo.latestUsable(it.slug);
      const label = `${it.slug} · ${new Date(it.scannedAt).toISOString().slice(0, 10)}`;
      if (!local) rows.push({ fingerprint: fp, label, status: "added", diffs: [], reasons: [], localId: null });
      else if (it.scannedAt > local.scannedAt) {
        rows.push({ fingerprint: fp, label, status: "changed", diffs: [{ field: "scannedAt", local: local.scannedAt, incoming: it.scannedAt }], reasons: [], localId: local.id });
      } else rows.push({ fingerprint: fp, label, status: "unchanged", diffs: [], reasons: [], localId: local.id });
    }
    // 扫描结果不删：替换导入也不会因为文件里没有就删掉本机的扫描。
    return rows;
  },
  apply(ctx) {
    const counts = emptyCounts();
    if (ctx.phase !== "upsert") return counts;
    const repo = new BaselinesRepo(ctx.db);
    const items = new Map(ctx.items.map((i) => [baselineFingerprint(i.slug), i]));
    for (const row of ctx.rows) {
      const it = items.get(row.fingerprint);
      if (!it) continue;
      if (row.status === "unchanged" || ctx.decide(row) === "local") {
        counts.kept++;
        continue;
      }
      const id = repo.insert({
        slug: it.slug, scannedAt: it.scannedAt, status: it.status, skipReason: null, detail: null, origin: "imported",
        projects: it.projects, checks: it.checks, advice: it.advice, profile: { ...it.profile, pitfalls: [] },
        inputs: [], listingHash: "", staleAt: ctx.now, inferred: it.inferred, inferDetail: null, durationMs: 0,
      });
      ctx.batch.created("baseline", id);
      if (row.status === "added") counts.added++;
      else counts.updated++;
    }
    return counts;
  },
};
