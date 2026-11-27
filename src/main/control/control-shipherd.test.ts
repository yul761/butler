import { M } from "../strings";
import { describe, expect, it } from "vitest";
import type { SessionActivity } from "../../shared/activity";
import type { ShipherdControlRequest, ControlResult } from "../../shared/control";
import type { FeatureStatusRow, InboxView, PrDetail, Session, WatchedPr } from "../../shared/types";
import { BlocksRepo } from "../db/blocks-repo";
import { FeaturesRepo } from "../db/features-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { TicketsRepo } from "../db/tickets-repo";
import type { DeliveryCheck } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import { memDb } from "../test-utils";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionMessagesRepo } from "../db/session-messages-repo";
import { Mailbox } from "../mailbox/mailbox";
import type { ProgressFilter, ProgressView } from "../../shared/progress";
import { MemoryAdmission } from "../sessions/memory-admission";
import type { ControlHandlerDeps } from "./control-handler";
import { controlHandler } from "./control-handler";
import type { PreReviewOps } from "./prereview-control";
import type { TicketPr } from "../db/ticket-prs-repo";
import { noPreReview, type PreReviewBadge, type PreReviewQueueItem, type PreReviewTicketStatus, type PreReviewView } from "../../shared/prereview";

/** Shipherd 总控（BTL-190 第 5 点）：三个 feature（一个归档了）、四个 ticket（一个归档了）和各种 session。 */
function setup(o: { shipherdDeps?: boolean; admission?: ControlHandlerDeps["admission"]; noMetrics?: boolean; stacks?: ControlHandlerDeps["stacks"]; assessment?: boolean; preReviewOps?: PreReviewOps } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const features = new FeaturesRepo(db);
  const blocks = new BlocksRepo(db);
  const checkout = features.insert({ name: "checkout", workspaceDir: "/f/checkout", createdAt: 1, brief: "做结账" });
  const docs = features.insert({ name: "docs", workspaceDir: "/f/docs", createdAt: 2 });
  const gone = features.insert({ name: "gone", workspaceDir: "/f/gone", createdAt: 3 });
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
  // checkout 里的两个 feature（BTL-246，内部是 block）：Cart 排在 Payment 前面，BTL-1 在 Payment 里。
  const payment = blocks.insert({ featureId: checkout, name: "Payment", description: "付款", createdAt: 1 });
  const cart = blocks.insert({ featureId: checkout, name: "Cart", description: null, createdAt: 2, before: payment });
  tickets.setBlock("BTL-1", payment);
  const add = (id: string, s: Partial<Session> = {}) =>
    sessions.insertIfAbsent({ id, ticketKey: s.ticketKey ?? null, cwd: "/w", origin: "shipherd", createdAt: 1, lastActivityAt: 10, ...s });
  add("bt", { shipherd: true });
  add("fc", { featureId: checkout, coordinator: true });
  add("fx", { featureId: checkout, fixesSession: "c1" });
  add("c1", { ticketKey: "BTL-1", repoId: 1 });
  /** docs 的总控：终端关着（闲置时自动关掉了）。 */
  add("dc", { featureId: docs, coordinator: true, lastActivityAt: 5 });
  /** 开着终端的 session（终端 id 就是 session id）。 */
  const open = new Set(["bt", "fc", "fx", "c1"]);
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
  const rows: FeatureStatusRow[] = [
    { id: checkout, name: "checkout", status: "waiting", archivedAt: null, summaryAt: 5, summary: "x".repeat(2000), blockers: ["等 API"], decisions: [], openQuestions: [] },
    { id: docs, name: "docs", status: "not_started", archivedAt: null, summaryAt: null, summary: null, blockers: [], decisions: [], openQuestions: [] },
  ];
  const prs: WatchedPr[] = [
    { ticketKey: "BTL-1", prId: 1, repoId: 1, repoPath: "/r/btl-1", branch: "b-BTL-1", number: 12, url: "https://x/12", state: "open", review: "approved", ci: "failing", headSha: "abc", checkedAt: 0, readError: false },
    { ticketKey: "BTL-3", prId: null, repoId: 3, repoPath: "/r/btl-3", branch: "b-BTL-3", number: null, url: null, state: null, review: null, ci: "none", headSha: null, checkedAt: 0, readError: false },
    { ticketKey: "BTL-3", prId: 2, repoId: null, repoPath: null, branch: "", number: 4, url: "https://x/4", state: "open", review: null, ci: "unknown", headSha: null, checkedAt: 0, readError: false },
  ];
  const inboxView: InboxView = { decisions: [], reports: [] };
  const replies = new Map<string, { id: string; text: string; at: number | null }>();
  let now = 1_000;
  const interrupts: string[] = [];
  const repo = new SessionMessagesRepo(db);
  const mailbox = new Mailbox({
    repo, root: mkdtempSync(join(tmpdir(), "cb-mbox-")),
    head: (id) => sessions.head(id), termOf: (id) => {
      const h = sessions.head(id)?.id ?? id;
      return open.has(h) ? h : null;
    },
    openTerms: () => [...open],
    check: (id) => guardCheck(id), recheckAfter: () => () => true,
    deliver: async (termId, text) => (delivered.push([termId, text]), "sent" as DeliverResult),
    canInterrupt: () => true, interrupt: (t) => void interrupts.push(t), interruptRecheck: () => () => true,
    lastReply: (id) => replies.get(id) ?? null, nameOf: (id) => id ?? "Shipherd", notify: () => {}, now: () => now, log: () => {},
  });
  const progressCalls: ProgressFilter[] = [];
  const metricsCalls: (number | undefined)[] = [];
  const progressView = { filter: { featureId: null }, features: [], counts: { merged: 0, blocked: 0, in_review: 0, in_progress: 0, not_started: 0, total: 0 },
    stuck: [], stacks: [], groups: { byLabel: [], byPrefix: [] }, featureGroups: [], freshness: { generatedAt: 0, prsCheckedOldest: null, prsCheckedNewest: null, readErrors: 0, unread: 0, summaryOldest: null } } satisfies ProgressView;
  const summaryState = { running: new Set<number>(), stale: new Set<number>(), prStatusAt: new Map<number, number>(), refreshed: [] as number[] };
  const asked: string[] = [];
  const handle = controlHandler({
    tickets, sessions, features, blocks,
    ticketService: { workDir: (r: { worktreePath: string | null; repoPath: string }) => r.worktreePath ?? r.repoPath } as never,
    sessionService: {
      isRunning: (id: string) => open.has(id), termIdOf: (id: string) => (open.has(id) ? id : null),
      runningCoordinator: (featureId: number) => sessions.listFeatureCoordinators(featureId).find((x) => x.coordinator && open.has(x.id)) ?? null,
      featureTerminalCount: (featureId: number) => sessions.listByFeature(featureId).filter((x) => open.has(x.id)).length,
      openFeature: async (req: { featureId: number; sessionId?: string }) => (opened.push({ feature: req.featureId, session: req.sessionId ?? null }), openAs(req.sessionId)),
    } as never,
    refresher: { precheck: () => null, refresh: async (id) => (refreshed.push(id), "done" as const) },
    mailbox,
    activity: (id) => activities.get(id) ?? null,
    activityOutput: async () => "out",
    lastReply: (id) => (id === "fc" ? "等你定" : null),
    inbox: { ask: (s) => (asked.push(s.id), 7), report: () => ({ id: 8, queued: false, noCoordinator: false }) },
    kill: () => {},
    screenNeedsUser: () => false,
    submit: async (termId, text) => (submitted.push([termId, text]), "sent" as const),
    notify: () => {},
    admission: o.admission,
    stacks: o.stacks,
    preReviewOps: o.preReviewOps,
    ...(o.shipherdDeps !== false && {
      shipherd: {
        featureRows: () => rows,
        prs: () => prs,
        prTurns: () => (url) => (url === "https://x/12" ? { owner: "agent", kind: "fixing_ci", sessionId: "s1" } : null),
        openHeads: () => [...open].map((id) => sessions.get(id)!),
        needsYou: (id) => needs.get(id) ?? null,
        inbox: { view: () => inboxView },
        shipherdSessions: () => ["bt"],
        progress: (f) => (progressCalls.push(f), progressView),
        ...(!o.noMetrics && { metrics: (days: number | undefined) => (metricsCalls.push(days), { days: days ?? 30 } as never) }),
        ...(o.assessment && {
          assessment: {
            summaries: (ids: number[]) => new Map(ids.filter((id) => id === 1).map((id) => [id, { risk: "high" as const, ready: false, missing: [{ key: "evidence" as const, state: "fail" as const, detail: "missing test output" }] }])),
            // prId 1 是 BTL-1（checkout）的，2 是 BTL-3（不在 epic 里）的。
            view: (ref: string, keep?: (key: string) => boolean) =>
              (ref === "1" || ref === "https://x/12") && (!keep || keep("BTL-1")) ? ({ prId: 1, url: "https://x/12" } as never)
                : ref === "2" && (!keep || keep("BTL-3")) ? ({ prId: 2, url: "https://x/4" } as never) : null,
          },
        }),
        summaries: {
          running: (id) => summaryState.running.has(id), stale: (id) => summaryState.stale.has(id), prStatusAt: (id) => summaryState.prStatusAt.get(id) ?? null,
          refresh: (id) => void summaryState.refreshed.push(id),
        },
      },
    }),
  });
  const base = { v: 1 as const, shipherd: true as const, from: "bt" };
  const call = (req: Record<string, unknown>) => handle({ ...base, ...req } as ShipherdControlRequest);
  return {
    handle, call, base, checkout, docs, payment, cart, sessions, features, open, activities, needs, delivered, refreshed, opened, submitted, inboxView, asked, setGuard: (f: typeof guardCheck) => (guardCheck = f),
    prs, replies, mailbox, repo, interrupts, progressCalls, metricsCalls, summaryState, setNow: (t: number) => (now = t),
  };
}

const value = <T,>(r: ControlResult) => {
  if (!r.ok) throw new Error(r.error);
  return r.value as T;
};
const err = (r: ControlResult) => (r.ok ? "" : r.error);

describe("Shipherd 总控 read-only tools (BTL-190 5)", () => {

  it("list_epics lists every epic with its status, coordinator, a capped summary and its features' progress (BTL-246)", async () => {
    const { call, checkout, docs, payment, cart } = setup();
    const list = value<Record<string, unknown>[]>(await call({ op: "list_epics" }));
    expect(list.map((f) => [f.id, f.name, f.status, f.coordinatorRunning, f.coordinatorSession])).toEqual([
      [checkout, "checkout", "waiting", true, "fc"],
      [docs, "docs", "not_started", false, null],
    ]);
    expect((list[0].summary as string).length).toBe(1000);
    expect(list[0].blockers).toEqual(["等 API"]);
    expect(list[0]).toMatchObject({
      jiraEpic: null,
      features: [{ id: cart, name: "Cart", position: 1, merged: 0, total: 0 }, { id: payment, name: "Payment", position: 2, merged: 0, total: 1 }],
    });
    expect(list[1]).toMatchObject({ features: [] });
  });

  it("list_features lists the features inside epics in order, with their tickets, optionally for one epic (BTL-246)", async () => {
    const { call, checkout, payment, cart } = setup();
    const all = value<Record<string, unknown>[]>(await call({ op: "list_features" }));
    expect(all).toEqual([
      { epic: { id: checkout, name: "checkout" }, id: cart, name: "Cart", position: 1, merged: 0, total: 0, description: null, tickets: [] },
      { epic: { id: checkout, name: "checkout" }, id: payment, name: "Payment", position: 2, merged: 0, total: 1, description: "付款", tickets: [{ key: "BTL-1", title: "BTL-1 title", status: "active" }] },
    ]);
    expect(value(await call({ op: "list_features", epic: "docs" }))).toEqual([]);
    expect(value<unknown[]>(await call({ op: "list_features", epic: String(checkout) }))).toHaveLength(2);
    expect(err(await call({ op: "list_features", epic: "gone" }))).toContain("checkout");
  });

  it("list_tickets lists the tickets that are not archived with their epic and feature, filtered by epic by name or id", async () => {
    const { call, checkout, payment } = setup();
    const all = value<{ key: string; feature: unknown }[]>(await call({ op: "list_tickets" }));
    expect(all.map((t) => t.key).sort()).toEqual(["BTL-1", "BTL-2", "BTL-3"]);
    expect(all.find((t) => t.key === "BTL-1")).toMatchObject({
      title: "BTL-1 title", status: "active", epic: { id: checkout, name: "checkout" }, feature: { id: payment, name: "Payment" },
      repos: [{ name: "btl-1", dir: "/w/btl-1", branch: "b-BTL-1" }],
    });
    expect(all.find((t) => t.key === "BTL-2")).toMatchObject({ epic: { name: "docs" }, feature: null });
    expect(all.find((t) => t.key === "BTL-3")).toMatchObject({ epic: null, feature: null });
    const keys = async (req: object) => value<{ key: string }[]>(await call({ op: "list_tickets", ...req })).map((t) => t.key).sort();
    expect(await keys({ epic: "Checkout" })).toEqual(["BTL-1"]);
    expect(await keys({ epic: String(checkout) })).toEqual(["BTL-1"]);
    expect(await keys({ epic: "docs" })).toEqual(["BTL-2"]);
    expect(err(await call({ op: "list_tickets", epic: "nope" }))).toContain("checkout");
  });

  it("list_prs gives each watched PR with its ticket, epic and feature", async () => {
    const { call, checkout, payment } = setup();
    const list = value<Record<string, unknown>[]>(await call({ op: "list_prs" }));
    expect(list[0]).toMatchObject({
      ticket: "BTL-1", repo: "btl-1", branch: "b-BTL-1", number: 12, url: "https://x/12", state: "open", review: "approved", ci: "failing",
      epic: { id: checkout, name: "checkout" }, feature: { id: payment, name: "Payment" },
    });
    expect(list[1]).toMatchObject({ ticket: "BTL-3", number: null, epic: null, feature: null });
    // 不是 ticket 仓库的 PR：没有仓库名。
    expect(list[2]).toMatchObject({ ticket: "BTL-3", repo: null, number: 4 });
  });

  it("list_prs adds risk, ready and missing when Shipherd assessed the PR, and pr_assessment gives one PR (ws-g)", async () => {
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

  it("list_prs adds the stack, review and merge fields and whose turn the PR is (ws-b, turn model)", async () => {
    const { call, prs } = setup();
    const detail: PrDetail = {
      baseBranch: "main", isDraft: false, title: "Checkout", author: "me", labels: ["ui"], reviewRequests: [], mergeable: "mergeable", mergeState: "clean", statusChangedAt: 86_400_000, slug: "o/r",
      reviewers: [{ login: "ann", state: "approved", at: 0, bot: false }],
    };
    // 从没读成功过的（handoff 里给的链接）：不给 turn 这些，和看板一样不当 PR 算。
    prs[0] = { ...prs[0], checkedAt: 0, detail };
    expect(value<Record<string, unknown>[]>(await call({ op: "list_prs" }))[0]).not.toHaveProperty("turn");
    prs[0] = { ...prs[0], checkedAt: 1, detail };
    const list = value<Record<string, unknown>[]>(await call({ op: "list_prs" }));
    expect(list[0]).toMatchObject({
      title: "Checkout", headBranch: "b-BTL-1", baseBranch: "main", draft: false, author: "me", labels: ["ui"], mergeable: "mergeable", mergeState: "clean",
      reviewers: [{ login: "ann", state: "approved", at: null }], statusChangedAt: "1970-01-02T00:00:00.000Z", turn: { owner: "agent", kind: "fixing_ci", sessionId: "s1" },
    });
    expect(list[0]).not.toHaveProperty("waitingOn");
    // 分支行没有这些字段。
    expect(list[1]).not.toHaveProperty("turn");
  });

  it("list_epics says when the summary read PR status and whether it is stale (ws-b)", async () => {
    const { call, checkout, docs, summaryState } = setup();
    summaryState.stale.add(checkout);
    summaryState.prStatusAt.set(checkout, 86_400_000);
    const list = value<Record<string, unknown>[]>(await call({ op: "list_epics" }));
    expect(list.find((f) => f.id === checkout)).toMatchObject({ prStatusAt: "1970-01-02T00:00:00.000Z", stale: true });
    expect(list.find((f) => f.id === docs)).toMatchObject({ prStatusAt: null, stale: false });
  });

  it("progress_overview resolves the epic by name and returns the aggregate (ws-b)", async () => {
    const { call, progressCalls, checkout } = setup();
    expect(value(await call({ op: "progress_overview" }))).toMatchObject({ counts: { total: 0 }, prs: [] });
    await call({ op: "progress_overview", epic: "checkout" });
    expect(progressCalls).toEqual([{ featureId: null }, { featureId: checkout }]);
    expect(err(await call({ op: "progress_overview", epic: "gone" }))).toContain("checkout");
  });

  it("metrics_overview passes the days through and fails without effect data (ws-h)", async () => {
    const { call, metricsCalls } = setup();
    expect(value(await call({ op: "metrics_overview" }))).toEqual({ days: 30 });
    expect(value(await call({ op: "metrics_overview", days: 90 }))).toEqual({ days: 90 });
    expect(metricsCalls).toEqual([undefined, 90]);
    expect((await setup({ noMetrics: true }).call({ op: "metrics_overview" })).ok).toBe(false);
  });

  it("refresh_epic_summary starts a background run once, only for the open Shipherd 总控 (ws-b)", async () => {
    const { call, checkout, summaryState, open } = setup();
    summaryState.stale.add(checkout);
    expect(value(await call({ op: "refresh_epic_summary", epic: "checkout" }))).toMatchObject({
      started: true, epic: { id: checkout, name: "checkout" }, lastSummaryAt: new Date(5).toISOString(), stale: true,
    });
    expect(summaryState.refreshed).toEqual([checkout]);
    summaryState.running.add(checkout);
    expect(value(await call({ op: "refresh_epic_summary", epic: "checkout" }))).toMatchObject({ started: false, running: true });
    expect(summaryState.refreshed).toHaveLength(1);
    expect(err(await call({ op: "refresh_epic_summary", epic: "nope" }))).toContain("nope");
    open.delete("bt");
    expect((await call({ op: "refresh_epic_summary", epic: "docs" })).ok).toBe(false);
  });

  it("stack tools go to the stacks with the Shipherd scope; writes only from the open Shipherd 总控 (workstream K)", async () => {
    const seen: [unknown, string][] = [];
    const stacks = { handle: async (scope: unknown, req: { op: string }) => (seen.push([scope, req.op]), { v: 1 as const, ok: true as const, value: [] }) } as never;
    const { call, open } = setup({ stacks });
    expect((await call({ op: "list_stacks" })).ok).toBe(true);
    expect((await call({ op: "stack_rebase", stack: 1 })).ok).toBe(true);
    expect(seen).toEqual([[{ kind: "shipherd" }, "list_stacks"], [{ kind: "shipherd" }, "stack_rebase"]]);
    open.delete("bt");
    expect((await call({ op: "list_stacks" })).ok).toBe(true);
    for (const req of [{ op: "stack_rebase", stack: 1 }, { op: "stack_define", branches: ["a", "b"] }, { op: "stack_layer_mode", stack: 1, branch: "b", mode: "draft" }]) {
      expect((await call(req)).ok).toBe(false);
    }
    expect(seen).toHaveLength(3);
    expect((await setup().call({ op: "list_stacks" })).ok).toBe(false);
  });

  it("list_sessions lists every open session but itself, with its role, owners, needs-you and decisions", async () => {
    const { call, needs, inboxView, checkout } = setup();
    needs.set("c1", "在问用哪个方案");
    inboxView.decisions.push({ sessionId: "fc" } as never, { sessionId: "fc" } as never);
    const list = value<Record<string, unknown>[]>(await call({ op: "list_sessions" }));
    expect(list.map((s) => [s.id, s.role])).toEqual([["fc", "feature_coordinator"], ["fx", "fix"], ["c1", "ticket"]]);
    expect(list[0]).toMatchObject({ epic: { id: checkout, name: "checkout" }, feature: null, ticket: null, decisions: 2, needs_you: null, last_reply: "等你定" });
    expect(list[2]).toMatchObject({ ticket: "BTL-1", epic: { id: checkout, name: "checkout" }, feature: { name: "Payment" }, repo: "btl-1", needs_you: "在问用哪个方案", decisions: 0 });
  });

  it("session_activity reads any session; list_inbox returns everything", async () => {
    const { call, activities, inboxView } = setup();
    activities.set("c1", { kind: "testing", detail: null, background: false, startedAt: 1, lastOutputAt: 2, stuck: null, reason: null, action: null, lastOutput: "x" } as unknown as SessionActivity);
    expect(value(await call({ op: "session_activity", session: "c1" }))).toMatchObject({ kind: "testing", output: "out" });
    expect(err(await call({ op: "session_activity", session: "nope" }))).toContain("nope");
    inboxView.reports.push({ id: 3, text: "done" } as never);
    expect(value(await call({ op: "list_inbox" }))).toEqual({ ...inboxView, messages: [] });
  });

  it("refuses everything when Shipherd has no Shipherd 总控 here", async () => {
    const { call } = setup({ shipherdDeps: false });
    expect((await call({ op: "list_epics" })).ok).toBe(false);
  });
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const PREFIX = "Shipherd 总控发来的消息（你这一轮做完时的最后一段回复会转给它）：";

describe("Shipherd 总控 send_message and refresh_session (BTL-190 5)", () => {
  it("send_message releases the control inbox before waiting for the attempt, and still reports it (BTL-269)", async () => {
    const { handle, base } = setup();
    let released = 0;
    const r = await handle({ ...base, op: "send_message", session: "fc", text: "x" } as ShipherdControlRequest, { release: () => void released++ });
    expect(released).toBe(1);
    expect(value(r)).toMatchObject({ delivery: "delivered" });
  });

  it("queues a message for an epic coordinator; the mailbox types it in with a prefix (BTL-245)", async () => {
    const { call, delivered } = setup();
    // 停着的：等这一次尝试，如实说送到了（BTL-269）。
    expect(value(await call({ op: "send_message", session: "fc", text: "接口改了" }))).toMatchObject({ queued: false, delivery: "delivered", sessionId: "fc", note: expect.stringContaining("送进去了") });
    await tick();
    expect(delivered.map(([t]) => t)).toEqual(["fc"]);
    expect(delivered[0][1]).toContain(`${PREFIX}\n接口改了`);
  });

  it("returns a requestId and sends the target's next reply back to the Shipherd 总控 (ws-b, BTL-245)", async () => {
    const { call, delivered, replies, mailbox, repo, setNow } = setup();
    replies.set("fc", { id: "r0", text: "earlier", at: 1 });
    const out = value<{ requestId: string }>(await call({ op: "send_message", session: "fc", text: "进度？" }));
    expect(out.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await tick();
    expect(repo.get(out.requestId)).toMatchObject({ status: "delivered", toSession: "fc", fromSession: "bt" });
    setNow(2_000);
    replies.set("fc", { id: "r1", text: "PR 都绿了", at: 2_000 });
    await mailbox.stopped("fc");
    await tick();
    expect(delivered.at(-1)?.[0]).toBe("bt");
    expect(delivered.at(-1)?.[1]).toContain(out.requestId);
    expect(delivered.at(-1)?.[1]).toContain("PR 都绿了");
    const inbox = value<{ messages: { id: string; status: string }[] }>(await call({ op: "list_inbox" }));
    expect(inbox.messages.find((m) => m.id === out.requestId)?.status).toBe("replied");
  });

  it("never refuses because the target is busy: the message waits in its mailbox (BTL-245)", async () => {
    const { call, delivered, repo, mailbox, setGuard } = setup();
    setGuard(() => ({ ok: false, block: "busy" }));
    const out = value<{ requestId: string; note: string }>(await call({ op: "send_message", epic: "checkout", text: "t" }));
    expect(out.note).toContain("信箱");
    // 挡住的原因如实返回（BTL-269），不再承诺「下一次调用工具时」。
    expect(out).toMatchObject({ queued: true, delivery: "queued", blockedBy: "turn" });
    expect(out.note).not.toContain("下一次调用工具时就会读到");
    await tick();
    expect(delivered).toEqual([]);
    expect(repo.get(out.requestId)?.status).toBe("queued");
    setGuard((id) => ({ ok: true, termId: id, headId: id }));
    await mailbox.stopped("fc");
    expect(delivered.map(([t]) => t)).toEqual(["fc"]);
  });

  it("interrupt presses Esc on a busy target first, then types the message in (BTL-245)", async () => {
    const { call, delivered, interrupts, setGuard } = setup();
    setGuard(() => ({ ok: false, block: "busy" }));
    // 叫停：按 Esc 以后照样送进去了。
    expect(value(await call({ op: "send_message", session: "fc", text: "停一下", interrupt: true }))).toMatchObject({ delivery: "delivered", state: "busy" });
    await tick();
    expect(interrupts).toEqual(["fc"]);
    expect(delivered[0][1]).toContain("停一下");
  });

  it("opening a closed coordinator asks memory first; a refusal opens nothing but keeps the message queued for its next open (workstream W, BTL-245)", async () => {
    const mem = { availableMb: 2500 };
    const admission = new MemoryAdmission({
      read: async () => ({ totalKb: 64 * 1024 * 1024, availableKb: mem.availableMb * 1024, source: "vm_stat", pressure: "normal" }),
      settings: () => ({ reserveMb: 2048, sessionMb: 1024, maxRunning: 0 }),
      running: () => 0, now: () => 0, log: () => undefined,
    });
    const { call, opened, submitted, repo } = setup({ admission });
    const first = value<{ requestId: string; openError: string; state: string }>(await call({ op: "send_message", epic: "docs", text: "看一下" }));
    expect(first.openError).toContain("内存不够");
    expect(first.state).toBe("closed");
    expect(opened).toEqual([]);
    expect(submitted).toEqual([]);
    expect(repo.get(first.requestId)?.status).toBe("queued");
    mem.availableMb = 8000;
    expect(value(await call({ op: "send_message", epic: "docs", text: "再看一下" }))).toMatchObject({ sessionId: "dc", opened: "resumed" });
    await tick();
    expect(submitted).toHaveLength(1);
    expect(submitted[0][1]).toMatch(/看一下[\s\S]*再看一下/);
    expect(repo.get(first.requestId)?.status).toBe("delivered");
  });

  it("does not reopen a coordinator the user ended; the message waits for the user (BTL-256)", async () => {
    const { call, opened, repo, sessions } = setup();
    sessions.setUserEnded("dc", 123);
    const r = value<{ requestId: string; wake: string; note: string }>(await call({ op: "send_message", epic: "docs", text: "看一下" }));
    expect(r.wake).toBe("ended_by_user");
    expect(r.note).toContain("用户自己结束");
    expect(opened).toEqual([]);
    expect(repo.get(r.requestId)?.status).toBe("queued");
  });

  it("says waiting_memory when memory is too short to reopen a coordinator (BTL-256)", async () => {
    const admission = new MemoryAdmission({
      read: async () => ({ totalKb: 64 * 1024 * 1024, availableKb: 2500 * 1024, source: "vm_stat", pressure: "normal" }),
      settings: () => ({ reserveMb: 2048, sessionMb: 1024, maxRunning: 0 }),
      running: () => 0, now: () => 0, log: () => undefined,
    });
    const { call } = setup({ admission });
    expect(value(await call({ op: "send_message", epic: "docs", text: "看一下" }))).toMatchObject({ wake: "waiting_memory", wakeError: expect.stringContaining("内存不够") });
  });

  it("refuses ticket and fix sessions, itself and unknown ones", async () => {
    const { call, delivered } = setup();
    expect(err(await call({ op: "send_message", session: "c1", text: "t" }))).toContain("epic 总控");
    expect(err(await call({ op: "send_message", session: "fx", text: "t" }))).toContain("epic 总控");
    expect(err(await call({ op: "send_message", session: "bt", text: "t" }))).toContain("bt");
    expect(err(await call({ op: "send_message", session: "nope", text: "t" }))).toContain("nope");
    expect(err(await call({ op: "send_message", epic: "nope", text: "t" }))).toContain("checkout");
    expect(err(await call({ op: "send_message", epic: "gone", text: "t" }))).toContain("checkout");
    expect(delivered).toEqual([]);
  });

  it("takes an epic by name or id and sends to its running coordinator", async () => {
    const { call, delivered, opened, checkout } = setup();
    expect(value(await call({ op: "send_message", epic: "Checkout", text: "a" }))).toMatchObject({ delivery: "delivered", sessionId: "fc" });
    expect(value(await call({ op: "send_message", epic: String(checkout), text: "b" }))).toMatchObject({ delivery: "delivered", sessionId: "fc" });
    await tick();
    expect(delivered.map(([id]) => id)).toContain("fc");
    expect(opened).toEqual([]);
  });

  it("resumes the latest coordinator of an epic whose terminal was closed, then hands it the message", async () => {
    const { call, opened, submitted, delivered, docs } = setup();
    expect(value(await call({ op: "send_message", epic: "docs", text: "看一下 PR" }))).toMatchObject({ queued: true, sessionId: "dc", opened: "resumed" });
    expect(opened).toEqual([{ feature: docs, session: "dc" }]);
    await tick();
    expect(submitted.map(([t]) => t)).toEqual(["dc"]);
    expect(submitted[0][1]).toContain(`${PREFIX}\n看一下 PR`);
    expect(delivered).toEqual([]);
    // 给的是关着的 session：一样恢复它。
    const again = setup();
    expect(value(await again.call({ op: "send_message", session: "dc", text: "x" }))).toMatchObject({ sessionId: "dc", opened: "resumed" });
  });

  it("opens a new coordinator when the epic never had one", async () => {
    const { call, sessions, opened, submitted, docs } = setup();
    for (const s of sessions.listFeatureCoordinators(docs)) sessions.delete(s.id);
    expect(value(await call({ op: "send_message", epic: "docs", text: "开始吧" }))).toMatchObject({ queued: true, opened: "opened" });
    expect(opened).toEqual([{ feature: docs, session: null }]);
    await tick();
    expect(submitted).toHaveLength(1);
  });

  it("a second message while a new coordinator is still opening waits for it and joins the same mailbox (BTL-245)", async () => {
    const { call, sessions, opened, submitted, docs, repo } = setup();
    for (const s of sessions.listFeatureCoordinators(docs)) sessions.delete(s.id);
    const [a, b] = await Promise.all([call({ op: "send_message", epic: "docs", text: "一" }), call({ op: "send_message", epic: "docs", text: "二" })]);
    expect(opened).toHaveLength(1);
    const second = value<{ requestId: string; sessionId: string }>(b);
    expect(value<{ sessionId: string }>(a).sessionId).toBe(second.sessionId);
    await tick();
    expect(submitted).toHaveLength(1);
    expect(repo.get(second.requestId)?.toSession).toBe(second.sessionId);
  });

  it("only takes send_message from the Shipherd 总控 session itself", async () => {
    const { call, delivered } = setup();
    expect((await call({ op: "send_message", session: "fc", text: "t", from: "fx" })).ok).toBe(false);
    expect((await call({ op: "send_message", session: "fc", text: "t", from: null })).ok).toBe(false);
    expect(delivered).toEqual([]);
  });

  it("refuses send_message and refresh_session from a Shipherd 总控 whose terminal is closed", async () => {
    const { call, delivered, refreshed, open } = setup();
    open.delete("bt");
    expect((await call({ op: "send_message", session: "fc", text: "t" })).ok).toBe(false);
    expect((await call({ op: "refresh_session", session: "fc" })).ok).toBe(false);
    expect((await call({ op: "refresh_session", session: "fc", from: "fx" })).ok).toBe(false);
    expect((await call({ op: "refresh_session", session: "fc", from: null })).ok).toBe(false);
    await tick();
    expect(delivered).toEqual([]);
    expect(refreshed).toEqual([]);
  });

  it("refreshes any stopped session but itself", async () => {
    const { call, refreshed } = setup();
    expect(value(await call({ op: "refresh_session", session: "fc" }))).toEqual({ started: true });
    await tick();
    expect(refreshed).toEqual(["fc"]);
    expect((await call({ op: "refresh_session", session: "bt" })).ok).toBe(false);
  });
});

describe("Shipherd 总控 ask_user and report (BTL-190 5)", () => {
  it("takes them only from a Shipherd 总控 session", async () => {
    const { call, asked } = setup();
    expect(value(await call({ op: "ask_user", question: "先合哪个？" }))).toMatchObject({ id: 7 });
    expect(asked).toEqual(["bt"]);
    expect(value(await call({ op: "report", text: "巡检完了", kind: "done" }))).toMatchObject({ id: 8 });
    expect(err(await call({ op: "ask_user", question: "q", from: "fc" }))).toBeTruthy();
    expect(asked).toEqual(["bt"]);
  });
});

/** 预审的数据（BTL-271）：BTL-1（checkout）在跑，BTL-2（docs）有 2 条违规、还有一个排着，BTL-3 没预审过。 */
function fakePreReview() {
  const calls: string[] = [];
  const b = (o: Partial<PreReviewBadge> & { ticketKey: string }): PreReviewBadge => ({ ...noPreReview(o.ticketKey), ...o });
  const running = b({ ticketKey: "BTL-1", state: "running", id: 11, sessionId: "c1", prId: 1, repoSlug: "o/app", branch: "b-BTL-1", headSha: "a".repeat(40), startedAt: 5_000, trigger: "evidence" });
  const lib = b({ ticketKey: "BTL-1", state: "clean", id: 12, repoSlug: "o/lib", branch: "b-BTL-1", headSha: "c".repeat(40), finishedAt: 4_000 });
  // o/old 的 PR 3 已经关了：那是旧代码，不再重跑。o/wip 没有 PR、已经在排队：不再排第二次。
  const old = b({ ticketKey: "BTL-1", state: "clean", id: 13, repoSlug: "o/old", branch: "b-BTL-1", headSha: "f".repeat(40), finishedAt: 2_000 });
  const wip = b({ ticketKey: "BTL-1", state: "queued", id: 14, position: 2, repoSlug: "o/wip", branch: "b-BTL-1", headSha: "9".repeat(40), enqueuedAt: 6_500 });
  const viol = b({ ticketKey: "BTL-2", state: "violations", id: 5, violations: 2, repoSlug: "o/doc", branch: "b-BTL-2", headSha: "b".repeat(40), finishedAt: 3_000 });
  const queued = b({ ticketKey: "BTL-2", state: "queued", id: 6, position: 1, repoSlug: "o/doc", branch: "b-BTL-2", headSha: "d".repeat(40), enqueuedAt: 6_000 });
  const status = new Map<string, PreReviewTicketStatus>([
    ["BTL-1", { ticketKey: "BTL-1", overall: running, items: [running, lib, old, wip], enabled: true }],
    ["BTL-2", { ticketKey: "BTL-2", overall: viol, items: [viol], enabled: true }],
  ]);
  const pr = (id: number, ticketKey: string, slug: string, headBranch: string, state: TicketPr["state"] = "open") =>
    ({ id, ticketKey, url: `https://github.com/${slug}/pull/${id}`, slug, number: id * 10, headBranch, headSha: "e".repeat(40), state }) as TicketPr;
  const prs = [pr(1, "BTL-1", "o/app", "b-BTL-1"), pr(2, "BTL-2", "o/doc", "b-BTL-2"), pr(3, "BTL-1", "o/old", "b-BTL-1", "closed")];
  const item = (x: PreReviewBadge): PreReviewQueueItem => ({ ...x, id: x.id!, jobId: x.id! + 100, prNumber: null, prUrl: null, ending: null });
  const q = { running: [item(running)], ending: [] as PreReviewQueueItem[], queued: [item(queued), item({ ...wip, position: 1 })] };
  /** 不是 ticket 现在的分支的（旧分支）。 */
  const stale = new Set<string>();
  const ops: PreReviewOps = {
    status: {
      forTickets: (keys) => new Map(keys.map((k) => [k, status.get(k) ?? { ticketKey: k, overall: noPreReview(k), items: [] }])),
      forSessions: (ids) => new Map(ids.filter((id) => id === "c1").map((id) => [id, running])),
      forPrs: (ids) => new Map(ids.filter((id) => id === 1).map((id) => [id, running])),
      history: (by) => ("ticketKey" in by && by.ticketKey === "BTL-2" ? [queued, viol] : []),
      queue: () => ({ ...q, concurrency: 2, stopped: null }),
      placeOf: (id) => (id >= 100 ? { position: 2, ahead: 1, running: 1, reason: "cost", waiting: null } : null),
      isCurrentBranch: (_key, slug, branch) => !stale.has(`${slug}:${branch}`),
    } as PreReviewOps["status"],
    view: (id) =>
      id === 5
        ? ({ id: 5, verdict: "violations", status: "done", target: { repoSlug: "o/doc", branch: "b-BTL-2", headSha: "b".repeat(40) }, summary: "两处", detail: null, finishedAt: 3_000,
            violations: [{ severity: "must", file: "a.ts", line: 3, what: "没带仓库", fix: "" }], checks: null, missingEvidence: [{ detail: "没有截图" }] } as unknown as PreReviewView)
        : null,
    findPrs: (ref) => prs.filter((p) => String(p.id) === ref || p.url === ref),
    prsOf: (key) => prs.filter((p) => p.ticketKey === key),
    manual: (p) => (calls.push(`manual:${p.id}`), 100 + p.id),
    rerun: (id) => (calls.push(`rerun:${id}`), 200 + id),
    cancel: (id) => (calls.push(`cancel:${id}`), { ok: true }),
    moveToFront: (id, within) => (calls.push(`front:${id}:${within ? "epic" : "all"}`), id === 6 || id === 14 ? { ok: true } : { ok: false, reason: "not_queued" }),
    ticketOf: (id) => (id === 11 || id === 14 || id === 15 ? "BTL-1" : id === 6 || id === 5 ? "BTL-2" : undefined),
  };
  return { ops, calls, q, item, b, stale };
}

describe("pre-review for both coordinators (BTL-271)", () => {
  it("Shipherd control: list_tickets, list_sessions and list_prs carry preReview, so waiting on CI and pre-reviewing differ", async () => {
    const { ops } = fakePreReview();
    const t = setup({ preReviewOps: ops, assessment: true });
    const list = value<{ key: string; preReview: { state: string; violations: number; items?: unknown[] } }[]>(await t.call({ op: "list_tickets" }));
    expect(Object.fromEntries(list.map((x) => [x.key, x.preReview.state]))).toEqual({ "BTL-1": "running", "BTL-2": "violations", "BTL-3": "none" });
    expect(list.find((x) => x.key === "BTL-1")!.preReview.items).toHaveLength(4);
    expect(list.find((x) => x.key === "BTL-2")!.preReview).toMatchObject({ violations: 2, headSha: "b".repeat(12) });
    const sessions = value<{ id: string; preReview: { state: string; startedAt: string } | null }[]>(await t.call({ op: "list_sessions" }));
    expect(sessions.find((s) => s.id === "c1")!.preReview).toMatchObject({ state: "running", startedAt: new Date(5_000).toISOString() });
    expect(sessions.find((s) => s.id === "fc")!.preReview).toBeNull();
    const prs = value<{ prId: number | null; preReview?: { state: string } | null }[]>(await t.call({ op: "list_prs" }));
    expect(prs.find((p) => p.prId === 1)!.preReview).toMatchObject({ state: "running" });
    expect(prs.find((p) => p.prId === 2)!.preReview).toBeNull();
  });

  it("Shipherd control: pre_review_status gives the latest verdict's gist and the history; unknown tickets and PRs fail", async () => {
    const t = setup({ preReviewOps: fakePreReview().ops });
    const s = value<{ preReview: { state: string }; latest: { violations: { file: string }[]; missingEvidence: string[] }; history: { id: number }[] }>(await t.call({ op: "pre_review_status", ticket: "btl-2" }));
    expect(s.preReview.state).toBe("violations");
    expect(s.latest).toMatchObject({ id: 5, verdict: "violations", violations: [{ file: "a.ts", line: 3, what: "没带仓库" }], missingEvidence: ["没有截图"] });
    expect(s.history.map((h) => h.id)).toEqual([6, 5]);
    const p = value<{ ticket: string; pr: { prId: number }; preReview: { state: string }; latest: null }>(await t.call({ op: "pre_review_status", pr: "1" }));
    expect(p).toMatchObject({ ticket: "BTL-1", pr: { prId: 1, number: 10 }, preReview: { state: "running" }, latest: null });
    expect(err(await t.call({ op: "pre_review_status", ticket: "NOPE-1" }))).toContain("NOPE-1");
    expect(err(await t.call({ op: "pre_review_status", pr: "99" }))).not.toBe("");
  });

  it("Shipherd control: pre_review_run uses the same manual entry as the ticket page, a ticket gets one run per open PR and a rerun for repos without one", async () => {
    const { ops, calls } = fakePreReview();
    const t = setup({ preReviewOps: ops });
    const r = value<{ queued: { id: number; position: number; reason: string | null; pr?: string; repo?: string }[] }>(await t.call({ op: "pre_review_run", ticket: "BTL-1" }));
    // PR 1 开着（o/app）；o/lib 没有 PR，按最近一次（id 12）再排。o/app 已经有 PR，不再 rerun；
    // o/old 的 PR 3 关了，那条分支不重跑；o/wip 已经在排队，照实报上来、不排第二次。
    expect(calls).toEqual(["manual:1", "rerun:12"]);
    expect(r.queued).toEqual([
      expect.objectContaining({ id: 101, position: 2, ahead: 1, reason: "cost", pr: "https://github.com/o/app/pull/1" }),
      expect.objectContaining({ id: 212, repo: "o/lib", branch: "b-BTL-1" }),
      expect.objectContaining({ id: 14, repo: "o/wip", branch: "b-BTL-1", already: true }),
    ]);
    expect(err(await t.call({ op: "pre_review_run", pr: "3" }))).not.toBe("");
    expect(calls).toHaveLength(2);
  });

  it("Shipherd control: pre_review_run on a PR whose current head is already running reports that run instead of queuing a second", async () => {
    const { ops, calls, q, item, b } = fakePreReview();
    q.running = [item(b({ ticketKey: "BTL-1", state: "running", id: 11, prId: 1, repoSlug: "o/app", branch: "b-BTL-1", headSha: "e".repeat(40) }))];
    const t = setup({ preReviewOps: ops });
    const r = value<{ queued: { id: number; already?: boolean }[] }>(await t.call({ op: "pre_review_run", pr: "1" }));
    expect(r.queued).toEqual([expect.objectContaining({ id: 11, already: true })]);
    expect(calls).toEqual([]);
  });

  it("Shipherd control: pre_review_run finds the current head queued behind an older commit that is running, and does not supersede it", async () => {
    const { ops, calls, q, item, b } = fakePreReview();
    // 旧提交 A（id 11，head a…）在跑；PR 现在的 head（e…）交过证据、排着（id 15）。徽标上最要紧的是在跑的 A。
    q.queued.push(item(b({ ticketKey: "BTL-1", state: "queued", id: 15, position: 2, prId: 1, repoSlug: "o/app", branch: "b-BTL-1", headSha: "e".repeat(40), trigger: "evidence" })));
    const t = setup({ preReviewOps: ops });
    const r = value<{ queued: { id: number; already?: boolean }[] }>(await t.call({ op: "pre_review_run", pr: "1" }));
    // 认出排着的 15，不去作废它重排一次（作废会把 trigger 从 evidence 变成 manual，交证据的 session 就收不到失败）。
    expect(r.queued).toEqual([expect.objectContaining({ id: 15, already: true })]);
    const all = value<{ queued: { id: number; already?: boolean }[] }>(await t.call({ op: "pre_review_run", ticket: "BTL-1" }));
    expect(all.queued[0]).toMatchObject({ id: 15, already: true });
    expect(calls).toEqual(["rerun:12"]);
  });

  it("Shipherd control: a ticket-level pre_review_run skips branches that are no longer the ticket's", async () => {
    const { ops, calls, stale } = fakePreReview();
    // o/lib 的 b-BTL-1 已经不是 ticket 现在的分支、也没有开着的 PR：旧代码，不重跑。
    stale.add("o/lib:b-BTL-1");
    const t = setup({ preReviewOps: ops });
    const r = value<{ queued: { id: number; repo?: string }[] }>(await t.call({ op: "pre_review_run", ticket: "BTL-1" }));
    expect(calls).toEqual(["manual:1"]);
    expect(r.queued.map((x) => x.repo ?? null)).toEqual([null, "o/wip"]);
  });

  it("Shipherd control: running, cancelling and moving need the open Shipherd control itself; looking does not", async () => {
    const { ops, calls } = fakePreReview();
    const t = setup({ preReviewOps: ops });
    t.open.delete("bt");
    expect(err(await t.call({ op: "pre_review_run", pr: "1" }))).not.toBe("");
    expect(err(await t.call({ op: "pre_review_queue_act", cancel: 11 }))).not.toBe("");
    expect(calls).toEqual([]);
    const q = value<{ running: { id: number; ticket: string }[]; queued: { id: number; position: number }[]; concurrency: number; stopped: null }>(await t.call({ op: "pre_review_queue" }));
    expect(q).toMatchObject({ concurrency: 2, stopped: null, running: [{ id: 11, ticket: "BTL-1" }], queued: [{ id: 6, position: 1 }, { id: 14, position: 1 }] });
    t.open.add("bt");
    // Shipherd 总控插队排到全队最前（不给范围）。
    expect(value<{ done: string; queued: unknown[] }>(await t.call({ op: "pre_review_queue_act", front: 6 }))).toMatchObject({ done: "moved_to_front", queued: [{ id: 6 }, { id: 14 }] });
    expect(err(await t.call({ op: "pre_review_queue_act", front: 11 }))).not.toBe("");
    expect(err(await t.call({ op: "pre_review_queue_act", cancel: 77 }))).not.toBe("");
    expect(calls).toEqual(["front:6:all", "front:11:all"]);
  });

  it("epic control sees and acts only on its own epic: other epics' tickets, PRs and queue items are refused", async () => {
    const { ops, calls } = fakePreReview();
    const t = setup({ preReviewOps: ops, assessment: true });
    const epic = (req: Record<string, unknown>, from = "fc") => t.handle({ v: 1, featureId: t.checkout, from, ...req } as never);
    // BTL-1 是 checkout 的；BTL-2 是 docs 的。
    expect(value<{ preReview: { state: string } }>(await epic({ op: "pre_review_status", ticket: "BTL-1" })).preReview.state).toBe("running");
    expect(err(await epic({ op: "pre_review_status", ticket: "BTL-2" }))).toContain("BTL-2");
    expect(err(await epic({ op: "pre_review_status", pr: "2" }))).not.toBe("");
    expect(err(await epic({ op: "pre_review_run", ticket: "BTL-2" }))).not.toBe("");
    expect(err(await epic({ op: "pre_review_queue_act", cancel: 6 }))).not.toBe("");
    // 不是这个 epic 的总控（修复 session）不能动；看可以。
    expect(err(await epic({ op: "pre_review_run", pr: "1" }, "fx"))).not.toBe("");
    expect(err(await epic({ op: "pre_review_queue_act", cancel: 11 }, "fx"))).toBe(M().ctlPreReviewNotCoordinator);
    // 队列只列自己 epic 的条目（BTL-2 的 6 是 docs 的），total 是全队的条数。
    const q = value<{ running: { id: number }[]; queued: { id: number }[]; total: { running: number; queued: number } }>(await epic({ op: "pre_review_queue" }, "fx"));
    expect(q.running.map((x) => x.id)).toEqual([11]);
    expect(q.queued.map((x) => x.id)).toEqual([14]);
    expect(q.total).toEqual({ running: 1, queued: 2 });
    expect(calls).toEqual([]);
    expect(value<{ queued: { id: number }[] }>(await epic({ op: "pre_review_run", pr: "1" })).queued.map((q) => q.id)).toEqual([101]);
    expect(value<{ done: string }>(await epic({ op: "pre_review_queue_act", cancel: 11 })).done).toBe("cancelled");
    // epic 总控插队只排到自己 epic 的最前（带范围），越不过别的 epic。
    expect(value<{ done: string }>(await epic({ op: "pre_review_queue_act", front: 14 })).done).toBe("moved_to_front");
    expect(calls).toEqual(["manual:1", "cancel:11", "front:14:epic"]);
  });

  it("epic control: list_tickets and list_sessions carry preReview; list_prs and pr_assessment only cover the epic's PRs", async () => {
    const t = setup({ preReviewOps: fakePreReview().ops, assessment: true });
    const epic = (req: Record<string, unknown>) => t.handle({ v: 1, featureId: t.checkout, from: "fc", ...req } as never);
    const tickets = value<{ key: string; preReview: { state: string } }[]>(await epic({ op: "list_tickets" }));
    expect(tickets.map((x) => [x.key, x.preReview.state])).toEqual([["BTL-1", "running"]]);
    const sessions = value<{ id: string; preReview: { state: string } | null }[]>(await epic({ op: "list_sessions" }));
    expect(sessions.find((s) => s.id === "c1")!.preReview).toMatchObject({ state: "running" });
    expect(sessions.find((s) => s.id === "fc")!.preReview).toBeNull();
    const prs = value<{ ticket: string; preReview?: unknown }[]>(await epic({ op: "list_prs" }));
    expect(prs.map((p) => p.ticket)).toEqual(["BTL-1"]);
    expect(prs[0].preReview).toMatchObject({ state: "running" });
    expect(value<{ prId: number }>(await epic({ op: "pr_assessment", pr: "1" })).prId).toBe(1);
    expect(err(await epic({ op: "pr_assessment", pr: "2" }))).not.toBe("");
  });

  it("without the pre-review service the tools say it is unavailable and lists have no preReview", async () => {
    const t = setup();
    expect(err(await t.call({ op: "pre_review_queue" }))).not.toBe("");
    const list = value<object[]>(await t.call({ op: "list_tickets" }));
    expect(list[0]).not.toHaveProperty("preReview");
  });
});
