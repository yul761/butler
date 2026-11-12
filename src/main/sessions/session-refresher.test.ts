import { afterEach, describe, expect, it } from "vitest";
import type { SessionActivity } from "../../shared/activity";
import { sanitizeTask } from "../../shared/control";
import type { RefreshRefusal, Session } from "../../shared/types";
import { setLang } from "../i18n";
import { M } from "../strings";
import type { DeliveryBlock, DeliveryCheck } from "./delivery-guard";
import {
  autoRefreshNeedsYou, REFRESH_CLEAR_MS, REFRESH_COOLDOWN_MS, REFRESH_HANDOFF_MS, REFRESH_MEMORY_MS, refreshKindOf, SessionRefresher, startRefresh, type RefreshKind, type RefreshResult, type SessionRefresherDeps,
} from "./session-refresher";

const base = (o: Partial<Session> = {}): Session => ({
  id: "x", ticketKey: null, cwd: "/r", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null,
  waitingForInput: true, replacedBy: null, dismissed: false, createdAt: 0, repoId: null, coordinator: false, spawnedBy: null,
  featureId: null, fixesSession: null, epicId: null, model: null, butler: false, ...o,
});

/** 一个开着的终端：chain[0] 是终端启动时的 id（termId），最后一个是 head。 */
interface Term {
  chain: string[];
  session: Partial<Session>;
  kind: RefreshKind | null;
  context: number | null;
  /** guard 不通过的原因（null：通过）。needs_you 只有自动用的 guard 才看。 */
  block: DeliveryBlock | null;
  needsYou: boolean;
  background: boolean;
  /** 输入这些文字之后，过 ms 毫秒发生的事。 */
  reactions: Record<string, { ms: number; run: () => void } | undefined>;
  /** 输入这些文字时 deliver 的结果（默认 sent）。 */
  deliverResult: Record<string, "sent" | "exited" | "timeout" | undefined>;
  /** 用户上一次往这个终端输入的时间（0：没输入过）。 */
  typedAt: number;
  /** 终端打开的时间（R36）。 */
  openedAt: number;
  /** 粘贴前的复查（I2）不通过：deliver 返回 blocked，什么都没写。 */
  recheckFails: boolean;
}

function setup(o: { threshold?: number; commandReady?: boolean; epicPlanReady?: boolean; noEndTerminal?: boolean } = {}) {
  const state = {
    now: 1_000_000,
    threshold: o.threshold ?? 150_000,
    commandReady: o.commandReady ?? true,
    epicPlanReady: o.epicPlanReady ?? true,
    memory: true,
    /** 「需要你」还没判断完（needsYouUndecided）。 */
    undecided: false,
    /** epic scope 里 epic session 写的进度（epicProgress）。 */
    epicProgress: "做到第一步" as string | null,
    epicProgressReads: 0,
    /** 读 /handoff 命令文件时发生的事（这期间用户可能开始打字）。 */
    onCommandCheck: null as (() => void) | null,
    /** refreshActivity 读过的 id 和读的时候发生的事（R28：/clear 之后的新 head 要先读一次活动）。 */
    activityRefreshes: [] as string[],
    onRefreshActivity: null as ((id: string) => void) | null,
    /** 读库（head、记忆开关）的次数：stop 之后不能再读。 */
    reads: 0,
    /** 记忆的写入队列（memoryIdle）：默认马上就空；换成不 resolve 的就是一直在写。 */
    memoryIdle: (() => Promise.resolve()) as () => Promise<void>,
    /** memoryIdle 被等的时刻。 */
    memoryWaits: [] as number[],
    /** writeTail 收到的参数和当时已经输入过几段文字；tailResult 决定它返回什么（默认按终端 id 拼路径）。 */
    tails: [] as Array<{ oldHeadId: string; termId: string; kind: RefreshKind; typedBefore: number; at: number }>,
    tailResult: (async (termId: string) => tailOf(termId)) as (termId: string) => Promise<string | null>,
  };
  const terms: Term[] = [];
  const typed: Array<{ termId: string; text: string; at: number }> = [];
  const logs: string[] = [];
  /** 闲置关闭结束的终端（endTerminal 收到的参数）。 */
  const ended: Array<{ termId: string; headId: string; at: number }> = [];
  let notified = 0;
  const events: Array<{ at: number; run: () => void }> = [];
  const later = (ms: number, run: () => void) => events.push({ at: state.now + ms, run });

  const termOf = (id: string) => terms.find((t) => t.chain.includes(id)) ?? null;
  const headOf = (t: Term): Session => base({ ...t.session, id: t.chain[t.chain.length - 1] });
  const check = (respectNeedsYou: boolean) => (id: string): DeliveryCheck => {
    const t = termOf(id);
    if (!t) return { ok: false, block: "closed" };
    if (t.block) return { ok: false, block: t.block };
    if (respectNeedsYou && t.needsYou) return { ok: false, block: "needs_you" };
    return { ok: true, termId: t.chain[0], headId: t.chain[t.chain.length - 1] };
  };

  // 粘贴前的复查（I2）：guard 还通过、还是同一个终端、check 之后用户没输入过；recheckFails 时不通过。
  const recheckAfter = (respectNeedsYou: boolean) => (id: string, passed: { termId: string }) => {
    const at = state.now;
    return () => {
      const g = check(respectNeedsYou)(id);
      const t = termOf(id);
      return g.ok && g.termId === passed.termId && !!t && !t.recheckFails && t.typedAt <= at;
    };
  };

  const deps: SessionRefresherDeps = {
    guard: { check: check(true), recheckAfter: recheckAfter(true) },
    guardIgnoringNeedsYou: { check: check(false), recheckAfter: recheckAfter(false) },
    head: (id) => {
      state.reads++;
      const t = termOf(id);
      return t ? headOf(t) : null;
    },
    activity: (id): SessionActivity | null => {
      const t = termOf(id);
      return t ? { sessionId: id, kind: "waiting", detail: null, background: t.background, startedAt: null, lastOutputAt: null, stuck: null, reason: null, action: null, lastOutput: [] } : null;
    },
    kindOf: (s) => termOf(s.id)?.kind ?? null,
    contextOf: (id) => termOf(id)?.context ?? null,
    threshold: () => state.threshold,
    handoffCommandReady: async () => {
      state.onCommandCheck?.();
      return state.commandReady;
    },
    epicPlanReady: () => state.epicPlanReady,
    memoryEnabled: () => (state.reads++, state.memory),
    epicProgress: async () => {
      state.epicProgressReads++;
      return state.epicProgress;
    },
    deliver: async (termId, text, recheck) => {
      const t = terms.find((x) => x.chain[0] === termId);
      if (recheck && !recheck()) return "blocked";
      typed.push({ termId, text, at: state.now });
      const reaction = t?.reactions[text];
      if (reaction) later(reaction.ms, reaction.run);
      return t?.deliverResult[text] ?? "sent";
    },
    sessions: () => terms.map(headOf),
    lastUserInputAt: (termId) => terms.find((x) => x.chain[0] === termId)?.typedAt ?? 0,
    openedAt: (termId) => terms.find((x) => x.chain[0] === termId)?.openedAt ?? 0,
    memoryIdle: () => {
      state.memoryWaits.push(state.now);
      return state.memoryIdle();
    },
    writeTail: (oldHeadId, termId, kind) => {
      state.tails.push({ oldHeadId, termId, kind, typedBefore: typed.length, at: state.now });
      return state.tailResult(termId);
    },
    notify: () => void notified++,
    now: () => state.now,
    // 假时钟：睡多久时间就走多久，到点的事件依次发生。
    sleep: async (ms) => {
      state.now += ms;
      for (const e of events.filter((x) => x.at <= state.now).sort((a, b) => a.at - b.at)) {
        events.splice(events.indexOf(e), 1);
        e.run();
      }
    },
    refreshActivity: async (id) => {
      state.activityRefreshes.push(id);
      state.onRefreshActivity?.(id);
    },
    log: (m) => void logs.push(m),
    needsYouUndecided: () => state.undecided,
    endTerminal: o.noEndTerminal ? undefined : (termId, headId) => void ended.push({ termId, headId, at: state.now }),
  };
  const r = new SessionRefresher(deps);

  /** 加一个终端；默认是一个停着、上下文很长的 ticket session，/handoff 30 秒后收进来，/clear 2 秒后接上新 id。 */
  const addTerm = (id: string, over: Partial<Term> = {}): Term => {
    const t: Term = {
      chain: [id], session: { ticketKey: "DMS-1" }, kind: "ticket", context: 200_000, block: null, needsYou: false, background: false,
      reactions: {}, deliverResult: {}, typedAt: 0, openedAt: 1, recheckFails: false, ...over,
    };
    t.reactions = {
      "/handoff": { ms: 30_000, run: () => r.handoffStored(t.chain[t.chain.length - 1]) },
      // 新 id 的上下文还没读到。
      "/clear": { ms: 2_000, run: () => { t.chain.push(`${id}-new${t.chain.length}`); t.context = null; } },
      ...over.reactions,
    };
    terms.push(t);
    return t;
  };
  /** 等 autoCheck 起的换新跑完（不推时钟：时钟只由换新自己的 sleep 推）。 */
  const settle = async () => {
    for (let i = 0; i < 100_000 && terms.some((t) => r.isRefreshing(t.chain[0])); i++) await new Promise((res) => setImmediate(res));
    // 让失败之后的收尾也跑完。
    await new Promise((res) => setImmediate(res));
  };
  const texts = () => typed.map((x) => x.text);
  return { r, state, terms, typed, texts, logs, ended, addTerm, settle, later, notified: () => notified };
}

/** 测试里 writeTail 默认写到的尾巴文件。 */
const tailOf = (termId: string) => `/butler/refresh/${termId}.md`;

afterEach(() => setLang("zh"));

describe("SessionRefresher (plan 16)", () => {
  it("runs handoff, clear and resume in order for a ticket session", async () => {
    const t = setup();
    const term = t.addTerm("s1");
    const started = t.state.now;
    expect(await t.r.refresh("s1", "manual")).toBe("done");
    expect(t.texts()).toEqual(["/handoff", "/clear", M().refreshResume("ticket", "DMS-1", tailOf("s1"))]);
    expect(t.typed.every((x) => x.termId === "s1")).toBe(true);
    // /clear 在 handoff 收进来之后才输入，接着做的话在新 id 接上之后。
    expect(t.typed[1].at - started).toBeGreaterThanOrEqual(30_000);
    expect(t.typed[2].at - t.typed[1].at).toBeGreaterThanOrEqual(2_000);
    expect(term.chain).toHaveLength(2);
    expect(t.r.isRefreshing("s1")).toBe(false);
    expect(t.r.stepOf("s1")).toBeNull();
    expect(t.notified()).toBeGreaterThan(0);
  });

  it("passes a recheck to every deliver and stops when it says no right before the paste (I2)", async () => {
    const t = setup();
    t.addTerm("s1", { recheckFails: true });
    expect(await t.r.refresh("s1", "manual")).toBe("failed");
    expect(t.texts()).toEqual([]);
    expect(t.r.isRefreshing("s1")).toBe(false);
    expect(t.logs.some((l) => l.includes("blocked"))).toBe(true);

    // 第二步的复查不通过：/handoff 输入了，/clear 没有。
    const t2 = setup();
    const term2 = t2.addTerm("s1", {
      reactions: { "/handoff": { ms: 30_000, run: () => { t2.r.handoffStored("s1"); term2.recheckFails = true; } } },
    });
    expect(await t2.r.refresh("s1", "manual")).toBe("failed");
    expect(t2.texts()).toEqual(["/handoff"]);
  });

  it("stops before /clear when the user typed anything after Butler typed /handoff, however long ago (I3)", async () => {
    const t = setup();
    const term = t.addTerm("s1", {
      // 用户在等 handoff 的时候打了一下字（之后又安静了很久，guard 的 30 秒早过了）。
      reactions: { "/handoff": { ms: 300_000, run: () => t.r.handoffStored("s1") } },
    });
    t.later(10_000, () => (term.typedAt = t.state.now));
    expect(await t.r.refresh("s1", "manual")).toBe("failed");
    expect(t.texts()).toEqual(["/handoff"]);
    expect(t.logs.some((l) => l.includes("the user typed"))).toBe(true);
  });

  it("stops before the resume message when the user typed after /handoff (I3)", async () => {
    const t = setup();
    const term = t.addTerm("s1", {
      reactions: {
        "/clear": { ms: 2_000, run: () => { term.chain.push("s1-new"); term.context = null; term.typedAt = t.state.now; } },
      },
    });
    expect(await t.r.refresh("s1", "manual")).toBe("failed");
    expect(t.texts()).toEqual(["/handoff", "/clear"]);
  });

  it("input before Butler typed /handoff does not stop the refresh (I3)", async () => {
    const t = setup();
    t.addTerm("s1", { typedAt: t.state.now - 60_000 });
    expect(await t.r.refresh("s1", "manual")).toBe("done");
  });

  it("waits for the memory sync and writes the conversation tail of the old head before /clear (BTL-190)", async () => {
    const t = setup();
    const term = t.addTerm("s1");
    expect(await t.r.refresh("s1", "manual")).toBe("done");
    // 只等一次、只写一次：/handoff 输入了、/clear 还没有。
    expect(t.state.memoryWaits).toHaveLength(1);
    expect(t.state.memoryWaits[0]).toBeGreaterThanOrEqual(t.typed[0].at + 30_000);
    expect(t.state.tails).toEqual([{ oldHeadId: "s1", termId: "s1", kind: "ticket", typedBefore: 1, at: expect.any(Number) as number }]);
    expect(t.state.tails[0].at).toBeLessThanOrEqual(t.typed[1].at);
    expect(t.texts()[2]).toBe(M().refreshResume("ticket", "DMS-1", tailOf("s1")));
    expect(t.texts()[2]).toContain(tailOf("s1"));
    expect(term.chain).toHaveLength(2);
  });

  it("reads the tail from the current head after an earlier refresh, named after the terminal", async () => {
    const t = setup();
    t.addTerm("s1", { chain: ["s1", "s1-old"] });
    expect(await t.r.refresh("s1", "manual")).toBe("done");
    expect(t.state.tails.map((x) => [x.oldHeadId, x.termId])).toEqual([["s1-old", "s1"]]);
  });

  it("clears after 60 s when the memory sync does not finish, and logs it", async () => {
    const t = setup();
    t.state.memoryIdle = () => new Promise<void>(() => {});
    t.addTerm("s1");
    expect(REFRESH_MEMORY_MS).toBe(60_000);
    expect(await t.r.refresh("s1", "manual")).toBe("done");
    expect(t.texts()).toEqual(["/handoff", "/clear", M().refreshResume("ticket", "DMS-1", tailOf("s1"))]);
    expect(t.typed[1].at - t.state.memoryWaits[0]).toBeGreaterThanOrEqual(REFRESH_MEMORY_MS);
    expect(t.logs.some((l) => l.includes("memory sync did not finish"))).toBe(true);
  });

  it("goes on when waiting for memory fails", async () => {
    const t = setup();
    t.state.memoryIdle = () => Promise.reject(new Error("boom"));
    t.addTerm("s1");
    expect(await t.r.refresh("s1", "manual")).toBe("done");
    expect(t.logs.some((l) => l.includes("waiting for the memory sync failed"))).toBe(true);
  });

  it("leaves the tail out of the resume message when it could not be written", async () => {
    const none = setup();
    none.state.tailResult = async () => null;
    none.addTerm("s1");
    expect(await none.r.refresh("s1", "manual")).toBe("done");
    expect(none.texts()[2]).toBe(M().refreshResume("ticket", "DMS-1", null));

    const broken = setup();
    broken.state.tailResult = async () => {
      throw new Error("disk full");
    };
    broken.addTerm("s1");
    expect(await broken.r.refresh("s1", "manual")).toBe("done");
    expect(broken.texts()[2]).toBe(M().refreshResume("ticket", "DMS-1", null));
    expect(broken.logs.some((l) => l.includes("writing the conversation tail failed"))).toBe(true);
  });

  it("does not write a tail or wait for memory when the handoff never comes in", async () => {
    const t = setup();
    t.addTerm("s1", { reactions: { "/handoff": undefined } });
    expect(await t.r.refresh("s1", "manual")).toBe("failed");
    expect(t.state.tails).toEqual([]);
    expect(t.state.memoryWaits).toEqual([]);
  });

  it("does not start an automatic refresh within 60 s of the terminal being opened or resumed; manual still works (R36)", async () => {
    const t = setup();
    t.addTerm("s1", { openedAt: t.state.now - 59_999 });
    t.r.autoCheck();
    await t.settle();
    expect(t.texts()).toEqual([]);
    expect(t.r.precheck("s1", "auto")).toBe("busy");
    expect(t.r.precheck("s1", "coordinator")).toBeNull();
    expect(t.r.precheck("s1", "manual")).toBeNull();
    t.state.now += 1;
    t.r.autoCheck();
    await t.settle();
    expect(t.texts()).toEqual(["/handoff", "/clear", M().refreshResume("ticket", "DMS-1", tailOf("s1"))]);
  });

  it("the resume sentence recalls the handoff, reads the tail and carries on, in both languages (BTL-190)", () => {
    const path = "/Users/me/.butler/refresh/s1.md";
    expect(M().refreshResume("ticket", "DMS-1", path)).toBe(
      `上下文已由 Butler 换新。先用 recall 调出 DMS-1 最新的 handoff，再读一下 ${path} 里换新前的最近对话，然后接着做换新前正在做的事。如果换新前是在等用户、等 CI 或者等子 session，就用一句话说明在等什么，然后继续等。`,
    );
    expect(M().refreshResume("feature", "支付", null)).toBe(
      "上下文已由 Butler 换新。先用 butler-feature 的 recall 调出这个 feature 最新的 handoff，然后接着做换新前正在做的事。如果换新前是在等用户、等 CI 或者等子 session，就用一句话说明在等什么，然后继续等。",
    );
    expect(M().refreshResume("epic", "E1", path)).toContain(`先用 butler-epic 的 recall 调出这个 epic 最新的 handoff，再读一下 ${path}`);
    // 不再叫它停下来等用户。
    expect(M().refreshResume("ticket", "DMS-1", path)).not.toContain("不要自己开始");
    expect(M().refreshEpicHandoff).toBe(
      "Butler 要清空这个 session 的上下文。请先用 butler-epic 的 handoff 写下现在的进度和没解决的问题；规划有改动的话先用 set_epic_plan 更新。写完就停下。",
    );
    // Windows 上的路径（有空格、反斜杠）照样是一行，过了 sanitizeTask 也不变。
    const win = "C:\\Users\\John Doe\\.butler\\refresh\\s1.md";
    for (const lang of ["zh", "en"] as const) {
      setLang(lang);
      for (const kind of ["ticket", "feature", "epic"] as const) {
        const text = M().refreshResume(kind, "DMS-1", win);
        expect(text).not.toContain("\n");
        expect(sanitizeTask(text)).toBe(text);
        expect(text).toContain(win);
      }
    }
    setLang("en");
    expect(M().refreshResume("ticket", "DMS-1", path)).toBe(
      `Butler has refreshed the context. First use recall to load the latest handoff of DMS-1 and read ${path} for the conversation right before the refresh, then carry on with whatever you were doing before the refresh. If you were waiting for the user, for CI or for child sessions, say in one sentence what you're waiting for and keep waiting.`,
    );
    expect(M().refreshResume("feature", "x", null)).toContain("butler-feature");
    expect(M().refreshResume("feature", "x", null)).not.toContain("read ");
    expect(M().refreshResume("epic", "x", path)).toContain("butler-epic");
    expect(M().refreshEpicHandoff).toContain("set_epic_plan");
  });

  it("waits for the epic session's progress to change for an epic session", async () => {
    const t = setup();
    t.addTerm("e1", {
      kind: "epic", session: { epicId: 7 },
      reactions: { [M().refreshEpicHandoff]: { ms: 42_000, run: () => (t.state.epicProgress = "做到第二步") } },
    });
    const started = t.state.now;
    expect(await t.r.refresh("e1", "manual")).toBe("done");
    expect(t.texts()).toEqual([M().refreshEpicHandoff, "/clear", M().refreshResume("epic", "", tailOf("e1"))]);
    expect(t.typed[1].at - started).toBeGreaterThanOrEqual(42_000);
    // 每 5 秒查一次，不是每一次 sleep 都查。
    expect(t.state.epicProgressReads).toBeLessThanOrEqual(1 + Math.ceil(42_000 / 5_000) + 1);
  });

  it("does not count epic progress that stays the same or becomes null (R29: Butler's own re-render keeps the progress)", async () => {
    const same = setup();
    same.addTerm("e1", { kind: "epic", session: { epicId: 7 } });
    expect(await same.r.refresh("e1", "manual")).toBe("failed");
    expect(same.texts()).toEqual([M().refreshEpicHandoff]);
    expect(same.logs.some((l) => l.includes("not stored"))).toBe(true);

    const gone = setup();
    gone.addTerm("e1", {
      kind: "epic", session: { epicId: 7 },
      reactions: { [M().refreshEpicHandoff]: { ms: 10_000, run: () => (gone.state.epicProgress = null) } },
    });
    expect(await gone.r.refresh("e1", "manual")).toBe("failed");
    expect(gone.texts()).toEqual([M().refreshEpicHandoff]);

    // 之前没有进度：第一次写进度就算写完了。
    const first = setup();
    first.state.epicProgress = null;
    first.addTerm("e1", {
      kind: "epic", session: { epicId: 7 },
      reactions: { [M().refreshEpicHandoff]: { ms: 10_000, run: () => (first.state.epicProgress = "做到第一步") } },
    });
    expect(await first.r.refresh("e1", "manual")).toBe("done");
  });

  it("aborts when the guard fails between steps", async () => {
    const t = setup();
    // 第一次 handoff 收进来的时候用户开始打字；之后不再打。
    let typing = true;
    const term = t.addTerm("s1", {
      reactions: { "/handoff": { ms: 30_000, run: () => { t.r.handoffStored(term.chain[term.chain.length - 1]); if (typing) term.block = "typing"; typing = false; } } },
    });
    expect(await t.r.refresh("s1", "coordinator")).toBe("failed");
    expect(t.texts()).toEqual(["/handoff"]);
    expect(t.r.isRefreshing("s1")).toBe(false);
    expect(t.logs.some((l) => l.includes("s1") && l.includes("typing"))).toBe(true);
    // 冷却：总控和自动都不再试，30 分钟之后才行。
    expect(REFRESH_COOLDOWN_MS).toBe(1_800_000);
    term.block = null;
    expect(await t.r.refresh("s1", "coordinator")).toBe("cooldown");
    t.state.now += REFRESH_COOLDOWN_MS - 1;
    t.r.autoCheck();
    await t.settle();
    expect(t.texts()).toEqual(["/handoff"]);
    t.state.now += 1;
    t.r.autoCheck();
    await t.settle();
    expect(t.texts()).toEqual(["/handoff", "/handoff", "/clear", M().refreshResume("ticket", "DMS-1", tailOf("s1"))]);
  });

  it("waits for the session to be quiet again before the next step, and stops on a draft", async () => {
    const t = setup();
    const term = t.addTerm("s1", {
      reactions: {
        // 收进来之后还忙 50 秒（claude 在收尾），然后停下：照样往下走。
        "/handoff": { ms: 30_000, run: () => { t.r.handoffStored("s1"); term.block = "busy"; t.later(50_000, () => (term.block = null)); } },
      },
    });
    expect(await t.r.refresh("s1", "manual")).toBe("done");
    expect(t.texts()).toEqual(["/handoff", "/clear", M().refreshResume("ticket", "DMS-1", tailOf("s1"))]);
    expect(t.typed[1].at - t.typed[0].at).toBeGreaterThanOrEqual(30_000 + 50_000);

    // 一直忙超过一步的时限：失败，不输入 /clear。
    const t2 = setup();
    const busy = t2.addTerm("s1", { reactions: { "/handoff": { ms: 1_000, run: () => { t2.r.handoffStored("s1"); busy.block = "busy"; } } } });
    expect(await t2.r.refresh("s1", "manual")).toBe("failed");
    expect(t2.texts()).toEqual(["/handoff"]);

    // 接着做的话之前，用户留了草稿：不输入。
    const t3 = setup();
    const draft = t3.addTerm("s1", { reactions: { "/clear": { ms: 2_000, run: () => { draft.chain.push("s1-b"); draft.block = "draft"; } } } });
    expect(await t3.r.refresh("s1", "manual")).toBe("failed");
    expect(t3.texts()).toEqual(["/handoff", "/clear"]);
  });

  it("gives up when the handoff never arrives", async () => {
    const t = setup();
    t.addTerm("s1", { reactions: { "/handoff": undefined } });
    const started = t.state.now;
    expect(await t.r.refresh("s1", "manual")).toBe("failed");
    expect(t.texts()).toEqual(["/handoff"]);
    expect(REFRESH_HANDOFF_MS).toBe(600_000);
    expect(t.state.now - started).toBeGreaterThanOrEqual(REFRESH_HANDOFF_MS);
    expect(t.state.now - started).toBeLessThan(REFRESH_HANDOFF_MS + 10_000);
    expect(t.logs.some((l) => l.includes("s1") && l.includes("not stored"))).toBe(true);
  });

  it("gives up when /clear never brings a new session id, and when typing fails", async () => {
    const t = setup();
    t.addTerm("s1", { reactions: { "/clear": undefined } });
    const before = t.state.now;
    expect(await t.r.refresh("s1", "manual")).toBe("failed");
    expect(t.texts()).toEqual(["/handoff", "/clear"]);
    expect(REFRESH_CLEAR_MS).toBe(60_000);
    expect(t.state.now - before).toBeLessThan(30_000 + REFRESH_CLEAR_MS + 10_000);

    const t2 = setup();
    t2.addTerm("s1", { deliverResult: { "/clear": "timeout" } });
    expect(await t2.r.refresh("s1", "manual")).toBe("failed");
    expect(t2.texts()).toEqual(["/handoff", "/clear"]);
    expect(await t2.r.refresh("s1", "coordinator")).toBe("cooldown");
  });

  it("autoCheck only picks sessions over the threshold and not in cooldown", async () => {
    const t = setup();
    t.addTerm("low", { context: 149_999 });
    t.addTerm("none", { context: null });
    t.addTerm("high", { context: 150_000 });
    t.addTerm("higher", { context: 180_000, session: { ticketKey: "DMS-2" } });
    t.r.autoCheck();
    // 一次最多一个；在跑的时候不再起新的。
    expect(t.r.isRefreshing("higher") || t.r.isRefreshing("high")).toBe(true);
    t.r.autoCheck();
    expect(t.terms.filter((x) => t.r.isRefreshing(x.chain[0]))).toHaveLength(1);
    await t.settle();
    t.r.autoCheck();
    await t.settle();
    // 换新过的 session 新 id 的上下文还没读到，不会再被选；low 和 none 永远不选。
    const terms = [...new Set(t.typed.map((x) => x.termId))].sort();
    expect(terms).toEqual(["high", "higher"]);
    expect(t.typed.filter((x) => x.text === "/handoff")).toHaveLength(2);
  });

  it("autoCheck skips sessions that are busy, in needs-you, have a background task, or cannot be refreshed", async () => {
    const t = setup();
    t.addTerm("busy", { block: "busy" });
    t.addTerm("needs", { needsYou: true });
    t.addTerm("bg", { background: true });
    t.addTerm("fix", { kind: null });
    t.r.autoCheck();
    await t.settle();
    expect(t.typed).toEqual([]);
    // 手动可以：后台任务、「需要你」都不挡。
    expect(await t.r.refresh("bg", "manual")).toBe("done");
    expect(await t.r.refresh("needs", "coordinator")).toBe("done");
    expect(await t.r.refresh("busy", "manual")).toBe("busy");
    expect(await t.r.refresh("fix", "manual")).toBe("failed");
    expect(t.typed.some((x) => x.termId === "busy" || x.termId === "fix")).toBe(false);
  });

  it("autoCheck is off at threshold 0", async () => {
    const t = setup({ threshold: 0 });
    t.addTerm("s1", { context: 900_000 });
    t.r.autoCheck();
    await t.settle();
    expect(t.typed).toEqual([]);
    expect(await t.r.refresh("s1", "manual")).toBe("done");
  });

  it("skips tickets when the handoff command is not Butler's", async () => {
    const t = setup({ commandReady: false });
    t.addTerm("s1");
    t.addTerm("f1", { kind: "feature", session: { featureId: 3 } });
    t.addTerm("e1", {
      kind: "epic", session: { epicId: 7 }, context: 160_000,
      reactions: { [M().refreshEpicHandoff]: { ms: 10_000, run: () => (t.state.epicProgress = "做到第二步") } },
    });
    for (let i = 0; i < 4; i++) {
      t.r.autoCheck();
      await t.settle();
    }
    // 上下文最长的先选：ticket 和 feature 总控都不输入 /handoff，各记一次日志（之后冷却），也不挡住后面的 epic。
    expect(t.typed.filter((x) => x.text === "/handoff")).toEqual([]);
    expect(t.typed.filter((x) => x.termId === "e1").map((x) => x.text)).toEqual([M().refreshEpicHandoff, "/clear", M().refreshResume("epic", "", tailOf("e1"))]);
    expect(t.logs.filter((l) => l.includes("s1") && l.includes("/handoff"))).toHaveLength(1);
    expect(await t.r.refresh("s1", "manual")).toBe("failed");
    expect(t.typed.filter((x) => x.text === "/handoff")).toEqual([]);
  });

  it("does not auto-refresh epic sessions before the plan fix", async () => {
    const t = setup({ epicPlanReady: false });
    t.addTerm("e1", { kind: "epic", session: { epicId: 7 } });
    t.r.autoCheck();
    await t.settle();
    expect(t.typed).toEqual([]);
    // 手动也不行：epic session 会写一份进度 handoff，把记忆里的规划冲掉。
    expect(await t.r.refresh("e1", "manual")).toBe("failed");
    expect(t.typed).toEqual([]);
  });

  it("skips the ticket fan-out while refreshing", async () => {
    const t = setup();
    const seen: Array<{ refreshing: boolean; step: string | null }> = [];
    const term = t.addTerm("c1", {
      kind: "feature", session: { featureId: 3, coordinator: true },
      reactions: {
        // capture 存下 /handoff 时（index.ts 在这一刻决定要不要带动 ticket），这个 session 正在换新。
        "/handoff": { ms: 30_000, run: () => { seen.push({ refreshing: t.r.isRefreshing("c1"), step: t.r.stepOf("c1") }); t.r.handoffStored("c1"); } },
        "/clear": { ms: 2_000, run: () => { term.chain.push("c2"); seen.push({ refreshing: t.r.isRefreshing("c2"), step: t.r.stepOf("c2") }); } },
      },
    });
    expect(t.r.isRefreshing("c1")).toBe(false);
    expect(await t.r.refresh("c1", "manual")).toBe("done");
    expect(seen).toEqual([{ refreshing: true, step: "handoff" }, { refreshing: true, step: "clear" }]);
    expect(t.texts()[2]).toBe(M().refreshResume("feature", "", tailOf("c1")));
    expect(t.r.isRefreshing("c1")).toBe(false);
    expect(t.r.isRefreshing("c2")).toBe(false);
    // 不是这个 session 的 handoff 不算。
    const t2 = setup();
    t2.addTerm("a", { reactions: { "/handoff": { ms: 1_000, run: () => t2.r.handoffStored("other") } } });
    t2.addTerm("other", { context: 0 });
    expect(await t2.r.refresh("a", "manual")).toBe("failed");
    expect(t2.texts()).toEqual(["/handoff"]);
  });

  it("types nothing and does not cool down when the user starts typing before the first step", async () => {
    const t = setup();
    const term = t.addTerm("s1");
    t.state.onCommandCheck = () => {
      term.block = "typing";
      t.state.onCommandCheck = null;
    };
    expect(await t.r.refresh("s1", "coordinator")).toBe("busy");
    expect(t.typed).toEqual([]);
    expect(t.r.isRefreshing("s1")).toBe(false);
    term.block = null;
    expect(await t.r.refresh("s1", "coordinator")).toBe("done");
  });

  it("types nothing for any kind or trigger while memory is off (R30)", async () => {
    const t = setup();
    t.state.memory = false;
    t.addTerm("s1");
    t.addTerm("f1", { kind: "feature", session: { featureId: 3 } });
    t.addTerm("e1", { kind: "epic", session: { epicId: 7 } });
    t.r.autoCheck();
    await t.settle();
    for (const id of ["s1", "f1", "e1"]) {
      for (const trigger of ["auto", "coordinator", "manual"] as const) {
        expect(t.r.precheck(id, trigger)).toBe("memory_off");
        expect(await t.r.refresh(id, trigger)).toBe("memory_off");
      }
    }
    expect(t.typed).toEqual([]);
    expect(t.state.epicProgressReads).toBe(0);
    t.state.memory = true;
    expect(await t.r.refresh("s1", "manual")).toBe("done");
  });

  it("precheck answers at once without starting anything (R31)", async () => {
    const t = setup();
    const term = t.addTerm("s1");
    t.addTerm("fix", { kind: null });
    expect(t.r.precheck("s1", "auto")).toBeNull();
    expect(t.r.precheck("s1", "coordinator")).toBeNull();
    expect(t.r.isRefreshing("s1")).toBe(false);
    expect(t.r.precheck("fix", "manual")).toBe("failed");
    expect(t.r.precheck("nobody", "manual")).toBe("failed");
    // 草稿：哪种触发都挡；「需要你」和后台任务只挡自动。
    term.block = "draft";
    expect(t.r.precheck("s1", "manual")).toBe("busy");
    term.block = null;
    term.needsYou = true;
    expect(t.r.precheck("s1", "auto")).toBe("busy");
    expect(t.r.precheck("s1", "coordinator")).toBeNull();
    term.needsYou = false;
    term.background = true;
    expect(t.r.precheck("s1", "auto")).toBe("busy");
    expect(t.r.precheck("s1", "manual")).toBeNull();
    term.background = false;
    // 正在换新：already（新 id 也认）。
    const p = t.r.refresh("s1", "manual");
    expect(t.r.precheck("s1", "coordinator")).toBe("already");
    expect(await p).toBe("done");
    expect(t.r.precheck(term.chain[1], "manual")).toBeNull();
    // 失败过：总控和自动是 cooldown，手动不看。
    term.deliverResult = { "/handoff": "exited" };
    expect(await t.r.refresh("s1", "manual")).toBe("failed");
    expect(t.r.precheck("s1", "coordinator")).toBe("cooldown");
    expect(t.r.precheck("s1", "auto")).toBe("cooldown");
    expect(t.r.precheck("s1", "manual")).toBeNull();
    // epic 规划单独存放之前：哪种触发都 failed。
    const e = setup({ epicPlanReady: false });
    e.addTerm("e1", { kind: "epic", session: { epicId: 7 } });
    expect(e.r.precheck("e1", "manual")).toBe("failed");
    expect(e.r.precheck("e1", "auto")).toBe("failed");
  });

  it("only counts a handoff stored after Butler typed /handoff (review: the user's own /handoff during the checks)", async () => {
    const t = setup();
    t.addTerm("s1");
    t.state.onCommandCheck = () => t.r.handoffStored("s1");
    expect(await t.r.refresh("s1", "manual")).toBe("done");
    expect(t.texts()).toEqual(["/handoff", "/clear", M().refreshResume("ticket", "DMS-1", tailOf("s1"))]);
    // /clear 等的是输入之后 30 秒收进来的那一份，不是检查期间收进来的。
    expect(t.typed[1].at - t.typed[0].at).toBeGreaterThanOrEqual(30_000);

    // 之后再也没收进来：失败，不输入 /clear。
    const t2 = setup();
    t2.addTerm("s1", { reactions: { "/handoff": undefined } });
    t2.state.onCommandCheck = () => t2.r.handoffStored("s1");
    expect(await t2.r.refresh("s1", "manual")).toBe("failed");
    expect(t2.texts()).toEqual(["/handoff"]);
  });

  it("stops before the next typing step when memory is turned off midway (review)", async () => {
    const t = setup();
    const term = t.addTerm("s1");
    term.reactions["/handoff"] = { ms: 30_000, run: () => { t.r.handoffStored("s1"); t.state.memory = false; } };
    expect(await t.r.refresh("s1", "manual")).toBe("failed");
    expect(t.texts()).toEqual(["/handoff"]);
    expect(t.logs.some((l) => l.includes("memory_off"))).toBe(true);

    // 读命令文件期间关掉：什么都没输入，memory_off。
    const t2 = setup();
    t2.addTerm("s1");
    t2.state.onCommandCheck = () => (t2.state.memory = false);
    expect(await t2.r.refresh("s1", "coordinator")).toBe("memory_off");
    expect(t2.typed).toEqual([]);
  });

  it("does not refresh a ticket session without a ticket key (review)", async () => {
    const t = setup();
    t.addTerm("s1", { session: { ticketKey: null } });
    expect(t.r.precheck("s1", "manual")).toBe("failed");
    expect(await t.r.refresh("s1", "manual")).toBe("failed");
    t.r.autoCheck();
    await t.settle();
    expect(t.typed).toEqual([]);
  });

  it("an auto refresh stops when a background task starts while the command file is read (review)", async () => {
    const t = setup();
    const term = t.addTerm("s1");
    t.state.onCommandCheck = () => (term.background = true);
    expect(await t.r.refresh("s1", "auto")).toBe("busy");
    expect(t.typed).toEqual([]);
    expect(t.r.isRefreshing("s1")).toBe(false);
    // 手动不看后台任务。
    expect(await t.r.refresh("s1", "manual")).toBe("done");
  });

  it("refuses a second refresh of the same session while one is running", async () => {
    const t = setup();
    t.addTerm("s1");
    const p = t.r.refresh("s1", "manual");
    expect(await t.r.refresh("s1", "coordinator")).toBe("already");
    expect(await p).toBe("done");
    expect(t.texts().filter((x) => x === "/handoff")).toHaveLength(1);
  });

  it("manual refresh ignores needs-you but not drafts", async () => {
    const t = setup();
    const term = t.addTerm("s1", { needsYou: true });
    t.r.autoCheck();
    await t.settle();
    expect(t.typed).toEqual([]);
    expect(await t.r.refresh("s1", "manual")).toBe("done");
    expect(t.texts()).toHaveLength(3);
    term.block = "draft";
    expect(await t.r.refresh("s1", "manual")).toBe("busy");
    expect(t.texts()).toHaveLength(3);
  });

  it("a manual refresh is not held back by an earlier failure", async () => {
    const t = setup();
    const term = t.addTerm("s1", { deliverResult: { "/handoff": "exited" } });
    expect(await t.r.refresh("s1", "manual")).toBe("failed");
    term.deliverResult = {};
    expect(await t.r.refresh("s1", "coordinator")).toBe("cooldown");
    expect(await t.r.refresh("s1", "manual")).toBe("done");
  });

  it("re-reads the head's activity before each check while waiting to type (R28)", async () => {
    const t = setup();
    const term = t.addTerm("s1", {
      reactions: {
        // /clear 之后新 head 的活动还没读到：guard 看到的是忙。读过一次活动才知道它停在空的输入框上。
        "/clear": { ms: 2_000, run: () => { term.chain.push("s1-b"); term.block = "busy"; } },
      },
    });
    t.state.onRefreshActivity = () => {
      if (term.chain.length === 2) term.block = null;
    };
    expect(await t.r.refresh("s1", "manual")).toBe("done");
    expect(t.texts()).toEqual(["/handoff", "/clear", M().refreshResume("ticket", "DMS-1", tailOf("s1"))]);
    // 接着做的话没有等满一步的时限：读过活动马上就输入了。
    expect(t.typed[2].at - t.typed[1].at).toBeLessThan(REFRESH_CLEAR_MS);
    expect(t.state.activityRefreshes.length).toBeGreaterThanOrEqual(2);
    expect(t.state.activityRefreshes.every((id) => id === "s1")).toBe(true);
  });
});

describe("SessionRefresher.close (BTL-190 item 8)", () => {
  it("types /handoff, waits for it and the memory sync, then ends the terminal without /clear", async () => {
    const t = setup();
    const term = t.addTerm("s1");
    term.chain.push("s1-b"); // 之前换新过一次：终端还是 s1，head 是 s1-b。
    const steps: Array<string | null> = [];
    t.state.onCommandCheck = () => steps.push(t.r.stepOf("s1-b"));
    t.state.memoryIdle = () => (steps.push(t.r.stepOf("s1")), Promise.resolve());
    const started = t.state.now;
    expect(await t.r.close("s1-b", "auto")).toBe("done");
    expect(t.texts()).toEqual(["/handoff"]);
    expect(t.typed[0].termId).toBe("s1");
    expect(t.state.memoryWaits).toHaveLength(1);
    expect(t.state.memoryWaits[0] - started).toBeGreaterThanOrEqual(30_000);
    expect(t.ended).toEqual([{ termId: "s1", headId: "s1-b", at: expect.any(Number) }]);
    expect(t.ended[0].at).toBeGreaterThanOrEqual(t.state.memoryWaits[0]);
    // 关闭不写尾巴（没有 /clear，以后 --resume 恢复的是整段对话）。
    expect(t.state.tails).toEqual([]);
    // 从头到尾都报 close：「现在」页显示"闲置，正在关闭"。
    expect(steps).toEqual(["close", "close"]);
    expect(t.r.isRefreshing("s1")).toBe(false);
    expect(t.r.stepOf("s1")).toBeNull();
  });

  it("asks an epic session to write its progress with the idle-close wording", async () => {
    const t = setup();
    t.addTerm("e1", {
      kind: "epic", session: { epicId: 7 },
      reactions: { [M().idleCloseEpicHandoff]: { ms: 12_000, run: () => (t.state.epicProgress = "做到第二步") } },
    });
    expect(await t.r.close("e1", "manual")).toBe("done");
    expect(t.texts()).toEqual([M().idleCloseEpicHandoff]);
    expect(t.ended.map((e) => e.termId)).toEqual(["e1"]);
    expect(M().idleCloseEpicHandoff).not.toBe(M().refreshEpicHandoff);
    setLang("en");
    expect(M().idleCloseEpicHandoff).toMatch(/handoff/);
  });

  it("with memory off still has a ticket session write /handoff (the daily brief needs it), without waiting for memory", async () => {
    const t = setup();
    t.addTerm("s1");
    t.state.memory = false;
    expect(t.r.precheckClose("s1", "auto")).toBeNull();
    expect(await t.r.close("s1", "auto")).toBe("done");
    expect(t.texts()).toEqual(["/handoff"]);
    expect(t.state.memoryWaits).toEqual([]);
    expect(t.ended.map((e) => e.termId)).toEqual(["s1"]);
  });

  it("with memory off ends an epic session without typing anything (its handoff tool lives in memory)", async () => {
    const t = setup();
    t.addTerm("e1", { kind: "epic", session: { epicId: 7 } });
    t.state.memory = false;
    expect(await t.r.close("e1", "auto")).toBe("done");
    expect(t.texts()).toEqual([]);
    expect(t.ended.map((e) => e.termId)).toEqual(["e1"]);
  });

  it("waits for a background task the handoff turn started, and for the needs-you verdict on the reply, before ending", async () => {
    const t = setup();
    const term = t.addTerm("s1");
    // /handoff 收进来的时候（30 秒）它起了一个后台命令，40 秒时跑完；「需要你」到 50 秒才判断完。
    t.later(29_000, () => {
      term.background = true;
      t.state.undecided = true;
    });
    t.later(40_000, () => (term.background = false));
    t.later(50_000, () => (t.state.undecided = false));
    const started = t.state.now;
    expect(await t.r.close("s1", "auto")).toBe("done");
    expect(t.ended).toHaveLength(1);
    expect(t.ended[0].at - started).toBeGreaterThanOrEqual(50_000);
  });

  it("does not end the terminal when the verdict on the handoff reply is that it needs you", async () => {
    const t = setup();
    const term = t.addTerm("s1");
    t.later(29_000, () => (t.state.undecided = true));
    t.later(35_000, () => {
      t.state.undecided = false;
      term.needsYou = true;
    });
    expect(await t.r.close("s1", "auto")).toBe("failed");
    expect(t.ended).toEqual([]);
  });

  it("does not close when the user typed after /handoff", async () => {
    const t = setup();
    const term = t.addTerm("s1");
    t.later(10_000, () => (term.typedAt = t.state.now));
    expect(await t.r.close("s1", "auto")).toBe("failed");
    expect(t.texts()).toEqual(["/handoff"]);
    expect(t.ended).toEqual([]);
    expect(t.logs.some((l) => l.includes("close s1") && l.includes("typed"))).toBe(true);
  });

  it("does not close when the recheck right before ending fails", async () => {
    const t = setup();
    const term = t.addTerm("s1");
    t.later(31_000, () => (term.recheckFails = true));
    expect(await t.r.close("s1", "manual")).toBe("failed");
    expect(t.ended).toEqual([]);
  });

  it("gives up when the handoff never comes in, and leaves the terminal open", async () => {
    const t = setup();
    t.addTerm("s1", { reactions: { "/handoff": undefined } });
    expect(await t.r.close("s1", "manual")).toBe("failed");
    expect(t.texts()).toEqual(["/handoff"]);
    expect(t.state.memoryWaits).toEqual([]);
    expect(t.ended).toEqual([]);
  });

  it("respects needs-you for both triggers; background tasks and a just-opened terminal block a manual close too", async () => {
    const t = setup();
    const term = t.addTerm("s1", { needsYou: true });
    expect(t.r.precheckClose("s1", "auto")).toBe("busy");
    expect(t.r.precheckClose("s1", "manual")).toBe("busy");
    // 换新的手动触发不看需要你；关闭要看。
    expect(t.r.precheck("s1", "manual")).toBeNull();
    term.needsYou = false;
    term.background = true;
    expect(t.r.precheckClose("s1", "manual")).toBe("busy");
    term.background = false;
    term.openedAt = t.state.now - 10_000;
    expect(t.r.precheckClose("s1", "manual")).toBe("busy");
    term.openedAt = 1;
    term.block = "draft";
    expect(await t.r.close("s1", "manual")).toBe("busy");
    term.block = null;
    expect(t.r.precheckClose("s1", "manual")).toBeNull();
    expect(t.texts()).toEqual([]);
  });

  it("cannot close without a way to end the terminal, or a session Butler cannot refresh", async () => {
    const t = setup({ noEndTerminal: true });
    t.addTerm("s1");
    expect(await t.r.close("s1", "manual")).toBe("failed");
    const u = setup();
    u.addTerm("f1", { kind: null });
    expect(u.r.precheckClose("f1", "manual")).toBe("failed");
    expect(t.texts()).toEqual([]);
  });

  it("an auto close waits out the cooldown after a failure; a manual one does not", async () => {
    const t = setup();
    const term = t.addTerm("s1", { deliverResult: { "/handoff": "exited" } });
    expect(await t.r.close("s1", "auto")).toBe("failed");
    term.deliverResult = {};
    expect(t.r.precheckClose("s1", "auto")).toBe("cooldown");
    // 失败的关闭和换新共用冷却。
    expect(t.r.precheck("s1", "auto")).toBe("cooldown");
    expect(await t.r.close("s1", "manual")).toBe("done");
  });

  it("refuses a second close or a refresh while a close is running", async () => {
    const t = setup();
    t.addTerm("s1");
    const running = t.r.close("s1", "auto");
    expect(t.r.isRefreshing("s1")).toBe(true);
    expect(await t.r.close("s1", "manual")).toBe("already");
    expect(await t.r.refresh("s1", "manual")).toBe("already");
    expect(await running).toBe("done");
    expect(t.ended).toHaveLength(1);
  });
});

describe("SessionRefresher.stop (plan 16 review)", () => {
  it("a stop during a quiet-wait ends the run without typing, reading or logging", async () => {
    const t = setup();
    let readsAtStop = -1;
    const term = t.addTerm("s1", {
      reactions: {
        // handoff 收进来之后一直忙：换新停在 /clear 之前的等待里，这时 Butler 退出。
        "/handoff": { ms: 30_000, run: () => { t.r.handoffStored("s1"); term.block = "busy"; t.later(5_000, () => { t.r.stop(); readsAtStop = t.state.reads; }); } },
      },
    });
    const before = t.logs.length;
    expect(await t.r.refresh("s1", "manual")).toBe("failed");
    expect(t.texts()).toEqual(["/handoff"]);
    expect(t.state.reads).toBe(readsAtStop);
    // 只有开始时的那一行，没有失败、没有 unexpected error。
    expect(t.logs.slice(before).filter((m) => !m.endsWith(": started"))).toEqual([]);
    expect(t.r.isRefreshing("s1")).toBe(false);
    // 停了以后什么都不再开始。
    term.block = null;
    expect(t.r.precheck("s1", "manual")).toBe("busy");
    expect(await t.r.refresh("s1", "manual")).toBe("busy");
    t.r.autoCheck();
    await t.settle();
    expect(t.texts()).toEqual(["/handoff"]);
  });

  it("a stop while waiting for epic progress stops reading StateCore", async () => {
    const t = setup();
    t.addTerm("e1", { kind: "epic", session: { epicId: 4 }, reactions: { [M().refreshEpicHandoff]: { ms: 12_000, run: () => t.r.stop() } } });
    expect(await t.r.refresh("e1", "manual")).toBe("failed");
    const reads = t.state.epicProgressReads;
    expect(t.texts()).toEqual([M().refreshEpicHandoff]);
    expect(t.logs.some((m) => m.includes("unexpected error"))).toBe(false);
    // 停下之后没有再读：最多是停的那一刻正在读的那一次。
    expect(reads).toBe(4);
  });
});

describe("refreshKindOf (plan 16)", () => {
  it("names ticket sessions, ticket coordinators, feature coordinators and epic sessions, and nothing else", () => {
    const open = (s: Session) => refreshKindOf(s, true);
    expect(open(base({ ticketKey: "DMS-1" }))).toBe("ticket");
    expect(open(base({ ticketKey: "DMS-1", coordinator: true }))).toBe("ticket");
    expect(open(base({ featureId: 3, coordinator: true }))).toBe("feature");
    expect(open(base({ epicId: 2 }))).toBe("epic");
    // 修复 session、不是 Butler 开的、没开终端的、什么都不属于的：不换新。
    expect(open(base({ featureId: 3, fixesSession: "s-stuck" }))).toBeNull();
    expect(open(base({ ticketKey: "DMS-1", origin: "discovered" }))).toBeNull();
    expect(refreshKindOf(base({ ticketKey: "DMS-1" }), false)).toBeNull();
    expect(open(base())).toBeNull();
  });
});

describe("startRefresh (plan 16)", () => {
  it("answers a refusal at once, or starts the refresh without waiting for it", async () => {
    const started: string[] = [];
    let refusal: RefreshRefusal | null = "busy";
    const r = {
      precheck: () => refusal,
      refresh: (id: string) => (started.push(id), new Promise<RefreshResult>(() => undefined)),
    };
    expect(startRefresh(r, "s1", "manual", () => undefined)).toBe("busy");
    expect(started).toEqual([]);
    refusal = null;
    expect(startRefresh(r, "s1", "manual", () => undefined)).toBeNull();
    expect(started).toEqual(["s1"]);
    // refresh 本身出了错（不应该发生）：记日志，不往外抛。
    const logs: string[] = [];
    expect(startRefresh({ precheck: () => null, refresh: () => Promise.reject(new Error("boom")) }, "s2", "coordinator", (m) => void logs.push(m))).toBeNull();
    await new Promise((res) => setImmediate(res));
    expect(logs).toEqual(["refresh s2 (coordinator) failed"]);
  });
});

describe("autoRefreshNeedsYou (R33)", () => {
  it.each([
    // reason, undecided, refreshing → 挡不挡
    [null, false, false, false],
    [null, false, true, false],
    // 判断还没出结论：不开始新的自动换新，但正在进行的换新照样往下走。
    [null, true, false, true],
    [null, true, true, false],
    // 真判断出需要你：开始前和换新中都挡。
    ["要拆成两个 PR 吗？", false, false, true],
    ["要拆成两个 PR 吗？", false, true, true],
    ["要拆成两个 PR 吗？", true, false, true],
    ["要拆成两个 PR 吗？", true, true, true],
  ])("reason=%s undecided=%s refreshing=%s → %s", (reason, undecided, refreshing, expected) => {
    expect(autoRefreshNeedsYou({ reason, undecided, refreshing })).toBe(expected);
  });
});
