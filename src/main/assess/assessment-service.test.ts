import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { AssessRepo } from "../db/assess-repo";
import { PreReviewRepo, type PreReviewRow } from "../db/prereview-repo";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import type { HeadlessExecResult } from "../handoff/headless-exec";
import type { PrStatus } from "../tickets/gh";
import type { ProfileProject } from "../../shared/baselines";
import { defaultPrPolicy } from "../../shared/pr-policy";
import { BRIEF_END, BRIEF_START } from "../../shared/prereview";
import { evidenceStatus, requiredEvidence } from "../prereview/evidence";
import type { ExecRun } from "../prereview/model";
import { AssessmentService, openChangeRequests } from "./assessment-service";
import { BriefService } from "./brief-service";
import { upsertBriefBlock } from "./brief";

const SHA = "a".repeat(40);
const T = { repoSlug: "o/app", branch: "feat/x", headSha: SHA };
const proj: ProfileProject = { dir: "", langs: [], install: null, build: null, testAll: "pnpm test", testOne: null, fastest: null, lint: null, typecheck: null, inferred: [] };
const profile = { projects: [proj], dirs: [], ci: [], pitfalls: [] };
const DESC = "## Summary\nWhat changed: adds the thing to the parser.\n\n## Why\nBecause the old one dropped input.\n\n## Test\nUnit tests cover the new branch.";
const route = { task: "pr_brief" as const, requestedTier: "mid" as const, actualModel: "m", fallbackFrom: null, degraded: false, sameModelReview: false };

function setup(o: { allowed?: boolean; withTest?: boolean } = {}) {
  const db = memDb();
  new TicketsRepo(db).insert({ key: "T-1", title: "Parser fix", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const prs = new TicketPrsRepo(db);
  const pr0 = prs.link({ ticketKey: "T-1", url: "https://github.com/o/app/pull/4", slug: "o/app", repoId: null, number: 4, headBranch: "feat/x", state: "open", source: "branch", linkedAt: 1 }).pr;
  prs.update(pr0.id, { headSha: SHA, ci: "passing", mergeable: "mergeable", title: "Fix parser", isDraft: false });
  const pr = prs.get(pr0.id)!;
  const pre = new PreReviewRepo(db);
  const assess = new AssessRepo(db);
  const events: { kind: string; key?: string }[] = [];
  const policy = () => defaultPrPolicy();
  const gaps = (row: PreReviewRow) => evidenceStatus(pre.evidenceOf(row.id), requiredEvidence(profile, row.files.map((f) => f.path), policy().evidence));
  const id = pre.insert({ ticketKey: "T-1", sessionId: "s1", target: T, cwd: "/w", base: "main", prId: pr.id, trigger: "evidence", notes: "Left the old flag in place on purpose.", createdAt: 1 });
  pre.update(id, { status: "done", verdict: "clean", files: [{ path: "src/a.ts", added: 5, deleted: 1, binary: false }], finishedAt: 2 });
  const base = { preReviewId: id, prId: pr.id, ticketKey: "T-1", sessionId: "s1", target: T, createdAt: 1 };
  if (o.withTest !== false) {
    const e = pre.addEvidence({ ...base, kind: "check", category: "test", name: "unit", command: "echo SESSION CMD", claimed: "pass", summary: "SESSION SAYS 12 passed" });
    pre.setVerified(e, "rerun_pass", "pnpm test", null, 3);
  }
  const a = pre.addEvidence({ ...base, kind: "acceptance", category: null, name: "AC1 parser keeps input", command: null, claimed: null, summary: "added a branch" });
  pre.setVerified(a, "consistent", "matches the diff", null, 3);
  pre.addEvidence({ ...base, kind: "not_run", category: "build", name: "build", command: null, claimed: null, summary: "no build step for this change" });
  const service = new AssessmentService({
    prs, preReviews: pre, repo: assess, gaps, preReviewEnabled: () => true, policy, checks: () => ({ absent: null, hits: [] }), sessionOf: () => "s1",
    openCommentItems: () => null, waitingOnGate: () => false, files: async () => null,
    recordEvent: (kind, refs) => (events.push({ kind, key: refs?.dedupeKey }), true), lang: () => "en", changed: () => undefined, now: () => 10, log: () => undefined,
  });
  const audits: { outcome: string; target?: string | null }[] = [];
  let ghBody = `Intro text\n\n${BRIEF_START}\nold brief\n${BRIEF_END}\n\nFooter text`;
  const edits: string[] = [];
  const run: ExecRun = async () => ({ ok: true, value: { summary: "Fixes the parser so it keeps input." }, rawText: "", result: {} as never, route }) as HeadlessExecResult;
  const briefs = new BriefService({
    repo: assess, preReviews: pre, prs, assessment: service, gaps, policy, ticketTitle: () => "Parser fix", exec: run,
    external: {
      allowed: () => o.allowed ?? false,
      record: (_k, d) => (audits.push({ outcome: d.outcome, target: d.target }), audits.length),
      attempt: async (_k, d, fn) => {
        if (!(o.allowed ?? false)) return { ran: false, auditId: 0 };
        const value = await fn();
        audits.push({ outcome: "done", target: d.target });
        return { ran: true, value, auditId: audits.length };
      },
    },
    ghCwd: () => "/w",
    gh: { body: async () => ghBody, edit: async (x) => void (edits.push(x.body), (ghBody = x.body)) },
    lang: () => "en", changed: () => undefined, now: () => 20, log: () => undefined,
  });
  const status = { headSha: SHA, body: DESC, author: "me", reviews: [] } as unknown as PrStatus;
  return { db, prs, pr, pre, assess, service, briefs, events, audits, edits, rowId: id, status, ghBody: () => ghBody };
}

describe("AssessmentService", () => {
  it("acceptance 1: checks pass, evidence verified, clean pre-review → ready, low risk, one pr_ready event", async () => {
    const s = setup();
    await s.service.observe([s.pr], s.status);
    const r = s.assess.readiness(s.pr.id)!;
    expect(r.missing).toEqual([]);
    expect(r.ready).toBe(true);
    expect(s.assess.risk(s.pr.id)!.level).toBe("low");
    expect(s.events).toEqual([{ kind: "pr_ready", key: `ready:${s.pr.id}:${SHA}` }]);
    const at = s.assess.readiness(s.pr.id)!.computedAt;
    await s.service.assess(s.pr.id);
    expect(s.events).toHaveLength(1);
    expect(s.assess.readiness(s.pr.id)!.computedAt).toBe(at);
  });
  it("acceptance 3: missing test evidence → not ready, says what is missing, never low", async () => {
    const s = setup({ withTest: false });
    await s.service.observe([s.pr], s.status);
    const r = s.assess.readiness(s.pr.id)!;
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual([expect.objectContaining({ key: "evidence", state: "fail", detail: expect.stringContaining("missing test output") })]);
    expect(s.assess.risk(s.pr.id)!.level).not.toBe("low");
    expect(s.events.map((e) => e.kind)).not.toContain("pr_ready");
  });
  it("comments and description are unknown until the PR has been read", async () => {
    const s = setup();
    await s.service.assess(s.pr.id);
    expect(s.assess.readiness(s.pr.id)!.missing.map((m) => [m.key, m.state])).toEqual([["comments", "unknown"], ["description", "unknown"]]);
  });
  it("pr_risk_high fires once when the level becomes high", async () => {
    const s = setup();
    s.pre.update(s.rowId, { files: [{ path: "db/migrations/001.sql", added: 3, deleted: 0, binary: false }] });
    await s.service.observe([s.pr], s.status);
    await s.service.assess(s.pr.id);
    expect(s.assess.risk(s.pr.id)!.level).toBe("high");
    expect(s.events.filter((e) => e.kind === "pr_risk_high")).toEqual([{ kind: "pr_risk_high", key: `risk_high:${s.pr.id}:${SHA}` }]);
  });
  it("closed PRs keep their last result", async () => {
    const s = setup();
    await s.service.observe([s.pr], s.status);
    s.prs.update(s.pr.id, { state: "merged", ci: "failing" });
    await s.service.assess(s.pr.id);
    expect(s.assess.readiness(s.pr.id)!.ready).toBe(true);
  });
  it("openChangeRequests ignores the author and bots and lets a later approval win", () => {
    const r = (author: string, state: string, at: number) => ({ id: String(at), author, state, body: "", submittedAt: at }) as never;
    expect(openChangeRequests([r("me", "CHANGES_REQUESTED", 1), r("copilot-pull-request-reviewer[bot]", "CHANGES_REQUESTED", 2), r("bob", "CHANGES_REQUESTED", 3), r("bob", "APPROVED", 4), r("amy", "CHANGES_REQUESTED", 5)], "me")).toBe(1);
  });
});

describe("BriefService", () => {
  it("renders the six sections from verified evidence only", async () => {
    const s = setup();
    await s.service.observe([s.pr], s.status);
    const b = (await s.briefs.generate(s.pre.get(s.rowId)!))!;
    expect(b.summaryOk).toBe(true);
    const md = b.markdown;
    expect(md.startsWith(BRIEF_START) && md.endsWith(BRIEF_END)).toBe(true);
    expect(md).toContain("Fixes the parser so it keeps input.");
    expect(md).toContain("Butler's rerun passed (`pnpm test`)");
    expect(md).toContain("output checked");
    expect(md).not.toContain("SESSION SAYS");
    expect(md).not.toContain("SESSION CMD");
    expect(md).toContain("### Risk");
    expect(md).toContain("### Pre-review\n\nClean.");
    expect(md).toContain("`src/a.ts`");
    expect(md).toContain("no build step for this change");
    expect(md).toContain("Left the old flag in place on purpose.");
    // off by default: not posted.
    expect(s.edits).toEqual([]);
  });
  it("posting replaces only Butler's block and records the audit", async () => {
    const s = setup();
    const b = (await s.briefs.generate(s.pre.get(s.rowId)!))!;
    expect(await s.briefs.post(s.pr.id, true)).toEqual({ ok: true, url: s.pr.url });
    expect(s.ghBody()).toBe(`Intro text\n\n${b.markdown}\n\nFooter text`);
    expect(s.audits).toEqual([{ outcome: "done", target: s.pr.url }]);
    expect(s.assess.brief(b.id)!.postedUrl).toBe(s.pr.url);
  });
  it("auto-posts after generating when externalPrBriefPost is on", async () => {
    const s = setup({ allowed: true });
    await s.briefs.generate(s.pre.get(s.rowId)!);
    expect(s.edits).toHaveLength(1);
  });
  it("briefProvider returns null while the switch is off, the brief when on", async () => {
    const off = setup();
    await off.briefs.generate(off.pre.get(off.rowId)!);
    expect(off.briefs.briefProvider({ repoSlug: "o/app", branch: "feat/x", headSha: SHA, ticketKey: "T-1", prNumber: null })).toBeNull();
    const on = setup({ allowed: true });
    on.prs.update(on.pr.id, { isDraft: true });
    await on.briefs.generate(on.pre.get(on.rowId)!);
    const got = on.briefs.briefProvider({ repoSlug: "o/app", branch: "feat/x", headSha: null, ticketKey: "T-1", prNumber: null })!;
    expect(got.markdown).toContain(BRIEF_START);
    got.posted("https://github.com/o/app/pull/9");
    expect(on.assess.latestBriefForBranch("o/app", "feat/x")!.postedUrl).toBe("https://github.com/o/app/pull/9");
  });
});

describe("upsertBriefBlock", () => {
  it("appends when there is no block and leaves the rest alone", () => {
    expect(upsertBriefBlock("Hello\n\n", `${BRIEF_START}\nx\n${BRIEF_END}`)).toBe(`Hello\n\n${BRIEF_START}\nx\n${BRIEF_END}\n`);
    expect(upsertBriefBlock("", "B")).toBe("B\n");
  });
});
