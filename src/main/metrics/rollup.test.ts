import { describe, expect, it } from "vitest";
import type { DailyRow, MetricEvent, WaitSpan } from "../db/metrics-repo";
import { MergeGateRepo } from "../db/merge-gate-repo";
import { MetricsRepo } from "../db/metrics-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { UsageRepo } from "../db/usage-repo";
import { memDb } from "../test-utils";
import type { RegistryModel } from "../../shared/model-routing";
import { Metrics } from "./events";
import { readAvoidable, readFacts, readRisk, type Facts, type PrFact, type SessionFact, type UsageFact } from "./facts";
import { computeDaily, dayOf, isButlerMade, MetricsRollup, prMetrics, ROLLUP_DAYS, startOfDay, ticketMetrics, UNRATED, usdOf, weightedOf } from "./rollup";

const H = 60 * 60_000;
const T0 = new Date(2026, 9, 1, 9, 0, 0).getTime();

const pr = (o: Partial<PrFact> = {}): PrFact => ({
  id: 1, ticketKey: "T-1", url: "https://github.com/o/app/pull/7", slug: "o/app", number: 7, repoId: 1, repoPath: "/r", headBranch: "feat/a",
  state: "merged", openedAt: T0 + 2 * H, mergedAt: T0 + 10 * H, closedAt: null, source: "branch", ...o,
});
const session = (o: Partial<SessionFact> = {}): SessionFact => ({ id: "s1", ticketKey: "T-1", gitBranch: "feat/a", butler: true, createdAt: T0, ...o });
const use = (o: Partial<UsageFact> = {}): UsageFact => ({
  sessionId: "s1", at: T0 + H, model: "claude-opus-5-5", task: null, source: "session", input: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 10, costUsd: 0.5, ...o,
});
const ev = (o: Partial<MetricEvent> = {}): MetricEvent => ({
  id: 1, kind: "terminal_input", at: T0 + H, sessionId: "s1", ticketKey: "T-1", prId: null, repoSlug: null, data: {}, dedupeKey: null, ...o,
});
const span = (o: Partial<WaitSpan> = {}): WaitSpan => ({
  id: 1, sessionId: "s1", ticketKey: "T-1", kind: "human", category: "permission", source: "permission_prompt", startedAt: T0 + 3 * H, endedAt: T0 + 4 * H, lastSeenAt: T0, ...o,
});
const facts = (o: Partial<Facts> = {}): Facts => ({
  prs: [pr()], sessions: [session()], usage: [], stages: [], avoidable: new Map(), products: new Map(), risk: new Map(),
  owners: [], holds: [], events: [], spans: [], registry: [], ...o,
});
const find = (rows: DailyRow[], metric: string, groupKind = "all", groupKey = "") => rows.filter((r) => r.metric === metric && r.groupKind === groupKind && r.groupKey === groupKey);

describe("rollup helpers", () => {
  it("weights tokens like the usage page and prices unpriced rows from the registry", () => {
    expect(weightedOf(use({ input: 100, cacheWrite5m: 8, cacheWrite1h: 5, cacheRead: 10, output: 2 }))).toBe(100 + 10 + 10 + 1 + 10);
    const reg: RegistryModel[] = [{ name: "opus", tier: "high", enabled: true, account: "a", priceIn: 10, priceOut: 50, note: "" }];
    expect(usdOf(use({ costUsd: 0.25 }), reg)).toEqual({ usd: 0.25, partial: false });
    expect(usdOf(use({ costUsd: null, input: 1_000_000, output: 0 }), reg)).toEqual({ usd: 10, partial: false });
    expect(usdOf(use({ costUsd: null, model: "unknown" }), reg)).toEqual({ usd: 0, partial: true });
  });

  it("uses local calendar days", () => {
    expect(dayOf(new Date(2026, 0, 2, 23, 59).getTime())).toBe("2026-01-02");
  });
});

describe("isButlerMade", () => {
  it("is true when a Butler session pushed the branch, held the merge, or worked on the head branch", () => {
    const f = facts({ sessions: [session({ id: "b", butler: true, gitBranch: "x" }), session({ id: "h", butler: false, gitBranch: "feat/a" })] });
    expect(isButlerMade(pr(), f)).toBe(false);
    expect(isButlerMade(pr(), { ...f, owners: [{ ticketKey: "T-1", repoId: 1, branch: "feat/a", sessionId: "b" }] })).toBe(true);
    expect(isButlerMade(pr(), { ...f, owners: [{ ticketKey: "T-1", repoId: 1, branch: "feat/a", sessionId: "h" }] })).toBe(false);
    const hold = { id: 1, repoPath: "/r", branch: "feat/a", target: "main", kind: "pr" as const, prUrl: "https://github.com/O/app/pull/7/", sessionId: "b", ticketKey: "T-1", createdAt: 0, releasedAt: null, outcome: null };
    expect(isButlerMade(pr(), { ...f, holds: [hold] })).toBe(true);
    expect(isButlerMade(pr(), facts())).toBe(true);
  });
});

describe("prMetrics", () => {
  it("computes both cycle times from PR open and from the ticket's first session", () => {
    const m = prMetrics(facts(), new Map([[1, true]]), T0 + 20 * H).get(1)!;
    expect(m.cycleOpenMs).toBe(8 * H);
    expect(m.cycleTicketMs).toBe(10 * H);
    expect(m.butler).toBe(true);
  });

  it("counts human and Copilot comments, skips empty reviews, and takes avoidable and auto-handled counts", () => {
    const f = facts({
      stages: [
        { prId: 1, kind: "comment", at: T0, who: "human", hasBody: true, result: null, reviewId: null },
        { prId: 1, kind: "review", at: T0, who: "human", hasBody: false, result: null, reviewId: null },
        { prId: 1, kind: "review", at: T0, who: "copilot", hasBody: true, result: null, reviewId: null },
        { prId: 1, kind: "comment", at: T0, who: "author", hasBody: true, result: null, reviewId: null },
        { prId: 1, kind: "ci", at: T0, who: null, hasBody: false, result: "failing", reviewId: null },
        { prId: 1, kind: "ci", at: T0, who: null, hasBody: false, result: "passing", reviewId: null },
      ],
      avoidable: new Map([["o/app#7", 2]]),
      events: [ev({ kind: "comment_auto_handled", prId: 1 }), ev({ kind: "pr_reopened", prId: 1 }), ev({ kind: "pr_reverted", prId: 1 })],
    });
    expect(prMetrics(f, new Map(), T0).get(1)).toMatchObject({
      commentsHuman: 1, commentsCopilot: 1, commentsAvoidable: 2, commentsAutoHandled: 1, ciFailures: 1, reopens: 1, reverts: 1,
    });
  });

  it("counts a review once even when it was recorded again with another state (DISMISSED)", () => {
    const review = (reviewId: string) => ({ prId: 1, kind: "review" as const, at: T0, who: "human", hasBody: true, result: null, reviewId });
    // r1 先是 COMMENTED、后来被 DISMISSED：两条 stage，一个 review。
    const f = facts({ stages: [review("r1"), review("r1"), review("r2")] });
    expect(prMetrics(f, new Map(), T0).get(1)!.commentsHuman).toBe(2);
  });

  it("attributes interventions, waits and cost by head branch, splits the rest across the ticket, and ignores what happens after merge", () => {
    const f = facts({
      prs: [pr(), pr({ id: 2, number: 8, url: "https://github.com/o/app/pull/8", headBranch: "feat/b", mergedAt: T0 + 30 * H })],
      sessions: [session(), session({ id: "s2", gitBranch: "main" })],
      events: [
        ev({ sessionId: "s1" }),
        ev({ sessionId: "s2", kind: "needs_you_answer" }),
        ev({ sessionId: "s1", at: T0 + 11 * H }), // 合并之后：不归 PR 1
        ev({ sessionId: "s1", kind: "agent_merge" }), // 不是人介入
        ev({ sessionId: null, kind: "manual_merge", prId: 2 }),
      ],
      spans: [span({ sessionId: "s1", startedAt: T0 + 9 * H, endedAt: T0 + 12 * H }), span({ sessionId: "s1", kind: "idle" })],
      usage: [use({ sessionId: "s1", task: "needs_you" }), use({ sessionId: "s2", costUsd: 1 })],
    });
    const m = prMetrics(f, new Map(), T0 + 40 * H);
    expect(m.get(1)!.interventions).toBe(1.5);
    expect(m.get(2)!.interventions).toBe(1.5);
    expect(m.get(1)!.waitHumanMs).toBe(H); // 只算到合并
    expect(m.get(1)!.costUsd).toBe(1);
    expect(m.get(2)!.costUsd).toBe(0.5);
    expect([...m.get(1)!.costByTask.keys()].sort()).toEqual(["(interactive)", "needs_you"]);
    expect(m.get(1)!.costByModel.get("claude-opus-5-5")).toBe(150 + 75);
  });
});

describe("ticketMetrics", () => {
  it("counts a ticket once every PR is merged or closed, with all its sessions' cost", () => {
    const f = facts({
      prs: [pr(), pr({ id: 2, state: "closed", mergedAt: null, closedAt: T0 + 5 * H })],
      usage: [use(), use({ at: T0 + 50 * H })],
    });
    const t = ticketMetrics(f, prMetrics(f, new Map([[1, true]]), T0));
    expect(t).toEqual([expect.objectContaining({ ticketKey: "T-1", doneAt: T0 + 10 * H, butler: true, costUsd: 0.5 })]);
    const open = facts({ prs: [pr(), pr({ id: 2, state: "open", mergedAt: null })] });
    expect(ticketMetrics(open, prMetrics(open, new Map(), T0))).toEqual([]);
  });
});

describe("computeDaily", () => {
  it("writes PR metrics on the merge day for all, repo, product and risk groups", () => {
    const f = facts({ products: new Map([["o/app", ["Shop"]]]), risk: new Map([[1, "high"]]) });
    const rows = computeDaily(f, new Map([[1, true]]), T0 + 20 * H, "2000-01-01");
    const day = dayOf(T0 + 10 * H);
    expect(find(rows, "pr_merged")).toEqual([{ day, groupKind: "all", groupKey: "", butler: true, metric: "pr_merged", n: 1, total: 1 }]);
    expect(find(rows, "cycle_open_ms", "repo", "o/app")[0].total).toBe(8 * H);
    expect(find(rows, "pr_merged", "product", "Shop")).toHaveLength(1);
    expect(find(rows, "pr_merged", "risk", "high")).toHaveLength(1);
    expect(find(rows, "ticket_done")).toHaveLength(1);
  });

  it("puts PRs without a risk level under unrated and splits Butler from other PRs", () => {
    const f = facts({ prs: [pr(), pr({ id: 2, number: 8, url: "u8", headBranch: "x" })], sessions: [session({ butler: false })] });
    const rows = computeDaily(f, new Map([[1, true], [2, false]]), T0 + 20 * H, "2000-01-01");
    expect(find(rows, "pr_merged", "risk", UNRATED).map((r) => [r.butler, r.n])).toEqual([[true, 1], [false, 1]]);
  });

  it("counts events, interrupt categories and wait spans on their own day", () => {
    const f = facts({
      events: [ev({ kind: "interrupt", data: { category: "choice" }, repoSlug: "o/app" }), ev({ kind: "terminal_input" })],
      spans: [span(), span({ id: 2, kind: "idle", category: null, startedAt: T0 + 5 * H, endedAt: null })],
    });
    const rows = computeDaily(f, new Map(), T0 + 6 * H, "2000-01-01");
    expect(find(rows, "interrupt:choice")[0]).toMatchObject({ n: 1, butler: true });
    expect(find(rows, "interrupt:choice", "repo", "o/app")).toHaveLength(1);
    expect(find(rows, "event:terminal_input")[0].n).toBe(1);
    expect(find(rows, "wait_human:permission")[0].total).toBe(H);
    expect(find(rows, "event_sub:terminal_input:prompt")).toHaveLength(0); // 没有子类的事件不写 event_sub
    expect(find(rows, "wait_idle")[0].total).toBe(H); // 还开着：算到现在
  });

  it("counts event subtypes from data.mode, data.via or data.channel under event_sub (ws-h)", () => {
    const f = facts({
      events: [
        ev({ kind: "terminal_input", data: { mode: "prompt" } }), ev({ kind: "terminal_input", data: { mode: "prompt" } }), ev({ kind: "terminal_input", data: { mode: "dialog" } }),
        ev({ kind: "needs_you_answer", data: { via: "card" } }), ev({ kind: "manual_trigger", data: { channel: "lessons:run" } }), ev({ kind: "manual_merge", data: { mode: 3 } }),
      ],
    });
    const rows = computeDaily(f, new Map(), T0 + 6 * H, "2000-01-01");
    expect(find(rows, "event_sub:terminal_input:prompt")[0]).toMatchObject({ n: 2, total: 2, groupKind: "all" });
    expect(find(rows, "event_sub:terminal_input:dialog")[0].n).toBe(1);
    expect(find(rows, "event_sub:needs_you_answer:card")[0].n).toBe(1);
    expect(find(rows, "event_sub:manual_trigger:lessons:run")[0].n).toBe(1);
    expect(rows.filter((r) => r.metric.startsWith("event_sub:manual_merge"))).toHaveLength(0); // 不是字符串的不算
    expect(rows.filter((r) => r.metric.startsWith("event_sub:") && r.groupKind !== "all")).toHaveLength(0);
  });

  it("marks session-less events Butler by their PR or ticket (manual merges of Butler PRs)", () => {
    const f = facts({
      prs: [pr(), pr({ id: 2, ticketKey: "T-2", number: 8, url: "u8", headBranch: "x" })],
      events: [
        ev({ sessionId: null, kind: "manual_merge", prId: 1, ticketKey: "T-1" }),
        ev({ sessionId: null, kind: "manual_merge", prId: 2, ticketKey: "T-2" }),
        ev({ sessionId: null, kind: "manual_trigger", ticketKey: "T-1" }),
        ev({ sessionId: null, kind: "manual_trigger", ticketKey: "T-2" }),
      ],
    });
    const rows = computeDaily(f, new Map([[1, true], [2, false]]), T0 + 20 * H, "2000-01-01");
    expect(find(rows, "event:manual_merge").map((r) => [r.butler, r.n]).sort()).toEqual([[false, 1], [true, 1]]);
    expect(find(rows, "event:manual_trigger").map((r) => [r.butler, r.n]).sort()).toEqual([[false, 1], [true, 1]]);
  });

  it("adds all spend by task and model on the day it was spent, headless runs included", () => {
    const f = facts({
      sessions: [session(), session({ id: "h", butler: false })],
      usage: [use({ sessionId: null, task: "handoff", model: "m1" }), use({ sessionId: "s1", task: null }), use({ sessionId: "h", task: null })],
    });
    const rows = computeDaily(f, new Map(), T0 + 20 * H, "2000-01-01");
    expect(find(rows, "spend_task:handoff")).toEqual([expect.objectContaining({ butler: true, total: 150, day: dayOf(T0 + H) })]);
    expect(find(rows, "spend_task:(interactive)").map((r) => [r.butler, r.total]).sort()).toEqual([[false, 150], [true, 150]]);
    expect(find(rows, "spend_model:m1")).toHaveLength(1);
  });

  it("drops rows before the window", () => {
    expect(computeDaily(facts(), new Map(), T0 + 20 * H, "2999-01-01")).toEqual([]);
  });
});

describe("readers", () => {
  it("reads G's pr_risk if it exists, from the first level-like column, and nothing otherwise", () => {
    const db = memDb();
    // G's migration creates pr_risk; drop it to check the reader copes with the table missing or shaped differently.
    expect(readRisk(db).size).toBe(0);
    db.exec(`DROP TABLE pr_risk`);
    expect(readRisk(db).size).toBe(0);
    db.exec(`CREATE TABLE pr_risk (pr_id INTEGER, tier TEXT)`);
    db.exec(`INSERT INTO pr_risk VALUES (3, ' High '), (4, NULL)`);
    expect([...readRisk(db)]).toEqual([[3, "high"]]);
  });

  it("counts avoidable findings from the latest finished lesson run", () => {
    const db = memDb();
    db.exec(`INSERT INTO lesson_repos (slug, local_path, created_at) VALUES ('o/app', '/r', 0)`);
    const run = (id: number, status: string, findings: unknown) =>
      db.prepare(`INSERT INTO lesson_runs (id, repo_slug, pr_number, origin, status, findings_json, started_at) VALUES (?, 'o/app', 7, 'manual', ?, ?, 0)`).run(id, status, JSON.stringify(findings));
    run(1, "done", [{ avoidable: true }, { avoidable: true }]);
    run(2, "done", [{ avoidable: true }, { avoidable: false }]);
    run(3, "failed", [{ avoidable: true }, { avoidable: true }, { avoidable: true }]);
    expect(readAvoidable(db).get("o/app#7")).toBe(1);
  });

  it("reads comment, review and CI stages for PRs in the window without parsing bodies in JS, and tolerates bad JSON", () => {
    const db = memDb();
    const tickets = new TicketsRepo(db);
    tickets.insert({ key: "T-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
    const repoId = tickets.addRepo({ ticketKey: "T-1", repoPath: "/r/app", workMode: "branch", worktreePath: null, branch: "feat/a", createdAt: 1 });
    const prs = new TicketPrsRepo(db);
    const link = (n: number, mergedAt: number) =>
      prs.link({ ticketKey: "T-1", url: `https://github.com/o/app/pull/${n}`, slug: "o/app", repoId, number: n, headBranch: "feat/a", state: "merged", source: "branch", linkedAt: 0, openedAt: 0, mergedAt }).pr;
    const recent = link(7, T0);
    const old = link(8, T0 - 500 * 24 * H);
    const stage = (prId: number, kind: string, data: string) =>
      db.prepare(`INSERT INTO pr_stage_events (ticket_key, pr_id, kind, at, data, dedupe_key) VALUES ('T-1', ?, ?, ?, ?, ?)`).run(prId, kind, T0, data, `${prId}:${kind}:${data}`);
    stage(recent.id, "review", JSON.stringify({ id: "R1", who: "human", body: "  please fix  " }));
    stage(recent.id, "review", JSON.stringify({ id: 42, who: "human", body: "   " }));
    stage(recent.id, "ci", JSON.stringify({ result: "failing" }));
    stage(recent.id, "comment", "{not json");
    stage(old.id, "comment", JSON.stringify({ who: "human", body: "old" }));
    const f = readFacts(db, T0 - 10 * 24 * H, { events: [], spans: [], holds: [], registry: [] });
    expect(f.prs.find((p) => p.id === recent.id)?.repoPath).toBe("/r/app");
    expect(f.stages.map((x) => [x.kind, x.who, x.hasBody, x.result, x.reviewId])).toEqual([
      ["review", "human", true, null, "R1"],
      ["review", "human", false, null, "42"],
      ["ci", null, false, "failing", null],
      ["comment", null, false, null, null],
    ]);
  });
});

describe("MetricsRollup", () => {
  it("tags butler_made, records how merged PRs were merged, and replaces the window's daily rows idempotently", () => {
    const db = memDb();
    const tickets = new TicketsRepo(db);
    tickets.insert({ key: "T-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
    const repoId = tickets.addRepo({ ticketKey: "T-1", repoPath: "/r/app", workMode: "branch", worktreePath: null, branch: "feat/a", createdAt: 1 });
    const prs = new TicketPrsRepo(db);
    const now = T0 + 20 * H;
    const link = (n: number, branch: string) =>
      prs.link({ ticketKey: "T-1", url: `https://github.com/o/app/pull/${n}`, slug: "o/app", repoId, number: n, headBranch: branch, state: "merged", source: "branch", linkedAt: T0, openedAt: T0 + H, mergedAt: T0 + 10 * H }).pr;
    const a = link(7, "feat/a");
    const b = link(8, "feat/b");
    new SessionsRepo(db).insertIfAbsent({ id: "s1", ticketKey: "T-1", cwd: "/r/app", origin: "butler", gitBranch: "feat/a", createdAt: T0 });
    new UsageRepo(db).record([{ messageId: "m1", sessionId: "s1", agentId: null, source: "session", job: null, at: T0 + H, model: "m", input: 10, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, context: 10, costUsd: 0.1 }]);
    const gate = new MergeGateRepo(db);
    const holdId = gate.addHold({ repoPath: "/r/app", branch: "feat/a", target: "main", kind: "pr", prUrl: a.url, sessionId: "s1", ticketKey: "T-1", createdAt: T0 + 9 * H });
    gate.releaseHold(holdId, "merged", T0 + 10 * H);
    const repo = new MetricsRepo(db);
    const m = new Metrics({ repo, now: () => now });
    const r = new MetricsRollup({ db, repo, holds: gate, registry: () => [], record: m.recordEvent, since: () => T0, now: () => now });
    expect(r.run()).toBe(true);
    expect(r.run()).toBe(true);
    const made = db.prepare(`SELECT id, butler_made FROM ticket_prs ORDER BY id`).all() as { id: number; butler_made: number }[];
    expect(made.map((x) => [Number(x.id), Number(x.butler_made)])).toEqual([[a.id, 1], [b.id, 0]]);
    expect(repo.events(0).map((e) => [e.kind, e.prId]).sort()).toEqual([["agent_merge", a.id], ["manual_merge", b.id]]);
    const daily = repo.daily("2000-01-01");
    expect(find(daily, "pr_merged").map((x) => [x.butler, x.n]).sort()).toEqual([[false, 1], [true, 1]]);
    expect(find(daily, "event:manual_merge")).toHaveLength(1);
    expect(r.runIfStale(60_000)).toBe(false);
  });

  it("runs again once the last run is older than maxAge", () => {
    const db = memDb();
    const repo = new MetricsRepo(db);
    let now = T0;
    const r = new MetricsRollup({ db, repo, holds: new MergeGateRepo(db), registry: () => [], record: () => false, since: () => 0, now: () => now });
    expect(r.runIfStale(H)).toBe(true);
    expect(r.lastRun).toBe(T0);
    now += H - 1;
    expect(r.runIfStale(H)).toBe(false);
    now += 1;
    expect(r.runIfStale(H)).toBe(true);
  });

  it("starts the window at local midnight and prunes rows older than the window", () => {
    const db = memDb();
    const repo = new MetricsRepo(db);
    const now = new Date(2026, 9, 1, 15, 30).getTime();
    const fromDay = dayOf(startOfDay(now - ROLLUP_DAYS * 24 * H));
    expect(startOfDay(now)).toBe(new Date(2026, 9, 1).getTime());
    repo.replaceDaily("1990-01-01", [{ day: "1990-01-01", groupKind: "all", groupKey: "", butler: false, metric: "pr_merged", n: 1, total: 1 }]);
    const r = new MetricsRollup({ db, repo, holds: new MergeGateRepo(db), registry: () => [], record: () => false, since: () => 0, now: () => now });
    expect(r.run()).toBe(true);
    expect(repo.daily("1900-01-01").filter((x) => x.day < fromDay)).toEqual([]);
  });

  it("returns false instead of throwing when the database fails", () => {
    const db = memDb();
    const repo = new MetricsRepo(db);
    const r = new MetricsRollup({
      db, repo, holds: { allHolds: () => { throw new Error("x"); } }, registry: () => [], record: () => false, since: () => 0, now: () => 1, log: () => {},
    });
    expect(r.run()).toBe(false);
    // 一直失败也不会每次都重算：按上次开始跑的时间算新旧。
    expect(r.runIfStale(10)).toBe(false);
  });
});
