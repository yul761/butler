import { describe, expect, it } from "vitest";
import type { SessionActivity } from "../../shared/activity";
import type { ButlerControlRequest, ControlResult } from "../../shared/control";
import type { EpicFeatureRow, InboxView, PrDetail, Session, SessionView, WatchedPr } from "../../shared/types";
import { EpicsRepo } from "../db/epics-repo";
import { FeaturesRepo } from "../db/features-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { TicketsRepo } from "../db/tickets-repo";
import type { DeliveryCheck } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import { memDb } from "../test-utils";
import { ButlerMessagesRepo } from "../db/butler-messages-repo";
import type { ProgressFilter, ProgressView } from "../../shared/progress";
import { ButlerMessages } from "./butler-messages";
import { MemoryAdmission } from "../sessions/memory-admission";
import type { ControlHandlerDeps } from "./control-handler";
import { controlHandler } from "./control-handler";

/** Butler 总控（BTL-190 第 5 点）：两个 epic（一个归档了）、三个 feature（一个不属于 epic）、两个 ticket（一个归档了）和各种 session。 */
function setup(o: { butlerDeps?: boolean; admission?: ControlHandlerDeps["admission"]; noMetrics?: boolean; stacks?: ControlHandlerDeps["stacks"]; assessment?: boolean } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const features = new FeaturesRepo(db);
  const epics = new EpicsRepo(db);
  const shop = epics.insert({ name: "shop", workspaceDir: "/e/shop", createdAt: 1 });
  const old = epics.insert({ name: "old", workspaceDir: "/e/old", createdAt: 1 });
  epics.archive(old, 2);
  const checkout = features.insert({ name: "checkout", workspaceDir: "/f/checkout", createdAt: 1, epicId: shop, brief: "做结账" });
  const docs = features.insert({ name: "docs", workspaceDir: "/f/docs", createdAt: 2 });
  const gone = features.insert({ name: "gone", workspaceDir: "/f/gone", createdAt: 3, epicId: shop });
  features.archive(gone, 4);
  const ticket = (key: string, featureId: number | null, archivedAt: number | null = null) =>
    tickets.insert(
      { key, title: `${key} title`, status: "active", statusManual: null, createdAt: 1, archivedAt, featureId },
      { ticketKey: key, repoPath: `/r/${key.toLowerCase()}`, workMode: "worktree", worktreePath: `/w/${key.toLowerCase()}`, branch: `b-${key}`, createdAt: 1 },
    );
  ticket("BTL-1", checkout);
  ticket("BTL-2", docs);
  ticket("BTL-3", null);
  ticket("BTL-9", checkout, 5);
  const add = (id: string, s: Partial<Session> = {}) =>
    sessions.insertIfAbsent({ id, ticketKey: s.ticketKey ?? null, cwd: "/w", origin: "butler", createdAt: 1, lastActivityAt: 10, ...s });
  add("bt", { butler: true });
  add("ep", { epicId: shop });
  add("fc", { featureId: checkout, coordinator: true });
  add("fx", { featureId: checkout, fixesSession: "c1" });
  add("c1", { ticketKey: "BTL-1", repoId: 1 });
  add("closed-ep", { epicId: shop, lastActivityAt: 5 });
  /** docs 的总控：终端关着（闲置时自动关掉了）。 */
  add("dc", { featureId: docs, coordinator: true, lastActivityAt: 5 });
  /** 开着终端的 session（终端 id 就是 session id）。 */
  const open = new Set(["bt", "ep", "fc", "fx", "c1"]);
  const activities = new Map<string, SessionActivity>();
  const needs = new Map<string, string>();
  let guardCheck: (id: string) => DeliveryCheck = (id) => ({ ok: true, termId: id, headId: id });
  const delivered: [string, string][] = [];
  const refreshed: string[] = [];
  const opened: object[] = [];
  const submitted: [string, string][] = [];
  /** 打开（恢复或新开）的终端 id：恢复的用 session id，新开的用 new-<n>。 */
  const openAs = (sessionId: string | undefined) => {
    const id = sessionId ?? `new-${opened.length}`;
    if (!sessionId) add(id, {});
    open.add(id);
    return { ok: true as const, termId: id };
  };
  const view = (id: string): SessionView => ({ ...sessions.get(id)!, termId: open.has(id) ? id : null });
  const rows: (EpicFeatureRow & { epicId: number | null })[] = [
    { id: checkout, epicId: shop, name: "checkout", status: "waiting", archivedAt: null, summaryAt: 5, summary: "x".repeat(2000), blockers: ["等 API"], decisions: [], openQuestions: [] },
    { id: docs, epicId: null, name: "docs", status: "not_started", archivedAt: null, summaryAt: null, summary: null, blockers: [], decisions: [], openQuestions: [] },
  ];
  const prs: WatchedPr[] = [
    { ticketKey: "BTL-1", prId: 1, repoId: 1, repoPath: "/r/btl-1", branch: "b-BTL-1", number: 12, url: "https://x/12", state: "open", review: "approved", ci: "failing", headSha: "abc", checkedAt: 0, readError: false },
    { ticketKey: "BTL-3", prId: null, repoId: 3, repoPath: "/r/btl-3", branch: "b-BTL-3", number: null, url: null, state: null, review: null, ci: "none", headSha: null, checkedAt: 0, readError: false },
    { ticketKey: "BTL-3", prId: 2, repoId: null, repoPath: null, branch: "", number: 4, url: "https://x/4", state: "open", review: null, ci: "unknown", headSha: null, checkedAt: 0, readError: false },
  ];
  const inboxView: InboxView = { decisions: [], reports: [] };
  const replies = new Map<string, { id: string; text: string; at: number | null }>();
  let now = 1_000;
  const messages = new ButlerMessages({
    repo: new ButlerMessagesRepo(db), head: (id) => sessions.head(id), lastReply: (id) => replies.get(id) ?? null, termOf: (id) => (open.has(id) ? id : null),
    guard: { check: (id) => guardCheck(id), recheckAfter: () => () => true }, deliver: async (termId, text) => (delivered.push([termId, text]), "sent" as DeliverResult),
    targetName: (m) => (m.featureId !== null ? `feature ${m.featureId}` : `epic ${m.epicId}`), notify: () => {}, now: () => now, log: () => {},
  });
  const progressCalls: ProgressFilter[] = [];
  const metricsCalls: (number | undefined)[] = [];
  const progressView = { filter: { epicId: null, featureId: null }, epics: [], features: [], counts: { merged: 0, blocked: 0, in_review: 0, in_progress: 0, not_started: 0, total: 0 },
    stuck: [], stacks: [], groups: { byLabel: [], byPrefix: [] }, featureGroups: [], freshness: { generatedAt: 0, prsCheckedOldest: null, prsCheckedNewest: null, readErrors: 0, unread: 0, summaryOldest: null } } satisfies ProgressView;
  const summaryState = { running: new Set<number>(), stale: new Set<number>(), prStatusAt: new Map<number, number>(), refreshed: [] as number[] };
  const asked: string[] = [];
  const handle = controlHandler({
    tickets, sessions, features, epics,
    ticketService: { workDir: (r: { worktreePath: string | null; repoPath: string }) => r.worktreePath ?? r.repoPath } as never,
    sessionService: {
      isRunning: (id: string) => open.has(id), termIdOf: (id: string) => (open.has(id) ? id : null),
      runningCoordinator: (featureId: number) => sessions.listFeatureCoordinators(featureId).find((x) => x.coordinator && open.has(x.id)) ?? null,
      featureTerminalCount: (featureId: number) => sessions.listByFeature(featureId).filter((x) => open.has(x.id)).length,
      openFeature: async (req: { featureId: number; sessionId?: string }) => (opened.push({ feature: req.featureId, session: req.sessionId ?? null }), openAs(req.sessionId)),
      openEpic: async (req: { epicId: number; sessionId?: string }) => (opened.push({ epic: req.epicId, session: req.sessionId ?? null }), openAs(req.sessionId)),
    } as never,
    refresher: { precheck: () => null, refresh: async (id) => (refreshed.push(id), "done" as const) },
    guard: { check: (id) => guardCheck(id), recheckAfter: () => () => true },
    deliver: async (termId, text) => (delivered.push([termId, text]), "sent" as DeliverResult),
    activity: (id) => activities.get(id) ?? null,
    activityOutput: async () => "out",
    lastReply: (id) => (id === "ep" ? "等你定" : null),
    inbox: { ask: (s) => (asked.push(s.id), 7), report: () => ({ id: 8, queued: false, noCoordinator: false }) },
    kill: () => {},
    screenNeedsUser: () => false,
    submit: async (termId, text) => (submitted.push([termId, text]), "sent" as const),
    notify: () => {},
    admission: o.admission,
    stacks: o.stacks,
    ...(o.butlerDeps !== false && {
      butler: {
        epicViews: () => [{ id: shop, name: "shop", sessions: [view("ep"), view("closed-ep")], waiting: true, stuck: false, features: rows.filter((r) => r.epicId === shop) }],
        featureRows: () => rows,
        prs: () => prs,
        openHeads: () => [...open].map((id) => sessions.get(id)!),
        needsYou: (id) => needs.get(id) ?? null,
        inbox: { view: () => inboxView },
        messages,
        progress: (f) => (progressCalls.push(f), progressView),
        ...(!o.noMetrics && { metrics: (days: number | undefined) => (metricsCalls.push(days), { days: days ?? 30 } as never) }),
        ...(o.assessment && {
          assessment: {
            summaries: (ids: number[]) => new Map(ids.filter((id) => id === 1).map((id) => [id, { risk: "high" as const, ready: false, missing: [{ key: "evidence" as const, state: "fail" as const, detail: "missing test output" }] }])),
            view: (ref: string) => (ref === "1" || ref === "https://x/12" ? ({ prId: 1, url: "https://x/12" } as never) : null),
          },
        }),
        summaries: {
          running: (id) => summaryState.running.has(id), stale: (id) => summaryState.stale.has(id), prStatusAt: (id) => summaryState.prStatusAt.get(id) ?? null,
          refresh: (id) => void summaryState.refreshed.push(id),
        },
      },
    }),
  });
  const base = { v: 1 as const, butler: true as const, from: "bt" };
  const call = (req: Record<string, unknown>) => handle({ ...base, ...req } as ButlerControlRequest);
  return {
    handle, call, base, shop, checkout, docs, sessions, features, open, activities, needs, delivered, refreshed, opened, submitted, inboxView, asked, setGuard: (f: typeof guardCheck) => (guardCheck = f),
    prs, replies, messages, progressCalls, metricsCalls, summaryState, setNow: (t: number) => (now = t),
  };
}

const value = <T,>(r: ControlResult) => {
  if (!r.ok) throw new Error(r.error);
  return r.value as T;
};
const err = (r: ControlResult) => (r.ok ? "" : r.error);

describe("Butler 总控 read-only tools (BTL-190 5)", () => {
  it("list_epics lists the epics that are not archived, with their features and whether the epic session runs", async () => {
    const { call, shop } = setup();
    expect(value(await call({ op: "list_epics" }))).toEqual([{ id: shop, name: "shop", features: 1, sessionRunning: true, session: "ep", waiting: true, stuck: false }]);
  });

  it("list_features lists every feature with its epic, status, coordinator and a capped summary", async () => {
    const { call, shop, checkout, docs } = setup();
    const list = value<Record<string, unknown>[]>(await call({ op: "list_features" }));
    expect(list.map((f) => [f.id, f.name, f.epic, f.status, f.coordinatorRunning, f.coordinatorSession])).toEqual([
      [checkout, "checkout", { id: shop, name: "shop" }, "waiting", true, "fc"],
      [docs, "docs", null, "not_started", false, null],
    ]);
    expect((list[0].summary as string).length).toBe(1000);
    expect(list[0].blockers).toEqual(["等 API"]);
  });

  it("list_tickets lists the tickets that are not archived, filtered by feature or epic by name or id", async () => {
    const { call, shop, checkout } = setup();
    const all = value<{ key: string; feature: unknown; epic: unknown }[]>(await call({ op: "list_tickets" }));
    expect(all.map((t) => t.key).sort()).toEqual(["BTL-1", "BTL-2", "BTL-3"]);
    expect(all.find((t) => t.key === "BTL-1")).toMatchObject({
      title: "BTL-1 title", status: "active", feature: { id: checkout, name: "checkout" }, epic: { id: shop, name: "shop" },
      repos: [{ name: "btl-1", dir: "/w/btl-1", branch: "b-BTL-1" }],
    });
    expect(all.find((t) => t.key === "BTL-3")).toMatchObject({ feature: null, epic: null });
    const keys = async (req: object) => value<{ key: string }[]>(await call({ op: "list_tickets", ...req })).map((t) => t.key).sort();
    expect(await keys({ feature: "Checkout" })).toEqual(["BTL-1"]);
    expect(await keys({ feature: String(checkout) })).toEqual(["BTL-1"]);
    expect(await keys({ epic: "shop" })).toEqual(["BTL-1"]);
    expect(await keys({ epic: String(shop) })).toEqual(["BTL-1"]);
    expect(await keys({ feature: "docs", epic: "shop" })).toEqual([]);
    expect(err(await call({ op: "list_tickets", feature: "nope" }))).toContain("checkout");
    expect(err(await call({ op: "list_tickets", epic: "old" }))).toContain("shop");
  });

  it("list_prs gives each watched PR with its ticket, feature and epic", async () => {
    const { call, shop, checkout } = setup();
    const list = value<Record<string, unknown>[]>(await call({ op: "list_prs" }));
    expect(list[0]).toMatchObject({
      ticket: "BTL-1", repo: "btl-1", branch: "b-BTL-1", number: 12, url: "https://x/12", state: "open", review: "approved", ci: "failing",
      feature: { id: checkout, name: "checkout" }, epic: { id: shop, name: "shop" },
    });
    expect(list[1]).toMatchObject({ ticket: "BTL-3", number: null, feature: null, epic: null });
    // 不是 ticket 仓库的 PR：没有仓库名。
    expect(list[2]).toMatchObject({ ticket: "BTL-3", repo: null, number: 4 });
  });

  it("list_prs adds risk, ready and missing when Butler assessed the PR, and pr_assessment gives one PR (ws-g)", async () => {
    const plain = setup();
    expect(value<Record<string, unknown>[]>(await plain.call({ op: "list_prs" }))[0]).not.toHaveProperty("risk");
    expect(err(await plain.call({ op: "pr_assessment", pr: "1" }))).toContain("预审");
    const { call } = setup({ assessment: true });
    const list = value<Record<string, unknown>[]>(await call({ op: "list_prs" }));
    expect(list[0]).toMatchObject({ prId: 1, risk: "high", ready: false, missing: ["missing test output"] });
    // 分支行没有 prId，也就没有评估；评估过以外的 PR 是 null。
    expect(list[1]).not.toHaveProperty("risk");
    expect(list[2]).toMatchObject({ prId: 2, risk: null, ready: null, missing: [] });
    expect(value(await call({ op: "pr_assessment", pr: "https://x/12" }))).toEqual({ prId: 1, url: "https://x/12" });
    expect(err(await call({ op: "pr_assessment", pr: "99" }))).toContain("99");
  });

  it("list_prs adds the stack, review and merge fields and who the PR waits on (ws-b)", async () => {
    const { call, prs } = setup();
    const detail: PrDetail = {
      baseBranch: "main", isDraft: false, title: "Checkout", author: "me", labels: ["ui"], reviewRequests: [], mergeable: "mergeable", mergeState: "clean", statusChangedAt: 86_400_000, slug: "o/r",
      reviewers: [{ login: "ann", state: "approved", at: 0, bot: false }],
    };
    // 从没读成功过的（handoff 里给的链接）：不给 waitingOn 这些，和进度页一样不当 PR 算。
    prs[0] = { ...prs[0], checkedAt: 0, detail };
    expect(value<Record<string, unknown>[]>(await call({ op: "list_prs" }))[0]).not.toHaveProperty("waitingOn");
    prs[0] = { ...prs[0], checkedAt: 1, detail };
    const list = value<Record<string, unknown>[]>(await call({ op: "list_prs" }));
    expect(list[0]).toMatchObject({
      title: "Checkout", headBranch: "b-BTL-1", baseBranch: "main", draft: false, author: "me", labels: ["ui"], mergeable: "mergeable", mergeState: "clean",
      reviewers: [{ login: "ann", state: "approved", at: null }], statusChangedAt: "1970-01-02T00:00:00.000Z", waitingOn: { who: "author", reason: "ci_failing", names: ["me"] },
    });
    // 分支行没有这些字段。
    expect(list[1]).not.toHaveProperty("waitingOn");
  });

  it("list_features says when the summary read PR status and whether it is stale (ws-b)", async () => {
    const { call, checkout, docs, summaryState } = setup();
    summaryState.stale.add(checkout);
    summaryState.prStatusAt.set(checkout, 86_400_000);
    const list = value<Record<string, unknown>[]>(await call({ op: "list_features" }));
    expect(list.find((f) => f.id === checkout)).toMatchObject({ prStatusAt: "1970-01-02T00:00:00.000Z", stale: true });
    expect(list.find((f) => f.id === docs)).toMatchObject({ prStatusAt: null, stale: false });
  });

  it("progress_overview resolves the feature or epic by name and returns the aggregate (ws-b)", async () => {
    const { call, progressCalls, checkout, shop } = setup();
    expect(value(await call({ op: "progress_overview" }))).toMatchObject({ counts: { total: 0 }, prs: [] });
    await call({ op: "progress_overview", feature: "checkout" });
    await call({ op: "progress_overview", epic: "shop" });
    expect(progressCalls).toEqual([{ featureId: null, epicId: null }, { featureId: checkout, epicId: null }, { featureId: null, epicId: shop }]);
    expect(err(await call({ op: "progress_overview", feature: "gone" }))).toContain("checkout");
    expect(err(await call({ op: "progress_overview", epic: "old" }))).toContain("shop");
  });

  it("metrics_overview passes the days through and fails without effect data (ws-h)", async () => {
    const { call, metricsCalls } = setup();
    expect(value(await call({ op: "metrics_overview" }))).toEqual({ days: 30 });
    expect(value(await call({ op: "metrics_overview", days: 90 }))).toEqual({ days: 90 });
    expect(metricsCalls).toEqual([undefined, 90]);
    expect((await setup({ noMetrics: true }).call({ op: "metrics_overview" })).ok).toBe(false);
  });

  it("refresh_feature_summary starts a background run once, only for the open Butler 总控 (ws-b)", async () => {
    const { call, checkout, summaryState, open } = setup();
    summaryState.stale.add(checkout);
    expect(value(await call({ op: "refresh_feature_summary", feature: "checkout" }))).toMatchObject({
      started: true, feature: { id: checkout, name: "checkout" }, lastSummaryAt: new Date(5).toISOString(), stale: true,
    });
    expect(summaryState.refreshed).toEqual([checkout]);
    summaryState.running.add(checkout);
    expect(value(await call({ op: "refresh_feature_summary", feature: "checkout" }))).toMatchObject({ started: false, running: true });
    expect(summaryState.refreshed).toHaveLength(1);
    expect(err(await call({ op: "refresh_feature_summary", feature: "nope" }))).toContain("nope");
    open.delete("bt");
    expect((await call({ op: "refresh_feature_summary", feature: "docs" })).ok).toBe(false);
  });

  it("stack tools go to the stacks with the Butler scope; writes only from the open Butler 总控 (workstream K)", async () => {
    const seen: [unknown, string][] = [];
    const stacks = { handle: async (scope: unknown, req: { op: string }) => (seen.push([scope, req.op]), { v: 1 as const, ok: true as const, value: [] }) } as never;
    const { call, open } = setup({ stacks });
    expect((await call({ op: "list_stacks" })).ok).toBe(true);
    expect((await call({ op: "stack_rebase", stack: 1 })).ok).toBe(true);
    expect(seen).toEqual([[{ kind: "butler" }, "list_stacks"], [{ kind: "butler" }, "stack_rebase"]]);
    open.delete("bt");
    expect((await call({ op: "list_stacks" })).ok).toBe(true);
    for (const req of [{ op: "stack_rebase", stack: 1 }, { op: "stack_define", branches: ["a", "b"] }, { op: "stack_layer_mode", stack: 1, branch: "b", mode: "draft" }]) {
      expect((await call(req)).ok).toBe(false);
    }
    expect(seen).toHaveLength(3);
    expect((await setup().call({ op: "list_stacks" })).ok).toBe(false);
  });

  it("list_sessions lists every open session but itself, with its role, owners, needs-you and decisions", async () => {
    const { call, needs, inboxView, shop, checkout } = setup();
    needs.set("c1", "在问用哪个方案");
    inboxView.decisions.push({ sessionId: "ep" } as never, { sessionId: "ep" } as never);
    const list = value<Record<string, unknown>[]>(await call({ op: "list_sessions" }));
    expect(list.map((s) => [s.id, s.role])).toEqual([["ep", "epic"], ["fc", "feature_coordinator"], ["fx", "fix"], ["c1", "ticket"]]);
    expect(list[0]).toMatchObject({ epic: { id: shop, name: "shop" }, feature: null, ticket: null, decisions: 2, needs_you: null, last_reply: "等你定" });
    expect(list[3]).toMatchObject({ ticket: "BTL-1", feature: { id: checkout, name: "checkout" }, epic: { id: shop, name: "shop" }, repo: "btl-1", needs_you: "在问用哪个方案", decisions: 0 });
  });

  it("session_activity reads any session; list_inbox returns everything", async () => {
    const { call, activities, inboxView } = setup();
    activities.set("c1", { kind: "testing", detail: null, background: false, startedAt: 1, lastOutputAt: 2, stuck: null, reason: null, action: null, lastOutput: "x" } as unknown as SessionActivity);
    expect(value(await call({ op: "session_activity", session: "c1" }))).toMatchObject({ kind: "testing", output: "out" });
    expect(err(await call({ op: "session_activity", session: "nope" }))).toContain("nope");
    inboxView.reports.push({ id: 3, text: "done" } as never);
    expect(value(await call({ op: "list_inbox" }))).toEqual({ ...inboxView, messages: [] });
  });

  it("refuses everything when Butler has no Butler 总控 here", async () => {
    const { call } = setup({ butlerDeps: false });
    expect((await call({ op: "list_epics" })).ok).toBe(false);
  });
});

describe("Butler 总控 send_message and refresh_session (BTL-190 5)", () => {
  it("sends a message to an epic session or a feature coordinator through the guard, with a prefix", async () => {
    const { call, delivered } = setup();
    expect(value(await call({ op: "send_message", session: "ep", text: "先合 checkout" }))).toMatchObject({ sent: true, sessionId: "ep" });
    expect(value(await call({ op: "send_message", session: "fc", text: "接口改了" }))).toMatchObject({ sent: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(delivered).toEqual([["ep", "Butler 总控发来的消息（你这一轮做完时的最后一段回复会转给它）：\n先合 checkout"], ["fc", "Butler 总控发来的消息（你这一轮做完时的最后一段回复会转给它）：\n接口改了"]]);
  });

  it("returns a requestId and sends the target's next reply back to the Butler 总控 (ws-b)", async () => {
    const { call, delivered, replies, messages, setNow } = setup();
    replies.set("fc", { id: "r0", text: "earlier", at: 1 });
    const out = value<{ requestId: string }>(await call({ op: "send_message", session: "fc", text: "进度？" }));
    expect(out.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await new Promise((r) => setTimeout(r, 0));
    expect(messages.recent()[0]).toMatchObject({ requestId: out.requestId, status: "waiting", targetSession: "fc" });
    setNow(2_000);
    replies.set("fc", { id: "r1", text: "PR 都绿了", at: 2_000 });
    await messages.targetStopped("fc");
    expect(delivered.at(-1)?.[0]).toBe("bt");
    expect(delivered.at(-1)?.[1]).toContain(out.requestId);
    expect(delivered.at(-1)?.[1]).toContain("PR 都绿了");
    const inbox = value<{ messages: { status: string }[] }>(await call({ op: "list_inbox" }));
    expect(inbox.messages[0].status).toBe("delivered");
  });

  it("records a requestId for a message that went to a reopened terminal, and a failure when the guard says no (ws-b)", async () => {
    const { call, messages, setGuard, setNow } = setup();
    const out = value<{ requestId: string }>(await call({ op: "send_message", feature: "docs", text: "看一下" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(messages.recent()[0]).toMatchObject({ requestId: out.requestId, status: "waiting", targetSession: "dc" });
    setNow(2_000);
    setGuard(() => ({ ok: false, block: "typing" }));
    expect((await call({ op: "send_message", session: "fc", text: "t" })).ok).toBe(false);
    expect(messages.recent()[0]).toMatchObject({ status: "failed" });
  });

  it("opening a closed coordinator asks memory first; a refusal says why, opens nothing and marks the message failed (workstream W, ws-b)", async () => {
    const mem = { availableMb: 2500 };
    const admission = new MemoryAdmission({
      read: async () => ({ totalKb: 64 * 1024 * 1024, availableKb: mem.availableMb * 1024, source: "vm_stat", pressure: "normal" }),
      settings: () => ({ reserveMb: 2048, sessionMb: 1024, maxRunning: 0 }),
      running: () => 0, now: () => 0, log: () => undefined,
    });
    const { call, opened, submitted, messages } = setup({ admission });
    expect(err(await call({ op: "send_message", feature: "docs", text: "看一下" }))).toContain("内存不够");
    expect(opened).toEqual([]);
    expect(submitted).toEqual([]);
    expect(messages.recent()[0]).toMatchObject({ status: "failed", error: "no_memory" });
    mem.availableMb = 8000;
    expect(value(await call({ op: "send_message", feature: "docs", text: "看一下" }))).toMatchObject({ sessionId: "dc", opened: "resumed" });
  });

  it("refuses ticket and fix sessions, itself, unknown ones and a blocked guard", async () => {
    const { call, delivered, setGuard } = setup();
    expect(err(await call({ op: "send_message", session: "c1", text: "t" }))).toContain("epic session");
    expect(err(await call({ op: "send_message", session: "fx", text: "t" }))).toContain("epic session");
    expect(err(await call({ op: "send_message", session: "bt", text: "t" }))).toContain("bt");
    expect(err(await call({ op: "send_message", session: "nope", text: "t" }))).toContain("nope");
    expect(err(await call({ op: "send_message", feature: "nope", text: "t" }))).toContain("checkout");
    expect(err(await call({ op: "send_message", epic: "old", text: "t" }))).toContain("shop");
    setGuard(() => ({ ok: false, block: "busy" }));
    expect(err(await call({ op: "send_message", session: "ep", text: "t" }))).toContain("它还没停下来等输入");
    expect(delivered).toEqual([]);
  });

  it("takes a feature or an epic by name or id and sends to its running session", async () => {
    const { call, delivered, opened, shop } = setup();
    expect(value(await call({ op: "send_message", feature: "Checkout", text: "a" }))).toMatchObject({ sent: true, sessionId: "fc" });
    expect(value(await call({ op: "send_message", epic: String(shop), text: "b" }))).toMatchObject({ sent: true, sessionId: "ep" });
    await new Promise((r) => setTimeout(r, 0));
    expect(delivered.map(([id]) => id)).toEqual(["fc", "ep"]);
    expect(opened).toEqual([]);
  });

  it("resumes the latest coordinator of a feature whose terminal was closed, then hands it the message", async () => {
    const { call, opened, submitted, delivered, docs } = setup();
    expect(value(await call({ op: "send_message", feature: "docs", text: "看一下 PR" }))).toMatchObject({ sent: true, sessionId: "dc", opened: "resumed" });
    expect(opened).toEqual([{ feature: docs, session: "dc" }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(submitted).toEqual([["dc", "Butler 总控发来的消息（你这一轮做完时的最后一段回复会转给它）：\n看一下 PR"]]);
    expect(delivered).toEqual([]);
    // 给的是关着的 session：一样恢复它。
    const again = setup();
    expect(value(await again.call({ op: "send_message", session: "dc", text: "x" }))).toMatchObject({ sessionId: "dc", opened: "resumed" });
  });

  it("resumes the epic session that was used last when none is running", async () => {
    const { call, open, opened, submitted, shop } = setup();
    open.delete("ep");
    expect(value(await call({ op: "send_message", epic: "shop", text: "巡检" }))).toMatchObject({ sent: true, opened: "resumed" });
    expect(opened).toEqual([{ epic: shop, session: "ep" }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(submitted.map(([id]) => id)).toEqual(["ep"]);
    // 给的是关着的 session、同一个 epic 另一个 session 在跑：发给在跑的，不再开。
    open.add("ep");
    expect(value(await call({ op: "send_message", session: "closed-ep", text: "t" }))).toMatchObject({ sessionId: "ep" });
    expect(opened).toHaveLength(1);
  });

  it("opens a new coordinator when the feature never had one, unless its epic still has to start it", async () => {
    const { call, sessions, opened, submitted, docs, checkout } = setup();
    for (const s of sessions.listFeatureCoordinators(docs)) sessions.delete(s.id);
    expect(value(await call({ op: "send_message", feature: "docs", text: "开始吧" }))).toMatchObject({ sent: true, opened: "opened" });
    expect(opened).toEqual([{ feature: docs, session: null }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(submitted).toHaveLength(1);
    // checkout 属于 epic、规划还没发过、没有总控：这要 epic session 用 start_feature 开工。
    for (const s of sessions.listFeatureCoordinators(checkout)) sessions.delete(s.id);
    expect(err(await call({ op: "send_message", feature: "checkout", text: "t" }))).toContain("start_feature");
    expect(opened).toHaveLength(1);
  });

  it("only takes send_message from the Butler 总控 session itself", async () => {
    const { call, delivered } = setup();
    expect((await call({ op: "send_message", session: "ep", text: "t", from: "fc" })).ok).toBe(false);
    expect((await call({ op: "send_message", session: "ep", text: "t", from: null })).ok).toBe(false);
    expect(delivered).toEqual([]);
  });

  it("refuses send_message and refresh_session from a Butler 总控 whose terminal is closed", async () => {
    const { call, delivered, refreshed, open } = setup();
    open.delete("bt");
    expect((await call({ op: "send_message", session: "ep", text: "t" })).ok).toBe(false);
    expect((await call({ op: "refresh_session", session: "ep" })).ok).toBe(false);
    expect((await call({ op: "refresh_session", session: "ep", from: "fc" })).ok).toBe(false);
    expect((await call({ op: "refresh_session", session: "ep", from: null })).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(delivered).toEqual([]);
    expect(refreshed).toEqual([]);
  });

  it("refreshes any stopped session but itself", async () => {
    const { call, refreshed } = setup();
    expect(value(await call({ op: "refresh_session", session: "ep" }))).toEqual({ started: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(refreshed).toEqual(["ep"]);
    expect((await call({ op: "refresh_session", session: "bt" })).ok).toBe(false);
  });
});

describe("Butler 总控 ask_user and report (BTL-190 5)", () => {
  it("takes them only from a Butler 总控 session", async () => {
    const { call, asked } = setup();
    expect(value(await call({ op: "ask_user", question: "先合哪个？" }))).toMatchObject({ id: 7 });
    expect(asked).toEqual(["bt"]);
    expect(value(await call({ op: "report", text: "巡检完了", kind: "done" }))).toMatchObject({ id: 8 });
    expect(err(await call({ op: "ask_user", question: "q", from: "ep" }))).toBeTruthy();
    expect(asked).toEqual(["bt"]);
  });
});
