import type { BatchOutcome } from "../../../shared/batches";
import {
  WIZARD_LIVE_STATES,
  type AdmissionScope,
  type WizardActResult,
  type WizardEstimate,
  type WizardFailedItem,
  type WizardNote,
  type WizardRunView,
  type WizardState,
  type WizardSummary,
  type WizardVerdict,
} from "../../../shared/lesson-admission";
import type { LessonBulkVerb, LessonTarget } from "../../../shared/lessons";
import { withTransaction, type Db } from "../../db/database";
import type { LessonsRepo } from "../../db/lessons-repo";
import type { LessonEnricher } from "../enrich";
import { ENRICH_CHUNK } from "../enrich";
import { isCloned, type LessonRunner } from "../lesson-runner";
import { chunks } from "./call";
import type { ItemGate, StepFailure, StepKind } from "./model-steps";
import type { LessonVerdict } from "./pipeline";
import type { AdmissionService } from "./service";

/**
 * 初始化向导（addendum 第 8 节）：扫描 → 提取 → 生成 → 判 → 等接受 → 接受。状态和工作单元都在库里，
 * 重启以后 resume() 接着做。模型调用失败只让对应的单元失败（1、5、15 分钟后自动重试），从不让整次运行失败；
 * 限流按 waitUntil 推迟，不算一次尝试。
 */

/** 自动重试的间隔：第 n 次失败以后等 WIZARD_RETRY_MS[n - 1]。 */
export const WIZARD_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
/** 自动重试几次（失败这么多次以后不再自动重试，留给「重试」按钮）。 */
export const WIZARD_MAX_ATTEMPTS = 3;
/** 等分析队列时多久看一次。 */
export const WIZARD_POLL_MS = 3_000;
/** 估算用的合并 PR 列表留多久。 */
export const MERGED_CACHE_MS = 10 * 60_000;

/** E2 的仓库扫描（第 1 阶段）；没接进来时记「仓库扫描还不可用」。 */
export interface BaselineScanner {
  scan(slug: string): Promise<{ legacyViolations?: number; noLint?: boolean } | null>;
}
/** F 的回测（第 3 阶段）；没接进来时记「未回测」。 */
export interface BacktestRunner {
  /** live：向导还在跑（取消了就不再等素材）。 */
  run(scope: AdmissionScope, onCall: () => void, live?: () => boolean): Promise<{ backtested: boolean }>;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(h: unknown): void;
}
const REAL_TIMERS: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface WizardDeps {
  db: Db;
  repo: LessonsRepo;
  admission: Pick<AdmissionService, "judge" | "accept" | "review" | "pipeline" | "reviewPolicy">;
  runner: Pick<LessonRunner, "backfill" | "mergedPrNumbers">;
  enricher: Pick<LessonEnricher, "needing" | "enrich">;
  bulk: (verb: LessonBulkVerb, target: LessonTarget) => BatchOutcome;
  now: () => number;
  notify?: () => void;
  log?: (msg: string, err?: unknown) => void;
  policyVersion: () => number;
  scanner?: BaselineScanner | null;
  backtest?: BacktestRunner | null;
  timers?: Timers;
}

interface RunRow {
  id: number;
  scope_kind: "repo" | "product" | "all";
  repo_slug: string | null;
  product_id: number | null;
  state: WizardState;
  detail: string;
  policy_version: number | null;
  plan_batch: number | null;
  accept_batch: number | null;
  review_id: number | null;
  calls: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

interface ItemRow {
  kind: string;
  key: string;
  status: "queued" | "running" | "done" | "failed" | "skipped";
  attempts: number;
  not_before: number | null;
  error: string | null;
}

interface Detail {
  notes: WizardNote[];
  backfilled?: boolean;
  backtested?: boolean;
  summary?: WizardSummary;
}

const scopeOf = (r: RunRow): AdmissionScope =>
  r.scope_kind === "repo" ? { kind: "repo", slug: r.repo_slug! } : r.scope_kind === "product" ? { kind: "product", productId: Number(r.product_id) } : { kind: "all" };

function groupPrs(keys: readonly string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const k of keys) {
    const [slug, n] = splitPrKey(k);
    (out.get(slug) ?? out.set(slug, []).get(slug)!).push(n);
  }
  return out;
}

const prKey = (slug: string, n: number) => `${slug}#${n}`;
const splitPrKey = (k: string): [string, number] => {
  const i = k.lastIndexOf("#");
  return [k.slice(0, i), Number(k.slice(i + 1))];
};

export class WizardService {
  private readonly timers: Timers;
  private readonly driving = new Set<number>();
  private readonly again = new Set<number>();
  private readonly pending = new Map<number, unknown>();
  /** 每次运行一条队：推进、判、重试、重新计算一个接一个（不会两遍判同时写同一次运行）。 */
  private readonly tails = new Map<number, Promise<unknown>>();
  /** 素材到了、已经排了重判还没开始的运行：再来的通知并进这一遍。 */
  private readonly rejudge = new Set<number>();
  /** stop() 之后什么都不再排、不再写（退出时库要关了）。 */
  private stopped = false;
  /** 合并 PR 的列表（估算用；每个仓库一次 gh，10 分钟内不再拉）。 */
  private readonly mergedCache = new Map<string, { at: number; prs: number[] | null }>();

  constructor(private readonly d: WizardDeps) {
    this.timers = d.timers ?? REAL_TIMERS;
  }

  // ------------------------------------------------------------------ 范围

  slugsOf(scope: AdmissionScope): string[] {
    if (scope.kind === "repo") return [scope.slug];
    if (scope.kind === "product") return this.d.repo.product(scope.productId)?.slugs ?? [];
    return this.d.repo.repos().map((r) => r.slug);
  }

  private liveRun(scope: AdmissionScope): RunRow | null {
    const live = WIZARD_LIVE_STATES.map(() => "?").join(",");
    const where = scope.kind === "repo" ? "scope_kind = 'repo' AND repo_slug = ?" : scope.kind === "product" ? "scope_kind = 'product' AND product_id = ?" : "scope_kind = 'all'";
    const args: (string | number)[] = scope.kind === "repo" ? [scope.slug] : scope.kind === "product" ? [scope.productId] : [];
    return (this.d.db.prepare(`SELECT * FROM lesson_wizard_runs WHERE ${where} AND state IN (${live}) ORDER BY id DESC LIMIT 1`).get(...args, ...WIZARD_LIVE_STATES) as unknown as RunRow | undefined) ?? null;
  }

  /** 开始之前的估算：找到的合并 PR、已经分析过的、待确认的规矩、大概要几次后台调用和多久。 */
  async estimate(scope: AdmissionScope): Promise<WizardEstimate> {
    const repos: WizardEstimate["repos"] = [];
    let unanalysed = 0;
    for (const slug of this.slugsOf(scope)) {
      const row = this.d.repo.repo(slug);
      const cloned = isCloned(row);
      const merged = cloned ? await this.mergedPrs(slug) : null;
      const status = merged ? this.d.repo.queueStatusOf(slug, merged) : new Map();
      const analysed = merged ? merged.filter((n) => status.get(n)?.status === "done" || status.get(n)?.status === "skipped").length : 0;
      repos.push({ slug, cloned, merged: merged?.length ?? null, analysed, setUp: this.setUp(slug) });
      if (merged) unanalysed += merged.length - analysed;
    }
    const candidates = this.d.admission.pipeline.candidates(scope).length;
    const enrichNeeding = this.d.enricher.needing().filter((l) => this.inScope(scope, l.scope)).length;
    const sample = Number(this.d.admission.reviewPolicy(scope)["batch.sampleSize"]);
    // 每 20 条候选大约一次去重、一次冲突、一次清晰度、一次分类；抽查 10 条一次。
    const perChunk = Math.ceil((candidates + unanalysed * 2) / 20);
    const expectedCalls = unanalysed + Math.ceil(enrichNeeding / ENRICH_CHUNK) + perChunk * 4 + Math.ceil(Math.min(sample, candidates + unanalysed) / 10);
    const avg = this.d.repo.averageRunMs();
    return { repos, pendingLessons: candidates, enrichNeeding, expectedCalls, expectedMs: avg === null ? null : avg * expectedCalls, liveRunId: this.liveRun(scope)?.id ?? null };
  }

  private async mergedPrs(slug: string): Promise<number[] | null> {
    const hit = this.mergedCache.get(slug);
    if (hit && this.d.now() - hit.at < MERGED_CACHE_MS) return hit.prs;
    const prs = await this.d.runner.mergedPrNumbers(slug);
    this.mergedCache.set(slug, { at: this.d.now(), prs });
    return prs;
  }

  /** 这个仓库被哪一次接受了的向导覆盖过（它自己、它所在的产品，或者「全部」）。 */
  private setUp(slug: string): boolean {
    const runs = this.d.db.prepare(`SELECT scope_kind, repo_slug, product_id FROM lesson_wizard_runs WHERE state = 'accepted'`).all() as { scope_kind: string; repo_slug: string | null; product_id: number | null }[];
    return runs.some((r) => r.scope_kind === "all" || (r.scope_kind === "repo" && r.repo_slug === slug) || (r.scope_kind === "product" && (this.d.repo.product(Number(r.product_id))?.slugs ?? []).includes(slug)));
  }

  private inScope(scope: AdmissionScope, s: { kind: "repo"; slug: string } | { kind: "product"; productId: number }): boolean {
    if (scope.kind === "all") return true;
    if (scope.kind === "repo") return s.kind === "repo" && s.slug === scope.slug;
    if (s.kind === "product") return s.productId === scope.productId;
    return this.slugsOf(scope).includes(s.slug);
  }

  // ------------------------------------------------------------------ 动作

  /** 开始一次（这个范围已经有一次没结束的就回到那一次）。 */
  start(scope: AdmissionScope): number {
    const live = this.liveRun(scope);
    if (live) {
      this.kick(live.id);
      return live.id;
    }
    const now = this.d.now();
    const r = this.d.db
      .prepare(`INSERT INTO lesson_wizard_runs (scope_kind, repo_slug, product_id, state, detail, policy_version, created_at, updated_at) VALUES (?, ?, ?, 'scanning', ?, ?, ?, ?)`)
      .run(scope.kind, scope.kind === "repo" ? scope.slug : null, scope.kind === "product" ? scope.productId : null, JSON.stringify({ notes: [] } satisfies Detail), this.policyVersion(), now, now);
    const id = Number(r.lastInsertRowid);
    this.kick(id);
    this.d.notify?.();
    return id;
  }

  async act(a: import("../../../shared/lesson-admission").WizardAction): Promise<WizardActResult> {
    if (a.op === "start") return { ok: true, runId: this.start(a.scope) };
    const run = this.row(a.runId);
    if (!run) return { ok: false, reason: "not_found" };
    switch (a.op) {
      case "recalculate":
        if (run.state !== "awaiting_accept") return { ok: false, reason: "bad_state" };
        // 只重放：失败的不重试（那是「重试」按钮），缓存里有的不再问模型。
        await this.serial(run.id, async () => {
          if (this.row(run.id)?.state !== "awaiting_accept") return;
          await this.judgePass(run.id, { replay: true });
          this.scheduleRetry(run.id);
        });
        return { ok: true, runId: run.id };
      case "retry": {
        if (!WIZARD_LIVE_STATES.includes(run.state)) return { ok: false, reason: "bad_state" };
        this.d.db.prepare(`UPDATE lesson_wizard_items SET status = 'queued', attempts = 0, not_before = NULL WHERE run_id = ? AND status = 'failed' AND kind <> 'pr'`).run(run.id);
        if (run.state === "awaiting_accept") await this.serial(run.id, () => this.retryPass(run.id));
        else this.kick(run.id);
        return { ok: true, runId: run.id };
      }
      case "accept":
        return this.accept(run);
      case "cancel":
        this.clearTimer(run.id);
        // 在判的那一遍看到状态变了就不再写（judge 的 live）。
        if (!this.advance(run.id, WIZARD_LIVE_STATES, "cancelled", { finished: true })) return { ok: false, reason: "bad_state" };
        return { ok: true, runId: run.id };
      case "pullBack":
      case "rejectGroup": {
        if (run.state !== "awaiting_accept") return { ok: false, reason: "bad_state" };
        const verdicts = new Map(this.verdicts(run.id).map((v) => [v.lessonId, v]));
        // 只动这次搁置、现在还是搁置着的候选（之后被人确认、驳回、合并的不再碰）。
        const ids = a.lessonIds.filter((id) => {
          const v = verdicts.get(id)?.verdict;
          const l = this.d.repo.get(id);
          return (v === "shelved" || v === "covered") && l?.status === "pending" && l.mergedInto === null && l.admission === "shelved";
        });
        if (!ids.length) return { ok: false, reason: "not_shelved" };
        const out = this.d.bulk(a.op === "pullBack" ? "confirm" : "reject", { ids });
        this.d.notify?.();
        return { ok: true, runId: run.id, batchId: out.batchId, affected: out.affected };
      }
    }
  }

  private accept(run: RunRow): WizardActResult {
    if (run.state !== "awaiting_accept") return { ok: false, reason: "bad_state" };
    const review = run.review_id === null ? null : this.d.admission.review(Number(run.review_id), scopeOf(run));
    if (review?.blocked) return { ok: false, reason: "blocked" };
    const verdicts = this.verdicts(run.id);
    const ids = verdicts.filter((v) => v.verdict === "admit" || v.verdict === "merged").map((v) => v.lessonId);
    const keepers = verdicts.filter((v) => v.verdict === "merged" && v.ref !== null).map((v) => v.ref!);
    const all = [...new Set([...ids, ...keepers])];
    this.clearTimer(run.id);
    // 先换状态：还在跑的重试看到不是等接受了，就不再写计划和结论。
    if (!this.advance(run.id, ["awaiting_accept"], "accepted", { finished: true })) return { ok: false, reason: "bad_state" };
    let out: { batchId: number | null; affected: number };
    try {
      out = all.length ? this.d.admission.accept({ ids: all }) : { batchId: null, affected: 0 };
    } catch (e) {
      this.advance(run.id, ["accepted"], "awaiting_accept", { finished: false });
      throw e;
    }
    this.d.db.prepare(`UPDATE lesson_wizard_runs SET accept_batch = ? WHERE id = ?`).run(out.batchId, run.id);
    this.d.notify?.();
    return { ok: true, runId: run.id, batchId: out.batchId, affected: out.affected };
  }

  /**
   * 启动时：做到一半的单元放回队列，没结束的运行接着做；等接受的有该重试的就排上。
   * 等接受、还有规矩没判完的（多半在等回测素材）：上次退出前素材可能已经到了、通知没人接（stop() 之后到的，
   * 或者重判还没跑 app 就退了），这里再判一遍；素材还没有的话回测会再去拿，拿到后照常 onMaterial。
   * 有还会重试的失败项的不在这里判：按退避排的那一遍会重判。重试次数用完的失败项不会再排，不挡这一遍。
   */
  resume(): void {
    this.d.db.prepare(`UPDATE lesson_wizard_items SET status = 'queued' WHERE status = 'running'`).run();
    const live = WIZARD_LIVE_STATES.map(() => "?").join(",");
    const unfinished = this.d.db.prepare(
      `SELECT 1 FROM lesson_wizard_verdicts WHERE run_id = ?1 AND verdict = 'unfinished'
         AND NOT EXISTS (SELECT 1 FROM lesson_wizard_items WHERE run_id = ?1 AND status = 'failed' AND kind <> 'pr'
                           AND not_before IS NOT NULL AND attempts <= ?2) LIMIT 1`,
    );
    for (const r of this.d.db.prepare(`SELECT id, state FROM lesson_wizard_runs WHERE state IN (${live}) ORDER BY id`).all(...WIZARD_LIVE_STATES) as { id: number; state: WizardState }[]) {
      const id = Number(r.id);
      if (r.state !== "awaiting_accept") this.kick(id);
      else if (unfinished.get(id, WIZARD_MAX_ATTEMPTS)) void this.serial(id, () => this.retryPass(id)).catch((e: unknown) => this.d.log?.(`lesson wizard ${id}: re-judging after a restart failed`, e));
      else this.scheduleRetry(id);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const h of this.pending.values()) this.timers.clear(h);
    this.pending.clear();
  }

  /**
   * 回测素材拿到了（或者放弃了）：等接受、还有规矩没判完（多半在等这份素材）的运行再判一遍。缓存里有的不再问模型；
   * 范围不看仓库，重判一遍只花本地时间。
   * 正在判的运行也要再判：这一遍可能在素材到之前就问过回测（没有 gh 时素材会立即放弃，常常比第一遍判完还早），
   * 判完写下的「没判完」不会再有人来通知。重判排在这一遍后面（serial），那时运行已经进了等接受。
   * 重判还没开始时再来的通知（一个产品的几个仓库先后拿到素材）并进同一遍；开始以后再来的另排一遍。
   */
  onMaterial(): void {
    if (this.stopped) return;
    const waiting = new Set(
      (
        this.d.db
          .prepare(`SELECT DISTINCT r.id AS id FROM lesson_wizard_runs r JOIN lesson_wizard_verdicts v ON v.run_id = r.id WHERE r.state = 'awaiting_accept' AND v.verdict = 'unfinished'`)
          .all() as { id: number }[]
      ).map((r) => Number(r.id)),
    );
    const runs = this.d.db.prepare(`SELECT id, state FROM lesson_wizard_runs WHERE state IN ('judging', 'awaiting_accept') ORDER BY id`).all() as { id: number; state: WizardState }[];
    for (const r of runs) {
      const id = Number(r.id);
      if (r.state !== "judging" && !waiting.has(id) && !this.tails.has(id)) continue;
      if (this.rejudge.has(id)) continue;
      this.rejudge.add(id);
      void this.serial(id, () => {
        this.rejudge.delete(id);
        return this.retryPass(id);
      }).catch((e: unknown) => this.d.log?.(`lesson wizard ${id}: re-judging after backtest material failed`, e));
    }
  }

  /** 等现在在跑的推进结束（测试用）。 */
  async idle(): Promise<void> {
    while (this.driving.size || this.tails.size) await new Promise((r) => setTimeout(r, 1));
  }

  private serial<T>(id: number, fn: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(id, tail);
    void tail.then(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
    return next;
  }

  // ------------------------------------------------------------------ 推进

  private kick(id: number): void {
    if (this.stopped) return;
    if (this.driving.has(id)) {
      this.again.add(id);
      return;
    }
    this.driving.add(id);
    void this.serial(id, () => this.drive(id))
      .catch((e: unknown) => {
        this.d.log?.(`lesson wizard ${id} failed`, e);
        if (this.stopped) return;
        try {
          // 只有还没结束的运行才变成失败（取消、接受了的保持原样）。
          const live = WIZARD_LIVE_STATES.map(() => "?").join(",");
          this.d.db.prepare(`UPDATE lesson_wizard_runs SET error = ? WHERE id = ? AND state IN (${live})`).run(e instanceof Error ? e.message : String(e), id, ...WIZARD_LIVE_STATES);
          this.advance(id, WIZARD_LIVE_STATES, "failed", { finished: true });
        } catch (e2) {
          this.d.log?.(`lesson wizard ${id}: recording the failure failed`, e2);
        }
      })
      .finally(() => {
        this.driving.delete(id);
        if (this.again.delete(id)) this.kick(id);
      });
  }

  private async drive(id: number): Promise<void> {
    for (;;) {
      const run = this.row(id);
      if (!run) return;
      switch (run.state) {
        case "scanning":
          await this.scan(run);
          if (!this.advance(id, ["scanning"], "extracting")) return;
          continue;
        case "extracting":
          if (!(await this.extract(run))) return; // 还在等分析队列：定时再看
          if (!this.advance(id, ["extracting"], "generating")) return;
          continue;
        case "generating":
          await this.generate(run);
          if (!this.advance(id, ["generating"], "judging")) return;
          continue;
        case "judging":
          if (!(await this.judgePass(id))) return;
          if (!this.advance(id, ["judging"], "awaiting_accept")) return;
          this.scheduleRetry(id);
          return;
        default:
          return;
      }
    }
  }

  private async scan(run: RunRow): Promise<void> {
    const notes: WizardNote[] = [];
    if (!this.d.scanner) notes.push({ kind: "scanUnavailable" });
    else
      for (const slug of this.slugsOf(scopeOf(run))) {
        const r = await this.d.scanner.scan(slug).catch(() => null);
        if (r?.legacyViolations) notes.push({ kind: "legacyViolations", slug, count: r.legacyViolations });
        if (r?.noLint) notes.push({ kind: "noLint", slug });
      }
    this.patchDetail(run.id, (dt) => ({ ...dt, notes: [...dt.notes, ...notes] }));
  }

  /** 第 2 阶段：把范围里的仓库交给分析队列，等它们分析完，再补填范围。返回 false = 还在等队列。 */
  private async extract(run: RunRow): Promise<boolean> {
    const detail = this.detail(run);
    if (!detail.backfilled) {
      const notes: WizardNote[] = [];
      const items: string[] = [];
      for (const slug of this.slugsOf(scopeOf(run))) {
        const r = await this.d.runner.backfill(slug);
        if (r.ok) items.push(...r.prs.map((n) => prKey(slug, n)));
        else notes.push(r.reason === "no_gh" ? { kind: "noGh" } : r.reason === "unknown_repo" ? { kind: "uncloned", slug } : { kind: "ghFailed", slug });
      }
      // 已经分析过的 PR 一开始就是结束的（不算这次的调用）。
      const ins = this.d.db.prepare(`INSERT OR IGNORE INTO lesson_wizard_items (run_id, kind, key, status) VALUES (?, 'pr', ?, ?)`);
      const known = new Map<string, string>();
      for (const [slug, ns] of groupPrs(items)) for (const [n, st] of this.d.repo.queueStatusOf(slug, ns)) known.set(prKey(slug, n), st.status);
      withTransaction(this.d.db, () => {
        for (const k of items) {
          const st = known.get(k);
          ins.run(run.id, k, st === "done" || st === "skipped" || st === "failed" ? st : "queued");
        }
      });
      const uniq = (ns: WizardNote[]) => [...new Map(ns.map((n) => [JSON.stringify(n), n])).values()];
      this.patchDetail(run.id, (dt) => ({ ...dt, backfilled: true, notes: uniq([...dt.notes, ...notes]) }));
    }
    if (!this.syncPrs(run.id)) {
      if (this.isState(run.id, ["extracting"])) this.schedule(run.id, WIZARD_POLL_MS, () => this.kick(run.id));
      return false;
    }
    await this.enrichPass(run);
    return true;
  }

  /** 按分析队列更新 pr 单元；全部结束（分析完、跳过或失败）时返回 true。分析过的 PR 每次尝试算一次调用。 */
  private syncPrs(runId: number): boolean {
    const items = this.items(runId, "pr").filter((i) => i.status === "queued" || i.status === "running");
    let open = 0;
    let calls = 0;
    const upd = this.d.db.prepare(`UPDATE lesson_wizard_items SET status = ?, attempts = ? WHERE run_id = ? AND kind = 'pr' AND key = ?`);
    for (const [slug, prs] of groupPrs(items.map((i) => i.key))) {
      const status = this.d.repo.queueStatusOf(slug, prs);
      for (const n of prs) {
        const key = prKey(slug, n);
        const before = items.find((i) => i.key === key)!;
        const s = status.get(n);
        // 不在队列里（被清掉了）当作跳过。
        const next = s ? s.status : "skipped";
        if (next === "queued" || next === "running") open++;
        else if (next === "done" || next === "failed") calls += Math.max(1, s?.attempts ?? 1);
        if (next !== before.status) upd.run(next, s?.attempts ?? 0, runId, key);
      }
    }
    if (calls) this.addCalls(runId, calls);
    return open === 0;
  }

  /** 补填范围里还没补的规矩；失败的单元按退避重试，不挡后面的阶段（补不上的规矩照样用已有的字段判）。 */
  private async enrichPass(run: RunRow): Promise<void> {
    const scope = scopeOf(run);
    const needing = this.d.enricher.needing().filter((l) => this.inScope(scope, l.scope));
    const touched = new Set<string>();
    const gate = this.gate(run.id, { touched });
    const ids = needing.map((l) => l.id).filter((id) => gate.allowedRaw("enrich", String(id)));
    // 不再需要补的（别处补好了、出了范围）失败了也不再重试。
    this.dropStale(run.id, touched, true);
    for (const part of chunks(ids, ENRICH_CHUNK)) {
      if (!this.isState(run.id, WIZARD_LIVE_STATES)) return;
      const r = await this.d.enricher.enrich(part, () => this.addCalls(run.id, 1));
      if (r.ok) {
        const missing = new Set(r.value.missing);
        for (const id of part) {
          if (missing.has(id)) gate.failedRaw("enrich", String(id), { reason: "missing", message: "", waitUntil: null });
          else gate.doneRaw("enrich", String(id));
        }
      } else for (const id of part) gate.failedRaw("enrich", String(id), { reason: r.reason, message: r.message, waitUntil: r.waitUntil });
    }
  }

  private async generate(run: RunRow): Promise<void> {
    if (!this.d.backtest) {
      this.patchDetail(run.id, (dt) => ({ ...dt, notes: [...dt.notes.filter((n) => n.kind !== "notBacktested"), { kind: "notBacktested" }] }));
      return;
    }
    const r = await this.d.backtest.run(scopeOf(run), () => this.addCalls(run.id, 1), () => !this.stopped && this.isState(run.id, WIZARD_LIVE_STATES));
    this.patchDetail(run.id, (dt) => ({ ...dt, backtested: r.backtested }));
  }

  /**
   * 第 4 阶段（也是「重新计算」）：判一遍，写结论和总结。缓存里有的不再调模型。判完时运行已经被取消、接受了（或者
   * 退出了）就什么都不写，返回 false。replay：失败的单元不重试，只按现在的线重算。
   */
  private async judgePass(id: number, o: { replay?: boolean } = {}): Promise<boolean> {
    const run = this.row(id);
    if (!run) return false;
    const live = () => !this.stopped && this.isState(id, ["judging", "awaiting_accept"]);
    if (!live()) return false;
    const scope = scopeOf(run);
    const touched = new Set<string>();
    const r = await this.d.admission.judge(scope, {
      gate: this.gate(id, { touched, replay: o.replay }),
      onCall: () => this.addCalls(id, 1),
      seed: id,
      reviewBatch: run.plan_batch === null ? null : Number(run.plan_batch),
      live,
    });
    if (!live()) return false;
    // 这一遍没再碰的失败单元（组变了、规矩不再是候选）不会再有人重试：记成跳过，免得重试一直排在过去的时间上。
    this.dropStale(id, touched, false);
    this.writeVerdicts(id, r.verdicts);
    this.d.db
      .prepare(`UPDATE lesson_wizard_runs SET plan_batch = COALESCE(?, plan_batch), review_id = COALESCE(?, review_id), policy_version = ?, updated_at = ? WHERE id = ?`)
      .run(r.planBatch, r.reviewId, this.policyVersion(), this.d.now(), id);
    const fresh = this.row(id)!;
    this.patchDetail(id, (dt) => ({ ...dt, summary: this.summarize(fresh, r.verdicts) }));
    this.d.notify?.();
    return true;
  }

  /** 失败了、这一遍却没碰到的单元记成跳过（enrich = 只看补填的单元；否则看判的单元）。 */
  private dropStale(id: number, touched: ReadonlySet<string>, enrich: boolean): void {
    const rows = this.d.db
      .prepare(`SELECT kind, key FROM lesson_wizard_items WHERE run_id = ? AND status = 'failed' AND kind <> 'pr' AND ${enrich ? "kind = 'enrich'" : "kind <> 'enrich'"}`)
      .all(id) as { kind: string; key: string }[];
    const upd = this.d.db.prepare(`UPDATE lesson_wizard_items SET status = 'skipped', not_before = NULL WHERE run_id = ? AND kind = ? AND key = ?`);
    for (const r of rows) if (!touched.has(`${r.kind}:${r.key}`)) upd.run(id, r.kind, r.key);
  }

  /** 自动重试（或「重试」按钮）：先补填失败的，再判一遍。 */
  private async retryPass(id: number): Promise<void> {
    const run = this.row(id);
    if (!run || run.state !== "awaiting_accept" || this.stopped) return;
    await this.enrichPass(run);
    if (!(await this.judgePass(id))) return;
    this.scheduleRetry(id);
  }

  private scheduleRetry(id: number): void {
    if (this.stopped || !this.isState(id, ["awaiting_accept"])) return;
    const due = this.d.db
      .prepare(`SELECT MIN(not_before) AS at FROM lesson_wizard_items WHERE run_id = ? AND status = 'failed' AND kind <> 'pr' AND not_before IS NOT NULL AND attempts <= ?`)
      .get(id, WIZARD_MAX_ATTEMPTS) as { at: number | null };
    if (due.at === null) return;
    // 至少隔一秒：到期了的也不在同一刻再排一次。
    this.schedule(id, Math.max(1_000, Number(due.at) - this.d.now()), () => {
      void this.serial(id, () => this.retryPass(id)).catch((e: unknown) => this.d.log?.(`lesson wizard ${id}: retry failed`, e));
    });
  }

  private schedule(id: number, ms: number, fn: () => void): void {
    if (this.stopped) return;
    this.clearTimer(id);
    this.pending.set(
      id,
      this.timers.set(() => {
        this.pending.delete(id);
        fn();
      }, ms),
    );
  }

  private clearTimer(id: number): void {
    const h = this.pending.get(id);
    if (h !== undefined) this.timers.clear(h);
    this.pending.delete(id);
  }

  // ------------------------------------------------------------------ 工作单元的闸门

  /** 判断流水线用的闸门：每个单元在库里记尝试次数和下次可以试的时间。 */
  gate(runId: number, o: { touched?: Set<string>; replay?: boolean } = {}): ItemGate & {
    allowedRaw(kind: string, key: string): boolean;
    doneRaw(kind: string, key: string): void;
    failedRaw(kind: string, key: string, f: StepFailure): void;
  } {
    const get = this.d.db.prepare(`SELECT * FROM lesson_wizard_items WHERE run_id = ? AND kind = ? AND key = ?`);
    const upsert = this.d.db.prepare(
      `INSERT INTO lesson_wizard_items (run_id, kind, key, status, attempts, not_before, error) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, kind, key) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, not_before = excluded.not_before, error = excluded.error`,
    );
    const allowedRaw = (kind: string, key: string): boolean => {
      o.touched?.add(`${kind}:${key}`);
      const r = get.get(runId, kind, key) as unknown as ItemRow | undefined;
      if (!r) {
        upsert.run(runId, kind, key, "queued", 0, null, null);
        return true;
      }
      if (r.status !== "failed") return true;
      if (o.replay) return false;
      return Number(r.attempts) <= WIZARD_MAX_ATTEMPTS && (r.not_before === null || Number(r.not_before) <= this.d.now());
    };
    const doneRaw = (kind: string, key: string): void => void upsert.run(runId, kind, key, "done", (get.get(runId, kind, key) as unknown as ItemRow | undefined)?.attempts ?? 0, null, null);
    const failedRaw = (kind: string, key: string, f: StepFailure): void => {
      const prev = Number((get.get(runId, kind, key) as unknown as ItemRow | undefined)?.attempts ?? 0);
      // 限流：推到限额恢复的时候，不算一次尝试。
      if (f.waitUntil !== null) return void upsert.run(runId, kind, key, "failed", prev, Math.max(f.waitUntil, this.d.now() + WIZARD_POLL_MS), f.reason);
      const attempts = prev + 1;
      const at = attempts <= WIZARD_MAX_ATTEMPTS ? this.d.now() + WIZARD_RETRY_MS[attempts - 1] : null;
      upsert.run(runId, kind, key, "failed", attempts, at, f.message ? `${f.reason}: ${f.message}`.slice(0, 500) : f.reason);
    };
    return {
      allowed: (k: StepKind, key) => allowedRaw(k, key),
      done: (k: StepKind, key) => doneRaw(k, key),
      failed: (k: StepKind, key, f) => failedRaw(k, key, f),
      allowedRaw,
      doneRaw,
      failedRaw,
    };
  }

  // ------------------------------------------------------------------ 读

  view(id: number): WizardRunView | null {
    const r = this.row(id);
    if (!r) return null;
    const detail = this.detail(r);
    const prs = this.items(id, "pr");
    const enrich = this.items(id, "enrich");
    const failed: WizardFailedItem[] = this.d.db
      // PR 的失败归分析队列管（运行页上重试），这里只在总结里数。
      .prepare(`SELECT * FROM lesson_wizard_items WHERE run_id = ? AND status = 'failed' AND kind <> 'pr' ORDER BY kind, key`)
      .all(id)
      .map((x) => {
        const i = x as unknown as ItemRow;
        return { kind: i.kind, key: i.key, attempts: Number(i.attempts), retryAt: Number(i.attempts) > WIZARD_MAX_ATTEMPTS ? null : (i.not_before ?? null), error: i.error };
      });
    return {
      id: Number(r.id),
      scope: scopeOf(r),
      state: r.state,
      progress: {
        prs: { done: prs.filter((i) => i.status !== "queued" && i.status !== "running").length, total: prs.length },
        enrich: { done: enrich.filter((i) => i.status === "done").length, total: enrich.length },
      },
      calls: Number(r.calls),
      notes: detail.notes,
      summary: detail.summary ?? null,
      review: r.review_id === null ? null : this.d.admission.review(Number(r.review_id), scopeOf(r)),
      verdicts: this.verdicts(id),
      failed,
      planBatch: r.plan_batch === null ? null : Number(r.plan_batch),
      acceptBatch: r.accept_batch === null ? null : Number(r.accept_batch),
      error: r.error,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    };
  }

  /** 最近的几次（页面列出来，没结束的在最前面）。 */
  list(limit = 20): WizardRunView[] {
    return (this.d.db.prepare(`SELECT id FROM lesson_wizard_runs ORDER BY finished_at IS NOT NULL, id DESC LIMIT ?`).all(limit) as { id: number }[]).map((r) => this.view(Number(r.id))!);
  }

  private summarize(run: RunRow, verdicts: readonly LessonVerdict[]): WizardSummary {
    const prs = this.items(run.id, "pr");
    const shelved: Record<string, number> = {};
    let prose = 0;
    let checks = 0;
    for (const v of verdicts) {
      if (v.verdict === "shelved") shelved[v.reason ?? "other"] = (shelved[v.reason ?? "other"] ?? 0) + 1;
      if (v.verdict === "admit") {
        if (v.check) checks++;
        else prose++;
      }
    }
    const review = run.review_id === null ? null : this.d.admission.review(Number(run.review_id), scopeOf(run));
    return {
      prs: {
        total: prs.length,
        analysed: prs.filter((i) => i.status === "done").length,
        failed: prs.filter((i) => i.status === "failed").length,
        skipped: prs.filter((i) => i.status === "skipped").length,
      },
      candidates: verdicts.length,
      admitted: { prose, checks },
      merged: verdicts.filter((v) => v.verdict === "merged").length,
      shelved,
      covered: verdicts.filter((v) => v.verdict === "covered").length,
      unfinished: verdicts.filter((v) => v.verdict === "unfinished").length,
      passRate: review?.passRate ?? null,
      sameModelReview: review?.sameModelReview ?? false,
      backtested: this.detail(run).backtested === true,
      calls: Number(run.calls),
    };
  }

  private writeVerdicts(id: number, verdicts: readonly LessonVerdict[]): void {
    const ins = this.d.db.prepare(`INSERT INTO lesson_wizard_verdicts (run_id, lesson_id, verdict, reason, ref, score) VALUES (?, ?, ?, ?, ?, ?)`);
    withTransaction(this.d.db, () => {
      this.d.db.prepare(`DELETE FROM lesson_wizard_verdicts WHERE run_id = ?`).run(id);
      for (const v of verdicts) ins.run(id, v.lessonId, v.verdict, v.reason, v.ref, v.score);
    });
  }

  verdicts(id: number): WizardVerdict[] {
    return (this.d.db.prepare(`SELECT * FROM lesson_wizard_verdicts WHERE run_id = ? ORDER BY lesson_id`).all(id) as { lesson_id: number; verdict: WizardVerdict["verdict"]; reason: string | null; ref: number | null; score: number | null }[]).map(
      (v) => ({ lessonId: Number(v.lesson_id), verdict: v.verdict, reason: v.reason, ref: v.ref === null ? null : Number(v.ref), score: v.score }),
    );
  }

  private row(id: number): RunRow | null {
    return (this.d.db.prepare(`SELECT * FROM lesson_wizard_runs WHERE id = ?`).get(id) as unknown as RunRow | undefined) ?? null;
  }

  private items(id: number, kind: string): ItemRow[] {
    return this.d.db.prepare(`SELECT * FROM lesson_wizard_items WHERE run_id = ? AND kind = ?`).all(id, kind) as unknown as ItemRow[];
  }

  private detail(r: RunRow): Detail {
    try {
      const d = JSON.parse(r.detail) as Detail;
      return { ...d, notes: Array.isArray(d.notes) ? d.notes : [] };
    } catch {
      return { notes: [] };
    }
  }

  private patchDetail(id: number, fn: (d: Detail) => Detail): void {
    const r = this.row(id);
    if (!r) return;
    this.d.db.prepare(`UPDATE lesson_wizard_runs SET detail = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(fn(this.detail(r))), this.d.now(), id);
  }

  /** 状态只从 from 里的某一个换成 to（比较并交换）；换了返回 true。取消、接受和推进因此不会互相覆盖。 */
  private advance(id: number, from: readonly WizardState[], to: WizardState, o: { finished?: boolean } = {}): boolean {
    if (this.stopped) return false;
    const now = this.d.now();
    const marks = from.map(() => "?").join(",");
    const r = this.d.db
      .prepare(`UPDATE lesson_wizard_runs SET state = ?, updated_at = ?, finished_at = CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE finished_at END WHERE id = ? AND state IN (${marks})`)
      .run(to, now, o.finished ? 1 : 0, now, o.finished === false ? 1 : 0, id, ...from);
    if (Number(r.changes) === 0) return false;
    this.d.notify?.();
    return true;
  }

  private isState(id: number, states: readonly WizardState[]): boolean {
    const r = this.row(id);
    return r !== null && states.includes(r.state);
  }

  private addCalls(id: number, n: number): void {
    this.d.db.prepare(`UPDATE lesson_wizard_runs SET calls = calls + ? WHERE id = ?`).run(n, id);
  }

  private policyVersion(): number {
    return this.d.policyVersion();
  }
}
