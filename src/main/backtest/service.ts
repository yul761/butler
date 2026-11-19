// 回测服务（工作流 F 第 3、4 节）：后台任务 backtest（op：prefetch 拿素材、check 回测一条已有的检查、review 定期复查），
// 准入第 5 关的回答（assess），向导第 3 段（BacktestRunner）。
import type { AdmissionPolicy } from "../../shared/admission-policy";
import type { BacktestSample, BacktestSkipReason, BacktestSummary } from "../../shared/backtest";
import type { CheckInput, CheckRow, CheckScope } from "../../shared/checks";
import type { AdmissionScope } from "../../shared/lesson-admission";
import type { BacktestRepo, StoredResult } from "../db/backtest-repo";
import type { BgJobContext, BgJobResult } from "../background/queue";
import type { BgJob } from "../db/background-repo";
import type { Evaluator } from "./evaluator";
import { defHash, hashOf, type BacktestCheckDef, type EvalSource } from "./evaluate";
import { estimateFalsePositives, judgeHits, seededSample, type JudgeDeps } from "./judge";
import { anchorsFor, materialState, prefetchRepo, type BacktestGh, type SourceRef } from "./material";

/** 每条结果留几个误报样例、几个抓到的评论。 */
const FP_SAMPLES = 10;
const CAUGHT_SAMPLES = 20;
/** 向导等素材时多久看一次任务行。 */
const POLL_MS = 500;
/** 向导最多等多久（素材很多时剩下的交给后台，第 5 关先答 pending）。 */
const WIZARD_WAIT_MS = 15 * 60_000;
/** 拿素材的任务排在别的后台活后面。 */
const PREFETCH_PRIORITY = -1;

export type BacktestPayload =
  | { op: "prefetch"; slug: string }
  | { op: "check"; checkId: number }
  | { op: "review" };

/** 第 5 关的回答。 */
export type GateAnswer =
  | {
      kind: "tested";
      recall: number | null;
      fpRate: number | null;
      hits: number;
      comments: number;
      commentsMatched: number;
      falsePositives: number;
      prs: number;
      /** 范围里没回测的仓库（产品层的规矩）。 */
      skipped: { slug: string; reason: BacktestSkipReason }[];
    }
  | { kind: "untested"; reason: BacktestSkipReason }
  | { kind: "pending" };

export interface AssessInput {
  lessonId: number | null;
  /** 规矩原文（给判误报的模型看）。 */
  ruleText: string;
  draft: Pick<CheckInput, "type" | "params" | "globs" | "excludeGlobs" | "message">;
  slugs: readonly string[];
  sources: readonly (SourceRef & { slug: string | null })[];
  /** 已经存成检查的：结果挂到它的 key 上。 */
  checkKey?: string | null;
  onCall?: () => void;
}

export interface BacktestServiceDeps {
  repo: BacktestRepo;
  gh: BacktestGh;
  evaluate: Evaluator;
  judge: Omit<JudgeDeps, "cwd" | "onCall">;
  localPath: (slug: string) => string | null;
  /** 这个仓库生效的准入策略（三层叠加后）。 */
  policy: (slug: string) => AdmissionPolicy;
  ticketPattern: () => string;
  queue: { enqueue(kind: "backtest", payload: BacktestPayload, o?: { dedupeKey?: string | null; notBefore?: number | null; priority?: number }): number };
  jobs: { get(id: number): Pick<BgJob, "state" | "error"> | null };
  /** 这个仓库上所有规矩的出处（拿素材时一起拿出处所在 PR 的评论和文件）。 */
  sourcesOf: (slug: string) => SourceRef[];
  checks: {
    get(id: number): CheckRow | null;
    /** 检查适用的仓库（产品层：产品里的仓库；全局：所有登记的仓库）。 */
    slugsOf(scope: CheckScope): string[];
    /** 检查来自的规矩：原文和出处。 */
    lessonOf(row: CheckRow): { text: string; sources: (SourceRef & { slug: string | null })[] } | null;
  };
  /** 准入范围里的仓库（向导用）。 */
  slugsOfScope: (scope: AdmissionScope) => string[];
  legacy?: { run(checkId: number, slug: string): Promise<{ ok: true; scan: { scanId: number; count: number; status: string } } | { ok: false; message: string }> };
  /** 一个仓库的素材拿到了：D 的自动准入再跑一遍（第 5 关之前答了 pending 的规矩）。 */
  onMaterial?: (slug: string) => void;
  /** 复查（F 第 6 节）：自动升级、降级、阈值复查。 */
  onReview?: (ctx: BgJobContext) => Promise<BgJobResult>;
  onChanged?: () => void;
  fallbackCwd: string;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, e?: unknown) => void;
}

const num = (p: AdmissionPolicy, k: keyof AdmissionPolicy): number => Number(p[k]);
const SKIP_ORDER: readonly BacktestSkipReason[] = ["run_command", "not_cloned", "no_gh", "no_material"];

export const checkDef = (c: Pick<CheckInput, "type" | "params" | "globs" | "excludeGlobs">): BacktestCheckDef => ({
  type: c.type, params: c.params, globs: c.globs, excludeGlobs: c.excludeGlobs,
});

const sourcesHash = (ss: readonly SourceRef[]): string =>
  hashOf(ss.map((s) => [s.id, s.prNumber, s.path, s.line, s.reviewer]).sort((a, b) => Number(a[0]) - Number(b[0])));

/** 几个仓库的结果合起来：命中、误报、评论相加，比例重新算。 */
export function summarize(results: readonly StoredResult[]): BacktestSummary {
  const done = results.filter((r) => r.status === "done");
  const sum = (f: (r: StoredResult) => number) => done.reduce((s, r) => s + f(r), 0);
  const hits = sum((r) => r.hits);
  const fp = sum((r) => r.falsePositives);
  const comments = sum((r) => r.comments);
  const matched = sum((r) => r.commentsMatched);
  const legacy = done.some((r) => r.legacy !== null) ? sum((r) => r.legacy ?? 0) : null;
  return {
    tested: done.length > 0,
    skipped: results.filter((r) => r.status === "skipped").map((r) => ({ slug: r.slug, reason: r.skipReason ?? "no_material" })),
    prs: sum((r) => r.prs), hits, falsePositives: fp, fpRate: hits > 0 ? fp / hits : null, comments, commentsMatched: matched,
    recall: comments > 0 ? matched / comments : null, legacy,
    samples: done.flatMap((r) => r.samples.falsePositives).slice(0, FP_SAMPLES),
    at: results.length ? Math.max(...results.map((r) => r.createdAt)) : null,
  };
}

export class BacktestService {
  constructor(private readonly d: BacktestServiceDeps) {}

  private sleep(ms: number): Promise<void> {
    return this.d.sleep ? this.d.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /** 排一个拿素材的任务（同一个仓库排着的不重复排）。 */
  enqueuePrefetch(slug: string): number {
    return this.d.queue.enqueue("backtest", { op: "prefetch", slug }, { dedupeKey: `prefetch:${slug}`, priority: PREFETCH_PRIORITY });
  }

  enqueueCheck(checkId: number): number {
    return this.d.queue.enqueue("backtest", { op: "check", checkId }, { dedupeKey: `check:${checkId}`, priority: PREFETCH_PRIORITY });
  }

  /** 第 5 关：草稿在范围里每个仓库上回测，合起来回答。素材还没有的先排任务、答 pending。 */
  async assess(input: AssessInput): Promise<GateAnswer> {
    const results: StoredResult[] = [];
    let pending = false;
    for (const slug of input.slugs) {
      const r = await this.backtestOn(slug, input);
      if (r === "pending") pending = true;
      else results.push(r);
    }
    if (pending) return { kind: "pending" };
    const s = summarize(results);
    if (!s.tested) {
      const reasons = s.skipped.map((x) => x.reason);
      return { kind: "untested", reason: SKIP_ORDER.find((r) => reasons.includes(r)) ?? "no_material" };
    }
    return {
      kind: "tested", recall: s.recall, fpRate: s.fpRate, hits: s.hits, comments: s.comments, commentsMatched: s.commentsMatched,
      falsePositives: s.falsePositives, prs: s.prs, skipped: s.skipped,
    };
  }

  /** 一个仓库：跳过、pending，或者（缓存的或新算的）结果。 */
  private async backtestOn(slug: string, input: AssessInput): Promise<StoredResult | "pending"> {
    const def = checkDef(input.draft);
    const dh = defHash(def);
    const sources = input.sources.filter((s) => s.slug === null || s.slug === slug);
    const sh = sourcesHash(sources);
    const base = { defHash: dh, sourcesHash: sh, lessonId: input.lessonId, checkKey: input.checkKey ?? null, slug };
    const cwd = this.d.localPath(slug);
    if (input.draft.type === "run_command") return this.skip(base, "run_command");
    if (!cwd) return this.skip(base, "not_cloned");
    const st = materialState(this.d.repo, slug, sources);
    if (st.kind === "no_gh") return this.skip(base, "no_gh");
    if (st.kind === "missing") {
      this.enqueuePrefetch(slug);
      return "pending";
    }
    const materialKey = this.d.repo.materialKey(slug);
    const prev = this.d.repo.latest(dh, slug);
    if (prev && prev.status === "done" && prev.sourcesHash === sh && prev.materialKey === materialKey) {
      if (input.checkKey && !prev.checkKey) this.d.repo.linkCheck(dh, input.checkKey);
      return prev;
    }
    const policy = this.d.policy(slug);
    const window = st.window;
    const fetched = this.d.repo.commentsFetched(slug, window);
    const all = this.d.repo.comments(slug, window);
    const prComments: Record<number, { path: string | null; line: number | null }[]> = {};
    for (const n of fetched) prComments[n] = (all.get(n) ?? []).map((a) => ({ path: a.path, line: a.line ?? a.originalLine }));
    const srcComments = this.d.repo.comments(slug, [...new Set(sources.map((s) => s.prNumber))]);
    const evalSources: EvalSource[] = [];
    for (const s of sources) {
      const a = anchorsFor(s, srcComments.get(s.prNumber) ?? []).find((x) => x.originalCommit && x.path);
      if (!a || !a.path || !a.originalCommit) continue;
      const f = this.d.repo.file(slug, a.originalCommit, a.path);
      evalSources.push({ sourceId: s.id, prNumber: s.prNumber, path: a.path, line: a.originalLine ?? a.line, content: f?.status === "ok" ? f.content : null });
    }
    const prs = this.d.repo.diffs(slug, window);
    if (!prs.length && !evalSources.some((s) => s.content !== null)) return this.skip(base, "no_material");
    const out = await this.d.evaluate({ check: def, ticketPattern: this.d.ticketPattern(), tolerance: num(policy, "backtest.lineTolerance"), prs, prComments, sources: evalSources });
    const sample = seededSample(out.unmatched, num(policy, "backtest.judgeSample"), dh);
    const hits = sample.map((h) => ({ key: `${dh}:${h.pr}:${h.path}:${h.line}`, path: h.path, line: h.line, text: h.text, context: h.context, pr: h.pr }));
    const j = hits.length
      ? await judgeHits({ ...this.d.judge, cwd, onCall: input.onCall }, "backtest_fp", { text: input.ruleText, message: input.draft.message }, hits)
      : { judged: 0, falsePositives: 0, verdicts: new Map(), incomplete: false, waitUntil: null };
    const falsePositives = estimateFalsePositives(out.unmatchedTotal, j.judged, j.falsePositives);
    const fpSamples: BacktestSample[] = hits
      .map((h) => ({ pr: h.pr, path: h.path, line: h.line, text: h.text, verdict: j.verdicts.get(h.key)?.verdict ?? null, reason: j.verdicts.get(h.key)?.reason ?? null }))
      .filter((s) => s.verdict !== "violation")
      .sort((a, b) => Number(a.verdict === null) - Number(b.verdict === null))
      .slice(0, FP_SAMPLES);
    if (!hits.length) for (const h of out.unmatched.slice(0, FP_SAMPLES)) fpSamples.push({ pr: h.pr, path: h.path, line: h.line, text: h.text, verdict: null, reason: null });
    const id = this.d.repo.insertResult({
      ...base,
      // 没判完（限流、失败）：照保守的算，但下次重算（指纹对不上）。
      materialKey: j.incomplete ? `${materialKey}|partial` : materialKey,
      status: "done", skipReason: null, prs: out.prs, hits: out.hits, matchedHits: out.matched, judged: j.judged, judgedFp: j.falsePositives,
      falsePositives, fpRate: out.hits > 0 ? falsePositives / out.hits : null, comments: out.comments, commentsMatched: out.commentsMatched,
      recall: out.comments > 0 ? out.commentsMatched / out.comments : null,
      samples: { falsePositives: fpSamples, caught: out.caught.slice(0, CAUGHT_SAMPLES).map((c) => ({ pr: c.pr, path: c.path, line: c.line })) },
      at: this.d.now(),
    });
    this.d.onChanged?.();
    return this.d.repo.result(id)!;
  }

  /** 跳过也落一行（页面要写原因）；和上一次一样的跳过不重复写。 */
  private skip(base: { defHash: string; sourcesHash: string; lessonId: number | null; checkKey: string | null; slug: string }, reason: BacktestSkipReason): StoredResult {
    const prev = this.d.repo.latest(base.defHash, base.slug);
    if (prev && prev.status === "skipped" && prev.skipReason === reason) return prev;
    const id = this.d.repo.insertResult({
      ...base, materialKey: "", status: "skipped", skipReason: reason, prs: 0, hits: 0, matchedHits: 0, judged: 0, judgedFp: 0, falsePositives: 0, fpRate: null,
      comments: 0, commentsMatched: 0, recall: null, samples: { falsePositives: [], caught: [] }, at: this.d.now(),
    });
    this.d.onChanged?.();
    return this.d.repo.result(id)!;
  }

  /** 一条检查最新的回测（各仓库合起来）；没有为 null。 */
  summaryOf(row: CheckRow): BacktestSummary | null {
    const rs = this.d.repo.latestAll(defHash(checkDef(row)));
    return rs.length ? summarize(rs) : null;
  }

  // ------------------------------------------------------------ 后台任务

  handler = async (ctx: BgJobContext): Promise<BgJobResult> => {
    const p = ctx.payload as BacktestPayload;
    try {
      if (p.op === "prefetch") return await this.runPrefetch(p.slug, ctx.signal);
      if (p.op === "check") return await this.runCheck(p.checkId, ctx.signal);
      if (p.op === "review") return this.d.onReview ? await this.d.onReview(ctx) : { done: true };
      return { failed: `unknown op ${(p as { op: string }).op}` };
    } catch (e) {
      this.d.log?.(`backtest job ${ctx.id} failed`, e);
      return { failed: String(e instanceof Error ? e.message : e).slice(0, 500) };
    }
  };

  private async runPrefetch(slug: string, signal: AbortSignal): Promise<BgJobResult> {
    const cwd = this.d.localPath(slug);
    if (!cwd) return { done: true };
    const policy = this.d.policy(slug);
    const r = await prefetchRepo({ repo: this.d.repo, gh: this.d.gh, now: this.d.now, log: this.d.log }, { slug, cwd, recentPrs: num(policy, "backtest.recentPrs"), sources: this.d.sourcesOf(slug) }, signal);
    if (r.kind === "aborted") return { defer: true };
    this.d.onChanged?.();
    // 失败也算拿过了：materialState 看重试次数决定接着等还是当 gh 不能用；两种情况都让准入再看一遍。
    if (r.kind === "failed" && !r.gaveUp) return { defer: true, notBefore: this.d.now() + 10 * 60_000, reason: "gh failed" };
    this.d.onMaterial?.(slug);
    return { done: true };
  }

  /** 回测一条已有的检查（手写的、导入的、接受进来的），再在当前代码上扫一遍存量。 */
  private async runCheck(checkId: number, signal: AbortSignal): Promise<BgJobResult> {
    const row = this.d.checks.get(checkId);
    if (!row) return { done: true };
    const lesson = this.d.checks.lessonOf(row);
    const slugs = this.d.checks.slugsOf(row.scope);
    for (const slug of slugs) {
      if (signal.aborted) return { defer: true };
      const input: AssessInput = { lessonId: row.lessonId, ruleText: lesson?.text ?? row.message, draft: row, slugs: [slug], sources: lesson?.sources ?? [], checkKey: row.key };
      let r = await this.backtestOn(slug, input);
      if (r === "pending") {
        const pre = await this.runPrefetch(slug, signal);
        if ("defer" in pre) return pre;
        r = await this.backtestOn(slug, input);
        if (r === "pending") continue;
      }
      if (r.status === "done" && r.legacy === null && this.d.legacy) {
        const scan = await this.d.legacy.run(checkId, slug);
        if (scan.ok && scan.scan.status === "done") this.d.repo.setLegacy(r.id, scan.scan.count, scan.scan.scanId);
      }
    }
    this.d.onChanged?.();
    return { done: true };
  }

  // ------------------------------------------------------------ 向导第 3 段

  /** 范围里每个仓库排一个拿素材的任务，等它们跑完。都有素材（不缺 clone、gh 能用）才算回测过。 */
  readonly wizardRunner = {
    run: async (scope: AdmissionScope, _onCall: () => void, live: () => boolean = () => true): Promise<{ backtested: boolean }> => {
      const slugs = this.d.slugsOfScope(scope);
      if (!slugs.length) return { backtested: false };
      const cloned = slugs.filter((s) => this.d.localPath(s) !== null);
      const jobs = cloned.map((s) => this.enqueuePrefetch(s));
      const end = this.d.now() + WIZARD_WAIT_MS;
      while (live() && this.d.now() < end && jobs.some((id) => { const j = this.d.jobs.get(id); return j !== null && (j.state === "queued" || j.state === "running"); }))
        await this.sleep(POLL_MS);
      const ready = cloned.filter((s) => materialState(this.d.repo, s, this.d.sourcesOf(s)).kind === "ready");
      return { backtested: cloned.length === slugs.length && ready.length === slugs.length };
    },
  };
}
