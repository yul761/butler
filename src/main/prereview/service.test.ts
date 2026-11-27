import { fakeMailbox } from "../mailbox/fake-mailbox";
import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import type { BgJobContext } from "../background/queue";
import type { HeadlessExecResult } from "../handoff/headless-exec";
import { PreReviewRepo } from "../db/prereview-repo";
import { TicketPrsRepo, type TicketPr } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import type { ProfileProject } from "../../shared/baselines";
import type { CheckHitView } from "../../shared/checks";
import type { Lesson } from "../../shared/lessons";
import { defaultPrPolicy } from "../../shared/pr-policy";
import type { ExecRun } from "./model";
import { makePreReviewHandler, summarizeHits, verdictOf, type RunnerDeps } from "./runner";
import { PreReviewService, type PreReviewServiceDeps } from "./service";

const SHA = "a".repeat(40);
const route = { task: "pre_review" as const, requestedTier: "high" as const, actualModel: "rev", fallbackFrom: null, degraded: false, sameModelReview: false };
const ok = (value: unknown): HeadlessExecResult => ({ ok: true, value, rawText: "", result: {} as never, route });
const proj: ProfileProject = { dir: "", langs: [], install: null, build: null, testAll: "pnpm test", testOne: null, fastest: null, lint: null, typecheck: null, inferred: [] };
const lesson = (id: number, text: string): Lesson => ({ id, text, strength: "must", scopeGlobs: [], scopeLang: null } as unknown as Lesson);

function setup(o: { enabled?: boolean | ((ticketKey?: string | null) => boolean); dirty?: string; guardOk?: boolean; review?: unknown; verify?: unknown; placeOf?: PreReviewServiceDeps["placeOf"]; lang?: "zh" | "en" } = {}) {
  const db = memDb();
  const repo = new PreReviewRepo(db);
  const tickets = new TicketsRepo(db);
  tickets.insert({ key: "T-1", title: "Add thing", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const prs = new TicketPrsRepo(db);
  const jobs: { kind: string; payload: { preReviewId: number }; dedupeKey: string | null | undefined }[] = [];
  const cancelled: number[] = [];
  const fronted: number[] = [];
  let changes = 0;
  const sent: string[] = [];
  let guardOk = o.guardOk ?? true;
  const git = async (_cwd: string, args: string[]) => (args[0] === "rev-parse" ? (args[1] === "HEAD" ? SHA : "feat/x") : (o.dirty ?? ""));
  const mailbox = fakeMailbox({ canDeliver: () => guardOk, deliver: (_to, body) => void sent.push(body) });
  const deliverQueued = mailbox.deliverQueued;
  const sd: PreReviewServiceDeps = {
    repo,
    queue: { enqueue: (kind, payload, x) => (jobs.push({ kind, payload, dedupeKey: x.dedupeKey }), jobs.length), cancel: (id) => (cancelled.push(id), true), moveToFront: (id) => (fronted.push(id), true) },
    placeOf: o.placeOf,
    enabled: (k) => (typeof o.enabled === "function" ? o.enabled(k) : (o.enabled ?? true)),
    place: (sid) => (sid === "s1" ? { cwd: "/w", ticketKey: "T-1", slug: "o/app" } : null),
    git,
    recipient: () => "s1",
    cwdOf: () => "/w",
    isShipherdPr: () => true,
    openPrFor: (k, t) => prs.byTicket(k ?? "").find((p) => p.state === "open" && p.slug === t.repoSlug && p.headBranch === t.branch) ?? null,
    profile: () => ({ projects: [proj], dirs: [], ci: [], pitfalls: [] }),
    policy: () => defaultPrPolicy(),
    mailbox,
    lang: () => o.lang ?? "en",
    changed: () => void changes++,
    now: () => 1000,
    log: () => undefined,
  };
  const service = new PreReviewService(sd);
  const run: ExecRun = async (x) => (x.task === "pre_review" ? ok(o.review ?? { violations: [], summary: "fine" }) : ok(o.verify ?? { items: [] }));
  const after: number[] = [];
  const rd: RunnerDeps = {
    repo,
    diff: async () => ({ base: "b".repeat(40), files: [{ path: "src/a.ts", added: 5, deleted: 1, binary: false }], patches: new Map([["src/a.ts", "+x"]]), source: "git" }),
    lessons: () => ({ lessons: [lesson(7, "FULL RULE TEXT: never swallow errors")], total: 1 }),
    checks: () => ({ absent: null, hits: [] }),
    ci: () => null,
    profile: sd.profile,
    policy: sd.policy,
    ticketTitle: () => "Add thing",
    producer: () => ({ model: "dev", tier: "high" }),
    exec: run,
    rerun: { git, run: async () => ({ kind: "pass" }) },
    lang: () => "en",
    after: async (row) => void after.push(row.id),
    deliver: async (row) => void (await service.deliver(row)),
    changed: () => void changes++,
    now: () => 2000,
    log: () => undefined,
  };
  const handler = makePreReviewHandler(rd);
  const ctx = (id: number, checkpoint: unknown = null, signal = new AbortController().signal) => {
    const saved: unknown[] = [];
    const c = { id: 1, kind: "pre_review", payload: { preReviewId: id }, checkpoint, ticketKey: "T-1", attempts: 1, signal, save: (x: unknown) => saved.push(x), sessionAwake: () => true, admitSession: async () => ({ ok: false, reason: "x" }) } as BgJobContext;
    return { c, saved };
  };
  return { db, repo, prs, service, handler, ctx, jobs, cancelled, fronted, sent, after, setGuard: (v: boolean) => (guardOk = v), deliverQueued, mailbox, changes: () => changes, rd };
}

const evidence = { checks: [{ name: "unit tests", category: "test", command: "echo ok", result: "pass", output: "12 passed" }], acceptance: [{ criterion: "AC1", how: "added X" }] };

describe("PreReviewService.submitEvidence", () => {
  it("records the evidence against HEAD and queues a pre-review", async () => {
    const s = setup();
    const r = await s.service.submitEvidence("s1", evidence);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.message).toContain("aaaaaaa");
    const row = s.repo.get(r.preReviewId)!;
    expect(row).toMatchObject({ trigger: "evidence", status: "queued", target: { repoSlug: "o/app", branch: "feat/x", headSha: SHA }, jobId: 1 });
    expect(s.repo.evidenceOf(row.id).map((e) => [e.kind, e.category, e.claimed])).toEqual([["check", "test", "pass"], ["acceptance", null, null]]);
    expect(s.jobs[0]!.dedupeKey).toBe(`session:s1:${SHA}:${row.id}`);
  });
  it("ties evidence to an already open PR on the same branch (PR id and base)", async () => {
    const s = setup();
    const open = s.prs.link({ ticketKey: "T-1", url: "https://github.com/o/app/pull/9", slug: "o/app", repoId: null, number: 9, headBranch: "feat/x", state: "open", source: "branch", linkedAt: 1 }).pr;
    s.db.prepare("UPDATE ticket_prs SET base_branch = 'develop' WHERE id = ?").run(open.id);
    const r = await s.service.submitEvidence("s1", evidence);
    if (!r.ok) throw new Error(r.message);
    expect(s.repo.get(r.preReviewId)).toMatchObject({ prId: open.id, base: "develop" });
    expect(s.repo.evidenceOf(r.preReviewId).every((e) => e.prId === open.id)).toBe(true);
  });
  it("refuses a dirty worktree, an unknown session, junk evidence, and does nothing when pre-review is off", async () => {
    expect((await setup({ dirty: " M a.ts" }).service.submitEvidence("s1", evidence)).message).toMatch(/uncommitted/);
    expect((await setup().service.submitEvidence("nope", evidence)).ok).toBe(false);
    expect((await setup().service.submitEvidence("s1", { checks: "x" })).ok).toBe(false);
    const off = setup({ enabled: false });
    expect((await off.service.submitEvidence("s1", evidence)).message).toMatch(/off/);
    expect(off.jobs).toHaveLength(0);
  });
  it("a second submission for the same commit supersedes the queued one", async () => {
    const s = setup();
    const a = await s.service.submitEvidence("s1", evidence);
    const b = await s.service.submitEvidence("s1", evidence);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(s.repo.get(a.preReviewId)).toMatchObject({ status: "skipped", detail: "superseded" });
    expect(s.cancelled).toEqual([1]);
  });
});

describe("pre-review runner and delivery", () => {
  it("clean: verifies the evidence by rerun, finishes, runs the assessment and delivers one line", async () => {
    const s = setup();
    const r = await s.service.submitEvidence("s1", evidence);
    if (!r.ok) throw new Error(r.message);
    const { c } = s.ctx(r.preReviewId);
    expect(await s.handler(c)).toEqual({ done: true });
    const row = s.repo.get(r.preReviewId)!;
    expect(row).toMatchObject({ status: "done", verdict: "clean", model: "rev", lessonIds: [7] });
    expect(row.checks?.rerun).toEqual([expect.objectContaining({ category: "test", command: "pnpm test", ok: true })]);
    const ev = s.repo.evidenceOf(row.id);
    expect(ev[0]).toMatchObject({ verified: "rerun_pass" });
    // the acceptance item went to the cross-check, which did not judge it.
    expect(ev[1]).toMatchObject({ verified: "unverifiable" });
    expect(s.after).toEqual([row.id]);
    expect(s.sent).toEqual(["Shipherd pre-review of aaaaaaa passed."]);
    expect(s.repo.get(row.id)!.deliveredAt).toBe(1000);
  });
  it("violations: delivers the list without the rule's full text", async () => {
    const s = setup({ review: { violations: [{ lessonId: 7, checkKey: null, file: "src/a.ts", line: 3, severity: "must", what: "swallows the error", fix: "rethrow it" }], summary: "1 issue" } });
    const r = await s.service.submitEvidence("s1", evidence);
    if (!r.ok) throw new Error(r.message);
    await s.handler(s.ctx(r.preReviewId).c);
    expect(s.repo.get(r.preReviewId)!.verdict).toBe("violations");
    expect(s.sent[0]).toContain("src/a.ts:3: swallows the error → rethrow it");
    expect(s.sent[0]).not.toContain("FULL RULE TEXT");
    expect(s.sent[0]).toContain("submit_evidence");
  });
  it("a busy session gets it later from its mailbox, and flush does not queue it twice (BTL-245)", async () => {
    const s = setup({ guardOk: false });
    const r = await s.service.submitEvidence("s1", evidence);
    if (!r.ok) throw new Error(r.message);
    await s.handler(s.ctx(r.preReviewId).c);
    expect(s.sent).toEqual([]);
    await s.service.flush();
    s.setGuard(true);
    s.deliverQueued();
    expect(s.sent).toHaveLength(1);
    expect(s.repo.get(r.preReviewId)!.deliveredAt).toBe(1000);
    await s.service.flush();
    expect(s.sent).toHaveLength(1);
  });
  it("defers when told to yield and resumes from the checkpoint", async () => {
    const s = setup();
    const r = await s.service.submitEvidence("s1", evidence);
    if (!r.ok) throw new Error(r.message);
    const ctl = new AbortController();
    ctl.abort();
    expect(await s.handler(s.ctx(r.preReviewId, null, ctl.signal).c)).toEqual({ defer: true });
    // 让路后放回 queued：同一份代码再交证据时会取代它（不会两次都跑、都送）。
    expect(s.repo.get(r.preReviewId)!.status).toBe("queued");
    expect(await s.handler(s.ctx(r.preReviewId).c)).toEqual({ done: true });
    expect(s.repo.get(r.preReviewId)!.status).toBe("done");
  });
  it("new evidence for the same commit replaces a pre-review that yielded", async () => {
    const s = setup();
    const a = await s.service.submitEvidence("s1", evidence);
    if (!a.ok) throw new Error(a.message);
    const ctl = new AbortController();
    ctl.abort();
    await s.handler(s.ctx(a.preReviewId, null, ctl.signal).c);
    const b = await s.service.submitEvidence("s1", evidence);
    if (!b.ok) throw new Error(b.message);
    expect(s.repo.get(a.preReviewId)).toMatchObject({ status: "skipped", detail: "superseded" });
    expect(s.cancelled).toEqual([1]);
  });
  it("a throw mid-run ends the pre-review as failed instead of leaving it running", async () => {
    const s = setup();
    const r = await s.service.submitEvidence("s1", evidence);
    if (!r.ok) throw new Error(r.message);
    const h = makePreReviewHandler({
      ...({} as RunnerDeps), repo: s.repo, now: () => 1, log: () => undefined, after: async () => undefined, deliver: async () => undefined,
      diff: async () => ({ base: "b", files: [], patches: new Map(), source: "git" }),
      policy: () => defaultPrPolicy(), profile: () => null, lessons: () => { throw new Error("db locked"); },
    });
    expect(await h(s.ctx(r.preReviewId).c)).toEqual({ done: true });
    expect(s.repo.get(r.preReviewId)).toMatchObject({ status: "failed", verdict: "error", detail: "error: db locked" });
  });
  it("flush retries a failed evidence pre-review and never sends a row twice", async () => {
    const s = setup({ guardOk: false });
    const r = await s.service.submitEvidence("s1", evidence);
    if (!r.ok) throw new Error(r.message);
    s.repo.update(r.preReviewId, { status: "failed", verdict: "error", detail: "diff unavailable", finishedAt: 1000 });
    s.setGuard(true);
    const stale = s.repo.get(r.preReviewId)!;
    await s.service.flush();
    s.deliverQueued();
    expect(s.sent).toHaveLength(1);
    expect(await s.service.deliver(stale)).toBe("already");
    expect(s.sent).toHaveLength(1);
  });
  it("a failed diff ends the pre-review as an error", async () => {
    const s = setup();
    const r = await s.service.submitEvidence("s1", evidence);
    if (!r.ok) throw new Error(r.message);
    const h = makePreReviewHandler({ ...({} as RunnerDeps), repo: s.repo, diff: async () => null, now: () => 1, log: () => undefined, after: async () => undefined, deliver: async () => undefined });
    await h(s.ctx(r.preReviewId).c);
    expect(s.repo.get(r.preReviewId)).toMatchObject({ status: "failed", verdict: "error", detail: "diff unavailable" });
  });
});

describe("PreReviewService.onPrSeen", () => {
  const pr = (s: ReturnType<typeof setup>, p: Partial<TicketPr> = {}): TicketPr => {
    const row = s.prs.link({ ticketKey: "T-1", url: "https://github.com/o/app/pull/4", slug: "o/app", repoId: null, number: 4, headBranch: "feat/x", state: "open", source: "branch", linkedAt: 1 }).pr;
    return { ...row, headSha: SHA, ...p };
  };
  it("attaches the PR to earlier work on the same commit and queues once per commit", async () => {
    const s = setup();
    const r = await s.service.submitEvidence("s1", evidence);
    if (!r.ok) throw new Error(r.message);
    const p = pr(s);
    expect(s.service.onPrSeen(p)).toBeNull();
    expect(s.repo.get(r.preReviewId)!.prId).toBe(p.id);
    const p2 = { ...p, headSha: "c".repeat(40) };
    const id = s.service.onPrSeen(p2);
    expect(id).not.toBeNull();
    expect(s.repo.get(id!)).toMatchObject({ trigger: "pr", prId: p.id, sessionId: "s1" });
    expect(s.service.onPrSeen(p2)).toBeNull();
  });
  it("skips drafts, closed PRs and everything when pre-review is off; manual runs anyway", () => {
    const s = setup();
    expect(s.service.onPrSeen(pr(s, { isDraft: true }))).toBeNull();
    expect(s.service.onPrSeen({ ...pr(s), state: "merged" })).toBeNull();
    const off = setup({ enabled: false });
    expect(off.service.onPrSeen(pr(off))).toBeNull();
    expect(off.service.manual(pr(off))).not.toBeNull();
  });
  it("asks whether pre-review is on for this PR's / session's ticket (epic automation level, BTL-247)", async () => {
    const asked: (string | null | undefined)[] = [];
    const s = setup({ enabled: (k) => (asked.push(k), false) });
    expect(s.service.onPrSeen(pr(s))).toBeNull();
    expect((await s.service.submitEvidence("s1", {})).ok).toBe(false);
    expect(asked).toEqual(["T-1", "T-1"]);
  });
});

describe("runner helpers", () => {
  const hit = (p: Partial<CheckHitView>): CheckHitView => ({ id: 1, checkId: 1, checkKey: "k", repoSlug: null, file: "a.ts", line: null, stage: "edit", mode: "enforce", severity: "block", outcome: "fail", blocked: true, detail: "", sessionId: "s1", verdict: null, at: 1, ...p } as CheckHitView);
  it("summarizeHits keeps the latest outcome per check and file and skips false positives", () => {
    const out = summarizeHits([hit({ id: 1, at: 1 }), hit({ id: 2, at: 2, outcome: "resolved" }), hit({ id: 3, file: "b.ts" }), hit({ id: 4, checkKey: "fp", verdict: "false_positive" })]);
    expect(out).toEqual([{ checkKey: "k", name: "k", severity: "block", mode: "enforce", files: ["b.ts"], count: 1 }]);
  });
  it("verdictOf: must violations or enforced blocking failures make it violations", () => {
    const f = summarizeHits([hit({})]);
    expect(verdictOf([], f)).toBe("violations");
    expect(verdictOf([], summarizeHits([hit({ mode: "shadow" })]))).toBe("clean");
    expect(verdictOf([{ lessonId: 1, checkKey: null, file: "a", line: null, severity: "should", what: "", fix: "" }], [])).toBe("clean");
  });
});

describe("pre-review visibility and queue actions (BTL-271)", () => {
  it("submit_evidence tells the session its place in the queue and why the queue is stopped", async () => {
    const zh = setup({ lang: "zh", placeOf: () => ({ position: 3, ahead: 2, running: 2, reason: null, waiting: null }) });
    const r = await zh.service.submitEvidence("s1", evidence);
    expect(r.message).toContain("排在预审队列第 3 个（前面还有 2 个）");
    expect(r.message).toContain("现在有 2 个在跑");
    const paused = setup({ lang: "zh", placeOf: () => ({ position: 1, ahead: 0, running: 0, reason: "cost", waiting: null }) });
    expect((await paused.service.submitEvidence("s1", evidence)).message).toContain("预审现在停着（花费熔断了），恢复后才开始");
    const en = setup({ placeOf: () => ({ position: 2, ahead: 1, running: 1, reason: "memory", waiting: null }) });
    expect((await en.service.submitEvidence("s1", evidence)).message).toMatch(/number 2 in the pre-review queue \(1 ahead\); pre-review is paused right now \(memory is short\)/);
    // 马上就开跑了（不在排队里）
    const running = setup({ placeOf: () => null });
    expect((await running.service.submitEvidence("s1", evidence)).message).toContain("Shipherd is pre-reviewing it.");
  });

  it("cancel takes a queued pre-review off the queue and tells the waiting session", async () => {
    const s = setup();
    const r = await s.service.submitEvidence("s1", evidence);
    if (!r.ok) throw new Error(r.message);
    expect(s.service.cancel(r.preReviewId)).toEqual({ ok: true });
    expect(s.repo.get(r.preReviewId)).toMatchObject({ status: "skipped", detail: "cancelled" });
    expect(s.cancelled).toEqual([1]);
    expect(s.mailbox.queuedByRef(`prereview:${r.preReviewId}`)).toBeTruthy();
    expect(s.service.cancel(r.preReviewId)).toEqual({ ok: false, reason: "not_queued" });
    expect(s.service.cancel(999)).toEqual({ ok: false, reason: "not_found" });
  });

  it("cancelling a running pre-review: the runner neither puts it back nor writes its late result", async () => {
    const s = setup();
    const r = await s.service.submitEvidence("s1", evidence);
    if (!r.ok) throw new Error(r.message);
    const ctl = new AbortController();
    const { c } = s.ctx(r.preReviewId, null, ctl.signal);
    // 模型调用期间取消：中止信号、行改成 skipped
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const slow = makePreReviewHandler({ ...s.rd, exec: async (x) => (await gate, ok(x.task === "pre_review" ? { violations: [], summary: "late" } : { items: [] })) });
    const run = slow(c);
    await new Promise((res) => setTimeout(res, 0));
    expect(s.repo.get(r.preReviewId)).toMatchObject({ status: "running", startedAt: 2000 });
    expect(s.service.cancel(r.preReviewId)).toEqual({ ok: true });
    ctl.abort();
    release();
    await run;
    expect(s.repo.get(r.preReviewId)).toMatchObject({ status: "skipped", detail: "cancelled", summary: null });
  });

  it("a cancel that lands while the model runs drops the result even without the abort signal", async () => {
    const s = setup();
    const r = await s.service.submitEvidence("s1", evidence);
    if (!r.ok) throw new Error(r.message);
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const slow = makePreReviewHandler({ ...s.rd, exec: async (x) => (await gate, ok(x.task === "pre_review" ? { violations: [], summary: "late" } : { items: [] })) });
    const run = slow(s.ctx(r.preReviewId).c);
    await new Promise((res) => setTimeout(res, 0));
    s.service.cancel(r.preReviewId);
    release();
    expect(await run).toEqual({ done: true });
    expect(s.repo.get(r.preReviewId)).toMatchObject({ status: "skipped", summary: null });
    expect(s.after).toEqual([]);
  });

  it("the runner records the start time when it marks running and notifies at start and at the verdict", async () => {
    const s = setup();
    const r = await s.service.submitEvidence("s1", evidence);
    if (!r.ok) throw new Error(r.message);
    const before = s.changes();
    await s.handler(s.ctx(r.preReviewId).c);
    expect(s.repo.get(r.preReviewId)).toMatchObject({ status: "done", startedAt: 2000 });
    expect(s.changes() - before).toBeGreaterThanOrEqual(2);
  });

  it("a yielded pre-review goes back to the queue with no start time", async () => {
    const s = setup();
    const r = await s.service.submitEvidence("s1", evidence);
    if (!r.ok) throw new Error(r.message);
    const ctl = new AbortController();
    ctl.abort();
    expect(await s.handler(s.ctx(r.preReviewId, null, ctl.signal).c)).toEqual({ defer: true });
    expect(s.repo.get(r.preReviewId)).toMatchObject({ status: "queued", startedAt: null });
  });

  it("moveToFront moves the queued job; finished or unknown ones are refused", async () => {
    const s = setup();
    const r = await s.service.submitEvidence("s1", evidence);
    if (!r.ok) throw new Error(r.message);
    expect(s.service.moveToFront(r.preReviewId)).toEqual({ ok: true });
    expect(s.fronted).toEqual([1]);
    await s.handler(s.ctx(r.preReviewId).c);
    expect(s.service.moveToFront(r.preReviewId)).toEqual({ ok: false, reason: "not_queued" });
    expect(s.service.moveToFront(12345)).toEqual({ ok: false, reason: "not_found" });
  });
});
