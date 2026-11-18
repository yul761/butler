import { BatchRecorder } from "../../../batches/batch-recorder";
import { checkAdapter, lessonAdapter, policyAdapter, productAdapter } from "../../../batches/table-adapter";
import { ChecksService } from "../../../checks/checks-service";
import { LessonRunsRepo } from "../../../db/lesson-runs-repo";
import { LessonsRepo, type NewLessonSource } from "../../../db/lessons-repo";
import type { ExecOptions, HeadlessExecResult } from "../../../handoff/headless-exec";
import { memDb } from "../../../test-utils";
import { AdmissionPolicyService } from "../../admission-policies";
import { LessonBatchService } from "../../lesson-batches";
import { JudgmentCache } from "../judgments";
import type { TaskId } from "../../../../shared/model-routing";

export type FakeAnswer = (req: ExecOptions) => unknown;

/** 假的模型：按 task 找回答函数；没有回答的 task 当成调用失败。回答可以返回一个 HeadlessExecResult（模拟失败或限流）。 */
export function fakeRunner(answers: Partial<Record<TaskId, FakeAnswer>>, model = "fake-mid") {
  const calls: ExecOptions[] = [];
  const run = async (req: ExecOptions): Promise<HeadlessExecResult> => {
    calls.push(req);
    const route = { task: req.task, requestedTier: "mid" as const, actualModel: model, fallbackFrom: null, degraded: false, sameModelReview: false };
    const a = answers[req.task];
    if (!a) return { ok: false, reason: "claude_error", message: `no fake answer for ${req.task}`, limit: null, stderr: "", result: null, rawText: null, route };
    const v = a(req);
    if (v && typeof v === "object" && "ok" in v && (v as { ok: unknown }).ok === false) return { route, ...(v as object) } as HeadlessExecResult;
    return { ok: true, value: v, rawText: JSON.stringify(v), result: {} as never, route };
  };
  return { run, calls, of: (task: TaskId) => calls.filter((c) => c.task === task) };
}

export const failed = (reason = "claude_error", waitUntil?: number) => ({
  ok: false, reason, message: "boom", limit: null, stderr: "", result: null, rawText: null, ...(waitUntil !== undefined ? { waitUntil } : {}),
});

/** 规矩准入测试的一套：仓库 acme/web、acme/api，内存数据库，批次、检查、策略都接好。 */
export function setupAdmission(now = 1_000_000) {
  const db = memDb();
  const repo = new LessonsRepo(db);
  repo.upsertRepo("acme/web", "/definitely/missing/web", 1);
  repo.upsertRepo("acme/api", "/definitely/missing/api", 1);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db), checkAdapter(db)]);
  const clock = { now };
  const checks = new ChecksService({ db, lessons: repo, recorder, now: () => clock.now, config: () => ({ enabled: true, editTimeoutSec: 8, pushTimeoutSec: 600, ticketPattern: "X-\\d+" }) });
  let version = 1;
  const policies = new AdmissionPolicyService({ db, repo, recorder, version: { get: () => version, set: (v) => (version = v) }, now: () => clock.now });
  const batches = new LessonBatchService({ db, repo, recorder, now: () => clock.now, onPolicyChanged: () => policies.bumpVersion() });
  const runs = new LessonRunsRepo(db);
  const judgments = new JudgmentCache(db);
  let pr = 100;
  /** 加一条规矩；sources 给多条出处时第一条是新建，其余是命中。 */
  const lesson = (text: string, o: { slug?: string; at?: number; sources?: Partial<NewLessonSource>[]; status?: "pending" | "confirmed" } = {}) => {
    const slug = o.slug ?? "acme/web";
    const at = o.at ?? clock.now;
    const srcs = o.sources ?? [{}];
    const mk = (s: Partial<NewLessonSource>): NewLessonSource => {
      const n = s.prNumber ?? ++pr;
      return { prNumber: n, url: `https://github.com/${slug}/pull/${n}#r${n}`, slug, runId: null, ...s };
    };
    const id = repo.addLesson({ scope: { kind: "repo", slug }, text, why: `why ${text}`, at, source: mk(srcs[0]) });
    for (const s of srcs.slice(1)) repo.hit(id, at, mk(s));
    if (o.status === "confirmed") repo.setStatus(id, "confirmed", at);
    return id;
  };
  return { db, repo, recorder, checks, policies, batches, runs, judgments, clock, lesson };
}
