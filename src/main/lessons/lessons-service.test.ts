import { describe, expect, it, vi } from "vitest";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { LessonRunsRepo } from "../db/lesson-runs-repo";
import type { LessonsGate } from "../claude/availability";
import type { LessonQueueRow } from "../db/lessons-repo";
import type { LessonRunDetail } from "../../shared/lessons";
import type { OpenSessionResult } from "../../shared/types";
import { RepoIdentity } from "./repo-identity";
import { LessonsService, queueRowStatus } from "./lessons-service";
import { LessonBatchService } from "./lesson-batches";
import { BatchRecorder } from "../batches/batch-recorder";
import { lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";

const git = (p: string): string | null => (p.startsWith("/none") ? null : `git@github.com:${p.slice(1).replace("_", "/")}.git`);
const src = { prNumber: 1, url: "https://github.com/acme/web/pull/1", slug: "acme/web", runId: null };

// path.join 在 Windows 上用反斜杠：比较前先统一成 /。
const posix = (p: string): string => p.replace(/\\/g, "/");

const setup = (over: { paths?: string[]; groups?: string[][]; exists?: (p: string) => boolean } = {}) => {
  const given = over.exists;
  const exists = given ? (p: string) => given(posix(p)) : (p: string) => !posix(p).startsWith("/none") || !posix(p).endsWith(".git");
  const db = memDb();
  const repo = new LessonsRepo(db);
  const runs = new LessonRunsRepo(db);
  const openExternal = vi.fn();
  const notify = vi.fn();
  const backfill = vi.fn(async () => ({ ok: true as const, enqueued: 3, prs: [1, 2, 3] }));
  const runner = {
    backfill,
    cancel: vi.fn((): "ok" | "not_found" | "bad_status" => "ok"),
    retry: vi.fn((): "ok" | "not_found" | "bad_status" => "ok"),
    retryFailed: vi.fn(() => 2),
    runNow: vi.fn(),
    running: vi.fn((): { queueId: number; runId: number; slug: string; prNumber: number; startedAt: number }[] => []),
  };
  const gate: { value: LessonsGate } = { value: { paused: false } };
  const availability = { lessonsGate: vi.fn(() => gate.value), pauseLessons: vi.fn(), resumeLessons: vi.fn() };
  const openRun = vi.fn<(d: LessonRunDetail, repoPath: string) => Promise<OpenSessionResult>>(async () => ({ ok: true, termId: "term-1", alreadyOpen: false }));
  const log = vi.fn();
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db)]);
  const batches = new LessonBatchService({ db, repo, recorder, now: () => 100 });
  const svc = new LessonsService({
    repo, batches, runs, availability, identity: new RepoIdentity({ git, exists }), runner, openRun, log,
    knownRepoPaths: () => over.paths ?? ["/acme_web", "/acme_api", "/none_x"],
    repoGroups: () => over.groups ?? [],
    exists,
    ghAvailable: () => true, openExternal, now: () => 100, notify,
  });
  svc.state();
  const add = (slug: string, text = "t") => repo.addLesson({ scope: { kind: "repo", slug }, text, why: "w", at: 1, source: src });
  return { db, recorder, batches, repo, runs, svc, openExternal, notify, backfill, add, runner, availability, gate, openRun, log };
};

describe("LessonsService.state", () => {
  it("splits known paths into repos and unknown repos, one repo per slug", () => {
    const { svc } = setup({ paths: ["/acme_web", "/acme_web", "/acme_api", "/none_x"] });
    const s = svc.state();
    expect(s.repos.map((r) => r.slug)).toEqual(["acme/api", "acme/web"]);
    expect(s.unknownRepos).toEqual([{ path: "/none_x", reason: "not_git" }]);
    expect(s.ghAvailable).toBe(true);
  });

  it("does not upsert an unchanged repo", () => {
    const { svc, repo } = setup();
    const spy = vi.spyOn(repo, "upsertRepo");
    svc.state();
    svc.state();
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips paths that do not exist", () => {
    const { svc } = setup({ paths: ["/acme_web", "/gone_x"], exists: (p) => !p.startsWith("/gone") });
    const s = svc.state();
    expect(s.repos.map((r) => r.slug)).toEqual(["acme/web"]);
    expect(s.unknownRepos).toEqual([]);
  });

  it("upserts once when the stored path is no longer a candidate", () => {
    const paths = ["/acme_web"];
    const { svc, repo } = setup({ paths });
    paths[0] = "/acme_web2";
    const spy = vi.spyOn(repo, "upsertRepo");
    svc.state();
    svc.state();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe("/acme_web2");
  });

  it("writes the first of several paths for one slug once, and keeps a stored candidate", () => {
    const both = ["/acme_web", "/acme_web2"];
    const a = setup({ paths: [] });
    const spyA = vi.spyOn(a.repo, "upsertRepo");
    const svcA = new LessonsService({
      repo: a.repo, batches: a.batches, runs: a.runs, availability: a.availability, identity: new RepoIdentity({ git: () => "git@github.com:acme/web.git", exists: () => true }), runner: a.runner, openRun: a.openRun,
      knownRepoPaths: () => both, repoGroups: () => [], exists: () => true,
      ghAvailable: () => true, openExternal: a.openExternal, now: () => 100, notify: a.notify,
    });
    svcA.state();
    svcA.state();
    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyA.mock.calls[0][1]).toBe("/acme_web");
    a.repo.upsertRepo("acme/web", "/acme_web2", 1);
    spyA.mockClear();
    svcA.state();
    expect(spyA).not.toHaveBeenCalled();
  });

  it("reports queued/failed, overflow and hides rejected lessons", () => {
    const { svc, repo, add } = setup();
    for (let i = 0; i < 35; i++) repo.setStatus(add("acme/web", `l${i}`), "confirmed", 2);
    const rej = add("acme/web", "no");
    repo.setStatus(rej, "rejected", 2);
    repo.enqueue("acme/web", [1, 2, 3], "backfill", 1);
    const a = repo.take(1)!;
    repo.finish(a.id, "failed", 2, "boom");
    const web = svc.state().repos.find((r) => r.slug === "acme/web")!;
    expect(web.overflow).toBe(5);
    expect(web.failed).toBe(1);
    expect(web.queued).toBe(2);
    const s = svc.state();
    expect(s.lessons).toHaveLength(35);
    expect(s.lessons.some((l) => l.id === rej)).toBe(false);
  });

  it("suggests products from repo groups mapped to slugs", () => {
    const { svc } = setup({ groups: [["/acme_web", "/acme_api"], ["/acme_api", "/acme_web"], ["/none_x"]] });
    expect(svc.state().suggestions).toEqual([{ slugs: ["acme/api", "acme/web"], together: 2 }]);
  });
});

describe("LessonsService.act", () => {
  it("confirm with text sets the text first and notifies", async () => {
    const { svc, repo, add, notify } = setup();
    svc.state();
    const id = add("acme/web", "old");
    expect(await svc.act({ op: "confirm", id, text: "新正文" })).toMatchObject({ ok: true, affected: 1 });
    expect(repo.get(id)).toMatchObject({ status: "confirmed", text: "新正文" });
    expect(notify).toHaveBeenCalled();
  });

  it("merge rejects different scopes, same lesson and missing lessons", async () => {
    const { svc, repo, add, notify } = setup();
    const a = add("acme/web");
    const b = add("acme/api");
    expect(await svc.act({ op: "merge", keepId: a, dropId: b, text: "x" })).toEqual({ ok: false, reason: "scope_mismatch" });
    expect(await svc.act({ op: "merge", keepId: a, dropId: a, text: "x" })).toEqual({ ok: false, reason: "same_lesson" });
    expect(await svc.act({ op: "merge", keepId: a, dropId: 999, text: "x" })).toEqual({ ok: false, reason: "not_found" });
    expect(repo.get(a)?.hits).toBe(1);
    expect(notify).not.toHaveBeenCalled();
    const c = add("acme/web");
    expect(await svc.act({ op: "merge", keepId: a, dropId: c, text: "x" })).toMatchObject({ ok: true, affected: 2 });
    expect(repo.get(c)?.mergedInto).toBe(a);
  });

  it("returns not_found for a lesson id that does not exist", async () => {
    const { svc } = setup();
    expect(await svc.act({ op: "reject", id: 42 })).toEqual({ ok: false, reason: "not_found" });
    expect(await svc.act({ op: "edit", id: 42, text: "x" })).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects an existing product name", async () => {
    const { svc } = setup();
    expect(await svc.act({ op: "createProduct", name: "shop", slugs: [] })).toEqual({ ok: true });
    expect(await svc.act({ op: "createProduct", name: "shop", slugs: [] })).toEqual({ ok: false, reason: "name_taken" });
  });

  it("openSource only opens https urls", async () => {
    const { svc, repo, add, openExternal } = setup();
    const id = add("acme/web");
    const good = repo.get(id)!.sources[0]!.id;
    expect(await svc.act({ op: "openSource", sourceId: good })).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/web/pull/1");
    repo.hit(id, 2, { prNumber: 2, url: "javascript:alert(1)", slug: "acme/web", runId: null });
    const bad = repo.get(id)!.sources.find((s) => s.prNumber === 2)!.id;
    expect(await svc.act({ op: "openSource", sourceId: bad })).toEqual({ ok: false, reason: "bad_url" });
    expect(openExternal).toHaveBeenCalledTimes(1);
    repo.hit(id, 3, { prNumber: 3, url: "https://evil.example/github.com/x", slug: "acme/web", runId: null });
    const foreign = repo.get(id)!.sources.find((s) => s.prNumber === 3)!.id;
    expect(await svc.act({ op: "openSource", sourceId: foreign })).toEqual({ ok: false, reason: "bad_url" });
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("openSource accepts a known enterprise host and rejects credentials and lookalikes", async () => {
    const { svc, repo, add, openExternal } = setup();
    repo.upsertRepo("ghe.acme.io/t/a", "/ghe", 1);
    const id = add("acme/web");
    const source = (n: number, url: string) => {
      repo.hit(id, n, { prNumber: n, url, slug: "acme/web", runId: null });
      return repo.get(id)!.sources.find((s) => s.prNumber === n)!.id;
    };
    expect(await svc.act({ op: "openSource", sourceId: source(2, "https://ghe.acme.io/t/a/pull/3") })).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith("https://ghe.acme.io/t/a/pull/3");
    const bad = ["https://github.com@evil.com/a/b/pull/1", "https://github.com.evil.com/a/b", "https://evilgithub.com/a", "https://user:pw@github.com/a"];
    for (const [i, url] of bad.entries()) {
      expect(await svc.act({ op: "openSource", sourceId: source(10 + i, url) }), url).toEqual({ ok: false, reason: "bad_url" });
    }
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("backfill returns the runner result as is", async () => {
    const { svc, backfill } = setup();
    expect(await svc.act({ op: "backfill", slug: "acme/web" })).toEqual({ ok: true, enqueued: 3 });
    expect(backfill).toHaveBeenCalledWith("acme/web");
  });
});

describe("LessonsService.pendingCount", () => {
  it("counts pending only", () => {
    const { svc, repo, add } = setup();
    add("acme/web");
    add("acme/web");
    repo.setStatus(add("acme/web"), "confirmed", 2);
    expect(svc.pendingCount()).toBe(2);
  });
});

describe("LessonsService product and confirm guards", () => {
  it("confirm on a rejected lesson returns bad_status and leaves it rejected", async () => {
    const { svc, repo, add } = setup();
    const id = add("acme/web");
    repo.setStatus(id, "rejected", 1);
    expect(await svc.act({ op: "confirm", id })).toEqual({ ok: false, reason: "bad_status" });
    expect(repo.get(id)?.status).toBe("rejected");
  });

  it("setDisabled on a pending lesson returns bad_status", async () => {
    const { svc, repo, add } = setup();
    const id = add("acme/web");
    expect(await svc.act({ op: "setDisabled", id, disabled: true })).toEqual({ ok: false, reason: "bad_status" });
    expect(repo.get(id)?.status).toBe("pending");
  });

  it("disable then enable returns to confirmed", async () => {
    const { svc, repo, add } = setup();
    const id = add("acme/web");
    repo.setStatus(id, "confirmed", 1);
    expect(await svc.act({ op: "setDisabled", id, disabled: true })).toMatchObject({ ok: true, affected: 1 });
    expect(repo.get(id)?.status).toBe("disabled");
    expect(await svc.act({ op: "setDisabled", id, disabled: false })).toMatchObject({ ok: true, affected: 1 });
    expect(repo.get(id)?.status).toBe("confirmed");
  });

  it("deleteProduct on a missing id returns product_not_found", async () => {
    const { svc } = setup();
    expect(await svc.act({ op: "deleteProduct", id: 999 })).toEqual({ ok: false, reason: "product_not_found" });
  });

  it("addToProduct on a missing product returns product_not_found, not an FK error", async () => {
    const { svc } = setup();
    expect(await svc.act({ op: "addToProduct", id: 999, slug: "acme/web" })).toEqual({ ok: false, reason: "product_not_found" });
  });

  it("addToProduct with an unknown slug and removeFromProduct on a missing product return product_not_found", async () => {
    const { svc, repo } = setup();
    const pid = repo.createProduct("p", [], 1);
    expect(await svc.act({ op: "addToProduct", id: pid, slug: "no/such" })).toEqual({ ok: false, reason: "product_not_found" });
    expect(await svc.act({ op: "removeFromProduct", id: 999, slug: "acme/web" })).toEqual({ ok: false, reason: "product_not_found" });
  });
});

const qrow = (over: Partial<LessonQueueRow>): LessonQueueRow => ({
  id: 1, prNumber: 1, origin: "merged", status: "queued", error: null, errorMessage: null, attempts: 0, lastRunId: null, enqueuedAt: 0, finishedAt: null, notBefore: null, ...over,
});

describe("queueRowStatus", () => {
  it("maps limited, waiting and cancelled", () => {
    expect(queueRowStatus(qrow({ status: "running" }), null, 10)).toBe("running");
    const limit = { paused: true, reason: "limit" } as const;
    expect(queueRowStatus(qrow({ status: "queued" }), { status: "limited" }, 10, limit)).toBe("limited");
    expect(queueRowStatus(qrow({ status: "queued" }), { status: "limited" }, 10)).toBe("queued");
    expect(queueRowStatus(qrow({ status: "queued", notBefore: 50 }), { status: "limited" }, 10)).toBe("waiting");
    expect(queueRowStatus(qrow({ status: "queued" }), { status: "limited" }, 10, { paused: true, reason: "manual" })).toBe("queued");
    expect(queueRowStatus(qrow({ status: "queued", notBefore: 50 }), null, 10)).toBe("waiting");
    expect(queueRowStatus(qrow({ status: "queued", notBefore: 5 }), null, 10)).toBe("queued");
    expect(queueRowStatus(qrow({ status: "skipped", error: "cancelled" }), null, 10)).toBe("cancelled");
    expect(queueRowStatus(qrow({ status: "skipped", error: null }), null, 10)).toBe("skipped");
    expect(queueRowStatus(qrow({ status: "failed", error: "gh" }), null, 10)).toBe("failed");
    expect(queueRowStatus(qrow({ status: "done" }), null, 10)).toBe("done");
  });
});

describe("LessonsService queue views", () => {
  it("state reports running items, queued total and the pause", () => {
    const { svc, repo, runner, gate } = setup();
    repo.enqueue("acme/web", [1, 2, 3], "backfill", 1);
    const item = { queueId: 9, runId: 4, slug: "acme/web", prNumber: 1, startedAt: 7 };
    runner.running.mockReturnValue([item]);
    expect(svc.state().queue).toEqual({ running: [item], queued: 3, pause: null });
    gate.value = { paused: true, reason: "limit", until: 500, message: "resets soon" };
    expect(svc.state().queue.pause).toEqual({ reason: "limit", until: 500, message: "resets soon" });
  });

  it("repo view counts skipped and cancelled", () => {
    const { svc, repo } = setup();
    repo.enqueue("acme/web", [1, 2, 3], "backfill", 1);
    const a = repo.take(1)!;
    repo.finish(a.id, "skipped", 2);
    const b = repo.take(1)!;
    repo.defer(b.id, 99);
    repo.cancelQueued(b.id, 3);
    const web = svc.state().repos.find((r) => r.slug === "acme/web")!;
    expect(web).toMatchObject({ queued: 1, running: 0, failed: 0, skipped: 1, cancelled: 1 });
  });

  it("runs lists queue rows with their last run", () => {
    const { svc, repo, runs, gate } = setup();
    repo.enqueue("acme/web", [5, 6], "merged", 1);
    const a = repo.take(1)!;
    const runId = runs.start({ queueId: a.id, slug: "acme/web", prNumber: 5, origin: "merged", startedAt: 10 });
    runs.finish(runId, { status: "limited", reason: "usage_limit", finishedAt: 20, prTitle: "Fix it", created: 1, costUsd: 0.5, durationMs: 1000 });
    repo.defer(a.id, 99999, runId);
    const rows = svc.runs("acme/web");
    const r5 = rows.find((r) => r.prNumber === 5)!;
    expect(r5.status).toBe("waiting");
    gate.value = { paused: true, reason: "limit", until: 99999, message: null };
    expect(svc.runs("acme/web").find((r) => r.prNumber === 5)!.status).toBe("limited");
    expect(r5).toMatchObject({ queueId: a.id, prTitle: "Fix it", notBefore: 99999, origin: "merged" });
    expect(r5.lastRun).toEqual({ id: runId, status: "limited", reason: "usage_limit", startedAt: 10, finishedAt: 20, created: 1, hit: 0, dropped: 0, costUsd: 0.5, durationMs: 1000 });
    const r6 = rows.find((r) => r.prNumber === 6)!;
    expect(r6).toMatchObject({ status: "queued", lastRun: null, prTitle: null });
  });

  it("a running retry shows the running run, not the failed attempt before it", () => {
    const { svc, repo, runs, runner } = setup();
    repo.enqueue("acme/web", [5], "merged", 1);
    const q = repo.take(1)!;
    const failedRun = runs.start({ queueId: q.id, slug: "acme/web", prNumber: 5, origin: "merged", startedAt: 10 });
    runs.finish(failedRun, { status: "failed", reason: "exit_nonzero", finishedAt: 20, prTitle: "Fix it" });
    repo.finish(q.id, "failed", 20, "exit_nonzero", { runId: failedRun });
    expect(repo.retry(q.id, 40)).toBe("ok");
    repo.take(41);
    const live = runs.start({ queueId: q.id, slug: "acme/web", prNumber: 5, origin: "merged", startedAt: 50 });
    runner.running.mockReturnValue([{ queueId: q.id, runId: live, slug: "acme/web", prNumber: 5, startedAt: 50 }]);
    const r = svc.runs("acme/web")[0];
    expect(r.status).toBe("running");
    expect(r.lastRun).toMatchObject({ id: live, status: "running", startedAt: 50, finishedAt: null });
    // 这次还没读到 PR 标题：沿用上一次的。
    expect(r.prTitle).toBe("Fix it");
    // 从这一行打开的详情就是正在跑的这次，上一次失败的在尝试列表里。
    const d = svc.run(r.lastRun!.id)!;
    expect(d).toMatchObject({ id: live, status: "running" });
    expect(d.attempts.map((a) => a.id)).toEqual([failedRun]);
  });

  it("a first attempt that is running has its run as the last run", () => {
    const { svc, repo, runs, runner } = setup();
    repo.enqueue("acme/web", [5], "merged", 1);
    const q = repo.take(1)!;
    const live = runs.start({ queueId: q.id, slug: "acme/web", prNumber: 5, origin: "merged", startedAt: 30 });
    runner.running.mockReturnValue([{ queueId: q.id, runId: live, slug: "acme/web", prNumber: 5, startedAt: 30 }]);
    const r = svc.runs("acme/web")[0];
    expect(r).toMatchObject({ status: "running", prTitle: null });
    expect(r.lastRun).toEqual({ id: live, status: "running", reason: null, startedAt: 30, finishedAt: null, created: 0, hit: 0, dropped: 0, costUsd: null, durationMs: null });
  });

  const finding = { comment_url: "https://github.com/acme/web/pull/1#r1", summary: "s", avoidable: true, why_missed: "w", rule: { text: "r", why: "y", scope: "repo", product_id: null, same_as: null, globs: [], lang: null, layer: null, strength: "should", checkability: "prose", checkability_reason: "r" } };
  const finishRun = (runs: LessonRunsRepo, over: Parameters<LessonRunsRepo["finish"]>[1]) => {
    const id = runs.start({ queueId: null, slug: "acme/web", prNumber: 1, origin: "merged", startedAt: 1 });
    runs.finish(id, over);
    return id;
  };

  it("run parses findings and lists created and hit lessons", () => {
    const { svc, repo, runs } = setup();
    const earlier = finishRun(runs, { status: "done", reason: null, finishedAt: 2 });
    const id = finishRun(runs, { status: "done", reason: null, finishedAt: 3, findings: [finding], prUrl: "https://github.com/acme/web/pull/1", model: "m", inputTokens: 5, outputTokens: 6 });
    const l1 = repo.addLesson({ scope: { kind: "repo", slug: "acme/web" }, text: "new", why: "w", at: 1, source: { ...src, runId: id } });
    const l2 = repo.addLesson({ scope: { kind: "repo", slug: "acme/web" }, text: "old", why: "w", at: 1, source: { ...src, runId: null } });
    repo.hit(l2, 2, { prNumber: 2, url: "https://github.com/acme/web/pull/2", slug: "acme/web", runId: id });
    const d = svc.run(id)!;
    expect(d.findings).toEqual([
      { summary: "s", avoidable: true, whyMissed: "w", rule: { text: "r", why: "y", scope: "repo" }, commentUrl: "https://github.com/acme/web/pull/1#r1" },
    ]);
    expect(d.lessons).toEqual([
      { id: l1, text: "new", status: "pending", kind: "created" },
      { id: l2, text: "old", status: "pending", kind: "hit" },
    ]);
    expect(d).toMatchObject({ slug: "acme/web", prNumber: 1, prUrl: "https://github.com/acme/web/pull/1", model: "m", inputTokens: 5, outputTokens: 6, trimmed: false });
    expect(d.attempts.map((a) => a.id)).toEqual([earlier]);
    expect(svc.run(9999)).toBeNull();
  });

  it("openInClaude returns the session id", async () => {
    const { svc, runs, openRun, notify } = setup();
    const id = finishRun(runs, { status: "failed", reason: "claude_error", finishedAt: 3, message: "boom" });
    expect(await svc.act({ op: "openInClaude", runId: id })).toEqual({ ok: true, sessionId: "term-1" });
    expect(openRun).toHaveBeenCalledTimes(1);
    const [d, repoPath] = openRun.mock.calls[0];
    expect(d).toEqual(svc.run(id));
    expect(repoPath).toBe("/acme_web");
    expect(notify).toHaveBeenCalled();
    openRun.mockResolvedValueOnce({ ok: false, reason: "claude_missing" });
    expect(await svc.act({ op: "openInClaude", runId: id })).toEqual({ ok: false, reason: "claude_missing" });
  });

  it("openInClaude for an unknown run is not_found", async () => {
    const { svc, runs, openRun, repo } = setup();
    expect(await svc.act({ op: "openInClaude", runId: 9999 })).toEqual({ ok: false, reason: "not_found" });
    // 运行还在，仓库没了（这里直接看 repo.repo 查不到）。
    const id = finishRun(runs, { status: "done", reason: null, finishedAt: 3 });
    vi.spyOn(repo, "repo").mockReturnValue(null);
    expect(await svc.act({ op: "openInClaude", runId: id })).toEqual({ ok: false, reason: "not_found" });
    expect(openRun).not.toHaveBeenCalled();
  });

  it("openInClaude returns ok:false when writing the run file fails", async () => {
    const { svc, runs, openRun, log } = setup();
    const id = finishRun(runs, { status: "done", reason: null, finishedAt: 3 });
    openRun.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    expect(await svc.act({ op: "openInClaude", runId: id })).toEqual({ ok: false, reason: "write_failed" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`run ${id}`), expect.any(Error));
  });

  it("run with unparsable findings returns findings null", () => {
    const { svc, runs } = setup();
    const id = finishRun(runs, { status: "done", reason: null, finishedAt: 3, findings: [{ nope: 1 }] });
    expect(svc.run(id)!.findings).toBeNull();
    const none = finishRun(runs, { status: "failed", reason: "error", finishedAt: 4 });
    expect(svc.run(none)!.findings).toBeNull();
  });

  it("retry, retryFailed, cancel, pauseQueue, resumeQueue and runNow call through and notify", async () => {
    const { svc, runner, availability, notify } = setup();
    expect(await svc.act({ op: "retry", queueId: 3 })).toEqual({ ok: true });
    expect(runner.retry).toHaveBeenCalledWith(3);
    expect(await svc.act({ op: "retryFailed", slug: "acme/web" })).toEqual({ ok: true });
    expect(runner.retryFailed).toHaveBeenCalledWith("acme/web");
    expect(await svc.act({ op: "cancel", queueId: 4 })).toEqual({ ok: true });
    expect(runner.cancel).toHaveBeenCalledWith(4);
    expect(await svc.act({ op: "pauseQueue" })).toEqual({ ok: true });
    expect(availability.pauseLessons).toHaveBeenCalled();
    expect(await svc.act({ op: "resumeQueue" })).toEqual({ ok: true });
    expect(availability.resumeLessons).toHaveBeenCalled();
    expect(await svc.act({ op: "runNow" })).toEqual({ ok: true });
    expect(runner.runNow).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(6);
  });

  it("cancel of an unknown id returns not_found and does not notify", async () => {
    const { svc, runner, notify } = setup();
    runner.cancel.mockReturnValue("not_found");
    runner.retry.mockReturnValue("bad_status");
    expect(await svc.act({ op: "cancel", queueId: 99 })).toEqual({ ok: false, reason: "not_found" });
    expect(await svc.act({ op: "retry", queueId: 99 })).toEqual({ ok: false, reason: "bad_status" });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("LessonsService bulk staleness", () => {
  it("refuses a bulk action that would change more lessons than the page showed", async () => {
    const { svc, add, repo } = setup();
    const a = add("acme/web");
    const b = add("acme/web");
    expect(await svc.act({ op: "bulk", verb: "confirm", target: { filter: { slug: "acme/web" } }, expect: 1 })).toEqual({ ok: false, reason: "stale" });
    expect([repo.get(a)?.status, repo.get(b)?.status]).toEqual(["pending", "pending"]);
    expect(await svc.act({ op: "bulk", verb: "confirm", target: { filter: { slug: "acme/web", maxId: a } }, expect: 1 })).toMatchObject({ ok: true, affected: 1 });
    expect(repo.get(b)?.status).toBe("pending");
    repo.setFields(b, { admission: "auto" }, 5);
    expect(await svc.act({ op: "acceptRecommended", expect: 0 })).toEqual({ ok: false, reason: "stale" });
    expect(await svc.act({ op: "acceptRecommended", expect: 1 })).toMatchObject({ ok: true, affected: 1 });
  });
});

describe("LessonsService enrich (workstream D)", () => {
  it("reports how many lessons need enrichment and starts it once", async () => {
    const a = setup();
    let running = false;
    let done: (() => void) | null = null;
    const enricher = {
      needing: () => a.repo.lessons(),
      running: () => running,
      start: (_s: unknown, d: () => void) => (running ? false : ((running = true), (done = d), true)),
    };
    const svc = new LessonsService({
      repo: a.repo, batches: a.batches, runs: a.runs, availability: a.availability, identity: new RepoIdentity({ git: () => "", exists: () => false }), runner: a.runner, openRun: a.openRun,
      knownRepoPaths: () => [], repoGroups: () => [], ghAvailable: () => true, openExternal: a.openExternal, now: () => 100, notify: a.notify, enricher,
    });
    a.add("acme/web");
    expect(svc.state().enrich).toEqual({ needing: 1, running: false });
    expect(await svc.act({ op: "enrich" })).toEqual({ ok: true });
    expect(await svc.act({ op: "enrich" })).toEqual({ ok: false, reason: "busy" });
    expect(svc.state().enrich.running).toBe(true);
    running = false;
    done!();
    expect(a.notify).toHaveBeenCalled();
  });

  it("without an enricher the action is not available", async () => {
    expect(await setup().svc.act({ op: "enrich" })).toEqual({ ok: false, reason: "not_found" });
  });
});
