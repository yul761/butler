import { existsSync } from "node:fs";
import { z } from "zod";
import type { Lang } from "../../shared/i18n";
import type { Lesson, LessonScope } from "../../shared/lessons";
import type { BatchRecorder } from "../batches/batch-recorder";
import type { LessonRunsRepo } from "../db/lesson-runs-repo";
import type { LessonsRepo, SourceDetails, SourceWithExcerpt } from "../db/lessons-repo";
import { LESSON_GH_TIMEOUT_MS, type prLessonDataDetail } from "../tickets/gh";
import { callModel, chunks, inputHash, type AdmissionRunner, type CallOutcome } from "./admission/call";
import { JudgmentCache } from "./admission/judgments";
import { EN_FIELDS, ZH_FIELDS, fillEmpty, ruleFields } from "./analyze";
import { reviewItems } from "./material";

/** 一次补填最多这么多条规矩；每条最多带这么多条出处评论。 */
export const ENRICH_CHUNK = 10;
export const ENRICH_SOURCES = 5;
const EXCERPT_IN_PROMPT = 600;

export const EnrichSchema = z.object({
  enriched: z.array(
    z.object({
      id: z.number().int(),
      globs: z.array(z.string()),
      lang: z.string().nullable(),
      layer: z.string().nullable(),
      strength: z.enum(["must", "should"]),
      checkability: z.enum(["checkable", "prose"]),
      checkability_reason: z.string(),
    }),
  ),
});
type EnrichItem = z.infer<typeof EnrichSchema>["enriched"][number];

export interface EnricherDeps {
  repo: LessonsRepo;
  runs: LessonRunsRepo;
  recorder: BatchRecorder;
  judgments: JudgmentCache;
  run: AdmissionRunner;
  /** 拉 PR 的评论补出处；没有或 gh 不可用时只用分析运行里存下的摘要。 */
  gh?: { prLessonDataDetail: typeof prLessonDataDetail; available: () => boolean };
  lang: () => Lang;
  now: () => number;
  fallbackCwd: () => string;
  log?: (msg: string, e?: unknown) => void;
}

export interface EnrichResult { enriched: number[]; missing: number[]; batchId: number | null; calls: number }

const scopeKey = (s: LessonScope): string => (s.kind === "repo" ? `repo:${s.slug}` : `product:${s.productId}`);
const sameScope = (a: LessonScope, b: LessonScope): boolean => scopeKey(a) === scopeKey(b);

/** 一条规矩补填看的内容：变了就重新补。 */
const enrichInput = (l: Lesson) => ({ text: l.text, why: l.why, scope: scopeKey(l.scope) });

/**
 * 老规矩的补填（lesson_enrich）：按规矩的正文、出处评论和文件路径补范围、类型、强度和可检查性。
 * 不重新分析 PR；只填空着的字段；写入是一个自动批次（可撤销），出处的评论细节也在这一批里补上。
 */
export class LessonEnricher {
  private job: Promise<unknown> | null = null;

  constructor(private readonly d: EnricherDeps) {}

  /** 后台补完范围里所有还没补的（规矩页的「补填范围」）；已经在补就不再开一个。done 在结束时调用。 */
  start(scopes: readonly LessonScope[] | undefined, done: () => void): boolean {
    if (this.job) return false;
    this.job = this.enrichAll(scopes)
      .catch((e: unknown) => this.d.log?.("lessons: enrich failed", e))
      .finally(() => {
        this.job = null;
        done();
      });
    return true;
  }

  running(): boolean {
    return this.job !== null;
  }

  /** 还没补过的规矩（已驳回、已合并的不算）。 */
  needing(scopes?: readonly LessonScope[]): Lesson[] {
    return this.d.repo
      .lessons({ status: ["pending", "confirmed", "disabled"] })
      .filter((l) => l.enrichedAt === null && (!scopes || scopes.some((s) => sameScope(s, l.scope))));
  }

  /** 补一批（最多 ENRICH_CHUNK 条）。缓存里有、输入没变的直接用，不调模型。 */
  async enrich(ids: readonly number[], onCall?: () => void): Promise<CallOutcome<EnrichResult>> {
    const lessons = this.d.repo.lessons({ ids: [...ids] }).filter((l) => l.enrichedAt === null);
    if (lessons.length === 0) return { ok: true, value: { enriched: [], missing: [], batchId: null, calls: 0 }, model: null, degraded: false, sameModelReview: false };
    const details = await this.sourceDetails(lessons);
    const now = this.d.now();
    const results = new Map<number, EnrichItem>();
    const todo: Lesson[] = [];
    for (const l of lessons) {
      const hit = this.d.judgments.get<EnrichItem>("enrich", String(l.id), inputHash(enrichInput(l)));
      if (hit) results.set(l.id, hit.result);
      else todo.push(l);
    }
    let calls = 0;
    let route: { model: string | null; degraded: boolean } = { model: null, degraded: false };
    if (todo.length > 0) {
      const r = await callModel(
        this.d.run,
        { task: "lesson_enrich", label: "lesson enrich", schema: EnrichSchema, prompt: this.prompt(todo, details), cwd: this.d.fallbackCwd() },
        () => {
          calls++;
          onCall?.();
        },
      );
      if (!r.ok) {
        // 出处细节先存下（下次不用再拉 gh）。
        this.write(lessons, details, new Map(), now);
        return r;
      }
      route = { model: r.model, degraded: r.degraded };
      const wanted = new Set(todo.map((l) => l.id));
      for (const item of r.value.enriched) {
        if (!wanted.has(item.id)) continue;
        results.set(item.id, item);
        const l = todo.find((x) => x.id === item.id)!;
        this.d.judgments.put("enrich", String(l.id), inputHash(enrichInput(l)), item, { ...route, at: now });
      }
    }
    const batchId = this.write(lessons, details, results, now);
    return {
      ok: true,
      value: { enriched: lessons.filter((l) => results.has(l.id)).map((l) => l.id), missing: lessons.filter((l) => !results.has(l.id)).map((l) => l.id), batchId, calls },
      model: route.model, degraded: route.degraded, sameModelReview: false,
    };
  }

  /** 把范围里所有还没补的都补完（按块，失败的块留着下次）。 */
  async enrichAll(scopes?: readonly LessonScope[], onCall?: () => void): Promise<{ enriched: number; failed: number; calls: number }> {
    let enriched = 0;
    let failed = 0;
    let calls = 0;
    for (const part of chunks(this.needing(scopes).map((l) => l.id), ENRICH_CHUNK)) {
      const r = await this.enrich(part, () => {
        calls++;
        onCall?.();
      });
      if (r.ok) {
        enriched += r.value.enriched.length;
        failed += r.value.missing.length;
      } else failed += part.length;
    }
    return { enriched, failed, calls };
  }

  /** 一批的写入：出处细节和字段，一个自动批次。什么都没变时不留批次。 */
  private write(lessons: Lesson[], details: Map<number, SourceDetails>, results: Map<number, EnrichItem>, now: number): number | null {
    const { outcome } = this.d.recorder.run(
      { kind: "lesson_enrich", origin: "auto", entity: "lesson", scope: { ids: lessons.length }, summary: { enriched: results.size }, now },
      (ctx) => {
        for (const l of lessons) {
          const own = this.d.repo.sourcesWithExcerpt(l.id).filter((s) => details.has(s.id));
          const item = results.get(l.id);
          if (own.length === 0 && !item) continue;
          ctx.track("lesson", l.id);
          for (const s of own) this.d.repo.fillSource(s.id, details.get(s.id)!);
          if (item) {
            const patch = fillEmpty(l, ruleFields(item), now);
            if (patch) this.d.repo.setFields(l.id, patch, now);
          }
        }
      },
    );
    return outcome.batchId;
  }

  /** 出处缺评论细节的：先按 PR 拉一次 gh（本机有克隆时），拉不到的用分析运行里存下的摘要。 */
  private async sourceDetails(lessons: Lesson[]): Promise<Map<number, SourceDetails>> {
    const out = new Map<number, SourceDetails>();
    const byPr = new Map<string, { slug: string; pr: number; sources: SourceWithExcerpt[] }>();
    for (const l of lessons) {
      for (const s of this.d.repo.sourcesWithExcerpt(l.id)) {
        if (s.excerpt !== null && s.reviewer !== null) continue;
        const slug = s.slug ?? (l.scope.kind === "repo" ? l.scope.slug : null);
        if (slug === null) continue;
        const k = `${slug}#${s.prNumber}`;
        const g = byPr.get(k) ?? { slug, pr: s.prNumber, sources: [] };
        g.sources.push(s);
        byPr.set(k, g);
      }
    }
    for (const g of byPr.values()) {
      const local = this.d.repo.repo(g.slug)?.localPath;
      let filled = false;
      if (this.d.gh?.available() && local && existsSync(local)) {
        try {
          const got = await this.d.gh.prLessonDataDetail(local, g.pr, LESSON_GH_TIMEOUT_MS);
          if (got.data) {
            const items = new Map(reviewItems(got.data).flatMap((i) => (i.url ? [[i.url, i] as const] : [])));
            for (const s of g.sources) {
              const i = s.url ? items.get(s.url) : undefined;
              if (i) out.set(s.id, { reviewer: i.author || null, path: i.path, line: i.line, excerpt: i.body });
            }
            filled = true;
          }
        } catch (e) {
          this.d.log?.(`lessons: enrich could not fetch ${g.slug}#${g.pr}`, e);
        }
      }
      for (const s of g.sources) {
        if (out.has(s.id) || (filled && s.excerpt !== null)) continue;
        const summary = this.findingSummary(g.slug, g.pr, s);
        if (summary) out.set(s.id, { excerpt: summary });
      }
    }
    return out;
  }

  /** 分析运行里存下的这条评论的摘要（按评论链接对）。 */
  private findingSummary(slug: string, pr: number, s: SourceWithExcerpt): string | null {
    if (s.url === null || s.excerpt !== null) return null;
    const runs = s.runId !== null ? [this.d.runs.get(s.runId)].filter((r) => r !== null) : this.d.runs.forPr(slug, pr);
    for (const r of runs) {
      if (!Array.isArray(r.findings)) continue;
      for (const f of r.findings as { comment_url?: unknown; summary?: unknown }[]) {
        if (f && f.comment_url === s.url && typeof f.summary === "string" && f.summary.trim()) return f.summary.trim();
      }
    }
    return null;
  }

  private prompt(lessons: Lesson[], details: Map<number, SourceDetails>): string {
    const zh = this.d.lang() === "zh";
    const blocks = lessons.map((l) => {
      const scope = l.scope.kind === "repo" ? l.scope.slug : (this.d.repo.product(l.scope.productId)?.name ?? `#${l.scope.productId}`);
      const sources = this.d.repo.sourcesWithExcerpt(l.id).slice(-ENRICH_SOURCES).map((s) => {
        const d = { ...s, ...Object.fromEntries(Object.entries(details.get(s.id) ?? {}).filter(([, v]) => v !== null && v !== undefined)) } as SourceWithExcerpt;
        const where = d.path ? `${d.path}${d.line ? `:${d.line}` : ""}` : zh ? "（不在具体文件上）" : "(not on a file)";
        const who = d.reviewer ?? (zh ? "未知" : "unknown");
        const body = (d.excerpt ?? (zh ? "（评论原文找不到了）" : "(comment text unavailable)")).replace(/\s+/g, " ").slice(0, EXCERPT_IN_PROMPT);
        return `  - PR ${d.prNumber} · ${who} · ${where}: ${body}`;
      });
      return `#${l.id} [${scope}] ${l.text}\n  ${zh ? "为什么" : "why"}: ${l.why}\n${sources.join("\n") || (zh ? "  （没有出处评论）" : "  (no source comments)")}`;
    });
    const fields = (zh ? ZH_FIELDS : EN_FIELDS).replace(/rule\./g, "");
    if (zh) {
      return `下面是从 code review 里提炼出来的规矩，每条带着它的出处评论（PR、评论人、文件和行、评论原文）。给每条规矩补上范围、类型、强度和可检查性，enriched 里每条规矩一项，id 用规矩的编号。

${fields}

规矩：
${blocks.join("\n\n")}`;
    }
    return `Below are rules distilled from code review, each with its source comments (PR, reviewer, file and line, comment text). Fill in the scope, kind, strength and checkability of every rule: one entry in enriched per rule, with the rule's number as id.

${fields}

Rules:
${blocks.join("\n\n")}`;
  }
}
