import { describe, expect, it } from "vitest";
import type { SessionActivity } from "../../shared/activity";
import type { RefreshRefusal, Session } from "../../shared/types";
import { SessionsRepo } from "../db/sessions-repo";
import { memDb } from "../test-utils";
import { HIDDEN_KEEP_MS, MANUAL_IDLE_MS, PURGE_EVERY_MS, SessionCleanup, type SessionCleanupDeps, working } from "./session-cleanup";
import type { CloseTrigger } from "./session-refresher";

const MIN = 60_000;
const NOW = 10_000_000_000;

const base = (o: Partial<Session> = {}): Session => ({
  id: "x", ticketKey: null, cwd: "/r", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null,
  waitingForInput: true, replacedBy: null, dismissed: false, createdAt: 0, repoId: null, coordinator: false, spawnedBy: null,
  featureId: null, fixesSession: null, epicId: null, model: null, ...o,
});

const act = (o: Partial<SessionActivity> = {}): SessionActivity => ({
  sessionId: "x", kind: "waiting", detail: null, background: false, startedAt: null, lastOutputAt: null,
  stuck: null, reason: null, action: null, lastOutput: [], ...o,
});

interface Term {
  termId: string;
  head: Session;
  activity: SessionActivity | null;
  typedAt: number;
  openedAt: number;
}

function setup(o: { minutes?: number } = {}) {
  const state = {
    now: NOW,
    minutes: o.minutes ?? 180,
    /** precheckClose 的回答（按 head id；不在里面的是 null）。 */
    refusals: {} as Record<string, RefreshRefusal>,
    askUser: new Set<string>(),
    /** 在等 Butler 递合并或 CI 通知的 head。 */
    waiting: new Set<string>(),
    hidden: [] as Session[],
    /** 其他链上的 id → head。 */
    heads: {} as Record<string, Session>,
    open: new Set<string>(),
    chains: {} as Record<string, string[]>,
    tickets: {} as Record<number, string[]>,
    features: {} as Record<number, number[]>,
    tailFails: false,
  };
  const terms: Term[] = [];
  const closes: Array<{ id: string; trigger: CloseTrigger }> = [];
  const prechecks: Array<{ id: string; trigger: CloseTrigger }> = [];
  const deleted: string[] = [];
  const tails: string[] = [];
  const logs: string[] = [];
  let notified = 0;
  const deps: SessionCleanupDeps = {
    idleMinutes: () => state.minutes,
    terminals: () => terms.map((t) => ({ termId: t.termId, head: t.head })),
    activity: (id) => terms.find((t) => t.head.id === id)?.activity ?? null,
    lastUserInputAt: (termId) => terms.find((t) => t.termId === termId)?.typedAt ?? 0,
    openedAt: (termId) => terms.find((t) => t.termId === termId)?.openedAt ?? 0,
    ticketsOfFeature: (f) => state.tickets[f] ?? [],
    featuresOfEpic: (e) => state.features[e] ?? [],
    askUserPending: (id) => state.askUser.has(id),
    waitingOnButler: (id) => state.waiting.has(id),
    refresher: {
      precheckClose: (id, trigger) => {
        prechecks.push({ id, trigger });
        return state.refusals[id] ?? null;
      },
      close: async (id, trigger) => {
        closes.push({ id, trigger });
        return "done";
      },
    },
    hiddenBefore: (before) => state.hidden.filter((s) => (s.lastActivityAt ?? 0) < before),
    head: (id) => state.heads[id] ?? terms.find((t) => t.head.id === id)?.head ?? state.hidden.find((s) => s.id === id) ?? null,
    terminalOpen: (id) => state.open.has(id),
    deleteChain: (id) => {
      const ids = state.chains[id] ?? [id];
      deleted.push(...ids);
      state.hidden = state.hidden.filter((s) => s.id !== id);
      return ids;
    },
    removeTail: (id) => {
      if (state.tailFails) throw new Error("EACCES");
      tails.push(id);
    },
    notify: () => void notified++,
    now: () => state.now,
    log: (m) => void logs.push(m),
  };
  const c = new SessionCleanup(deps);
  /** 一个开着的终端：默认是 4 小时前停下的 ticket session。 */
  const add = (id: string, o: { session?: Partial<Session>; activity?: SessionActivity | null; termId?: string; typedAt?: number; openedAt?: number } = {}) => {
    const t: Term = {
      termId: o.termId ?? id, head: base({ ticketKey: "BTL-1", lastActivityAt: NOW - 240 * MIN, ...o.session, id }),
      activity: o.activity === undefined ? act({ sessionId: id }) : o.activity, typedAt: o.typedAt ?? 0, openedAt: o.openedAt ?? NOW - 300 * MIN,
    };
    terms.push(t);
    return t;
  };
  return { c, state, terms, closes, prechecks, deleted, tails, logs, add, notified: () => notified };
}

describe("working (BTL-190 item 8)", () => {
  it("counts thinking, tools and background commands as working, and an unknown activity too", () => {
    expect(working(null)).toBe(true);
    expect(working(act({ kind: "thinking" }))).toBe(true);
    expect(working(act({ kind: "test" }))).toBe(true);
    expect(working(act({ kind: "waiting", background: true }))).toBe(true);
    for (const kind of ["waiting", "idle", "approval"] as const) expect(working(act({ kind }))).toBe(false);
  });
});

describe("SessionCleanup idle close (BTL-190 item 8)", () => {
  it("closes a session stopped longer than the setting, automatically", async () => {
    const t = setup({ minutes: 180 });
    t.add("old");
    t.add("recent", { session: { lastActivityAt: NOW - 179 * MIN } });
    t.c.tick();
    expect(t.closes).toEqual([{ id: "old", trigger: "auto" }]);
    expect(t.prechecks.every((p) => p.trigger === "auto")).toBe(true);
    t.state.minutes = 30;
    t.closes.length = 0;
    t.c.tick();
    expect(t.closes.map((x) => x.id)).toEqual(["old", "recent"]);
  });

  it("leaves a session waiting on a merge-queue or CI notice open: the notice only reaches an open terminal", () => {
    const t = setup();
    t.add("queued");
    t.add("free");
    t.state.waiting.add("queued");
    t.c.tick();
    expect(t.closes.map((x) => x.id)).toEqual(["free"]);
  });

  it("does not count time asleep as idle: after waking, the idle clock starts again", () => {
    const t = setup();
    t.add("old");
    t.c.resumed();
    t.c.tick();
    expect(t.closes).toEqual([]);
    t.state.now += 180 * MIN;
    t.c.tick();
    expect(t.closes.map((x) => x.id)).toEqual(["old"]);
  });

  it("does nothing automatically at 0", () => {
    const t = setup({ minutes: 0 });
    t.add("old");
    t.c.tick();
    expect(t.closes).toEqual([]);
    expect(t.prechecks).toEqual([]);
  });

  it("counts idle time from the latest of the stop, the last output, the user's typing and the terminal opening", () => {
    const at = NOW - 60 * MIN;
    const cases: Array<Parameters<ReturnType<typeof setup>["add"]>[1]> = [
      { session: { lastActivityAt: at } },
      { activity: act({ lastOutputAt: at }) },
      { typedAt: at },
      { openedAt: at },
    ];
    for (const o of cases) {
      const t = setup({ minutes: 120 });
      t.add("s1", o);
      t.c.tick();
      expect(t.closes).toEqual([]);
      t.state.now += 61 * MIN;
      t.c.tick();
      expect(t.closes.map((x) => x.id)).toEqual(["s1"]);
    }
  });

  it("leaves sessions the refresher refuses (needs you, draft, background, cooldown, fix sessions …) and ones with a pending ask_user", () => {
    const t = setup();
    t.add("needs-you");
    t.add("asking");
    t.add("ok");
    t.state.refusals["needs-you"] = "busy";
    t.state.askUser.add("asking");
    t.c.tick();
    expect(t.closes.map((x) => x.id)).toEqual(["ok"]);
  });

  it("does not close a ticket coordinator while a session of its ticket is working", () => {
    const t = setup();
    t.add("coord", { session: { coordinator: true } });
    const child = t.add("child", { activity: act({ kind: "edit" }) });
    t.add("other-ticket", { session: { ticketKey: "BTL-2" }, activity: act({ kind: "edit" }) });
    // 子 session 自己关不关由换新那边看（这里的假换新都放行）；总控等着。
    t.c.tick();
    expect(t.closes.map((x) => x.id)).not.toContain("coord");
    child.activity = act({ kind: "waiting" });
    t.closes.length = 0;
    t.c.tick();
    expect(t.closes.map((x) => x.id)).toContain("coord");
  });

  it("counts a child whose activity is not known yet as working", () => {
    const t = setup();
    t.add("coord", { session: { coordinator: true } });
    t.add("child", { activity: null });
    t.c.tick();
    expect(t.closes.map((x) => x.id)).not.toContain("coord");
  });

  it("does not close a feature coordinator while one of its tickets' sessions or its fix sessions is working", () => {
    const t = setup();
    t.state.tickets[5] = ["BTL-1"];
    t.add("feat", { session: { ticketKey: null, featureId: 5 } });
    const child = t.add("child", { activity: act({ kind: "thinking" }) });
    const fix = t.add("fix", { session: { ticketKey: null, featureId: 5, fixesSession: "x" }, activity: act({ kind: "waiting" }) });
    t.add("elsewhere", { session: { ticketKey: "BTL-9" }, activity: act({ kind: "thinking" }) });
    t.c.tick();
    expect(t.closes.map((x) => x.id)).not.toContain("feat");
    child.activity = act({ kind: "waiting" });
    fix.activity = act({ kind: "waiting", background: true });
    t.closes.length = 0;
    t.c.tick();
    expect(t.closes.map((x) => x.id)).not.toContain("feat");
    fix.activity = act({ kind: "waiting" });
    t.closes.length = 0;
    t.c.tick();
    expect(t.closes.map((x) => x.id)).toContain("feat");
  });

  it("does not close an epic session while a session of its features is working", () => {
    const t = setup();
    t.state.features[3] = [5];
    t.state.tickets[5] = ["BTL-1"];
    t.add("epic", { session: { ticketKey: null, epicId: 3 } });
    const feat = t.add("feat", { session: { ticketKey: null, featureId: 5 }, activity: act({ kind: "thinking" }) });
    t.add("elsewhere", { session: { ticketKey: null, featureId: 6 }, activity: act({ kind: "thinking" }) });
    t.c.tick();
    expect(t.closes.map((x) => x.id)).not.toContain("epic");
    feat.activity = act({ kind: "waiting" });
    const ticket = t.add("ticket", { activity: act({ kind: "edit" }) });
    t.closes.length = 0;
    t.c.tick();
    expect(t.closes.map((x) => x.id)).not.toContain("epic");
    ticket.activity = act({ kind: "idle" });
    t.closes.length = 0;
    t.c.tick();
    expect(t.closes.map((x) => x.id)).toContain("epic");
  });

  it("a plain ticket session does not wait for other sessions of its ticket", () => {
    const t = setup();
    t.add("s1");
    t.add("s2", { activity: act({ kind: "edit" }) });
    t.c.tick();
    expect(t.closes.map((x) => x.id)).toContain("s1");
  });

  it("the button closes only the given sessions, ignores the setting, and needs five minutes stopped", () => {
    const t = setup({ minutes: 0 });
    t.add("a", { session: { lastActivityAt: NOW - 10 * MIN } });
    t.add("b", { session: { lastActivityAt: NOW - 10 * MIN } });
    t.add("just-used", { session: { lastActivityAt: NOW - 2 * MIN } });
    t.add("not-here");
    // 旧的链上 id 也认（renderer 手里的可能还是 /clear 之前的 id）。
    t.state.heads["a-old"] = t.terms[0].head;
    expect(MANUAL_IDLE_MS).toBe(5 * MIN);
    expect(t.c.closeIdleNow(["a-old", "b", "just-used"])).toBe(2);
    expect(t.closes).toEqual([{ id: "a", trigger: "manual" }, { id: "b", trigger: "manual" }]);
  });
});

describe("SessionCleanup deleting hidden sessions (BTL-190 item 8)", () => {
  const hidden = (id: string, lastActivityAt: number) => base({ id, dismissed: true, lastActivityAt });

  it("deletes sessions hidden for 14 days on the first tick and then once an hour, with each chain id's tail", () => {
    const t = setup({ minutes: 0 });
    t.state.hidden = [hidden("old", NOW - HIDDEN_KEEP_MS - 1), hidden("new", NOW - HIDDEN_KEEP_MS + MIN)];
    t.state.chains["old"] = ["old-a", "old"];
    t.c.tick();
    expect(t.deleted).toEqual(["old-a", "old"]);
    expect(t.tails).toEqual(["old-a", "old"]);
    expect(t.notified()).toBe(1);
    // 一小时之内不再查。
    t.state.now += 2 * MIN;
    t.c.tick();
    expect(t.deleted).toEqual(["old-a", "old"]);
    t.state.now += PURGE_EVERY_MS;
    t.c.tick();
    expect(t.deleted).toEqual(["old-a", "old", "new"]);
    expect(t.notified()).toBe(2);
  });

  it("skips sessions whose terminal is open and does not notify when nothing was deleted", () => {
    const t = setup({ minutes: 0 });
    t.state.hidden = [hidden("old", 0)];
    t.state.open.add("old");
    expect(t.c.purgeHidden()).toBe(0);
    expect(t.deleted).toEqual([]);
    expect(t.notified()).toBe(0);
  });

  it("goes on when removing a tail fails", () => {
    const t = setup({ minutes: 0 });
    t.state.hidden = [hidden("a", 0), hidden("b", 0)];
    t.state.tailFails = true;
    expect(t.c.purgeHidden()).toBe(2);
    expect(t.deleted).toEqual(["a", "b"]);
    expect(t.logs.filter((l) => l.includes("refresh tail"))).toHaveLength(2);
  });

  it("the delete-all button deletes only hidden heads whose terminal is closed", () => {
    const t = setup({ minutes: 0 });
    t.state.hidden = [hidden("h1", NOW), hidden("h2", NOW), hidden("h-open", NOW)];
    t.state.open.add("h-open");
    t.add("shown");
    // 被 /clear 替换过的旧 id：按它删会删掉别人的链，不动。
    t.state.heads["h1-old"] = t.state.hidden[0];
    expect(t.c.deleteHidden(["h1", "h2", "h2", "h-open", "shown", "h1-old", "missing"])).toBe(2);
    expect(t.deleted).toEqual(["h1", "h2"]);
  });
});

describe("SessionCleanup with the real repository (BTL-190 item 8)", () => {
  it("purges a hidden chain from the database so no older segment comes back", () => {
    const repo = new SessionsRepo(memDb());
    const add = (id: string, lastActivityAt: number) => repo.insertIfAbsent({ id, ticketKey: null, cwd: "/w", origin: "butler", createdAt: 1, lastActivityAt });
    add("a", 1);
    add("b", 2);
    repo.setReplacedBy("a", "b", "clear");
    repo.dismiss("b", 3);
    add("kept", 1);
    repo.dismiss("kept", NOW - MIN);
    add("visible", 1);
    const tails: string[] = [];
    const c = new SessionCleanup({
      idleMinutes: () => 0, terminals: () => [], activity: () => null, lastUserInputAt: () => 0, openedAt: () => 0,
      ticketsOfFeature: () => [], featuresOfEpic: () => [],
      refresher: { precheckClose: () => null, close: async () => "done" },
      hiddenBefore: (before) => repo.listHiddenBefore(before),
      head: (id) => repo.get(id), terminalOpen: () => false,
      deleteChain: (id) => repo.deleteChain(id), removeTail: (id) => void tails.push(id),
      notify: () => {}, now: () => NOW, log: () => {},
    });
    expect(c.purgeHidden()).toBe(1);
    expect(tails.sort()).toEqual(["a", "b"]);
    expect(repo.get("a")).toBeNull();
    expect(repo.get("b")).toBeNull();
    expect(repo.get("kept")).not.toBeNull();
    expect(repo.get("visible")).not.toBeNull();
  });
});
