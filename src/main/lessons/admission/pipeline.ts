import type { AdmissionPolicy } from "../../../shared/admission-policy";
import type { BatchOrigin } from "../../../shared/batches";
import type { Lang } from "../../../shared/i18n";
import type { AdmissionScope, AdmissionVerdictKind } from "../../../shared/lesson-admission";
import type { Lesson, LessonCheckability, LessonScope } from "../../../shared/lessons";
import { TIERS, type Tier } from "../../../shared/model-routing";
import type { BatchRecorder } from "../../batches/batch-recorder";
import type { ChecksService } from "../../checks/checks-service";
import type { CheckDrafter } from "../../checks/draft";
import type { LessonRunsRepo } from "../../db/lesson-runs-repo";
import type { LessonFieldsPatch, LessonsRepo } from "../../db/lessons-repo";
import type { Candidate } from "../../routing/router";
import type { ScopeRef } from "../../scope/layered";
import { M } from "../../strings";
import type { AdmissionPolicyService } from "../admission-policies";
import type { AdmissionRunner } from "./call";
import type { JudgmentCache } from "./judgments";
import {
  OPEN_GATE, readCanon, readClarity, readClassify, readConflict, readDraft, readSame, runClarity, runClassify, runCluster, runConflicts, runDrafts, runSample,
  type ItemGate, type StepCtx, type StepLesson,
} from "./model-steps";
import { clarityPart, consistencyPart, evidencePart, scoreLesson, type ScoreResult } from "./score";
import { globsOverlap, textSimilarity, tokens, UnionFind } from "./similarity";

/**
 * 规矩准入流水线（addendum 第 4、5 节）：候选规矩过四道闸门（去重、冲突、普遍性、可检查性），再打分、落线。
 * judge() 不改结构：只写一个「计划」批次（每条候选的 admission / 搁置原因 / 分数），合并和提到产品层留给接受（accept.ts）。
 */

export type { AdmissionScope };
export type VerdictKind = AdmissionVerdictKind;

export interface LessonVerdict {
  lessonId: number;
  verdict: VerdictKind;
  /** 搁置原因（shelved / merged / covered 时）。 */
  reason: string | null;
  ref: number | null;
  note: string | null;
  score: number | null;
  /** 推荐的规矩是可检查的、草稿已经准备好（接受时写成影子检查）。 */
  check: boolean;
  /** 合并进来以后要提到哪个产品层（接受时做）。 */
  promoteTo: number | null;
}

/** 仓库现有的检查覆盖（E2 的仓库基线接在这里；D 默认只看这条规矩有没有启用的检查）。 */
export interface CoverageProvider {
  coveredBy(q: { scope: LessonScope; text: string; scopeGlobs: string[] }): { label: string; strength: "strong" | "weak" }[];
  /** 给分类提示词用的仓库现有检查摘要。 */
  describeForPrompt?(slugs: string[], maxChars: number): string | null;
}

export interface PipelineDeps {
  repo: LessonsRepo;
  recorder: BatchRecorder;
  policies: Pick<AdmissionPolicyService, "resolve" | "version">;
  judgments: JudgmentCache;
  runs: Pick<LessonRunsRepo, "get">;
  checks: Pick<ChecksService, "repo">;
  drafter: Pick<CheckDrafter, "generate">;
  run: AdmissionRunner;
  lang: () => Lang;
  now: () => number;
  fallbackCwd: () => string;
  coverage?: CoverageProvider | null;
}

export interface JudgeOptions {
  gate?: ItemGate;
  onCall?: () => void;
  origin?: BatchOrigin;
  /** 只判这几条（改了分类之后重判一条用）；其余的只当参照。 */
  only?: number[];
  /** 跳过闸门 1、2（重判一条时，它们不依赖分类）。 */
  skipDedupe?: boolean;
  /** 批次的 kind（默认 admission_plan）。 */
  kind?: string;
  /** 写计划之前再问一次：返回 false 就不写（向导在判的时候被取消、接受了）。 */
  live?: () => boolean;
}

export interface JudgeResult {
  planBatch: number | null;
  candidates: number;
  verdicts: LessonVerdict[];
  /** 抽查要看的：被推荐的规矩（按合并后的样子）和产出它们的模型。 */
  admitted: StepLesson[];
  producer: Candidate | null;
  ctx: StepCtx;
}

const BASELINE_PROMPT_CHARS = 4000;
const CANDIDATE_ADMISSIONS = new Set(["pending", "auto", "shelved"]);
export const isCandidate = (l: Lesson): boolean => l.status === "pending" && CANDIDATE_ADMISSIONS.has(l.admission);

interface Bucket {
  ref: ScopeRef;
  /** 产品桶：组跨仓库时提到这个产品。 */
  productId: number | null;
  lessons: Lesson[];
}

/** 合并后的样子（闸门 2 到 4 按它判）。 */
interface Group {
  keeper: Lesson;
  members: Lesson[];
  text: string;
  promoteTo: number | null;
}

export class AdmissionPipeline {
  constructor(private readonly d: PipelineDeps) {}

  // ------------------------------------------------------------------ 范围和桶

  private reposOf(l: Lesson): string[] {
    return l.scope.kind === "repo" ? [l.scope.slug] : (this.d.repo.product(l.scope.productId)?.slugs ?? []);
  }

  private applies(a: Lesson, b: Lesson): boolean {
    const x = new Set(this.reposOf(a));
    return this.reposOf(b).some((s) => x.has(s));
  }

  scopeLabel(l: Lesson): string {
    return l.scope.kind === "repo" ? l.scope.slug : (this.d.repo.product(l.scope.productId)?.name ?? `#${l.scope.productId}`);
  }

  policyOf(ref: ScopeRef): AdmissionPolicy {
    return this.d.policies.resolve(ref).value;
  }

  private lessonPolicy(l: Lesson): AdmissionPolicy {
    return this.policyOf(l.scope.kind === "repo" ? { kind: "repo", slug: l.scope.slug } : { kind: "product", productId: l.scope.productId });
  }

  /** 一个范围分成几个桶：产品（连同成员仓库）一个桶，不属于任何产品的仓库各一个桶；一个仓库只进一个桶。 */
  buckets(scope: AdmissionScope): Bucket[] {
    const all = this.d.repo.lessons({ status: ["pending", "confirmed"] });
    const inRepo = (slug: string) => all.filter((l) => l.scope.kind === "repo" && l.scope.slug === slug);
    const inProduct = (id: number) => all.filter((l) => l.scope.kind === "product" && l.scope.productId === id);
    if (scope.kind === "repo") {
      const refs = this.d.repo.productsOf(scope.slug).flatMap((p) => inProduct(p.id).filter((l) => l.status === "confirmed"));
      return [{ ref: scope, productId: null, lessons: [...inRepo(scope.slug), ...refs] }];
    }
    if (scope.kind === "product") {
      const p = this.d.repo.product(scope.productId);
      if (!p) return [];
      return [{ ref: scope, productId: p.id, lessons: [...inProduct(p.id), ...p.slugs.flatMap(inRepo)] }];
    }
    const claimed = new Set<string>();
    const out: Bucket[] = [];
    for (const p of [...this.d.repo.products()].sort((a, b) => a.id - b.id)) {
      const slugs = p.slugs.filter((s) => !claimed.has(s));
      for (const s of slugs) claimed.add(s);
      out.push({ ref: { kind: "product", productId: p.id }, productId: p.id, lessons: [...inProduct(p.id), ...slugs.flatMap(inRepo)] });
    }
    for (const r of this.d.repo.repos()) if (!claimed.has(r.slug)) out.push({ ref: { kind: "repo", slug: r.slug }, productId: null, lessons: inRepo(r.slug) });
    return out;
  }

  /** 这个范围现在的候选。 */
  candidates(scope: AdmissionScope): Lesson[] {
    return this.buckets(scope).flatMap((b) => b.lessons.filter(isCandidate));
  }

  // ------------------------------------------------------------------ 合并后的样子

  stepOf(l: Lesson, text = l.text, members: Lesson[] = [l]): StepLesson {
    return {
      id: l.id,
      text,
      why: l.why,
      globs: l.scopeGlobs,
      scopeLabel: this.scopeLabel(l),
      degraded: members.every((m) => m.degraded),
      excerpts: members.flatMap((m) => this.d.repo.sourcesWithExcerpt(m.id).map((s) => s.excerpt).filter((e): e is string => !!e)).slice(0, 8),
    };
  }

  /** 起草检查用的就是库里那条规矩本身（起草器自己读库），缓存指纹也按它算。 */
  rawStep(l: Lesson): StepLesson {
    return { id: l.id, text: l.text, why: l.why, globs: l.scopeGlobs, scopeLabel: this.scopeLabel(l), degraded: l.degraded };
  }

  private evidenceOf(g: Group) {
    const sources = g.members.flatMap((m) => m.sources.map((s) => ({ ...s, slug: s.slug ?? this.reposOf(m)[0] ?? "" })));
    const prs = new Set(sources.map((s) => `${s.slug}#${s.prNumber}`)).size;
    const known = sources.filter((s) => s.reviewer);
    const reviewers = new Set(known.map((s) => s.reviewer!.toLowerCase())).size;
    return {
      hits: g.members.reduce((s, m) => s + m.hits, 0),
      prs,
      reviewers,
      allKnown: known.length === sources.length && sources.length > 0,
      lastSeenAt: Math.max(...g.members.map((m) => m.lastSeenAt)),
      degraded: g.members.every((m) => m.degraded),
    };
  }

  // ------------------------------------------------------------------ 闸门 1：去重

  private async dedupe(b: Bucket, ctx: StepCtx, policy: AdmissionPolicy, unfinished: Set<number>): Promise<Group[]> {
    const pool = b.lessons.filter((l) => isCandidate(l) || l.status === "confirmed");
    const steps = new Map(pool.map((l) => [l.id, this.rawStep(l)]));
    const toks = new Map(pool.map((l) => [l.id, tokens(l.text)]));
    const minSim = Number(policy["dedupe.minSimilarity"]);
    const maxGroup = Number(policy["dedupe.maxGroup"]);
    const edges: [number, number][] = [];
    // 产品桶里不同仓库的规矩也要比（找出跨仓库重复的）；合进确认规矩时再看适不适用（splitByConfirmed）。
    const comparable = (a: Lesson, c: Lesson) => !(a.status === "confirmed" && c.status === "confirmed") && globsOverlap(a.scopeGlobs, c.scopeGlobs);
    for (let i = 0; i < pool.length; i++)
      for (let j = i + 1; j < pool.length; j++) {
        const a = pool[i];
        const c = pool[j];
        if (!comparable(a, c)) continue;
        if (readSame(this.d.judgments, steps.get(a.id)!, steps.get(c.id)!) !== null) continue;
        if (textSimilarity(toks.get(a.id)!, toks.get(c.id)!) < minSim) continue;
        edges.push([a.id, c.id]);
      }
    const toAsk = packPairs(edges, maxGroup).map((ids) => ids.map((id) => steps.get(id)!));
    const failedGroups = await runCluster(ctx, toAsk);
    for (const g of toAsk) if (failedGroups.has([...g.map((l) => l.id)].sort((x, y) => x - y).join(","))) for (const l of g) if (isCandidate(pool.find((p) => p.id === l.id)!)) unfinished.add(l.id);

    const same = new UnionFind();
    for (let i = 0; i < pool.length; i++)
      for (let j = i + 1; j < pool.length; j++)
        if (comparable(pool[i], pool[j]) && readSame(this.d.judgments, steps.get(pool[i].id)!, steps.get(pool[j].id)!) === true) same.union(pool[i].id, pool[j].id);
    const byId = new Map(pool.map((l) => [l.id, l]));
    const grouped = new Set<number>();
    const groups: Group[] = [];
    for (const ids of same.groups(pool.map((l) => l.id))) {
      const members = ids.map((id) => byId.get(id)!);
      for (const g of this.splitByConfirmed(members, b)) {
        for (const m of g.members) grouped.add(m.id);
        groups.push(g);
      }
    }
    for (const l of pool) if (!grouped.has(l.id) && isCandidate(l)) groups.push({ keeper: l, members: [l], text: l.text, promoteTo: null });
    return groups;
  }

  /**
   * 一组同义规矩里定留哪条：有确认过的就留它（不改它的字），候选只合进对它所在仓库也适用的那条确认规矩；
   * 剩下的候选自成一组，留出现最多、再最早的那条，跨了仓库而且是产品桶就提到产品层。
   */
  private splitByConfirmed(members: Lesson[], b: Bucket): Group[] {
    const confirmed = members.filter((m) => m.status === "confirmed").sort((x, y) => y.hits - x.hits || x.createdAt - y.createdAt || x.id - y.id);
    const out = new Map<number, Lesson[]>();
    const rest: Lesson[] = [];
    for (const m of members) {
      if (m.status === "confirmed") continue;
      const into = confirmed.find((c) => this.applies(c, m) && this.reposOf(m).every((s) => this.reposOf(c).includes(s)));
      if (into) (out.get(into.id) ?? out.set(into.id, []).get(into.id)!).push(m);
      else rest.push(m);
    }
    const groups: Group[] = [];
    for (const c of confirmed) {
      const ms = out.get(c.id);
      if (ms?.length) groups.push({ keeper: c, members: [c, ...ms], text: c.text, promoteTo: null });
    }
    if (rest.length) {
      const sorted = [...rest].sort((x, y) => y.hits - x.hits || x.createdAt - y.createdAt || x.id - y.id);
      const keeper = sorted.find((l) => l.scope.kind === "product") ?? sorted[0];
      const canon = rest.length > 1 ? readCanon(this.d.judgments, rest.map((l) => this.rawStep(l))) : null;
      const repos = new Set(rest.filter((l) => l.scope.kind === "repo").map((l) => (l.scope as { slug: string }).slug));
      const promoteTo = b.productId !== null && keeper.scope.kind === "repo" && repos.size >= 2 ? b.productId : null;
      groups.push({ keeper, members: rest, text: canon ?? keeper.text, promoteTo });
    }
    return groups;
  }

  // ------------------------------------------------------------------ 闸门 2：冲突

  private async conflicts(groups: Group[], refs: Lesson[], ctx: StepCtx, policy: AdmissionPolicy, unfinished: Set<number>) {
    const items = [...groups.filter((g) => isCandidate(g.keeper) && !unfinished.has(g.keeper.id)).map((g) => ({ l: g.keeper, step: this.stepOf(g.keeper, g.text, g.members) })),
      ...refs.map((l) => ({ l, step: this.rawStep(l) }))];
    const byId = new Map(items.map((x) => [x.l.id, x]));
    const toks = new Map(items.map((x) => [x.l.id, tokens(x.step.text)]));
    const pairs: [number, number][] = [];
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const c = items[j];
        if (!isCandidate(a.l) && !isCandidate(c.l)) continue;
        if (!this.applies(a.l, c.l) || !globsOverlap(a.l.scopeGlobs, c.l.scopeGlobs)) continue;
        if (textSimilarity(toks.get(a.l.id)!, toks.get(c.l.id)!) === 0) continue;
        pairs.push(a.l.id < c.l.id ? [a.l.id, c.l.id] : [c.l.id, a.l.id]);
      }
    const open = pairs.filter(([x, y]) => readConflict(this.d.judgments, byId.get(x)!.step, byId.get(y)!.step) === null);
    // 块：每块最多 maxGroup / 2 条，每一对落在（它两头所在的）一对块里，一对块一次调用。
    const half = Math.max(1, Math.floor(Number(policy["dedupe.maxGroup"]) / 2));
    const involved = [...new Set(open.flat())].sort((x, y) => x - y);
    const blockOf = new Map(involved.map((id, i) => [id, Math.floor(i / half)]));
    const blocks = new Map<string, { ids: Set<number>; pairs: [number, number][] }>();
    for (const [x, y] of open) {
      const bx = blockOf.get(x)!;
      const by = blockOf.get(y)!;
      const k = `${Math.min(bx, by)}:${Math.max(bx, by)}`;
      const blk = blocks.get(k) ?? blocks.set(k, { ids: new Set(involved.filter((id) => blockOf.get(id) === bx || blockOf.get(id) === by)), pairs: [] }).get(k)!;
      blk.pairs.push([x, y]);
    }
    const list = [...blocks.values()].map((b) => ({ lessons: [...b.ids].map((id) => byId.get(id)!.step), pairs: b.pairs }));
    const failed = await runConflicts(ctx, list);
    for (const b of list) if (failed.has(b.lessons.map((l) => l.id).sort((x, y) => x - y).join(","))) for (const [x, y] of b.pairs) for (const id of [x, y]) if (isCandidate(byId.get(id)!.l)) unfinished.add(id);
    const found: { a: number; b: number; kind: "conflict" | "conditional"; reason: string }[] = [];
    for (const [x, y] of pairs) {
      const j = readConflict(this.d.judgments, byId.get(x)!.step, byId.get(y)!.step);
      if (j && j.kind !== "none") found.push({ a: x, b: y, kind: j.kind, reason: j.reason });
    }
    return { found, byId };
  }

  // ------------------------------------------------------------------ judge

  async judge(scope: AdmissionScope, opts: JudgeOptions = {}): Promise<JudgeResult> {
    const t = M().admission;
    const now = this.d.now();
    const ctx: StepCtx = {
      run: this.d.run, judgments: this.d.judgments, lang: this.d.lang, now: this.d.now, cwd: this.d.fallbackCwd(),
      gate: opts.gate ?? OPEN_GATE, onCall: opts.onCall,
    };
    const only = opts.only ? new Set(opts.only) : null;
    const verdicts = new Map<number, LessonVerdict>();
    const patches = new Map<number, LessonFieldsPatch>();
    const admitted: StepLesson[] = [];
    const producers: string[] = [];
    let candidates = 0;
    const set = (id: number, v: Omit<LessonVerdict, "lessonId" | "check" | "promoteTo"> & Partial<Pick<LessonVerdict, "check" | "promoteTo">>, p: LessonFieldsPatch) => {
      verdicts.set(id, { lessonId: id, check: false, promoteTo: null, ...v });
      patches.set(id, { ...(patches.get(id) ?? {}), ...p });
    };
    const shelve = (_id: number, reason: string, ref: number | null, note: string | null): LessonFieldsPatch => ({ admission: "shelved", shelvedReason: reason, shelvedRef: ref, shelvedNote: note });
    const stamp = (s: ScoreResult): LessonFieldsPatch => ({ score: s.score, scoreParts: s.parts, scoredAt: now, scorePolicyVersion: this.d.policies.version() });

    for (const b of this.buckets(scope)) {
      const bucketPolicy = this.policyOf(b.ref);
      const unfinished = new Set<number>();
      const inScope = (l: Lesson) => isCandidate(l) && (!only || only.has(l.id));
      candidates += b.lessons.filter(inScope).length;
      if (!b.lessons.some(inScope)) continue;

      // 闸门 1
      const groups = opts.skipDedupe
        ? b.lessons.filter(isCandidate).map((l) => ({ keeper: l, members: [l], text: l.text, promoteTo: null }) satisfies Group)
        : await this.dedupe(b, ctx, bucketPolicy, unfinished);
      for (const g of groups)
        for (const m of g.members)
          if (m.id !== g.keeper.id && inScope(m))
            set(m.id, { verdict: "merged", reason: "duplicate", ref: g.keeper.id, note: t.note.duplicate(g.keeper.id), score: null, promoteTo: g.promoteTo }, shelve(m.id, "duplicate", g.keeper.id, t.note.duplicate(g.keeper.id)));

      // 闸门 2
      const refs = b.lessons.filter((l) => l.status === "confirmed");
      const live = groups.filter((g) => inScope(g.keeper) || (only && isCandidate(g.keeper)));
      const consistency = new Map<number, { ref: number; reason: string } | null>();
      const shelvedByConflict = new Map<number, { ref: number; reason: string }>();
      if (!opts.skipDedupe) {
        const { found, byId } = await this.conflicts(live, refs, ctx, bucketPolicy, unfinished);
        const autoPick = bucketPolicy["conflict.autoPickHigherHits"] === true;
        const hitsOf = (id: number) => live.find((g) => g.keeper.id === id)?.members.reduce((s, m) => s + m.hits, 0) ?? byId.get(id)!.l.hits;
        for (const c of found) {
          const [x, y] = [byId.get(c.a)!.l, byId.get(c.b)!.l];
          if (c.kind === "conditional") {
            for (const [me, other] of [[x, y], [y, x]] as const) if (isCandidate(me) && !consistency.get(me.id)) consistency.set(me.id, { ref: other.id, reason: c.reason });
            continue;
          }
          const losers: Lesson[] = [];
          if (!isCandidate(x) || !isCandidate(y)) losers.push(isCandidate(x) ? x : y);
          else if (autoPick && hitsOf(x.id) !== hitsOf(y.id)) {
            const [win, lose] = hitsOf(x.id) > hitsOf(y.id) ? [x, y] : [y, x];
            losers.push(lose);
            if (!consistency.get(win.id)) consistency.set(win.id, { ref: lose.id, reason: c.reason });
          } else losers.push(x, y);
          for (const l of losers) if (!shelvedByConflict.has(l.id)) shelvedByConflict.set(l.id, { ref: l.id === x.id ? y.id : x.id, reason: c.reason });
        }
      }

      // 闸门 3、4 和评分：每个还在的组一次。
      const toClarify: { g: Group; step: StepLesson; category: LessonCheckability; reasonPatch: LessonFieldsPatch; policy: AdmissionPolicy }[] = [];
      const needClass: { g: Group; step: StepLesson }[] = [];
      const baseline = this.d.coverage?.describeForPrompt?.(this.slugsOf(b), BASELINE_PROMPT_CHARS) ?? null;
      for (const g of live) {
        const k = g.keeper;
        if (!inScope(k)) continue;
        if (unfinished.has(k.id)) continue;
        const conflict = shelvedByConflict.get(k.id);
        if (conflict) {
          set(k.id, { verdict: "shelved", reason: "conflict", ref: conflict.ref, note: t.note.conflict(conflict.ref, conflict.reason), score: null }, shelve(k.id, "conflict", conflict.ref, t.note.conflict(conflict.ref, conflict.reason)));
          continue;
        }
        const policy = this.lessonPolicy(k);
        const e = this.evidenceOf(g);
        const minHits = Number(policy["generality.minHits"]);
        const minPrs = Number(policy["generality.minPrs"]);
        const minReviewers = Number(policy["generality.minReviewers"]);
        const needReviewers = policy["generality.allowSingleReviewer"] === false && e.allKnown && e.reviewers === 1 ? Math.max(2, minReviewers) : minReviewers;
        if (e.hits < minHits || e.prs < minPrs) {
          const note = t.note.generality(e.hits, e.prs, minHits, minPrs);
          set(k.id, { verdict: "shelved", reason: "generality", ref: null, note, score: null }, shelve(k.id, "generality", null, note));
          continue;
        }
        if (e.reviewers < needReviewers) {
          const note = t.note.reviewers(e.reviewers, needReviewers);
          set(k.id, { verdict: "shelved", reason: "generality", ref: null, note, score: null }, shelve(k.id, "generality", null, note));
          continue;
        }
        const step = this.stepOf(k, g.text, g.members);
        if (k.checkability === null) needClass.push({ g, step });
        // 存成 converted、检查却不再启用的（covered 里没拦下来）按可检查的判，推荐了再起草。
        else toClarify.push({ g, step, category: k.checkability === "converted" ? "checkable" : k.checkability, reasonPatch: {}, policy });
      }

      if (needClass.length) {
        const missing = await runClassify(ctx, needClass.map((x) => x.step), baseline);
        for (const id of missing) unfinished.add(Number(id));
      }
      for (const { g, step } of needClass) {
        const c = readClassify(this.d.judgments, step, baseline);
        if (!c) {
          unfinished.add(g.keeper.id);
          continue;
        }
        if (c.covered_by) {
          const note = t.note.covered(c.covered_by);
          set(g.keeper.id, { verdict: "covered", reason: "covered", ref: null, note, score: null }, { ...shelve(g.keeper.id, "covered", null, note), checkability: "covered", checkabilityReason: c.reason });
          continue;
        }
        toClarify.push({ g, step, category: c.checkability, reasonPatch: { checkability: c.checkability, checkabilityReason: c.reason }, policy: this.lessonPolicy(g.keeper) });
      }

      // 覆盖：已经有启用的检查带着这条规矩，或者仓库基线强覆盖。
      const covered = toClarify.filter((x) => {
        const by = this.coveredBy(x.g.keeper, x.step.text, x.category);
        if (!by) return true;
        const note = t.note.covered(by);
        set(x.g.keeper.id, { verdict: "covered", reason: "covered", ref: null, note, score: null }, { ...shelve(x.g.keeper.id, "covered", null, note), ...x.reasonPatch });
        return false;
      });

      if (covered.length) for (const id of await runClarity(ctx, covered.map((x) => x.step))) unfinished.add(Number(id));
      const scored: { x: (typeof covered)[number]; s: ScoreResult; parts: { evidence: ReturnType<typeof evidencePart>; clarity: ReturnType<typeof clarityPart>; consistency: ReturnType<typeof consistencyPart> } }[] = [];
      for (const x of covered) {
        const c = readClarity(this.d.judgments, x.step);
        if (!c) {
          unfinished.add(x.g.keeper.id);
          continue;
        }
        const e = this.evidenceOf(x.g);
        const parts = {
          evidence: evidencePart({ hits: e.hits, prs: e.prs, reviewers: e.reviewers, lastSeenAt: e.lastSeenAt, degraded: e.degraded }, x.policy, now),
          clarity: clarityPart(c.answer, c.scope_clear, c.reason, x.step.degraded, x.policy),
          consistency: consistencyPart(consistency.get(x.g.keeper.id) ?? null),
        };
        scored.push({ x, s: scoreLesson(parts, x.category === "checkable", x.policy), parts });
      }

      // 被推荐的可检查规矩起草检查；起草器说只能是文字的，按文字规矩的线重新落线。
      const drafts = scored.filter((r) => r.s.outcome === "admit" && r.x.category === "checkable");
      if (drafts.length) for (const id of await runDrafts(ctx, drafts.map((r) => this.rawStep(r.x.g.keeper)), this.d.drafter, (id) => {
        const cur = this.d.repo.get(id);
        return cur ? this.rawStep(cur) : null;
      })) unfinished.add(Number(id));
      for (const r of scored) {
        const k = r.x.g.keeper;
        if (unfinished.has(k.id)) continue;
        let { s } = r;
        let categoryPatch = r.x.reasonPatch;
        let check = false;
        if (s.outcome === "admit" && r.x.category === "checkable") {
          const d = readDraft(this.d.judgments, this.rawStep(k));
          if (!d) {
            unfinished.add(k.id);
            continue;
          }
          if (d.kind === "prose") {
            s = scoreLesson(r.parts, false, r.x.policy);
            categoryPatch = { checkability: "prose", checkabilityReason: d.reason };
          } else check = true;
        }
        const patch: LessonFieldsPatch = { ...categoryPatch, ...stamp(s) };
        if (s.outcome === "admit") {
          set(k.id, { verdict: "admit", reason: null, ref: null, note: null, score: s.score, check, promoteTo: r.x.g.promoteTo }, { ...patch, admission: "auto", shelvedReason: null, shelvedRef: null, shelvedNote: null });
          admitted.push(r.x.step);
          for (const m of r.x.g.members) for (const src of m.sources) if (src.runId !== null) producers.push(String(src.runId));
        } else {
          const reason = s.outcome;
          set(k.id, { verdict: "shelved", reason, ref: null, note: s.note, score: s.score }, { ...patch, ...shelve(k.id, reason, null, s.note) });
        }
      }

      for (const id of unfinished) {
        const l = b.lessons.find((x) => x.id === id);
        if (!l || !inScope(l) || verdicts.get(id)?.verdict === "merged") continue;
        set(id, { verdict: "unfinished", reason: null, ref: null, note: null, score: null }, { admission: "pending", shelvedReason: null, shelvedRef: null, shelvedNote: null });
      }
    }

    const planBatch = opts.live && !opts.live() ? null : this.writePlan(scope, patches, opts, now);
    return { planBatch, candidates, verdicts: [...verdicts.values()].sort((a, b) => a.lessonId - b.lessonId), admitted, producer: this.producerOf(producers), ctx };
  }

  private slugsOf(b: Bucket): string[] {
    return [...new Set(b.lessons.flatMap((l) => this.reposOf(l)))];
  }

  /** 已经被覆盖了吗：启用的检查带着这条规矩的 id，或者仓库基线说强覆盖。返回覆盖它的东西的名字。 */
  private coveredBy(l: Lesson, text: string, category: LessonCheckability): string | null {
    if (category === "covered") return l.checkabilityReason ?? "—";
    for (const id of this.d.checks.repo.idsOfLesson(l.id)) {
      const c = this.d.checks.repo.get(id);
      if (c?.enabled) return c.name;
    }
    const hit = this.d.coverage?.coveredBy({ scope: l.scope, text, scopeGlobs: l.scopeGlobs }).find((c) => c.strength === "strong");
    return hit?.label ?? null;
  }

  /** 产出这批规矩最多的那个模型（抽查时让路由换一个）。 */
  private producerOf(runIds: string[]): Candidate | null {
    const count = new Map<string, { n: number; tier: Tier }>();
    for (const id of new Set(runIds)) {
      const r = this.d.runs.get(Number(id));
      if (!r?.actualModel) continue;
      const tier = (TIERS as readonly string[]).includes(r.requestedTier ?? "") ? (r.requestedTier as Tier) : "mid";
      const c = count.get(r.actualModel) ?? { n: 0, tier };
      c.n++;
      count.set(r.actualModel, c);
    }
    const best = [...count.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    return best ? { model: best[0], tier: best[1].tier } : null;
  }

  /**
   * 计划批次：每条候选一行，值没变的跳过（撤销计划批次总是安全的：每行互不依赖）。判的时候（等模型的那段）被人确认、
   * 驳回、合并或者改过的规矩不写：它们已经不是这一遍看到的样子，下一遍再判。
   */
  private writePlan(scope: AdmissionScope, patches: Map<number, LessonFieldsPatch>, opts: JudgeOptions, passStart: number): number | null {
    if (!patches.size) return null;
    const now = this.d.now();
    const { outcome } = this.d.recorder.run(
      { kind: opts.kind ?? "admission_plan", origin: opts.origin ?? "auto", entity: "lesson", scope: { admission: scope }, summary: { candidates: patches.size }, now },
      (ctx) => {
        for (const [id, p] of patches) {
          const l = this.d.repo.get(id);
          if (!l || !isCandidate(l) || l.mergedInto !== null || (this.d.repo.updatedAt(id) ?? 0) > passStart || !changes(l, p)) {
            ctx.skip();
            continue;
          }
          ctx.track("lesson", id);
          this.d.repo.setFields(id, p, now);
        }
      },
    );
    return outcome.batchId;
  }

  /** 抽查（addendum 5.2）：跑 lesson_sample_review，把结果留在缓存里。 */
  async sample(ctx: StepCtx, lessons: StepLesson[], producer: Candidate | null): Promise<Set<string>> {
    return runSample(ctx, lessons, producer);
  }
}

/**
 * 把要问的相似对装进不超过 maxGroup 条的组：每一对都至少在一个组里（组可以重叠），所以问过一次以后每一对都有缓存，
 * 下一遍不会因为切片切开了一对而再问。一对优先放进已经有它一头、还有空位的组。顺序确定，组的组成（缓存键）也确定。
 */
export function packPairs(edges: readonly [number, number][], maxGroup: number): number[][] {
  const cap = Math.max(2, Math.floor(maxGroup));
  const groups: Set<number>[] = [];
  for (const [a, b] of edges) {
    if (groups.some((g) => g.has(a) && g.has(b))) continue;
    const room = (g: Set<number>) => g.size + (g.has(a) ? 0 : 1) + (g.has(b) ? 0 : 1) <= cap;
    const g = groups.find((x) => (x.has(a) || x.has(b)) && room(x));
    if (g) g.add(a).add(b);
    else groups.push(new Set([a, b]));
  }
  return groups.map((g) => [...g].sort((x, y) => x - y));
}

/** 分数差不到这么多不算改了（证据的新近程度每天都在变，不能让每一遍都写一个计划批次）。 */
const SCORE_EPSILON = 0.01;

const near = (a: unknown, b: unknown) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) < SCORE_EPSILON;

/** 分项只看有哪几项和各项的值（理由里的天数之类每天都变）。 */
function partsChanged(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) !== (b ?? null);
  const x = a as Record<string, { value: number } | undefined>;
  const y = b as Record<string, { value: number } | undefined>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)].filter((k) => x[k] !== undefined || y[k] !== undefined));
  for (const k of keys) {
    if (!x[k] || !y[k]) return true;
    if (!near(x[k]!.value, y[k]!.value)) return true;
  }
  return false;
}

/** 补丁会不会改东西（打分时间这种每次都变的只在分数或分项真变了时才算）。 */
export function changes(l: Lesson, p: LessonFieldsPatch): boolean {
  const cur = l as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    if (k === "scoredAt" || k === "scorePolicyVersion") continue;
    if (k === "scoreParts") {
      if (partsChanged(cur.scoreParts, v)) return true;
      continue;
    }
    if (k === "score" && near(cur.score, v)) continue;
    if ((cur[k] ?? null) !== (v ?? null)) return true;
  }
  if (p.scorePolicyVersion !== undefined && (l.scorePolicyVersion ?? null) !== p.scorePolicyVersion) return true;
  return false;
}
