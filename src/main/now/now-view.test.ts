import { describe, expect, it } from "vitest";
import type { SessionActivity } from "../../shared/activity";
import type { EpicView, FeatureView, MergeEvent, SessionView, TicketRepo, TicketView, WatchedPr } from "../../shared/types";
import { buildNowView, type NowInput } from "./now-view";

function session(id: string, over: Partial<SessionView> = {}): SessionView {
  return {
    id,
    ticketKey: null,
    cwd: "/w",
    origin: "butler",
    gitBranch: null,
    firstPrompt: null,
    lastActivityAt: 1000,
    waitingForInput: false,
    replacedBy: null,
    dismissed: false,
    createdAt: 0,
    repoId: null,
    coordinator: false,
    spawnedBy: null,
    featureId: null,
    fixesSession: null,
    epicId: null,
    model: null,
    termId: id,
    ...over,
  };
}

function repo(id: number, ticketKey: string, repoPath: string): TicketRepo {
  return { id, ticketKey, repoPath, workMode: "worktree", worktreePath: null, branch: `b${id}`, createdAt: 0, worktreeRemovedAt: null, cleanupBlocked: null };
}

function ticket(key: string, featureId: number | null, sessions: SessionView[], repos: TicketRepo[] = []): TicketView {
  return {
    key,
    title: `title ${key}`,
    repos,
    status: "active",
    statusManual: null,
    createdAt: 0,
    archivedAt: null,
    featureId,
    effectiveStatus: "active",
    sessions,
    hiddenSessions: [],
    waiting: false,
  };
}

function feature(id: number, epicId: number | null, tickets: TicketView[], sessions: SessionView[] = []): FeatureView {
  return {
    id,
    name: `feature ${id}`,
    workspaceDir: "/w",
    repos: [],
    createdAt: 0,
    archivedAt: null,
    epicId,
    brief: null,
    briefSentAt: null,
    tickets,
    sessions,
    hiddenSessions: [],
    waiting: false,
    summary: null,
    ticketPrs: {},
    activity: {},
  };
}

function epic(id: number, sessions: SessionView[] = []): EpicView {
  return { id, name: `epic ${id}`, workspaceDir: "/w", createdAt: 0, archivedAt: null, repos: [], plan: null, planAt: 0, sessions, hiddenSessions: [], waiting: false, stuck: false, features: [] };
}

function act(sessionId: string, over: Partial<SessionActivity> = {}): SessionActivity {
  return { sessionId, kind: "edit", detail: null, background: false, startedAt: 500, lastOutputAt: null, stuck: false, reason: null, action: null, lastOutput: [], ...over };
}

function pr(ticketKey: string, repoId: number, over: Partial<WatchedPr> = {}): WatchedPr {
  return { ticketKey, repoId, repoPath: "/r", branch: "b", number: 1, url: null, state: "open", review: "pending", ci: "passing", headSha: null, checkedAt: 0, ...over };
}

function input(over: Partial<NowInput> = {}): NowInput {
  return {
    tickets: [],
    features: [],
    epics: [],
    activity: () => null,
    needsYouReason: () => null,
    prs: () => [],
    mergeQueued: () => false,
    refreshing: () => null,
    merges: [],
    approvalText: "等你确认",
    ...over,
  };
}

const ids = (rows: { sessionId: string | null }[]) => rows.map((r) => r.sessionId);

describe("buildNowView", () => {
  it("groups ticket rows under their feature and epic", () => {
    const merges: MergeEvent[] = [{ id: 1, repoPath: "/r", kind: "wait", ticketKey: "A-1", branch: "b", otherTicket: null, otherBranch: null, files: [], createdAt: 0 }];
    const a1 = ticket("A-1", 10, [session("s-a1", { ticketKey: "A-1" })]);
    const b1 = ticket("B-1", 20, [session("s-b1", { ticketKey: "B-1" })]);
    const c1 = ticket("C-1", null, [session("s-c1", { ticketKey: "C-1" })]);
    // 调用方可能把 feature 下的 ticket 也放进 tickets：不能出现两次。
    const v = buildNowView(input({ tickets: [a1, c1], features: [feature(10, 1, [a1]), feature(20, null, [b1])], epics: [epic(1)], merges }));

    expect(v.epics.map((e) => e.id)).toEqual([1, null]);
    const [e1, none] = v.epics;
    expect(e1.name).toBe("epic 1");
    expect(e1.rows).toEqual([]);
    expect(e1.features.map((f) => [f.id, f.name, ids(f.rows)])).toEqual([[10, "feature 10", ["s-a1"]]]);
    expect(none.features.map((f) => [f.id, ids(f.rows)])).toEqual([[20, ["s-b1"]], [null, ["s-c1"]]]);
    const row = e1.features[0].rows[0];
    expect(row).toMatchObject({ ticketKey: "A-1", title: "title A-1", coordinator: false, repo: null, target: { page: "ticket", key: "A-1", sessionId: "s-a1" } });
    expect(v.running).toBe(3);
    expect(v.merges).toBe(merges);
  });

  it("puts coordinators first in their group", () => {
    const t = ticket("A-1", 10, [session("s-t", { ticketKey: "A-1", repoId: 1 }), session("s-tc", { ticketKey: "A-1", coordinator: true })], [repo(1, "A-1", "/r/app")]);
    const fix = session("s-fix", { featureId: 10, fixesSession: "s-t" });
    const coord = session("s-fc", { featureId: 10, coordinator: true });
    const ep = session("s-ep", { epicId: 1 });
    const v = buildNowView(input({ features: [feature(10, 1, [t], [fix, coord])], epics: [epic(1, [ep])] }));

    const e1 = v.epics[0];
    expect(e1.rows).toHaveLength(1);
    expect(e1.rows[0]).toMatchObject({ sessionId: "s-ep", coordinator: true, ticketKey: null, target: { page: "epic", id: 1, sessionId: "s-ep" } });
    const rows = e1.features[0].rows;
    expect(ids(rows)).toEqual(["s-fc", "s-fix", "s-tc", "s-t"]);
    expect(rows[0]).toMatchObject({ coordinator: true, target: { page: "feature", id: 10, sessionId: "s-fc" } });
    expect(rows[1]).toMatchObject({ coordinator: false, ticketKey: null, target: { page: "feature", id: 10, sessionId: "s-fix" } });
    expect(rows[2]).toMatchObject({ coordinator: true, ticketKey: "A-1", repo: null, target: { page: "ticket", key: "A-1", sessionId: "s-tc" } });
  });

  it("shows a ticket with an open PR and no open session", () => {
    const open = ticket("A-1", null, [session("s-old", { ticketKey: "A-1", termId: null })]);
    const merged = ticket("A-2", null, []);
    const none = ticket("A-3", null, []);
    const prs: Record<string, WatchedPr[]> = { "A-1": [pr("A-1", 1, { ci: "pending" })], "A-2": [pr("A-2", 2, { state: "merged" })] };
    const v = buildNowView(input({ tickets: [open, merged, none], prs: (k) => prs[k] ?? [] }));

    const rows = v.epics[0].features[0].rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      sessionId: null,
      ticketKey: "A-1",
      title: "title A-1",
      repo: null,
      coordinator: false,
      activity: null,
      mergeQueued: false,
      needsYou: null,
      refreshing: null,
      prs: prs["A-1"],
      idle: false,
      since: null,
      target: { page: "ticket", key: "A-1", sessionId: null },
    });
    expect(v.running).toBe(0);
  });

  it("ignores sessions Butler did not open", () => {
    const t = ticket("A-1", null, [session("s-ext", { ticketKey: "A-1", origin: "discovered" })]);
    const f = feature(10, null, [], [session("s-fext", { featureId: 10, coordinator: true, origin: "discovered" })]);
    const v = buildNowView(input({ tickets: [t], features: [f], epics: [epic(1, [session("s-eext", { epicId: 1, origin: "discovered" })])] }));

    expect(v.epics).toEqual([]);
    expect(v.running).toBe(0);
  });

  it("splits a ticket with sessions in two repos into two rows with repo names", () => {
    const repos = [repo(1, "A-1", "/src/app"), repo(2, "A-1", "/src/api")];
    const t = ticket("A-1", null, [session("s1", { ticketKey: "A-1", repoId: 1 }), session("s2", { ticketKey: "A-1", repoId: 2 })], repos);
    const single = ticket("A-2", null, [session("s3", { ticketKey: "A-2", repoId: 3 })], [repo(3, "A-2", "/src/web")]);
    const prs: Record<string, WatchedPr[]> = { "A-1": [pr("A-1", 2, { number: 22 }), pr("A-1", 1, { number: 11 })] };
    const v = buildNowView(input({ tickets: [t, single], prs: (k) => prs[k] ?? [] }));

    const rows = v.epics[0].features[0].rows;
    expect(rows.map((r) => [r.sessionId, r.repo])).toEqual([["s1", "app"], ["s2", "api"], ["s3", null]]);
    // 每个仓库的 PR 只挂在那个仓库的行上。
    expect(rows[0].prs.map((p) => p.number)).toEqual([11]);
    expect(rows[1].prs.map((p) => p.number)).toEqual([22]);
  });

  it("collects needs-you from approvals, stuck and judged replies, oldest first", () => {
    const t = ticket("A-1", null, [
      session("s-ok", { ticketKey: "A-1", repoId: 1 }),
      session("s-approve", { ticketKey: "A-1", repoId: 1 }),
      session("s-stuck", { ticketKey: "A-1", repoId: 1 }),
      session("s-asks", { ticketKey: "A-1", repoId: 1, lastActivityAt: 100 }),
    ]);
    const acts: Record<string, SessionActivity> = {
      "s-ok": act("s-ok"),
      "s-approve": act("s-approve", { kind: "approval", startedAt: 300 }),
      "s-stuck": act("s-stuck", { kind: "test", startedAt: 200, stuck: true, reason: "测试没有输出" }),
      "s-asks": act("s-asks", { kind: "waiting", startedAt: null }),
    };
    const asked: string[] = [];
    const v = buildNowView(input({
      tickets: [t],
      activity: (id) => acts[id] ?? null,
      needsYouReason: (id) => (asked.push(id), id === "s-asks" || id === "s-approve" ? "问你：要不要拆 PR" : null),
    }));

    expect(v.needsYou.map((r) => [r.sessionId, r.needsYou, r.since])).toEqual([
      ["s-asks", "问你：要不要拆 PR", 100],
      ["s-stuck", "测试没有输出", 200],
      ["s-approve", "等你确认", 300],
    ]);
    // 每行最多问一次；确认和卡住已经有理由，不用再问。
    expect(asked.sort()).toEqual(["s-asks", "s-ok"]);
    expect(v.epics[0].counts).toEqual({ active: 4, needsYou: 3, stuck: 1 });
  });

  it("a refreshing row has its step, is not needs-you and is not idle (plan 16)", () => {
    const t = ticket("A-1", null, [
      session("s-asks", { ticketKey: "A-1", repoId: 1 }),
      session("s-approve", { ticketKey: "A-1", repoId: 1 }),
      session("s-quiet", { ticketKey: "A-1", repoId: 1 }),
    ]);
    const acts: Record<string, SessionActivity> = {
      "s-asks": act("s-asks", { kind: "waiting" }),
      "s-approve": act("s-approve", { kind: "approval" }),
      "s-quiet": act("s-quiet", { kind: "waiting" }),
    };
    const asked: string[] = [];
    const v = buildNowView(input({
      tickets: [t],
      activity: (id) => acts[id] ?? null,
      needsYouReason: (id) => (asked.push(id), "问你：要不要拆 PR"),
      refreshing: (id) => (id === "s-quiet" ? "clear" : id === "s-asks" || id === "s-approve" ? "handoff" : null),
    }));
    const rows = v.epics[0].features[0].rows;
    expect(rows.map((r) => [r.sessionId, r.refreshing, r.needsYou, r.idle])).toEqual([
      ["s-asks", "handoff", null, false],
      ["s-approve", "handoff", null, false],
      ["s-quiet", "clear", null, false],
    ]);
    expect(asked).toEqual([]);
    expect(v.needsYou).toEqual([]);
  });

  it("marks quiet rows idle and counts per group", () => {
    const t = ticket("A-1", 10, [
      session("s-busy", { ticketKey: "A-1", repoId: 1 }),
      session("s-quiet", { ticketKey: "A-1", repoId: 1 }),
      session("s-nolog", { ticketKey: "A-1", repoId: 1 }),
      session("s-queued", { ticketKey: "A-1", repoId: 1 }),
    ]);
    const u = ticket("A-2", 10, [session("s-pr", { ticketKey: "A-2", repoId: 2 })]);
    const w = ticket("A-3", 10, [session("s-merged", { ticketKey: "A-3", repoId: 3 })]);
    const acts: Record<string, SessionActivity> = {
      "s-busy": act("s-busy", { kind: "edit" }),
      "s-quiet": act("s-quiet", { kind: "waiting", startedAt: null }),
      "s-queued": act("s-queued", { kind: "waiting", startedAt: null }),
      "s-pr": act("s-pr", { kind: "idle", startedAt: null }),
      "s-merged": act("s-merged", { kind: "waiting", startedAt: null }),
    };
    const prs: Record<string, WatchedPr[]> = { "A-2": [pr("A-2", 2)], "A-3": [pr("A-3", 3, { state: "merged" })] };
    const coord = session("s-fc", { featureId: 10, coordinator: true });
    const v = buildNowView(input({
      features: [feature(10, null, [t, u, w], [coord])],
      activity: (id) => acts[id] ?? null,
      prs: (k) => prs[k] ?? [],
      mergeQueued: (id) => id === "s-queued",
    }));

    const rows = v.epics[0].features[0].rows;
    expect(rows.map((r) => [r.sessionId, r.idle])).toEqual([
      ["s-fc", true],
      ["s-busy", false],
      ["s-quiet", true],
      ["s-nolog", true],
      ["s-queued", false],
      ["s-pr", false],
      ["s-merged", true],
    ]);
    expect(rows.find((r) => r.sessionId === "s-queued")?.mergeQueued).toBe(true);
    expect(rows.find((r) => r.sessionId === "s-quiet")?.since).toBe(1000);
    expect(v.epics[0].features[0].counts).toEqual({ active: 3, needsYou: 0, stuck: 0 });
    expect(v.epics[0].counts).toEqual({ active: 3, needsYou: 0, stuck: 0 });
  });

  it("drops empty epics and features", () => {
    const busy = ticket("A-1", 10, [session("s1", { ticketKey: "A-1" })]);
    const v = buildNowView(input({
      tickets: [ticket("C-1", null, [])],
      features: [feature(10, 1, [busy]), feature(11, 1, [ticket("A-2", 11, [])]), feature(12, null, [])],
      epics: [epic(1), epic(2)],
    }));

    expect(v.epics.map((e) => [e.id, e.features.map((f) => f.id)])).toEqual([[1, [10]]]);
  });
});
