import { z } from "zod";
import type { Lang } from "../../shared/i18n";
import type { Lesson, LessonProductView } from "../../shared/lessons";
import type { LessonFieldsPatch, LessonsRepo } from "../db/lessons-repo";
import { materialText, type Material, type ReviewItem } from "./material";

const RuleCore = z.object({
  text: z.string(),
  why: z.string(),
  scope: z.enum(["repo", "product"]),
  product_id: z.number().int().nullable(),
  same_as: z.number().int().nullable(),
});
// 工作流 D：范围、类型和可检查性，准入流水线和预审按这些筛。
const RuleExtra = z.object({
  globs: z.array(z.string()),
  lang: z.string().nullable(),
  layer: z.string().nullable(),
  strength: z.enum(["must", "should"]),
  checkability: z.enum(["checkable", "prose"]),
  checkability_reason: z.string(),
});
const findingsOf = <R extends z.ZodType>(rule: R) =>
  z.object({
    findings: z.array(
      z.object({ comment_url: z.string().nullable(), summary: z.string(), avoidable: z.boolean(), why_missed: z.string(), rule: rule.nullable() }),
    ),
  });
export const AnalysisSchema = findingsOf(RuleCore.extend(RuleExtra.shape));
/** 存下的分析结果：3.0 以前的运行没有 D 的字段，照样能读。 */
export const StoredAnalysisSchema = findingsOf(RuleCore.extend(RuleExtra.partial().shape));
export type Analysis = z.infer<typeof AnalysisSchema>;

/** 范围、类型、可检查性的说明：分析和补填（lesson_enrich）用同一段。 */
export const ZH_FIELDS = `- rule.globs：这条规矩管哪些文件，写成 glob（比如 "src/api/**"、"**/*.sql"）。从被评论的文件路径往上归纳到规矩真正针对的目录或文件类型；对整个仓库都适用就填 []。
- rule.lang：针对的语言（如 "ts"、"py"、"sql"），不限语言填 null。rule.layer：针对的层（如 "ui"、"api"、"db"、"test"、"build"、"docs"），不限填 null。
- rule.strength：正确性、安全、丢数据这类问题填 "must"；约定、风格、可读性填 "should"。
- rule.checkability：只看改动（diff）就能用确定的检查抓到违反的（禁止的写法、import 边界、注释要求、跑一条命令）填 "checkable"，需要理解意图、靠人判断的填 "prose"；rule.checkability_reason 用一句话说明。`;
export const EN_FIELDS = `- rule.globs: which files the rule governs, as globs (for example "src/api/**", "**/*.sql"). Generalise from the commented file paths to the directory or file type the rule is really about; use [] when it applies to the whole repo.
- rule.lang: the language it targets (such as "ts", "py", "sql"), or null for any. rule.layer: the layer it targets (such as "ui", "api", "db", "test", "build", "docs"), or null for any.
- rule.strength: "must" for correctness, security and data-loss issues; "should" for conventions, style and readability.
- rule.checkability: "checkable" when a deterministic check could catch a violation from the diff alone (a forbidden pattern, an import boundary, a comment requirement, a command to run); "prose" when it needs understanding of intent or human judgement. rule.checkability_reason: one sentence on why.`;

/** existing 要带上这个仓库和它所属产品的规矩，四种状态都要，让 claude 能指出"意思一样"。 */
export function analysisPrompt(lang: Lang, slug: string, m: Material, existing: Lesson[], products: LessonProductView[]): string {
  const zh = lang === "zh";
  const lessons = existing.length
    ? existing.map((l) => `#${l.id} [${l.status}] ${l.text}${l.scopeGlobs.length ? ` (${l.scopeGlobs.join(", ")})` : ""}`).join("\n")
    : zh ? "（暂无）" : "(none)";
  const prods = products.length
    ? products.map((p) => `${p.id} ${p.name}：${p.slugs.join(", ")}`).join("\n")
    : zh ? "（这个仓库不属于任何产品）" : "(this repo belongs to no product)";
  const material = materialText(m, lang);
  if (zh) {
    return `你在复盘仓库 ${slug} 的一个 PR。找出 review 里挑出来、开发时本来能避免的问题，把它们提炼成"下次写代码时就照着做"的规矩。

要求：
- 逐条看 review 评论，每条评论对应一个 finding；comment_url 填那条评论的链接，没有就填 null。
- avoidable：开发时按常识或项目惯例本来能避免就填 true。纯属个人偏好、只和这个 PR 的需求有关、review 者自己说错了的，填 false，并且 rule 填 null。
- rule.text：写成一句可以照做的话，用中文，不提具体的 PR 号或文件名，除非这条规矩就是针对那个文件的。rule.why 用一两句说明为什么。
- 已有的规矩如果意思一样，不要新写一条：把 rule.same_as 填成它的 id。标 [rejected] 的是用户驳回过的，不要再提。意思不一样才新建（same_as 为 null）。
- rule.scope 默认 "repo"；只有这条规矩明显适用于下面某个产品里的多个仓库时，才用 "product" 并填 product_id，否则 product_id 为 null。
${ZH_FIELDS}

已有的规矩（#id [状态] 正文 (适用文件)）：
${lessons}

产品（product_id 名字：仓库）：
${prods}

PR 材料：
${material}`;
  }
  return `You are reviewing a PR of the repo ${slug}. Find the problems the review raised that could have been avoided while developing, and distill them into rules to follow the next time code is written.

Requirements:
- Go through the review comments; each one is one finding. Put the comment's link in comment_url, or null if there is none.
- avoidable: true if common sense or project convention would have avoided it. For pure personal preference, issues tied only to this PR's requirements, or cases where the reviewer was wrong, use false and set rule to null.
- rule.text: one actionable sentence, written in English, with no PR numbers or file names unless the rule is about that very file. rule.why: one or two sentences on why.
- If an existing rule means the same thing, do not write a new one: set rule.same_as to its id. Rules marked [rejected] were rejected by the user; do not raise them again. Create a new rule (same_as null) only when the meaning differs.
- rule.scope defaults to "repo"; use "product" with a product_id only when the rule clearly applies to several repos of one of the products below, otherwise product_id is null.
${EN_FIELDS}

Existing rules (#id [status] text (files it applies to)):
${lessons}

Products (product_id name: repos):
${prods}

PR material:
${material}`;
}

export interface ApplyResult { created: number; hit: number; dropped: number }

/** allowed：素材里出现过的链接（每条评论的 url 加 PR 的 url）。模型给的 comment_url 不在里面就换成 PR 的链接。 */
export interface SourceUrls { allowed: ReadonlySet<string>; prUrl: string }

/** items：这次的 review 评论，出处按链接带上 reviewer、文件、行和原文；degradedFrom：降了档跑的，原本要的模型。 */
export interface ApplyExtras { items?: readonly ReviewItem[]; degradedFrom?: string | null }

type Rule = NonNullable<Analysis["findings"][number]["rule"]>;
export const ruleFields = (r: Pick<Rule, "globs" | "lang" | "layer" | "strength" | "checkability" | "checkability_reason">) => ({
  scopeGlobs: r.globs.map((g) => g.trim()).filter(Boolean),
  scopeLang: r.lang?.trim() || null,
  scopeLayer: r.layer?.trim() || null,
  strength: r.strength,
  checkability: r.checkability,
  checkabilityReason: r.checkability_reason.trim() || null,
});

/** 命中已有的规矩：只补还空着、而且从没补过的字段，用户和流水线定过的不动。 */
export function fillEmpty(l: Lesson, f: ReturnType<typeof ruleFields>, now: number): LessonFieldsPatch | null {
  if (l.enrichedAt !== null) return null;
  const patch: LessonFieldsPatch = { enrichedAt: now };
  if (l.scopeGlobs.length === 0 && f.scopeGlobs.length > 0) patch.scopeGlobs = f.scopeGlobs;
  if (l.scopeLang === null && f.scopeLang !== null) patch.scopeLang = f.scopeLang;
  if (l.scopeLayer === null && f.scopeLayer !== null) patch.scopeLayer = f.scopeLayer;
  if (l.strength === null) patch.strength = f.strength;
  if (l.checkability === null) {
    patch.checkability = f.checkability;
    patch.checkabilityReason = f.checkabilityReason;
  }
  return patch;
}

export function applyAnalysis(
  repo: LessonsRepo, slug: string, prNumber: number, a: Analysis, now: number, urls: SourceUrls, runId: number | null, extras: ApplyExtras = {},
): ApplyResult {
  const res: ApplyResult = { created: 0, hit: 0, dropped: 0 };
  const byUrl = new Map<string, ReviewItem>();
  for (const i of extras.items ?? []) if (i.url) byUrl.set(i.url, i);
  return repo.transaction(() => {
    const productIds = new Set(repo.productsOf(slug).map((p) => p.id));
    for (const f of a.findings) {
      if (!f.avoidable || !f.rule) continue;
      const url = f.comment_url !== null && urls.allowed.has(f.comment_url) ? f.comment_url : urls.prUrl;
      const item = byUrl.get(url);
      const source = {
        prNumber, url, slug, runId,
        ...(item ? { reviewer: item.author || null, path: item.path, line: item.line, excerpt: item.body } : {}),
      };
      const fields = ruleFields(f.rule);
      const same = f.rule.same_as === null ? null : repo.resolveMerged(f.rule.same_as); // 合并过的跟到留下的那条。
      const related =
        same !== null &&
        (same.scope.kind === "repo" ? same.scope.slug === slug : productIds.has(same.scope.productId));
      if (same && related) {
        if (same.status === "rejected") res.dropped++;
        else {
          repo.hit(same.id, now, source);
          const patch = fillEmpty(same, fields, now);
          if (patch) repo.setFields(same.id, patch, now);
          res.hit++;
        }
        continue;
      }
      const toProduct = f.rule.scope === "product" && f.rule.product_id !== null && productIds.has(f.rule.product_id);
      const id = repo.addLesson({
        scope: toProduct ? { kind: "product", productId: f.rule.product_id as number } : { kind: "repo", slug },
        text: f.rule.text, why: f.rule.why, at: now, source,
      });
      const degraded = extras.degradedFrom !== undefined && extras.degradedFrom !== null;
      repo.setFields(id, { ...fields, enrichedAt: now, ...(degraded ? { degraded: true, degradedFrom: extras.degradedFrom } : {}) }, now);
      res.created++;
    }
    return res;
  });
}
