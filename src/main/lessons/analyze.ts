import { z } from "zod";
import type { Lang } from "../../shared/i18n";
import type { Lesson, LessonProductView } from "../../shared/lessons";
import type { LessonsRepo } from "../db/lessons-repo";
import { materialText, type Material } from "./material";

export const AnalysisSchema = z.object({
  findings: z.array(
    z.object({
      comment_url: z.string().nullable(),
      summary: z.string(),
      avoidable: z.boolean(),
      why_missed: z.string(),
      rule: z
        .object({
          text: z.string(),
          why: z.string(),
          scope: z.enum(["repo", "product"]),
          product_id: z.number().int().nullable(),
          same_as: z.number().int().nullable(),
        })
        .nullable(),
    }),
  ),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

/** existing 要带上这个仓库和它所属产品的规矩，四种状态都要，让 claude 能指出"意思一样"。 */
export function analysisPrompt(lang: Lang, slug: string, m: Material, existing: Lesson[], products: LessonProductView[]): string {
  const zh = lang === "zh";
  const lessons = existing.length
    ? existing.map((l) => `#${l.id} [${l.status}] ${l.text}`).join("\n")
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

已有的规矩（#id [状态] 正文）：
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

Existing rules (#id [status] text):
${lessons}

Products (product_id name: repos):
${prods}

PR material:
${material}`;
}

export interface ApplyResult { created: number; hit: number; dropped: number }

export function applyAnalysis(repo: LessonsRepo, slug: string, prNumber: number, a: Analysis, now: number): ApplyResult {
  const res: ApplyResult = { created: 0, hit: 0, dropped: 0 };
  return repo.transaction(() => {
    const productIds = new Set(repo.productsOf(slug).map((p) => p.id));
    for (const f of a.findings) {
      if (!f.avoidable || !f.rule) continue;
      const source = { prNumber, url: f.comment_url };
      const same = f.rule.same_as === null ? null : repo.get(f.rule.same_as);
      const related =
        same !== null &&
        (same.scope.kind === "repo" ? same.scope.slug === slug : productIds.has(same.scope.productId));
      if (same && related) {
        if (same.status === "rejected") res.dropped++;
        else {
          repo.hit(same.id, now, source);
          res.hit++;
        }
        continue;
      }
      const toProduct = f.rule.scope === "product" && f.rule.product_id !== null && productIds.has(f.rule.product_id);
      repo.addLesson({
        scope: toProduct ? { kind: "product", productId: f.rule.product_id as number } : { kind: "repo", slug },
        text: f.rule.text, why: f.rule.why, at: now, source,
      });
      res.created++;
    }
    return res;
  });
}
