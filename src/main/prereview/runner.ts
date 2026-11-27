// 预审的后台处理函数（设计 §4.2）：取 diff → 选规矩 → 收检查结果 → 复跑 → 两次模型调用（并行）→ 写结果 → 评估和简报 → 递送。
// 可打断：检查点存复跑做到哪、已经拿到的模型结果。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BgHandler, BgJobContext, BgJobResult } from "../background/queue";
import type { PreReviewRepo, PreReviewRow, StoredEvidence } from "../db/prereview-repo";
import type { Candidate } from "../routing/router";
import type { RepoProfile } from "../../shared/baselines";
import type { CheckHitView } from "../../shared/checks";
import type { Lesson } from "../../shared/lessons";
import type { ResolvedPrPolicy } from "../../shared/pr-policy";
import type { CheckSummary, DiffFile, EvidenceVerified, Violation } from "../../shared/prereview";
import { diffForModel, type PrDiff } from "./diff";
import { preReviewByModel, verifyEvidenceByModel, type ExecRun, type Lang, type PreReviewModelResult } from "./model";
import { applyRerun, rerunEvidence, rerunPlan, rerunSummary, type RerunDeps, type RerunOutcome, type RerunResult } from "./rerun";

/** pre_reviews.files 最多存这么多个（设计 §2）。 */
export const PRE_REVIEW_MAX_FILES = 1000;

export interface PreReviewPayload {
  preReviewId: number;
}

interface Checkpoint {
  rerun?: RerunResult[];
  rerunDone?: RerunOutcome;
  review?: PreReviewModelResult;
  verify?: { ok: true; verdicts: [number, { verified: EvidenceVerified; detail: string }][]; model: string | null } | { ok: false; detail: string };
}

export interface RunnerDeps {
  repo: PreReviewRepo;
  /** 这份代码的 diff（worktree 里算，不行就走 GitHub compare）；拿不到为 null。 */
  diff(row: PreReviewRow): Promise<PrDiff | null>;
  lessons(slug: string, files: string[]): { lessons: Lesson[]; total: number };
  /** session 的检查情况（E1）：checks_absent 和命中。没有 session 时 absent 为 null、hits 为空。 */
  checks(sessionId: string | null): { absent: string | null; hits: CheckHitView[] };
  /** PR 的 CI；没有 PR 为 null。 */
  ci(prId: number | null): "pending" | "passing" | "failing" | null;
  profile(slug: string): RepoProfile | null;
  policy(slug: string): ResolvedPrPolicy;
  ticketTitle(key: string | null): string | null;
  /** 开发 session 的模型（审查方尽量换一个）。 */
  producer(sessionId: string | null): Candidate | null;
  exec: ExecRun;
  rerun: Omit<RerunDeps, "signal">;
  /** 多仓库 ticket：其他仓库的目录（只读工具能看到）。 */
  addDirs?(row: PreReviewRow): string[];
  lang(): Lang;
  /** 预审写完以后：算就绪、风险，生成简报（T8）。抛错只记日志。 */
  after(row: PreReviewRow): Promise<void>;
  /** 送进 session（没有 session 或送不到就留着，roundDone 再试）。 */
  deliver(row: PreReviewRow): Promise<void>;
  /** 开跑、出结论、放回队列时：界面马上刷新（notify）。 */
  changed?(): void;
  now(): number;
  log(msg: string, err?: unknown): void;
}

/** 还没 resolved 的失败，按检查汇总（同一个检查、同一个文件只看最新的一条；判成误报的不算）。 */
export function summarizeHits(hits: readonly CheckHitView[]): CheckSummary["failing"] {
  const last = new Map<string, CheckHitView>();
  for (const h of [...hits].sort((a, b) => a.at - b.at || a.id - b.id)) {
    if (h.outcome !== "fail" && h.outcome !== "resolved") continue;
    last.set(`${h.checkKey}\0${h.file}`, h);
  }
  const by = new Map<string, CheckSummary["failing"][number]>();
  for (const h of last.values()) {
    if (h.outcome !== "fail" || h.verdict === "false_positive") continue;
    const g = by.get(h.checkKey) ?? { checkKey: h.checkKey, name: h.checkKey, severity: h.severity === "block" ? "block" : "warn", mode: h.mode === "enforce" ? "enforce" : "shadow", files: [], count: 0 };
    if (!g.files.includes(h.file)) g.files.push(h.file);
    g.count++;
    if (h.severity === "block") g.severity = "block";
    if (h.mode === "enforce") g.mode = "enforce";
    by.set(h.checkKey, g);
  }
  return [...by.values()].sort((a, b) => (a.checkKey < b.checkKey ? -1 : 1));
}

/** 结论（设计 §4.4）：没有 must 违规、没有未解决的 block 级（enforce）检查失败 = clean。 */
export function verdictOf(violations: readonly Violation[], failing: CheckSummary["failing"]): "clean" | "violations" {
  const blocking = failing.some((f) => f.severity === "block" && f.mode === "enforce");
  return violations.some((v) => v.severity === "must") || blocking ? "violations" : "clean";
}

/** 要交叉核对的证据：复跑没定下来的那些（检查、验收、UI；没跑的说明不核对）。 */
const toVerify = (items: readonly StoredEvidence[]) => items.filter((i) => i.verified === "pending" && i.kind !== "not_run");

export function makePreReviewHandler(d: RunnerDeps): BgHandler {
  return async (ctx: BgJobContext): Promise<BgJobResult> => {
    const id = Number((ctx.payload as PreReviewPayload | null)?.preReviewId);
    const row = Number.isFinite(id) ? d.repo.get(id) : null;
    if (!row) return { done: true };
    if (row.status !== "queued" && row.status !== "running") return { done: true };
    // 开跑的时间在标 running 的这一刻取（界面算「预审中 N 分钟」）。
    d.repo.update(row.id, { status: "running", jobId: ctx.id, startedAt: d.now() });
    d.changed?.();
    // 让路时放回 queued（新证据能取代它）；中途抛错收成 failed，不留一行永远「进行中」。
    // 放回之前重读：等的这段时间里被取消了（行已经是 skipped）就不放回。
    const requeue = () => {
      if (d.repo.get(row.id)?.status !== "running") return;
      d.repo.update(row.id, { status: "queued", startedAt: null });
      d.changed?.();
    };
    try {
      const r = await runOnce(d, ctx, row);
      if ("defer" in r) requeue();
      return r;
    } catch (e) {
      if (ctx.signal.aborted) {
        requeue();
        return { defer: true };
      }
      d.log(`pre-review ${row.id}: failed`, e);
      d.repo.update(row.id, { status: "failed", verdict: "error", detail: `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500), finishedAt: d.now() });
      d.changed?.();
      await afterAndDeliver(d, row.id);
      return { done: true };
    }
  };
}

/** 没有 worktree 时给模型的目录：空的临时目录，免得它带着 Read/Grep 在 Shipherd 自己的工作目录里看。 */
const emptyCwd = (): string => mkdtempSync(join(tmpdir(), "shipherd-prereview-"));

async function runOnce(d: RunnerDeps, ctx: BgJobContext, row: PreReviewRow): Promise<BgJobResult> {
  const cp: Checkpoint = (ctx.checkpoint as Checkpoint | null) ?? {};
  const save = () => ctx.save(cp);
  const finishFailed = async (detail: string): Promise<BgJobResult> => {
    d.repo.update(row.id, { status: "failed", verdict: "error", detail: detail.slice(0, 500), finishedAt: d.now() });
    d.changed?.();
    await afterAndDeliver(d, row.id);
    return { done: true };
  };

  let diff: PrDiff | null;
  try {
    diff = await d.diff(row);
  } catch (e) {
    d.log(`pre-review ${row.id}: diff failed`, e);
    diff = null;
  }
  if (ctx.signal.aborted) return { defer: true };
  if (!diff) return finishFailed("diff unavailable");
  const files: DiffFile[] = diff.files.slice(0, PRE_REVIEW_MAX_FILES);
  const paths = files.map((f) => f.path);
  const slug = row.target.repoSlug;
  const policy = d.policy(slug);
  const profile = d.profile(slug);
  const { lessons, total } = d.lessons(slug, paths);
  const checks = d.checks(row.sessionId);
  const failing = summarizeHits(checks.hits);
  d.repo.update(row.id, { base: diff.base ?? row.base, files, lessonIds: lessons.map((l) => l.id) });

  // 1. 复跑（有检查类证据、有 worktree 时）。
  let evidence = d.repo.evidenceOf(row.id);
  let outcome: RerunOutcome | null = cp.rerunDone ?? null;
  if (!outcome && row.cwd && evidence.some((e) => e.kind === "check")) {
    const plan = rerunPlan(profile, paths, policy.evidence.rerun);
    outcome = await rerunEvidence(
      { cwd: row.cwd, sha: row.target.headSha, plan, timeoutSec: policy.evidence.rerunTimeoutSec, done: cp.rerun, onResult: (_r, all) => ((cp.rerun = all), save()) },
      { ...d.rerun, signal: ctx.signal },
    );
    if (outcome.kind === "interrupted") {
      cp.rerun = outcome.results;
      save();
      return { defer: true };
    }
    cp.rerunDone = outcome;
    save();
  }
  const at = d.now();
  for (const v of applyRerun(evidence, outcome)) d.repo.setVerified(v.id, v.verified, v.detail, v.rerunOutput, at);
  evidence = d.repo.evidenceOf(row.id);
  const summary: CheckSummary = { absent: checks.absent, failing, ci: d.ci(row.prId), rerun: outcome?.kind === "ran" ? rerunSummary(outcome.results) : [] };

  // 2. 两次模型调用（互不依赖，并行）。
  const lang = d.lang();
  const producer = d.producer(row.sessionId);
  const ticketTitle = d.ticketTitle(row.ticketKey);
  const { text: diffText } = diffForModel(diff, policy.risk.paths.generated);
  const pending = toVerify(evidence);
  const modelCwd = row.cwd ?? emptyCwd();
  const [review, verify] = await Promise.all([
    cp.review ??
      preReviewByModel(d.exec, {
        cwd: modelCwd, addDirs: d.addDirs?.(row), ticketKey: row.ticketKey, ticketTitle, producer, files, diffText,
        lessons: lessons.map((l) => ({ id: l.id, text: l.text, strength: l.strength, scopeGlobs: l.scopeGlobs })), lessonsTotal: total,
        checks: summary, evidence, lang,
      }).then((r) => {
        // 让路时模型调用不会停：拿到的结果照样存下，下次不用再调一遍。
        if (r.ok) {
          cp.review = r;
          save();
        }
        return r;
      }),
    cp.verify ??
      verifyEvidenceByModel(d.exec, { cwd: modelCwd, ticketKey: row.ticketKey, ticketTitle, producer, items: pending, rerun: summary.rerun, files, lang }).then((r) => {
        const stored: Checkpoint["verify"] = r.ok ? { ok: true, verdicts: [...r.verdicts], model: r.model } : r;
        if (r.ok) {
          cp.verify = stored;
          save();
        }
        return stored;
      }),
  ]);
  if (!row.cwd) rmSync(modelCwd, { recursive: true, force: true });
  if (ctx.signal.aborted) return { defer: true };
  // 模型调用期间被取消了（队列页、总控）：行已经是 skipped，结果丢掉，不写回。
  if (d.repo.get(row.id)?.status !== "running") return { done: true };

  // 3. 证据核实结果：模型没定的、调用失败的记 unverifiable。
  const verdicts = new Map(verify.ok ? verify.verdicts : []);
  const at2 = d.now();
  for (const e of pending) {
    const v = verdicts.get(e.id);
    d.repo.setVerified(e.id, v?.verified ?? "unverifiable", v?.detail ?? (verify.ok ? "not judged" : `cross-check failed: ${verify.detail}`), null, at2);
  }

  // 4. 结论。
  if (!review.ok) {
    d.repo.update(row.id, { checks: summary, status: "failed", verdict: "error", detail: review.detail, finishedAt: d.now() });
  } else {
    d.repo.update(row.id, {
      checks: summary, violations: review.violations, summary: review.summary, verdict: verdictOf(review.violations, failing),
      model: review.model, status: "done", detail: total > lessons.length ? `${total - lessons.length} rules left out` : null, finishedAt: d.now(),
    });
  }
  // 结论一写下就刷新：后面的评估、简报还要一会儿，界面不能一直显示「预审中」。
  d.changed?.();
  await afterAndDeliver(d, row.id);
  return { done: true };
}

async function afterAndDeliver(d: RunnerDeps, id: number): Promise<void> {
  const row = d.repo.get(id);
  if (!row) return;
  try {
    await d.after(row);
  } catch (e) {
    d.log(`pre-review ${id}: assessment or brief failed`, e);
  }
  try {
    await d.deliver(d.repo.get(id) ?? row);
  } catch (e) {
    d.log(`pre-review ${id}: delivery failed`, e);
  }
}
