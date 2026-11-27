import { describe, expect, it } from "vitest";
import { BackgroundRepo } from "../db/background-repo";
import { PreReviewRepo } from "../db/prereview-repo";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { memDb } from "../test-utils";
import type { BgGate } from "../../shared/background";
import type { ReviewTarget, Violation } from "../../shared/prereview";
import { PreReviewStatusService } from "./status";

const sha = (c: string) => c.repeat(40);
const must = (what: string): Violation => ({ lessonId: 1, checkKey: null, file: "a.ts", line: 1, severity: "must", what, fix: "" });

function setup() {
  const db = memDb();
  const repo = new PreReviewRepo(db);
  new TicketsRepo(db).insert({ key: "T-1", title: "x", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const prs = new TicketPrsRepo(db);
  for (const n of [1, 2, 3]) prs.link({ ticketKey: "T-1", url: `https://github.com/o/app/pull/${n}`, slug: "o/app", repoId: null, number: n, headBranch: "feat/x", state: "open", source: "branch", linkedAt: 1 });
  const jobs = new BackgroundRepo(db);
  let now = 10_000;
  const gates: { global: BgGate; tickets: Map<string, BgGate> } = { global: { run: true }, tickets: new Map() };
  const held = new Set<string>();
  let concurrency = 2;
  const chains = new Map<string, string[]>();
  const status = new PreReviewStatusService({
    repo,
    jobs: { queued: () => jobs.queued("pre_review"), running: () => jobs.runningOf("pre_review") },
    gate: (key) => (!gates.global.run ? gates.global : key ? (gates.tickets.get(key) ?? { run: true }) : { run: true }),
    concurrency: () => concurrency,
    heldLocks: () => held,
    lockKey: (cwd) => cwd,
    pr: (id) => ({ number: id * 10, url: `https://github.com/o/app/pull/${id * 10}` }),
    chainOf: (id) => chains.get(id) ?? [id],
    now: () => now,
  });
  /** 排一次预审：行 + 任务，和 PreReviewService.enqueue 一样。 */
  const enqueue = (o: { ticket?: string | null; slug?: string; branch?: string; head?: string; cwd?: string | null; session?: string | null; prId?: number | null } = {}) => {
    const target: ReviewTarget = { repoSlug: o.slug ?? "o/app", branch: o.branch ?? "feat/x", headSha: o.head ?? sha("a") };
    const id = repo.insert({ ticketKey: o.ticket === undefined ? "T-1" : o.ticket, sessionId: o.session ?? null, target, cwd: o.cwd === undefined ? "/w/1" : o.cwd, base: null, prId: o.prId ?? null, trigger: "evidence", createdAt: now });
    const jobId = jobs.enqueue({ kind: "pre_review", payload: { preReviewId: id }, ticketKey: o.ticket ?? "T-1", now });
    repo.update(id, { jobId });
    return { id, jobId };
  };
  /** 像 BackgroundQueue + runner 一样开跑：任务标 running，行标 running、记开跑时间。 */
  const start = (id: number) => {
    const job = jobs.take("pre_review", now, () => true, (j) => (j.payload as { preReviewId: number }).preReviewId === id)!;
    repo.update(id, { status: "running", startedAt: now });
    return job;
  };
  const finish = (id: number, jobId: number, o: { verdict: "clean" | "violations" | "error"; violations?: Violation[] }) => {
    repo.update(id, { status: o.verdict === "error" ? "failed" : "done", verdict: o.verdict, violations: o.violations ?? [], finishedAt: now });
    jobs.finish(jobId, "done", now);
  };
  return { db, repo, jobs, status, enqueue, start, finish, gates, held, chains, setNow: (t: number) => (now = t), setConcurrency: (n: number) => (concurrency = n) };
}

describe("PreReviewStatusService (BTL-271)", () => {
  it("a ticket nobody pre-reviewed is none", () => {
    const t = setup();
    expect(t.status.preReviewStatusFor("T-9")).toMatchObject({ ticketKey: "T-9", overall: { state: "none", id: null }, items: [] });
  });

  it("queued shows its position in take order, and moving to the front changes it", () => {
    const t = setup();
    const a = t.enqueue({ ticket: "T-1", cwd: "/w/1" });
    const b = t.enqueue({ ticket: "T-2", cwd: "/w/2" });
    expect(t.status.preReviewStatusFor("T-1").overall).toMatchObject({ state: "queued", position: 1, id: a.id });
    expect(t.status.preReviewStatusFor("T-2").overall).toMatchObject({ state: "queued", position: 2 });
    t.jobs.moveToFront(b.jobId);
    expect(t.status.preReviewStatusFor("T-2").overall.position).toBe(1);
    expect(t.status.preReviewStatusFor("T-1").overall.position).toBe(2);
  });

  it("running carries the start time; finished ones carry the verdict and the violation count", () => {
    const t = setup();
    const a = t.enqueue({ ticket: "T-1" });
    t.setNow(20_000);
    t.start(a.id);
    expect(t.status.preReviewStatusFor("T-1").overall).toMatchObject({ state: "running", startedAt: 20_000, position: null });
    t.finish(a.id, a.jobId, { verdict: "violations", violations: [must("x"), must("y")] });
    expect(t.status.preReviewStatusFor("T-1").overall).toMatchObject({ state: "violations", violations: 2, finishedAt: 20_000 });
    const b = t.enqueue({ ticket: "T-2" });
    t.start(b.id);
    t.finish(b.id, b.jobId, { verdict: "clean" });
    expect(t.status.preReviewStatusFor("T-2").overall.state).toBe("clean");
    const c = t.enqueue({ ticket: "T-3" });
    t.start(c.id);
    t.finish(c.id, c.jobId, { verdict: "error" });
    expect(t.status.preReviewStatusFor("T-3").overall.state).toBe("error");
  });

  it("a queued re-review keeps the last result next to it", () => {
    const t = setup();
    const a = t.enqueue({ ticket: "T-1", head: sha("a") });
    t.start(a.id);
    t.finish(a.id, a.jobId, { verdict: "violations", violations: [must("x")] });
    const b = t.enqueue({ ticket: "T-1", head: sha("b") });
    expect(t.status.preReviewStatusFor("T-1").overall).toMatchObject({ state: "queued", id: b.id, last: { state: "violations", id: a.id, violations: 1, headSha: sha("a") } });
  });

  it("paused with the gate's reason: the whole queue (manual, memory…) or this ticket's cost breaker", () => {
    const t = setup();
    t.enqueue({ ticket: "T-1" });
    t.enqueue({ ticket: "T-2" });
    t.gates.tickets.set("T-2", { run: false, reason: "cost", until: null });
    expect(t.status.preReviewStatusFor("T-1").overall).toMatchObject({ state: "queued", reason: null });
    expect(t.status.preReviewStatusFor("T-2").overall).toMatchObject({ state: "paused", reason: "cost", position: 2 });
    t.gates.global = { run: false, reason: "manual", until: 99 };
    expect(t.status.preReviewStatusFor("T-1").overall).toMatchObject({ state: "paused", reason: "manual", until: 99 });
    expect(t.status.queue().stopped).toEqual({ reason: "manual", until: 99 });
  });

  it("says what a queued one waits for: a pre-review running in the same worktree, or full concurrency", () => {
    const t = setup();
    const a = t.enqueue({ ticket: "T-1", cwd: "/w/1" });
    t.start(a.id);
    t.held.add("/w/1");
    const b = t.enqueue({ ticket: "T-1", cwd: "/w/1", head: sha("b") });
    // 同一个分支：在跑的那个和新排上的都看得见，代表是在跑的
    const s1 = t.status.preReviewStatusFor("T-1");
    expect(s1.overall).toMatchObject({ state: "running", id: a.id });
    expect(s1.items.map((i) => [i.id, i.state, i.waiting])).toEqual([[b.id, "queued", "worktree"], [a.id, "running", null]]);
    const c = t.enqueue({ ticket: "T-2", cwd: "/w/2" });
    t.setConcurrency(1);
    expect(t.status.preReviewStatusFor("T-2").overall).toMatchObject({ state: "queued", waiting: "concurrency", id: c.id });
    const q = t.status.queue();
    expect(q.queued.map((x) => [x.ticketKey, x.waiting])).toEqual([["T-1", "worktree"], ["T-2", "concurrency"]]);
  });

  it("a multi-repo ticket keeps one item per repo even with the same branch name; one repo's queue does not change the other's", () => {
    const t = setup();
    const a = t.enqueue({ ticket: "T-1", slug: "o/api", branch: "feature/T-1", cwd: "/w/api" });
    t.start(a.id);
    t.finish(a.id, a.jobId, { verdict: "clean" });
    t.enqueue({ ticket: "T-1", slug: "o/web", branch: "feature/T-1", cwd: "/w/web" });
    const s = t.status.preReviewStatusFor("T-1");
    expect(s.items.map((i) => [i.repoSlug, i.state]).sort()).toEqual([["o/api", "clean"], ["o/web", "queued"]]);
    // 代表是最要紧的那个；代表加上其他的等于全部
    expect(s.overall).toMatchObject({ repoSlug: "o/web", state: "queued" });
    const api = s.items.find((i) => i.repoSlug === "o/api")!;
    expect(api.last).toBeNull();
    expect(api.state).toBe("clean");
  });

  it("forTickets answers a whole list in one go, including tickets with nothing", () => {
    const t = setup();
    t.enqueue({ ticket: "T-1" });
    const m = t.status.forTickets(["T-1", "T-2"]);
    expect([...m.keys()]).toEqual(["T-1", "T-2"]);
    expect(m.get("T-2")!.overall.state).toBe("none");
  });

  it("cancelled (skipped) runs do not hide the earlier result", () => {
    const t = setup();
    const a = t.enqueue({ ticket: "T-1" });
    t.start(a.id);
    t.finish(a.id, a.jobId, { verdict: "clean" });
    const b = t.enqueue({ ticket: "T-1", head: sha("b") });
    t.repo.update(b.id, { status: "skipped", detail: "cancelled" });
    t.jobs.cancel(b.jobId, 1);
    expect(t.status.preReviewStatusFor("T-1").overall).toMatchObject({ state: "clean", id: a.id });
    expect(t.status.history({ ticketKey: "T-1" }).map((h) => [h.id, h.state, h.detail])).toEqual([[b.id, "none", "cancelled"], [a.id, "clean", null]]);
  });

  it("per session and per PR", () => {
    const t = setup();
    const a = t.enqueue({ ticket: "T-1", session: "s1", prId: 3 });
    t.start(a.id);
    expect(t.status.forSessions(["s1", "s2"])).toEqual(new Map([["s1", expect.objectContaining({ state: "running", id: a.id })]]));
    expect(t.status.forPrs([3]).get(3)).toMatchObject({ state: "running" });
  });

  it("the queue lists running and queued with ticket, PR, trigger and times; placeOf says where one stands", () => {
    const t = setup();
    t.setNow(1_000);
    const a = t.enqueue({ ticket: "T-1", prId: 2, cwd: "/w/1" });
    t.setNow(2_000);
    t.start(a.id);
    t.setNow(3_000);
    const b = t.enqueue({ ticket: "T-2", cwd: "/w/2" });
    const c = t.enqueue({ ticket: "T-3", cwd: "/w/3" });
    const q = t.status.queue();
    expect(q.running).toEqual([expect.objectContaining({ id: a.id, ticketKey: "T-1", prId: 2, prNumber: 20, trigger: "evidence", enqueuedAt: 1_000, startedAt: 2_000, state: "running" })]);
    expect(q.queued.map((x) => [x.id, x.position, x.enqueuedAt])).toEqual([[b.id, 1, 3_000], [c.id, 2, 3_000]]);
    expect(q.concurrency).toBe(2);
    expect(q.stopped).toBeNull();
    expect(t.status.placeOf(c.id)).toEqual({ position: 2, ahead: 1, running: 1, reason: null, waiting: null });
    expect(t.status.placeOf(a.id)).toBeNull();
  });

  it("a row left running after a restart whose job is back in the queue shows queued or paused, matching the queue page", () => {
    const t = setup();
    t.setNow(20_000);
    const a = t.enqueue({ ticket: "T-1" });
    t.start(a.id);
    // 退出：任务被放回排队（resetRunning），行还停在 running。
    t.jobs.resetRunning();
    t.setNow(90_000);
    expect(t.status.preReviewStatusFor("T-1").overall).toMatchObject({ state: "queued", position: 1, id: a.id });
    t.gates.global = { run: false, reason: "manual", until: null };
    expect(t.status.preReviewStatusFor("T-1").overall).toMatchObject({ state: "paused", reason: "manual" });
    const q = t.status.queue();
    expect(q.running).toEqual([]);
    expect(q.queued.map((x) => [x.id, x.state])).toEqual([[a.id, "paused"]]);
  });

  it("a refreshed session keeps the pre-review its old id submitted", () => {
    const t = setup();
    const a = t.enqueue({ ticket: "T-1", session: "old" });
    t.start(a.id);
    t.chains.set("new", ["new", "old"]);
    expect(t.status.forSessions(["new"])).toEqual(new Map([["new", expect.objectContaining({ state: "running", id: a.id })]]));
    // 没换新的照旧；同一次查询里旧 id 归新 id，不重复出现。
    expect([...t.status.forSessions(["new", "s9"]).keys()]).toEqual(["new"]);
  });
});
