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

function setup(o: { enabled?: boolean; dirty?: string; guardOk?: boolean; review?: unknown; verify?: unknown } = {}) {
  const db = memDb();
  const repo = new PreReviewRepo(db);
  const tickets = new TicketsRepo(db);
  tickets.insert({ key: "T-1", title: "Add thing", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const prs = new TicketPrsRepo(db);
  const jobs: { kind: string; payload: { preReviewId: number }; dedupeKey: string | null | undefined }[] = [];
  const cancelled: number[] = [];
  const sent: string[] = [];
  let guardOk = o.guardOk ?? true;
  const git = async (_cwd: string, args: string[]) => (args[0] === "rev-parse" ? (args[1] === "HEAD" ? SHA : "feat/x") : (o.dirty ?? ""));
  const sd: PreReviewServiceDeps = {
    repo,
    queue: { enqueue: (kind, payload, x) => (jobs.push({ kind, payload, dedupeKey: x.dedupeKey }), jobs.length), cancel: (id) => (cancelled.push(id), true) },
    enabled: () => o.enabled ?? true,
    place: (sid) => (sid === "s1" ? { cwd: "/w", ticketKey: "T-1", slug: "o/app" } : null),
    git,
    recipient: () => "s1",
    cwdOf: () => "/w",
    isButlerPr: () => true,
    openPrFor: (k, t) => prs.byTicket(k ?? "").find((p) => p.state === "open" && p.slug === t.repoSlug && p.headBranch === t.branch) ?? null,
    profile: () => ({ projects: [proj], dirs: [], ci: [], pitfalls: [] }),
    policy: () => defaultPrPolicy(),
    guard: { check: () => (guardOk ? { ok: true, termId: "t1", headId: "s1" } : { ok: false, block: "busy" }), recheckAfter: () => () => true },
    deliver: async (_t, text) => (sent.push(text), "sent"),
    busy: new Set(),
    lang: () => "en",
    changed: () => undefined,
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
    now: () => 2000,
    log: () => undefined,
  };
  const handler = makePreReviewHandler(rd);
  const ctx = (id: number, checkpoint: unknown = null, signal = new AbortController().signal) => {
    const saved: unknown[] = [];
    const c = { id: 1, kind: "pre_review", payload: { preReviewId: id }, checkpoint, ticketKey: "T-1", attempts: 1, signal, save: (x: unknown) => saved.push(x), sessionAwake: () => true, admitSession: async () => ({ ok: false, reason: "x" }) } as BgJobContext;
    return { c, saved };
  };
  return { db, repo, prs, service, handler, ctx, jobs, cancelled, sent, after, setGuard: (v: boolean) => (guardOk = v) };
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
    expect(s.sent).toEqual(["Butler pre-review of aaaaaaa passed."]);
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
  it("a busy session gets it later, from flush", async () => {
    const s = setup({ guardOk: false });
    const r = await s.service.submitEvidence("s1", evidence);
    if (!r.ok) throw new Error(r.message);
    await s.handler(s.ctx(r.preReviewId).c);
    expect(s.sent).toEqual([]);
    expect(s.repo.get(r.preReviewId)!.deliverTries).toBe(1);
    s.setGuard(true);
    await s.service.flush();
    expect(s.sent).toHaveLength(1);
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
    expect(s.repo.get(r.preReviewId)!.status).toBe("running");
    expect(await s.handler(s.ctx(r.preReviewId).c)).toEqual({ done: true });
    expect(s.repo.get(r.preReviewId)!.status).toBe("done");
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
