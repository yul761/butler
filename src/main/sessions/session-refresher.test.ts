import { afterEach, describe, expect, it } from "vitest";
import type { SessionActivity } from "../../shared/activity";
import type { Session } from "../../shared/types";
import { setLang } from "../i18n";
import { M } from "../strings";
import type { DeliveryBlock, DeliveryCheck } from "./delivery-guard";
import {
  REFRESH_CLEAR_MS, REFRESH_COOLDOWN_MS, REFRESH_HANDOFF_MS, SessionRefresher, type RefreshKind, type SessionRefresherDeps,
} from "./session-refresher";

const base = (o: Partial<Session> = {}): Session => ({
  id: "x", ticketKey: null, cwd: "/r", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null,
  waitingForInput: true, replacedBy: null, dismissed: false, createdAt: 0, repoId: null, coordinator: false, spawnedBy: null,
  featureId: null, fixesSession: null, epicId: null, model: null, ...o,
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
}

function setup(o: { threshold?: number; commandReady?: boolean; epicPlanReady?: boolean } = {}) {
  const state = {
    now: 1_000_000,
    threshold: o.threshold ?? 150_000,
    commandReady: o.commandReady ?? true,
    epicPlanReady: o.epicPlanReady ?? true,
    memory: true,
    /** epic scope 里 epic session 写的进度（epicProgress）。 */
    epicProgress: "做到第一步" as string | null,
    epicProgressReads: 0,
    /** 读 /handoff 命令文件时发生的事（这期间用户可能开始打字）。 */
    onCommandCheck: null as (() => void) | null,
  };
  const terms: Term[] = [];
  const typed: Array<{ termId: string; text: string; at: number }> = [];
  const logs: string[] = [];
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

  const deps: SessionRefresherDeps = {
    guard: { check: check(true) },
    guardIgnoringNeedsYou: { check: check(false) },
    head: (id) => {
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
    memoryEnabled: () => state.memory,
    epicProgress: async () => {
      state.epicProgressReads++;
      return state.epicProgress;
    },
    deliver: async (termId, text) => {
      typed.push({ termId, text, at: state.now });
      const t = terms.find((x) => x.chain[0] === termId);
      const reaction = t?.reactions[text];
      if (reaction) later(reaction.ms, reaction.run);
      return t?.deliverResult[text] ?? "sent";
    },
    sessions: () => terms.map(headOf),
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
    log: (m) => void logs.push(m),
  };
  const r = new SessionRefresher(deps);

  /** 加一个终端；默认是一个停着、上下文很长的 ticket session，/handoff 30 秒后收进来，/clear 2 秒后接上新 id。 */
  const addTerm = (id: string, over: Partial<Term> = {}): Term => {
    const t: Term = {
      chain: [id], session: { ticketKey: "DMS-1" }, kind: "ticket", context: 200_000, block: null, needsYou: false, background: false,
      reactions: {}, deliverResult: {}, ...over,
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
  return { r, state, terms, typed, texts, logs, addTerm, settle, later, notified: () => notified };
}

afterEach(() => setLang("zh"));

describe("SessionRefresher (plan 16)", () => {
  it("runs handoff, clear and resume in order for a ticket session", async () => {
    const t = setup();
    const term = t.addTerm("s1");
    const started = t.state.now;
    expect(await t.r.refresh("s1", "manual")).toBe("done");
    expect(t.texts()).toEqual(["/handoff", "/clear", M().refreshResume("ticket", "DMS-1")]);
    expect(t.typed.every((x) => x.termId === "s1")).toBe(true);
    // /clear 在 handoff 收进来之后才输入，接着做的话在新 id 接上之后。
    expect(t.typed[1].at - started).toBeGreaterThanOrEqual(30_000);
    expect(t.typed[2].at - t.typed[1].at).toBeGreaterThanOrEqual(2_000);
    expect(term.chain).toHaveLength(2);
    expect(t.r.isRefreshing("s1")).toBe(false);
    expect(t.r.stepOf("s1")).toBeNull();
    expect(t.notified()).toBeGreaterThan(0);
  });

  it("the resume sentence recalls progress and then waits for the user, in both languages", () => {
    expect(M().refreshResume("ticket", "DMS-1")).toBe(
      "上下文已由 Butler 换新。先用 recall 调出 DMS-1 最新的 handoff，用一两句话说明做到哪了，然后等用户的下一条指令，不要自己开始新的工作。",
    );
    expect(M().refreshResume("feature", "支付")).toBe(
      "上下文已由 Butler 换新。先用 butler-feature 的 recall 调出这个 feature 最新的 handoff，用一两句话说明做到哪了，然后等用户的下一条指令，不要自己开始新的工作。",
    );
    expect(M().refreshResume("epic", "E1")).toContain("先用 butler-epic 的 recall 调出这个 epic 最新的 handoff");
    expect(M().refreshEpicHandoff).toBe(
      "Butler 要清空这个 session 的上下文。请先用 butler-epic 的 handoff 写下现在的进度和没解决的问题；规划有改动的话先用 set_epic_plan 更新。写完就停下。",
    );
    setLang("en");
    expect(M().refreshResume("ticket", "DMS-1")).toContain("recall");
    expect(M().refreshResume("ticket", "DMS-1")).toContain("DMS-1");
    expect(M().refreshResume("feature", "x")).toContain("butler-feature");
    expect(M().refreshResume("epic", "x")).toContain("butler-epic");
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
    expect(t.texts()).toEqual([M().refreshEpicHandoff, "/clear", M().refreshResume("epic", "")]);
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
    expect(t.texts()).toEqual(["/handoff", "/handoff", "/clear", M().refreshResume("ticket", "DMS-1")]);
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
    expect(t.texts()).toEqual(["/handoff", "/clear", M().refreshResume("ticket", "DMS-1")]);
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
    expect(t.typed.filter((x) => x.termId === "e1").map((x) => x.text)).toEqual([M().refreshEpicHandoff, "/clear", M().refreshResume("epic", "")]);
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
    expect(t.texts()[2]).toBe(M().refreshResume("feature", ""));
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
    expect(t.texts()).toEqual(["/handoff", "/clear", M().refreshResume("ticket", "DMS-1")]);
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
});
