import { describe, expect, it } from "vitest";
import type { SessionActivity } from "../../shared/activity";
import type { ButlerControlRequest, ControlResult } from "../../shared/control";
import type { EpicFeatureRow, InboxView, Session, SessionView, WatchedPr } from "../../shared/types";
import { EpicsRepo } from "../db/epics-repo";
import { FeaturesRepo } from "../db/features-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { TicketsRepo } from "../db/tickets-repo";
import type { DeliveryCheck } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import { memDb } from "../test-utils";
import { controlHandler } from "./control-handler";

/** Butler 总控（BTL-190 第 5 点）：两个 epic（一个归档了）、三个 feature（一个不属于 epic）、两个 ticket（一个归档了）和各种 session。 */
function setup(o: { butlerDeps?: boolean } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const features = new FeaturesRepo(db);
  const epics = new EpicsRepo(db);
  const shop = epics.insert({ name: "shop", workspaceDir: "/e/shop", createdAt: 1 });
  const old = epics.insert({ name: "old", workspaceDir: "/e/old", createdAt: 1 });
  epics.archive(old, 2);
  const checkout = features.insert({ name: "checkout", workspaceDir: "/f/checkout", createdAt: 1, epicId: shop });
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
  add("closed-ep", { epicId: shop });
  /** 开着终端的 session（终端 id 就是 session id）。 */
  const open = new Set(["bt", "ep", "fc", "fx", "c1"]);
  const activities = new Map<string, SessionActivity>();
  const needs = new Map<string, string>();
  let guardCheck: (id: string) => DeliveryCheck = (id) => ({ ok: true, termId: id, headId: id });
  const delivered: [string, string][] = [];
  const refreshed: string[] = [];
  const view = (id: string): SessionView => ({ ...sessions.get(id)!, termId: open.has(id) ? id : null });
  const rows: (EpicFeatureRow & { epicId: number | null })[] = [
    { id: checkout, epicId: shop, name: "checkout", status: "waiting", archivedAt: null, summaryAt: 5, summary: "x".repeat(2000), blockers: ["等 API"], decisions: [], openQuestions: [] },
    { id: docs, epicId: null, name: "docs", status: "not_started", archivedAt: null, summaryAt: null, summary: null, blockers: [], decisions: [], openQuestions: [] },
  ];
  const prs: WatchedPr[] = [
    { ticketKey: "BTL-1", repoId: 1, repoPath: "/r/btl-1", branch: "b-BTL-1", number: 12, url: "https://x/12", state: "open", review: "approved", ci: "failing", headSha: "abc", checkedAt: 0 },
    { ticketKey: "BTL-3", repoId: 3, repoPath: "/r/btl-3", branch: "b-BTL-3", number: null, url: null, state: null, review: null, ci: "none", headSha: null, checkedAt: 0 },
  ];
  const inboxView: InboxView = { decisions: [], reports: [] };
  const asked: string[] = [];
  const handle = controlHandler({
    tickets, sessions, features, epics,
    ticketService: { workDir: (r: { worktreePath: string | null; repoPath: string }) => r.worktreePath ?? r.repoPath } as never,
    sessionService: {
      isRunning: (id: string) => open.has(id), termIdOf: (id: string) => (open.has(id) ? id : null),
      runningCoordinator: (featureId: number) => (featureId === checkout && open.has("fc") ? sessions.get("fc") : null),
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
    submit: async () => "sent" as const,
    notify: () => {},
    ...(o.butlerDeps !== false && {
      butler: {
        epicViews: () => [{ id: shop, name: "shop", sessions: [view("ep"), view("closed-ep")], waiting: true, stuck: false, features: rows.filter((r) => r.epicId === shop) }],
        featureRows: () => rows,
        prs: () => prs,
        openHeads: () => [...open].map((id) => sessions.get(id)!),
        needsYou: (id) => needs.get(id) ?? null,
        inbox: { view: () => inboxView },
      },
    }),
  });
  const base = { v: 1 as const, butler: true as const, from: "bt" };
  const call = (req: Record<string, unknown>) => handle({ ...base, ...req } as ButlerControlRequest);
  return { handle, call, base, shop, checkout, docs, open, activities, needs, delivered, refreshed, inboxView, asked, setGuard: (f: typeof guardCheck) => (guardCheck = f) };
}

const value = <T,>(r: ControlResult) => {
  if (!r.ok) throw new Error(r.error);
  return r.value as T;
};
const err = (r: ControlResult) => (r.ok ? "" : r.error);

describe("Butler 总控 read-only tools (BTL-190 5)", () => {
  it("list_epics lists the epics that are not archived, with their features and whether the epic session runs", async () => {
    const { call, shop } = setup();
    expect(value(await call({ op: "list_epics" }))).toEqual([{ id: shop, name: "shop", features: 1, sessionRunning: true, waiting: true, stuck: false }]);
  });

  it("list_features lists every feature with its epic, status, coordinator and a capped summary", async () => {
    const { call, shop, checkout, docs } = setup();
    const list = value<Record<string, unknown>[]>(await call({ op: "list_features" }));
    expect(list.map((f) => [f.id, f.name, f.epic, f.status, f.coordinatorRunning])).toEqual([
      [checkout, "checkout", { id: shop, name: "shop" }, "waiting", true],
      [docs, "docs", null, "not_started", false],
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
    expect(value(await call({ op: "list_inbox" }))).toEqual(inboxView);
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
    expect(delivered).toEqual([["ep", "Butler 总控发来的消息：\n先合 checkout"], ["fc", "Butler 总控发来的消息：\n接口改了"]]);
  });

  it("refuses ticket and fix sessions, closed sessions, itself, unknown ones and a blocked guard", async () => {
    const { call, delivered, setGuard } = setup();
    expect(err(await call({ op: "send_message", session: "c1", text: "t" }))).toContain("epic session");
    expect(err(await call({ op: "send_message", session: "fx", text: "t" }))).toContain("epic session");
    expect(err(await call({ op: "send_message", session: "bt", text: "t" }))).toContain("bt");
    expect(err(await call({ op: "send_message", session: "nope", text: "t" }))).toContain("nope");
    expect(err(await call({ op: "send_message", session: "closed-ep", text: "t" }))).toContain("closed-ep");
    setGuard(() => ({ ok: false, block: "busy" }));
    expect(err(await call({ op: "send_message", session: "ep", text: "t" }))).toContain("它正在干活");
    expect(delivered).toEqual([]);
  });

  it("only takes send_message from the Butler 总控 session itself", async () => {
    const { call, delivered } = setup();
    expect((await call({ op: "send_message", session: "ep", text: "t", from: "fc" })).ok).toBe(false);
    expect((await call({ op: "send_message", session: "ep", text: "t", from: null })).ok).toBe(false);
    expect(delivered).toEqual([]);
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
