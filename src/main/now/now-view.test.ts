import { describe, expect, it } from "vitest";
import type { ActivityEvent, SessionActivity } from "../../shared/activity";
import type { EpicView, FeatureView, InboxItemView, MergeEvent, SessionView, TicketRepo, TicketView, WatchedPr } from "../../shared/types";
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
    butler: false,
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
    decisions: [],
    recent: () => [],
    memory: [],
    ...over,
  };
}

let decisionId = 0;
function decision(sessionId: string, over: Partial<InboxItemView> = {}): InboxItemView {
  return {
    id: ++decisionId, kind: "decision", sessionId, role: "ticket", ticketKey: null, featureId: null, epicId: null, repo: null, text: `q of ${sessionId}`,
    options: [], context: null, reportKind: null, answer: null, createdAt: decisionId, open: true, target: { page: "ticket", key: "A-1", sessionId }, ...over,
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
    // 都没有活动记录：开着，但没在干活。
    expect(v.running).toBe(0);
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
      where: null,
      coordinator: false,
      activity: null,
      working: false,
      recent: [],
      mergeQueued: false,
      needsYou: null,
      refreshing: null,
      decisions: 0,
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
    // 在干活的：s-ok（改文件）和 s-stuck（跑测试，卡住了也还在跑）；停在确认上、等回复的不算。
    expect(v.epics[0].counts).toEqual({ active: 2, needsYou: 3, stuck: 1 });
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
    // 停在确认上的照样需要你（Butler 的 /handoff 要用户批准权限），别的理由在换新时都不算。
    expect(rows.map((r) => [r.sessionId, r.refreshing, r.needsYou, r.idle])).toEqual([
      ["s-asks", "handoff", null, false],
      ["s-approve", "handoff", "等你确认", false],
      ["s-quiet", "clear", null, false],
    ]);
    expect(asked).toEqual([]);
    expect(v.needsYou.map((r) => r.sessionId)).toEqual(["s-approve"]);
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
      // 停着、PR 还开着：照样折起来（BTL-190 第 7 点），PR 显示在行上。
      ["s-pr", true],
      ["s-merged", true],
    ]);
    expect(rows.find((r) => r.sessionId === "s-pr")?.prs).toHaveLength(1);
    expect(rows.find((r) => r.sessionId === "s-queued")?.mergeQueued).toBe(true);
    expect(rows.find((r) => r.sessionId === "s-quiet")?.since).toBe(1000);
    // 只有 s-busy 在干活：合并排队的、PR 开着的都不算。
    expect(v.epics[0].features[0].counts).toEqual({ active: 1, needsYou: 0, stuck: 0 });
    expect(v.epics[0].counts).toEqual({ active: 1, needsYou: 0, stuck: 0 });
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

describe("buildNowView with ask_user decisions (BTL-190 2+3)", () => {
  it("a session with a pending decision shows the card instead of its Haiku or stuck reason, and is not folded away", () => {
    const asked: string[] = [];
    const t = ticket("A-1", null, [session("s1", { ticketKey: "A-1" }), session("s2", { ticketKey: "A-1" })]);
    const d = decision("s1", { ticketKey: "A-1" });
    const v = buildNowView(input({
      tickets: [t], decisions: [d],
      activity: (id) => act(id, { kind: "waiting", stuck: id === "s1", reason: "stuck" }),
      needsYouReason: (id) => (asked.push(id), "haiku"),
    }));
    const rows = v.epics[0].features[0].rows;
    expect(rows.find((r) => r.sessionId === "s1")).toMatchObject({ needsYou: null, decisions: 1, idle: false });
    expect(rows.find((r) => r.sessionId === "s2")).toMatchObject({ needsYou: "haiku", decisions: 0 });
    expect(asked).toEqual(["s2"]);
    expect(ids(v.needsYou)).toEqual(["s2"]);
    expect(v.decisions).toEqual([d]);
    // 每条未决的条目算一件需要你。
    expect(v.epics[0].counts.needsYou).toBe(2);
  });

  it("an answered decision waiting to be delivered is not counted and the row no longer waits for you, but the row stays unfolded", () => {
    const t = ticket("A-1", null, [session("s1", { ticketKey: "A-1" })]);
    const answered = decision("s1", { ticketKey: "A-1", answer: "A" });
    const v = buildNowView(input({ tickets: [t], decisions: [answered], activity: (id) => act(id, { kind: "waiting" }), needsYouReason: () => "haiku" }));
    expect(v.epics[0].features[0].rows[0]).toMatchObject({ sessionId: "s1", needsYou: null, decisions: 0, idle: false });
    expect(v.epics[0].counts.needsYou).toBe(0);
    // 卡片照样在（显示「已回答，等它停下来再送」）。
    expect(v.decisions).toEqual([answered]);
  });

  it("approval still wins over a pending decision", () => {
    const t = ticket("A-1", null, [session("s1", { ticketKey: "A-1" })]);
    const v = buildNowView(input({ tickets: [t], decisions: [decision("s1")], activity: (id) => act(id, { kind: "approval" }) }));
    expect(v.needsYou[0]).toMatchObject({ sessionId: "s1", needsYou: "等你确认", decisions: 1 });
  });

  it("drops a coordinator's Haiku row when a session in its scope has a pending decision, but keeps it when stuck", () => {
    const boss = session("boss", { ticketKey: "A-1", coordinator: true });
    const child = session("c", { ticketKey: "A-1" });
    const fc = session("fc", { featureId: 10 });
    const ep = session("ep", { epicId: 1 });
    const other = session("o", { ticketKey: "B-1" });
    const a1 = ticket("A-1", 10, [boss, child]);
    const b1 = ticket("B-1", 20, [other]);
    const base = {
      tickets: [a1, b1], features: [feature(10, 1, [a1], [fc]), feature(20, null, [b1])], epics: [epic(1, [ep])],
      activity: (id: string) => act(id, { kind: "waiting" }), needsYouReason: () => "haiku",
    };
    const v = buildNowView(input({ ...base, decisions: [decision("c", { ticketKey: "A-1", featureId: 10, epicId: 1 })] }));
    expect(ids(v.needsYou).sort()).toEqual(["o"]);
    // 子 session 没有未决条目时总控照常。
    expect(ids(buildNowView(input(base)).needsYou).sort()).toEqual(["boss", "c", "ep", "fc", "o"]);
    // 总控自己提的不算子 session 的：它的卡片在，Haiku 行不在（因为它自己有未决条目）。
    const own = buildNowView(input({ ...base, decisions: [decision("fc", { featureId: 10, epicId: 1, role: "feature_coordinator" })] }));
    expect(ids(own.needsYou).sort()).toEqual(["boss", "c", "o"]);
    // 卡住照样显示。
    const stuck = buildNowView(input({ ...base, activity: (id) => act(id, { kind: "waiting", stuck: id === "fc", reason: "卡住" }), decisions: [decision("c", { ticketKey: "A-1", featureId: 10, epicId: 1 })] }));
    expect(ids(stuck.needsYou).sort()).toEqual(["fc", "o"]);
  });

  it("lists decisions of sessions whose terminal is closed, oldest first", () => {
    const late = decision("gone", { createdAt: 50 });
    const early = decision("gone2", { createdAt: 10, open: false });
    const v = buildNowView(input({ decisions: [late, early] }));
    expect(v.decisions.map((d) => d.sessionId)).toEqual(["gone2", "gone"]);
    expect(v.epics).toEqual([]);
  });

  it("counts only sessions that are working (thinking, running a tool, a background command) as running (BTL-190 7)", () => {
    const kinds = ["thinking", "edit", "command", "test", "agent", "waiting", "idle", "approval"] as const;
    const t = ticket("A-1", null, [...kinds.map((k) => session(`s-${k}`, { ticketKey: "A-1" })), session("s-bg", { ticketKey: "A-1" }), session("s-none", { ticketKey: "A-1" })]);
    const acts: Record<string, SessionActivity> = Object.fromEntries(kinds.map((k) => [`s-${k}`, act(`s-${k}`, { kind: k })]));
    // 回合结束了，后台命令还在跑：kind 是那个命令，background 为 true。
    acts["s-bg"] = act("s-bg", { kind: "command", background: true });
    const v = buildNowView(input({ tickets: [t], activity: (id) => acts[id] ?? null }));

    const rows = v.epics[0].features[0].rows;
    expect(rows.filter((r) => r.working).map((r) => r.sessionId)).toEqual(["s-thinking", "s-edit", "s-command", "s-test", "s-agent", "s-bg"]);
    expect(v.running).toBe(6);
    expect(v.epics[0].counts.active).toBe(6);
  });

  it("a stopped session with an open PR or pending CI is not counted as in progress (BTL-190 7)", () => {
    const t = ticket("A-1", null, [session("s1", { ticketKey: "A-1", repoId: 1 })]);
    const v = buildNowView(input({
      tickets: [t],
      activity: () => act("s1", { kind: "waiting", startedAt: null }),
      prs: () => [pr("A-1", 1, { ci: "pending" })],
    }));
    const [row] = v.epics[0].features[0].rows;
    expect(row).toMatchObject({ working: false, idle: true });
    expect(row.prs).toHaveLength(1);
    expect(v.running).toBe(0);
    expect(v.epics[0].counts.active).toBe(0);
  });

  it("gives each session row its recent tool lines and where it works, and passes the memory log through (BTL-190 7)", () => {
    const ev = (sessionId: string, label: string, kind: ActivityEvent["kind"] = "tool"): ActivityEvent => ({ sessionId, at: 1, kind, label });
    const t = ticket("A-1", 10, [session("s1", { ticketKey: "A-1", repoId: 1 }), session("s-tc", { ticketKey: "A-1", coordinator: true })], [repo(1, "A-1", "/src/app")]);
    const f = feature(10, 1, [t], [session("s-fc", { featureId: 10, coordinator: true })]);
    const memory = [ev("s1", "接口改成 v2", "memory-write")];
    const recent: Record<string, ActivityEvent[]> = { s1: [ev("s1", "Read a.ts"), ev("s1", "Bash pnpm test")] };
    const v = buildNowView(input({ features: [f], epics: [epic(1, [session("s-ep", { epicId: 1 })])], recent: (id) => recent[id] ?? [], memory }));

    const rows = [...v.epics[0].rows, ...v.epics[0].features[0].rows];
    expect(rows.map((r) => [r.sessionId, r.where, r.repo])).toEqual([
      ["s-ep", "epic 1", null],
      ["s-fc", "feature 10", null],
      ["s-tc", null, null],
      // 只有一个仓库：行上不写仓库名，实况卡片上照样写。
      ["s1", "app", null],
    ]);
    expect(rows.find((r) => r.sessionId === "s1")?.recent.map((e) => e.label)).toEqual(["Read a.ts", "Bash pnpm test"]);
    expect(rows.find((r) => r.sessionId === "s-fc")?.recent).toEqual([]);
    expect(v.memory).toBe(memory);
  });
});
