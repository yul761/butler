import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRIEF_LIMIT, EPIC_PLAN_MAX_CHARS, MAX_RUNNING_FEATURES_PER_EPIC, MAX_RUNNING_PER_FEATURE, SUMMARY_LIMIT, type ControlResult, type EpicControlRequest } from "../../shared/control";
import type { SessionActivity } from "../../shared/activity";
import type { EpicFeatureRow } from "../../shared/types";
import type { EpicHistoryEntry } from "../db/epic-history-repo";
import type { DeliveryCheck } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import { EpicsRepo } from "../db/epics-repo";
import { FeaturesRepo } from "../db/features-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { EpicService } from "../epics/epic-service";
import { makeRepo, memDb, tempDir } from "../test-utils";
import { FeatureService } from "../tickets/feature-service";
import { controlHandler } from "./control-handler";

async function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const features = new FeaturesRepo(db);
  const epics = new EpicsRepo(db);
  const home = tempDir("butler-home-");
  const featureService = new FeatureService({ features, tickets, epics, db, now: () => 1, homeDir: home });
  const epicService = new EpicService({ epics, features, featureService, db, now: () => 1, homeDir: home });
  const parent = join(tempDir("butler-code-"), "shop");
  mkdirSync(parent);
  const frontend = join(parent, "frontend");
  const backend = join(parent, "backend");
  const elsewhere = join(parent, "elsewhere");
  renameSync(makeRepo(), frontend);
  renameSync(makeRepo(), backend);
  renameSync(makeRepo(), elsewhere);
  const epic = await epicService.create({ name: "shop", repoPaths: [frontend, backend] });
  const solo = await epicService.create({ name: "solo", repoPaths: [frontend] });
  let notified = 0;
  let rows: EpicFeatureRow[] = [];
  let history: EpicHistoryEntry[] = [];
  const logs: string[] = [];
  const events: string[] = [];
  let refreshEpic: (epicId: number, except?: number) => void = (epicId, except) => void events.push(`refresh:${epicId}:${except}`);
  /** 开着终端的 session（终端 id 就是 session id）。 */
  const open = new Set<string>();
  const activities = new Map<string, SessionActivity>();
  const replies = new Map<string, string>();
  const killed: string[] = [];
  const refreshed: string[] = [];
  /** start_feature（BTL-190 第 4 点）：openFeature 的调用、每个 feature 跑着的总控（session id）、feature 开着的终端数。 */
  const opened: { featureId: number; sessionId?: string; start?: { instructions?: string | null } }[] = [];
  const runningOf = new Map<number, string>();
  const terminalsOf = new Map<number, number>();
  let openResult: (() => { ok: false; reason: "claude_missing" }) | null = null;
  let guardCheck: (id: string) => DeliveryCheck = (id) => ({ ok: true, termId: id, headId: id });
  const delivered: [string, string][] = [];
  let deliverResult: DeliverResult = "sent";
  const handle = controlHandler({
    tickets, sessions, features, epics, featureService,
    refresher: { precheck: () => null, refresh: async (id) => (refreshed.push(id), "done" as const) },
    ticketService: undefined as never,
    sessionService: {
      isRunning: (id: string) => open.has(id), termIdOf: (id: string) => (open.has(id) ? id : null),
      openFeature: async (req: { featureId: number; sessionId?: string }, extra: { start?: { instructions?: string | null } } = {}) => {
        if (openResult) return openResult();
        opened.push({ ...req, ...extra });
        const termId = req.sessionId ?? `new-${opened.length}`;
        open.add(termId);
        runningOf.set(req.featureId, termId);
        return { ok: true, termId, alreadyOpen: false };
      },
      runningCoordinator: (featureId: number) => {
        const id = runningOf.get(featureId);
        return id && open.has(id) ? sessions.get(id) ?? ({ id } as never) : null;
      },
      featureTerminalCount: (featureId: number) => terminalsOf.get(featureId) ?? 0,
    } as never,
    guard: { check: (id) => guardCheck(id), recheckAfter: () => () => true },
    deliver: async (termId, text) => (delivered.push([termId, text]), deliverResult),
    activity: (id) => activities.get(id) ?? null,
    kill: (termId) => void killed.push(termId),
    screenNeedsUser: () => false,
    lastReply: (id) => replies.get(id) ?? null,
    epicRows: () => rows,
    epicHistory: () => history,
    submit: async () => "sent" as const,
    notify: () => void notified++,
    syncEpic: (id) => void events.push(`sync:${id}:${features.list().length}`),
    refreshEpic: (id, except) => refreshEpic(id, except),
    log: (m) => logs.push(m),
  });
  const base = { v: 1 as const, epicId: epic.id, from: null };
  const row = (o: Partial<EpicFeatureRow>): EpicFeatureRow => ({
    id: 0, name: "f", status: "active", archivedAt: null, summaryAt: 5, summary: "s", blockers: [], decisions: [], openQuestions: [], ...o,
  });
  return { handle, base, epic, solo, features, epics, featureService, epicService, frontend, backend, elsewhere, notified: () => notified, setRows: (r: EpicFeatureRow[]) => (rows = r), row,
    setHistory: (h: EpicHistoryEntry[]) => (history = h),
    logs, events, setRefreshEpic: (f: typeof refreshEpic) => (refreshEpic = f), tickets, sessions, open, activities, replies, killed, refreshed,
    opened, runningOf, terminalsOf, delivered,
    setOpenResult: (f: typeof openResult) => (openResult = f), setGuard: (f: typeof guardCheck) => (guardCheck = f), setDeliver: (r: DeliverResult) => (deliverResult = r) };
}

const err = (r: ControlResult) => (r.ok ? "" : r.error);

describe("create_feature from an epic session (design 2026-11-01)", () => {
  it("creates the feature in the epic with its brief, and does not open a coordinator", async () => {
    const { handle, base, features, epic, frontend, backend, notified } = await setup();
    const r = await handle({ ...base, op: "create_feature", name: " checkout ", repos: ["frontend", backend], brief: " 做结账 " });
    expect(r).toMatchObject({ ok: true, value: { name: "checkout", repos: ["frontend", "backend"] } });
    const id = (r as { value: { id: number } }).value.id;
    const f = features.get(id)!;
    expect(f).toMatchObject({ name: "checkout", epicId: epic.id, brief: "做结账", briefSentAt: null });
    expect(f.repos.map((x) => x.repoPath)).toEqual([frontend, backend]);
    expect(notified()).toBe(1);
  });

  it("re-renders the epic handoff once the feature exists, and refreshes the others without the new one", async () => {
    const { handle, base, epic, features, events } = await setup();
    const r = await handle({ ...base, op: "create_feature", name: "checkout", repos: ["frontend"], brief: "b" });
    const id = (r as { value: { id: number } }).value.id;
    expect(features.list()).toHaveLength(1);
    expect(events).toEqual([`sync:${epic.id}:1`, `refresh:${epic.id}:${id}`]);
  });

  it("does not let a failing refresh fail create_feature, and refreshes nothing when it is refused", async () => {
    const { handle, base, events, logs, setRefreshEpic } = await setup();
    expect((await handle({ ...base, op: "create_feature", name: "a/b", repos: ["frontend"], brief: "b" })).ok).toBe(false);
    expect(events).toEqual([]);
    setRefreshEpic(() => {
      throw new Error("boom");
    });
    expect(await handle({ ...base, op: "create_feature", name: "checkout", repos: ["frontend"], brief: "b" })).toMatchObject({ ok: true });
    expect(logs.join("\n")).toContain("checkout");
  });

  it("lets repos be left out when the epic has one repo, and requires them when it has several", async () => {
    const { handle, base, solo } = await setup();
    const many = await handle({ ...base, op: "create_feature", name: "x", brief: "b" });
    expect(many.ok).toBe(false);
    expect(err(many)).toContain("frontend, backend");
    const one = await handle({ ...base, epicId: solo.id, op: "create_feature", name: "x", brief: "b" });
    expect(one).toMatchObject({ ok: true, value: { repos: ["frontend"] } });
  });

  it("refuses bad input and creates nothing", async () => {
    const { handle, base, features, featureService, elsewhere } = await setup();
    await featureService.create({ name: "taken", repoPaths: [elsewhere] });
    const archived = await featureService.create({ name: "old", repoPaths: [elsewhere] });
    await featureService.archive(archived.id, { terminalsOpen: () => false });
    const before = features.list({ includeArchived: true }).length;
    const bad: Record<string, unknown>[] = [
      { name: "taken", brief: "b" }, { name: " TAKEN ", brief: "b" }, { name: "old", brief: "b" },
      { name: "", brief: "b" }, { name: "   ", brief: "b" }, { name: "a/b", brief: "b" }, { name: "a\\b", brief: "b" }, { name: "..", brief: "b" },
      { name: "x".repeat(101), brief: "b" },
      { name: "ok", repos: ["elsewhere"], brief: "b" }, { name: "ok", repos: [elsewhere], brief: "b" }, { name: "ok", repos: ["nope"], brief: "b" },
      { name: "ok", repos: ["frontend"], brief: "x".repeat(BRIEF_LIMIT + 1) }, { name: "ok", repos: ["frontend"], brief: "  " },
    ];
    for (const b of bad) {
      expect((await handle({ ...base, op: "create_feature", ...b } as never)).ok, JSON.stringify(b).slice(0, 80)).toBe(false);
    }
    expect(features.list({ includeArchived: true })).toHaveLength(before);
    // 刚好 4000 字符可以。
    expect((await handle({ ...base, op: "create_feature", name: "fits", repos: ["frontend"], brief: "x".repeat(BRIEF_LIMIT) })).ok).toBe(true);
  });

  it("refuses everything for an archived or unknown epic", async () => {
    const { handle, base, epic, epicService } = await setup();
    await epicService.archive(epic.id, { terminalsOpen: () => false, featureTerminalsOpen: () => false });
    const ops: Partial<EpicControlRequest>[] = [{ op: "list_features" }, { op: "list_repos" }, { op: "create_feature", name: "x", repos: ["frontend"], brief: "b" }];
    for (const op of ops) {
      expect(await handle({ ...base, ...op } as EpicControlRequest)).toMatchObject({ ok: false });
    }
    expect(await handle({ ...base, epicId: 999, op: "list_features" })).toMatchObject({ ok: false });
  });

  it("lists the epic's repos and its features with summaries cut to the limit", async () => {
    const { handle, base, setRows, row, frontend, backend } = await setup();
    expect(await handle({ ...base, op: "list_repos" })).toEqual({
      v: 1, ok: true, value: [{ name: "frontend", path: frontend }, { name: "backend", path: backend }],
    });
    setRows([row({ id: 1, summary: "y".repeat(SUMMARY_LIMIT + 50) }), row({ id: 2, status: "archived", archivedAt: 9, summary: null })]);
    const r = await handle({ ...base, op: "list_features" });
    const v = (r as { value: EpicFeatureRow[] }).value;
    expect(v.map((x) => [x.id, x.status])).toEqual([[1, "active"], [2, "archived"]]);
    expect(v[0].summary).toHaveLength(SUMMARY_LIMIT);
    expect(v[1].summary).toBeNull();
  });
});

describe("set_epic_plan from an epic session (plan 16)", () => {
  it("set_epic_plan stores the plan and resyncs", async () => {
    const { handle, base, epics, epic, events } = await setup();
    const r = await handle({ ...base, op: "set_epic_plan", plan: "  先做支付，再做退款\n" });
    expect(r).toMatchObject({ ok: true, value: { note: expect.any(String) } });
    expect(epics.get(epic.id)).toMatchObject({ plan: "先做支付，再做退款", planAt: expect.any(Number) });
    expect(events).toEqual([`sync:${epic.id}:0`]);
    // 改了规划：整份换掉，再同步一次。
    await handle({ ...base, op: "set_epic_plan", plan: "改成先做退款" });
    expect(epics.get(epic.id)?.plan).toBe("改成先做退款");
    expect(events).toEqual([`sync:${epic.id}:0`, `sync:${epic.id}:0`]);
  });

  it("refuses an empty or too long plan, and an archived epic, and stores nothing", async () => {
    const { handle, base, epics, epic, solo, epicService, events } = await setup();
    for (const plan of ["   ", "x".repeat(EPIC_PLAN_MAX_CHARS + 1)]) {
      const r = await handle({ ...base, op: "set_epic_plan", plan });
      expect(err(r)).toContain(String(EPIC_PLAN_MAX_CHARS));
    }
    expect(epics.get(epic.id)?.plan).toBeNull();
    await epicService.archive(solo.id, { terminalsOpen: () => false, featureTerminalsOpen: () => false });
    expect(await handle({ ...base, epicId: solo.id, op: "set_epic_plan", plan: "p" })).toMatchObject({ ok: false });
    expect(epics.get(solo.id)?.plan).toBeNull();
    expect(events).toEqual([]);
  });
});

describe("epic_context from a feature coordinator", () => {
  it("returns the epic name and the other features, not the caller", async () => {
    const { handle, epic, features, featureService, elsewhere, setRows, row } = await setup();
    const mine = await featureService.create({ name: "mine", repoPaths: [elsewhere] });
    features.setEpic(mine.id, epic.id);
    setRows([row({ id: mine.id, name: "mine" }), row({ id: 77, name: "sibling", summary: "z".repeat(SUMMARY_LIMIT + 1) })]);
    const r = await handle({ v: 1, featureId: mine.id, from: null, op: "epic_context" });
    expect(r).toMatchObject({ ok: true, value: { epic: "shop", features: [{ id: 77, name: "sibling" }] } });
    const v = (r as { value: { features: EpicFeatureRow[] } }).value;
    expect(v.features).toHaveLength(1);
    expect(v.features[0].summary).toHaveLength(SUMMARY_LIMIT);
  });

  it("returns the epic's past decisions as history, and an empty history without any", async () => {
    const { handle, epic, features, featureService, elsewhere, setHistory } = await setup();
    const mine = await featureService.create({ name: "mine", repoPaths: [elsewhere] });
    features.setEpic(mine.id, epic.id);
    const empty = await handle({ v: 1, featureId: mine.id, from: null, op: "epic_context" });
    expect(empty).toMatchObject({ ok: true, value: { history: "" } });
    setHistory([{
      id: 1, epicId: epic.id, featureId: null, trigger: "weekly", createdAt: new Date(2026, 10, 2).getTime(), coversFrom: 0, coversUntil: 0,
      payload: { summary: "结账上线", decisions: [{ what: "金额用分存", why: "避免浮点误差" }] },
    }]);
    const r = await handle({ v: 1, featureId: mine.id, from: null, op: "epic_context" });
    const history = (r as { value: { history: string } }).value.history;
    for (const s of ["2026-11-02", "结账上线", "金额用分存", "避免浮点误差"]) expect(history).toContain(s);
  });

  it("errors for a feature outside any epic, and for an archived epic", async () => {
    const { handle, featureService, elsewhere, features, epic, epicService } = await setup();
    const lone = await featureService.create({ name: "lone", repoPaths: [elsewhere] });
    expect(await handle({ v: 1, featureId: lone.id, from: null, op: "epic_context" })).toMatchObject({ ok: false });
    features.setEpic(lone.id, epic.id);
    await epicService.archive(epic.id, { terminalsOpen: () => false, featureTerminalsOpen: () => false });
    features.unarchive(lone.id);
    expect(await handle({ v: 1, featureId: lone.id, from: null, op: "epic_context" })).toMatchObject({ ok: false });
  });
});

describe("sessions of an epic's features (task 11)", () => {
  /**
   * epic「shop」下有 checkout（总控 fc，ticket EP-1 的 session t1）和已归档的 old（总控 oc）；epic 外有 lone（总控 lc）。
   * epic 自己的 session 是 es。全部开着终端、停下来在等输入。
   */
  async function withSessions() {
    const t = await setup();
    const checkout = await t.featureService.create({ name: "checkout", repoPaths: [t.elsewhere], epicId: t.epic.id });
    const old = await t.featureService.create({ name: "old", repoPaths: [t.elsewhere], epicId: t.epic.id });
    const lone = await t.featureService.create({ name: "lone", repoPaths: [t.elsewhere] });
    t.tickets.insert({ key: "EP-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null, featureId: checkout.id });
    const add = (id: string, o: { ticketKey?: string; featureId?: number; coordinator?: boolean; epicId?: number }) => {
      t.sessions.insertIfAbsent({ id, ticketKey: o.ticketKey ?? null, cwd: "/w", origin: "butler", createdAt: 1, featureId: o.featureId ?? null, coordinator: o.coordinator, epicId: o.epicId ?? null });
      t.sessions.setWaiting(id, true, 5);
      t.open.add(id);
      t.activities.set(id, { sessionId: id, kind: "waiting", detail: null, background: false, startedAt: null, lastOutputAt: 1, stuck: null, reason: null, action: null, lastOutput: [] });
    };
    add("fc", { featureId: checkout.id });
    add("t1", { ticketKey: "EP-1" });
    add("oc", { featureId: old.id });
    add("lc", { featureId: lone.id });
    add("es", { epicId: t.epic.id });
    await t.featureService.archive(old.id, { terminalsOpen: () => false });
    const end = (session: string) => t.handle({ ...t.base, from: "es", op: "end_session", session, reason: "feature 做完了" });
    return { ...t, checkout, end };
  }

  it("lists the sessions of the epic's active features with their feature, ticket and last reply", async () => {
    const { handle, base, replies } = await withSessions();
    replies.set("t1", "PR 合并了");
    const r = await handle({ ...base, op: "list_sessions" });
    if (!r.ok) throw new Error(r.error);
    const rows = r.value as { id: string; feature: string; ticket: string | null; running: boolean; last_reply: string | null }[];
    expect(rows.map((x) => [x.id, x.feature, x.ticket, x.running, x.last_reply])).toEqual([
      ["fc", "checkout", null, true, null],
      ["t1", "checkout", "EP-1", true, "PR 合并了"],
    ]);
  });

  it("reads the activity of a session in its features only", async () => {
    const { handle, base } = await withSessions();
    expect(await handle({ ...base, op: "session_activity", session: "t1" })).toMatchObject({ ok: true, value: { sessionId: "t1", kind: "waiting", last_reply: null } });
    for (const id of ["lc", "oc", "es"]) {
      expect(await handle({ ...base, op: "session_activity", session: id }), id).toMatchObject({ ok: false, error: expect.stringContaining(id) });
    }
  });

  it("ends the coordinator or a ticket session of one of its features, and nothing outside them", async () => {
    const { end, killed } = await withSessions();
    for (const id of ["lc", "oc", "es"]) {
      expect(await end(id), id).toMatchObject({ ok: false, error: expect.stringContaining(`找不到 session ${id}`) });
    }
    expect(killed).toEqual([]);
    expect(await end("fc")).toEqual({ v: 1, ok: true, value: { ended: true } });
    expect(await end("t1")).toEqual({ v: 1, ok: true, value: { ended: true } });
    expect(killed).toEqual(["fc", "t1"]);
  });

  it("refreshes the coordinator or a ticket session of one of its features, and nothing outside them (plan 16)", async () => {
    const { handle, base, refreshed } = await withSessions();
    const refresh = (session: string) => handle({ ...base, from: "es", op: "refresh_session", session });
    for (const id of ["lc", "oc", "es"]) {
      expect(await refresh(id), id).toMatchObject({ ok: false, error: expect.stringContaining(`找不到 session ${id}`) });
    }
    expect(refreshed).toEqual([]);
    expect(await refresh("fc")).toEqual({ v: 1, ok: true, value: { started: true } });
    expect(await refresh("t1")).toEqual({ v: 1, ok: true, value: { started: true } });
    expect(refreshed).toEqual(["fc", "t1"]);
  });

  it("refuses everything for an archived epic", async () => {
    const { handle, base, epic, epicService, killed } = await withSessions();
    await epicService.archive(epic.id, { terminalsOpen: () => false, featureTerminalsOpen: () => false });
    for (const op of [{ op: "list_sessions" }, { op: "session_activity", session: "fc" }, { op: "end_session", session: "fc", reason: "r" }]) {
      expect(await handle({ ...base, ...op } as EpicControlRequest)).toMatchObject({ ok: false });
    }
    expect(killed).toEqual([]);
  });
});

describe("start_feature from an epic session (BTL-190 4)", () => {
  /** epic「shop」下有 checkout、cart（有 brief）和 bare（没有 brief），已归档的 old；epic 外有 lone。 */
  async function withFeatures() {
    const t = await setup();
    const make = (name: string, o: { brief?: string; epicId?: number | null } = {}) =>
      t.featureService.create({ name, repoPaths: [t.elsewhere], epicId: o.epicId === undefined ? t.epic.id : o.epicId ?? undefined, ...(o.brief !== undefined && { brief: o.brief }) });
    const checkout = await make("checkout", { brief: "做结账" });
    const cart = await make("cart", { brief: "做购物车" });
    const bare = await make("bare");
    const old = await make("old", { brief: "b" });
    await t.featureService.archive(old.id, { terminalsOpen: () => false });
    const lone = await make("lone", { brief: "b", epicId: null });
    const start = (feature: string, instructions?: string) =>
      t.handle({ ...t.base, from: "es", op: "start_feature", feature, ...(instructions !== undefined && { instructions }) });
    /** 让 feature 有一个跑着的总控。 */
    const running = (featureId: number, id: string) => {
      t.sessions.insertIfAbsent({ id, ticketKey: null, cwd: "/w", origin: "butler", createdAt: 1, featureId, coordinator: true });
      t.open.add(id);
      t.runningOf.set(featureId, id);
    };
    return { ...t, checkout, cart, bare, old, lone, start, running, make };
  }

  it("opens a new coordinator by name or id and hands it the plan and the instructions", async () => {
    const { start, checkout, cart, opened, notified } = await withFeatures();
    const r = await start(" CHECKOUT ", "先做 API");
    expect(r).toMatchObject({ ok: true, value: { feature: "checkout", id: checkout.id, sessionId: "new-1", started: "opened" } });
    expect(opened).toEqual([{ featureId: checkout.id, start: { instructions: "先做 API" } }]);
    expect(notified()).toBe(1);
    expect(await start(String(cart.id))).toMatchObject({ ok: true, value: { feature: "cart", started: "opened" } });
    expect(opened[1]).toEqual({ featureId: cart.id, start: { instructions: null } });
  });

  it("resumes the latest visible coordinator instead of opening a new one", async () => {
    const { start, checkout, sessions, opened } = await withFeatures();
    const add = (id: string, at: number, o: { fixesSession?: string } = {}) =>
      sessions.insertIfAbsent({ id, ticketKey: null, cwd: "/w", origin: "butler", createdAt: at, featureId: checkout.id, coordinator: !o.fixesSession, fixesSession: o.fixesSession ?? null });
    add("c-old", 1);
    add("c-new", 2);
    add("c-hidden", 3);
    sessions.dismiss("c-hidden");
    add("fix-1", 4, { fixesSession: "t1" });
    const r = await start("checkout");
    expect(r).toMatchObject({ ok: true, value: { sessionId: "c-new", started: "resumed" } });
    expect(opened).toEqual([{ featureId: checkout.id, sessionId: "c-new", start: { instructions: null } }]);
  });

  it("refuses an unknown, archived or other epic's feature, listing the epic's features", async () => {
    const { start, opened } = await withFeatures();
    for (const name of ["nope", "old", "lone", "999"]) {
      const r = await start(name);
      expect(r.ok, name).toBe(false);
      expect(err(r), name).toContain("checkout");
      expect(err(r), name).toContain("cart");
    }
    expect(opened).toEqual([]);
  });

  it("refuses a feature with no brief unless the epic says what to do", async () => {
    const { start, bare, opened } = await withFeatures();
    const r = await start("bare");
    expect(r.ok).toBe(false);
    expect(err(r)).toContain("instructions");
    expect(opened).toEqual([]);
    expect(await start("bare", "先读代码，规划好再建 ticket")).toMatchObject({ ok: true, value: { started: "opened" } });
    expect(opened).toEqual([{ featureId: bare.id, start: { instructions: "先读代码，规划好再建 ticket" } }]);
  });

  it(`runs at most ${MAX_RUNNING_FEATURES_PER_EPIC} feature coordinators per epic`, async () => {
    const { start, make, running, checkout, cart, opened, open } = await withFeatures();
    const more = [await make("a", { brief: "b" }), await make("b", { brief: "b" }), await make("c", { brief: "b" })];
    running(checkout.id, "fc");
    running(more[0].id, "ac");
    running(more[1].id, "bc");
    // 已经开着的那个不算新开：照样通过。
    expect(await start("checkout")).toMatchObject({ ok: true, value: { started: "already_running" } });
    expect((await start("c")).ok).toBe(true);
    const r = await start("cart");
    expect(r.ok).toBe(false);
    expect(err(r)).toContain(String(MAX_RUNNING_FEATURES_PER_EPIC));
    expect(err(r)).toContain("checkout");
    expect(opened.map((o) => o.featureId)).toEqual([more[2].id]);
    // 关掉一个总控就又能开。
    open.delete("fc");
    expect(await start("cart")).toMatchObject({ ok: true, value: { feature: "cart", started: "opened" } });
    expect(opened.map((o) => o.featureId)).toEqual([more[2].id, cart.id]);
  });

  it(`refuses when the feature already has ${MAX_RUNNING_PER_FEATURE} terminals open`, async () => {
    const { start, checkout, terminalsOf, opened } = await withFeatures();
    terminalsOf.set(checkout.id, MAX_RUNNING_PER_FEATURE);
    const r = await start("checkout");
    expect(r.ok).toBe(false);
    expect(err(r)).toContain(String(MAX_RUNNING_PER_FEATURE));
    expect(opened).toEqual([]);
  });

  it("does not open a second coordinator: says it is running, or hands it the instructions", async () => {
    const { start, checkout, running, opened, delivered } = await withFeatures();
    running(checkout.id, "fc");
    expect(await start("checkout")).toMatchObject({ ok: true, value: { feature: "checkout", sessionId: "fc", started: "already_running" } });
    expect(delivered).toEqual([]);
    expect(await start("checkout", "顺便把退款也做了")).toMatchObject({ ok: true, value: { sessionId: "fc", started: "sent" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(delivered).toHaveLength(1);
    expect(delivered[0][0]).toBe("fc");
    expect(delivered[0][1]).toContain("顺便把退款也做了");
    expect(opened).toEqual([]);
  });

  it("refuses to hand instructions to a coordinator that cannot take them now, saying why", async () => {
    const { start, checkout, running, setGuard, delivered } = await withFeatures();
    running(checkout.id, "fc");
    setGuard(() => ({ ok: false, block: "busy" }));
    const r = await start("checkout", "顺便把退款也做了");
    expect(r.ok).toBe(false);
    expect(err(r)).toContain("checkout");
    expect(delivered).toEqual([]);
  });

  it("logs instructions that were not delivered", async () => {
    const { start, checkout, running, setDeliver, logs } = await withFeatures();
    running(checkout.id, "fc");
    setDeliver("timeout");
    await start("checkout", "顺便把退款也做了");
    await new Promise((r) => setTimeout(r, 0));
    expect(logs.join("\n")).toContain("timeout");
  });

  it("starts a feature once when asked twice at the same time", async () => {
    const { start, opened } = await withFeatures();
    const [a, b] = await Promise.all([start("checkout"), start("checkout")]);
    expect(opened).toHaveLength(1);
    expect([a, b].filter((r) => r.ok && (r.value as { started: string }).started === "opened")).toHaveLength(1);
    expect([a, b].some((r) => r.ok && (r.value as { started: string }).started === "starting")).toBe(true);
  });

  it("says why when the coordinator cannot be opened", async () => {
    const { start, setOpenResult } = await withFeatures();
    setOpenResult(() => ({ ok: false, reason: "claude_missing" }));
    expect((await start("checkout")).ok).toBe(false);
  });

  it("create_feature with start opens the new feature's coordinator right away", async () => {
    const { handle, base, opened, features } = await setup();
    const r = await handle({ ...base, from: "es", op: "create_feature", name: "checkout", repos: ["frontend"], brief: "做结账", start: true });
    expect(r).toMatchObject({ ok: true, value: { name: "checkout", started: "opened", sessionId: "new-1" } });
    const id = (r as { value: { id: number } }).value.id;
    expect(opened).toEqual([{ featureId: id, start: { instructions: null } }]);
    expect(features.get(id)?.brief).toBe("做结账");
  });

  it("create_feature with start still creates the feature when the coordinator cannot be opened", async () => {
    const { handle, base, setOpenResult, features } = await setup();
    setOpenResult(() => ({ ok: false, reason: "claude_missing" }));
    const r = await handle({ ...base, from: "es", op: "create_feature", name: "checkout", repos: ["frontend"], brief: "做结账", start: true });
    expect(r).toMatchObject({ ok: true, value: { name: "checkout", started: false } });
    expect(features.list().map((f) => f.name)).toEqual(["checkout"]);
  });
});
