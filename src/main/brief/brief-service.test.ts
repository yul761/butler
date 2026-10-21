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
import { BriefService } from "./brief-service";

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
    service, tickets, addTicket, handoff, refresh,
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

  it("takes previous-day handoffs from that local day only, oldest first", () => {
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
    const brief = s.service.generateMorning();
    expect(brief.previousDay).toEqual({
      date: "2026-10-16",
      entries: [{ ticketKey: "A-1", done: ["周五上午"] }, { ticketKey: "B-2", done: ["周五下午"] }],
    });
  });
});
