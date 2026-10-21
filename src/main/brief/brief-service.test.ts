import { describe, expect, it } from "vitest";
import type { Handoff } from "../../shared/handoff";
import { BriefsRepo } from "../db/briefs-repo";
import { FollowupsRepo } from "../db/followups-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { MarksRepo } from "../db/marks-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { ingestHandoff, type IngestInput } from "../handoff/ingest";
import { emptyHandoff } from "../handoff/schema";
import { memDb } from "../test-utils";
import { BriefService, prPathParts } from "./brief-service";

const at = (d: number, h = 9, m = 0) => new Date(2026, 9, d, h, m).getTime();

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  let now = at(21);
  let unclaimed = 0;
  let fid = 0;
  const ingest = (input: IngestInput) => ingestHandoff({ db, tickets, handoffs, followups, now: () => now, newFollowupId: () => `f${++fid}` }, input);
  const service = new BriefService({
    tickets, sessions, handoffs, followups, marks: new MarksRepo(db), briefs: new BriefsRepo(db), settings: new SettingsRepo(db),
    now: () => now, unclaimedCount: () => unclaimed,
  });
  /** ticket 加一个最近有活动的 session（免得被算成“无活动”）。 */
  const addTicket = (key: string, activity = at(20)) => {
    tickets.insert({ key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: at(1), archivedAt: null });
    sessions.insertIfAbsent({ id: `s-${key}`, ticketKey: key, cwd: "/w", origin: "butler", lastActivityAt: activity, createdAt: at(1) });
  };
  const handoff = (key: string, over: Partial<Handoff>) =>
    ingest({ ticketKey: key, sessionId: `s-${key}`, trigger: "nightly", rawText: null, payload: { ...emptyHandoff(key), ...over } });
  const refresh = (key: string, r: { status: Handoff["status"]; pr: Handoff["pr"]; jira: Handoff["jira"] }) =>
    ingest({ ticketKey: key, sessionId: null, trigger: "refresh", rawText: null, payload: { ...emptyHandoff(key), ...r } });
  return {
    service, tickets, sessions, addTicket, handoff, refresh,
    setNow: (ms: number) => void (now = ms),
    setUnclaimed: (n: number) => void (unclaimed = n),
  };
}

describe("BriefService", () => {
  it("builds a morning brief from the database, looks back to Friday on Monday, and keeps the narrative off", () => {
    const s = setup();
    s.addTicket("A-1", at(16, 17));
    s.setNow(at(16, 16));
    s.handoff("A-1", { done_today: ["周五做的"], next_steps: ["周一先做"] });
    s.setNow(at(19, 9));
    const brief = s.service.generateMorning();
    expect(brief).toMatchObject({ kind: "morning", date: "2026-10-19", narrative: null, narrativeStatus: "off" });
    expect(brief.previousDay).toEqual({ date: "2026-10-16", entries: [{ ticketKey: "A-1", done: ["周五做的"] }] });
    expect(brief.items.map((i) => [i.rule, i.ticketKey, i.text])).toEqual([["next_step", "A-1", "周一先做"]]);
    expect(s.service.latest("morning")).toEqual(brief);
  });

  it("measures a manually blocked ticket from when it was set by hand", () => {
    const s = setup();
    s.addTicket("B-2");
    s.tickets.setStatusManual("B-2", "blocked", at(15));
    expect(s.service.generateMorning().items.map((i) => [i.rule, i.days])).toEqual([["blocked_long", 6]]);
  });

  it("snoozes an item until tomorrow", () => {
    const s = setup();
    s.addTicket("A-1");
    s.handoff("A-1", { next_steps: ["写测试"] });
    const key = s.service.generateMorning().items[0].key;
    s.service.mark(key, "snoozed");
    expect(s.service.generateMorning().items).toEqual([]);
    s.setNow(at(22));
    expect(s.service.generateMorning().items.map((i) => i.key)).toEqual([key]);
  });

  it("counts unclaimed sessions and builds the evening summary from today's handoffs", () => {
    const s = setup();
    s.setUnclaimed(2);
    expect(s.service.generateMorning().items.map((i) => [i.rule, i.count])).toEqual([["unclaimed", 2]]);
    s.addTicket("A-1");
    s.setNow(at(21, 16));
    s.handoff("A-1", { done_today: ["今天做的"], next_steps: ["明天做的"] });
    const evening = s.service.generateEvening();
    expect(evening).toMatchObject({ kind: "evening", date: "2026-10-21", narrativeStatus: "off" });
    expect(evening.evening).toEqual([{ ticketKey: "A-1", done: ["今天做的"], blockers: [], next: "明天做的", degraded: false }]);
    expect(s.service.latest("evening")?.id).toBe(evening.id);
  });

  it("leaves archived and done tickets out of the snapshot and the stale rule", () => {
    const s = setup();
    s.addTicket("OLD-1", at(1));
    s.addTicket("DONE-1", at(1));
    s.addTicket("LIVE-1", at(1));
    s.tickets.archive("OLD-1", at(20));
    s.tickets.setStatusManual("DONE-1", "done", at(10));
    expect(s.service.snapshot().map((t) => t.key)).toEqual(["LIVE-1"]);
    expect(s.service.generateMorning().items.map((i) => [i.rule, i.ticketKey])).toEqual([["stale", "LIVE-1"]]);
  });

  it("uses the last full handoff as latest, so a morning refresh keeps next_step keys stable but updates the PR", () => {
    const s = setup();
    s.addTicket("A-1");
    s.setNow(at(20, 16));
    s.handoff("A-1", { next_steps: ["写测试"] });
    const before = s.service.generateMorning().items.map((i) => i.key);
    expect(before).toHaveLength(1);
    s.setNow(at(21, 8));
    s.refresh("A-1", { status: "active", pr: null, jira: { status: "In Progress", subtasks: [] } });
    const snap = s.service.snapshot()[0];
    expect(snap.latest?.trigger).toBe("nightly");
    expect(snap.latest?.payload?.jira?.status).toBe("In Progress");
    expect(s.service.generateMorning().items.map((i) => i.key)).toEqual(before);
    s.refresh("A-1", { status: "in_review", pr: { number: 7, url: "u", state: "open", review: "approved" }, jira: null });
    expect(s.service.snapshot()[0].latest).toMatchObject({ trigger: "nightly", payload: { pr: { review: "approved" } } });
    expect(s.service.generateMorning().items.map((i) => i.rule)).toContain("pr_approved");
  });

  it("takes handoffs from the previous working day up to now, oldest first, without refreshes", () => {
    const s = setup();
    s.addTicket("A-1");
    s.addTicket("B-2");
    s.setNow(at(15, 16));
    s.handoff("A-1", { done_today: ["周四的"] });
    s.setNow(at(16, 10));
    s.handoff("A-1", { done_today: ["周五上午"] });
    s.setNow(at(16, 16));
    s.handoff("B-2", { done_today: ["周五下午"] });
    s.setNow(at(19, 8));
    s.handoff("A-1", { done_today: ["周一早上补跑的"] });
    s.refresh("B-2", { status: "active", pr: null, jira: null });
    const brief = s.service.generateMorning();
    expect(brief.previousDay).toEqual({
      date: "2026-10-16",
      entries: [{ ticketKey: "A-1", done: ["周五上午", "周一早上补跑的"] }, { ticketKey: "B-2", done: ["周五下午"] }],
    });
  });

  it("includes the catch-up nightly handoff in the morning brief after the laptop slept through Tuesday 16:00", () => {
    const s = setup();
    s.addTicket("A-1", at(20, 15));
    s.setNow(at(21, 8, 30));
    s.handoff("A-1", { done_today: ["周二下午的活"] });
    s.setNow(at(21, 8, 31));
    const brief = s.service.generateMorning();
    expect(brief.previousDay).toEqual({ date: "2026-10-20", entries: [{ ticketKey: "A-1", done: ["周二下午的活"] }] });
  });

  it("falls back to a valid refresh when a ticket has no full handoff", () => {
    const s = setup();
    s.addTicket("A-1");
    s.refresh("A-1", { status: "in_review", pr: { number: 3, url: "u", state: "open", review: "approved" }, jira: null });
    expect(s.service.snapshot()[0].latest).toMatchObject({ trigger: "refresh" });
    expect(s.service.generateMorning().items.map((i) => i.rule)).toContain("pr_approved");
  });

  it("refuses to mark followup items", () => {
    const s = setup();
    expect(() => s.service.mark("followup:f1", "done")).toThrow(/followup/);
  });
});

describe("BriefService.narrativeSource", () => {
  it("collects what the narrative needs and every identifier that could appear in free text", () => {
    const s = setup();
    s.addTicket("A-1");
    s.sessions.insertIfAbsent({ id: "s-other", ticketKey: "A-1", cwd: "/w", origin: "discovered", gitBranch: "hotfix/a1-crash", createdAt: at(1) });
    s.tickets.insert({
      key: "OLD-9", title: null, repoPath: "/repos/legacy-app", workMode: "branch", worktreePath: null, branch: "feature/OLD-9",
      status: "done", statusManual: null, createdAt: at(1), archivedAt: at(2),
    });
    s.handoff("A-1", {
      done_today: ["做了 A"], next_steps: ["写测试"], blockers: ["等评审"],
      pr: { number: 7, url: "https://github.com/acme/billing-svc/pull/7", state: "open", review: "approved" },
      followups: [{ id: null, kind: "flag", description: "开开关", trigger: "on_date", due_date: "2026-10-19", done: false }],
    });
    const brief = s.service.generateMorning();
    const src = s.service.narrativeSource(brief);
    expect(src.date).toBe("2026-10-21");
    expect(src.tickets).toHaveLength(1);
    expect(src.tickets[0]).toMatchObject({
      key: "A-1", status: "in_review", pr: { state: "open", review: "approved" }, doneLastDay: 1,
      nextSteps: ["写测试"], blockers: ["等评审"],
      followups: [{ kind: "flag", trigger: "on_date", description: "开开关", overdueDays: 2 }],
    });
    expect(src.items.map((i) => [i.rule, i.ticketKey])).toEqual(brief.items.map((i) => [i.rule, i.ticketKey]));
    expect([...src.known.tickets].sort()).toEqual(["A-1", "OLD-9"]);
    expect(src.known.repos).toEqual(expect.arrayContaining(["legacy-app", "acme", "billing-svc"]));
    expect(src.known.branches).toEqual(expect.arrayContaining(["b", "feature/OLD-9", "hotfix/a1-crash"]));
  });

  it("lists the identifiers that free text mentions: archived ticket key, session-only branch, PR owner, worktree directory", () => {
    const s = setup();
    s.addTicket("A-1");
    s.sessions.insertIfAbsent({ id: "s-wt", ticketKey: "A-1", cwd: "/work/a1-login-tree", origin: "discovered", gitBranch: "spike/only-in-session", createdAt: at(1) });
    s.tickets.insert({
      key: "OLD-9", title: null, repoPath: "/repos/legacy-app", workMode: "worktree", worktreePath: "/trees/old9-checkout", branch: "feature/OLD-9",
      status: "done", statusManual: null, createdAt: at(1), archivedAt: at(2),
    });
    s.handoff("A-1", {
      next_steps: ["等 OLD-9 合并后在 spike/only-in-session 上 rebase，再问 acme 的人"],
      pr: { number: 7, url: "https://github.com/acme/billing-svc/pull/7", state: "open", review: "pending" },
    });
    const src = s.service.narrativeSource(s.service.generateMorning());
    expect(src.tickets[0].nextSteps[0]).toContain("OLD-9");
    expect(src.known.tickets).toContain("OLD-9");
    expect(src.known.branches).toContain("spike/only-in-session");
    expect(src.known.repos).toContain("acme");
    expect(src.known.repos).toContain("old9-checkout");
    expect(src.known.repos).not.toContain("a1-login-tree");
  });
});

describe("prPathParts", () => {
  it("takes the owner and repository from common PR links", () => {
    expect(prPathParts("https://github.com/acme/billing-svc/pull/7")).toEqual(["acme", "billing-svc"]);
    expect(prPathParts("https://gitlab.example.com/group/sub/app/-/merge_requests/3")).toEqual(["group", "sub", "app"]);
    expect(prPathParts("https://bitbucket.example.com/projects/PAY/repos/ledger/pull-requests/9")).toEqual(["PAY", "ledger"]);
    expect(prPathParts("https://dev.azure.com/org/proj/_git/repo/pullrequest/12")).toEqual(["org", "proj", "repo"]);
    expect(prPathParts("not a url")).toEqual([]);
  });
});
