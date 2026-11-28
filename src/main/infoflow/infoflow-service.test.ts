import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types";
import { TASK_PREFIX } from "../../shared/control";
import { noticeNeedsYou } from "../../shared/turn";
import { MAIN_STRINGS } from "../strings";
import { FLOW_DAY_MS, FLOW_NOTE_SUFFIX_MAX, FLOW_SOURCE_NAME_LIMIT, FLOW_TEXT_LIMIT } from "../../shared/infoflow";
import { NOTE_BODY_LIMIT, plainNoteBody } from "../../shared/memory";
import { ConvRepo } from "../db/conv-repo";
import { InfoflowRepo } from "../db/infoflow-repo";
import { SessionMessagesRepo } from "../db/session-messages-repo";
import { FollowupsRepo } from "../db/followups-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { withTransaction } from "../db/database";
import { insertTicket, memDb } from "../test-utils";
import { closePreview, closeTicket, reopenTicket, retryClose, type ClosablePr, type OpenPrs, type TicketCloseDeps } from "../tickets/ticket-close";
import type { ActionWorld, CloseStep, TicketActions } from "./actions";
import { infoflowTicketActions } from "./wiring";
import type { ExtractedItem, ExtractOutcome } from "./extract";
import { FLOW_KEEP_MS, FLOW_MAX_AGE_MS, FLOW_MAX_ATTEMPTS, FLOW_SETTLE_MS, InfoflowService, type InfoflowDeps } from "./infoflow-service";

const T0 = 10_000_000;

function sess(id: string, o: Partial<Session> = {}): Session {
  return {
    id, ticketKey: null, cwd: "/", origin: "shipherd", gitBranch: null, firstPrompt: null, lastActivityAt: 0, waitingForInput: false, replacedBy: null,
    dismissed: false, createdAt: 0, repoId: null, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, model: null, shipherd: false,
    lessonRunId: null, ...o,
  };
}

const item = (o: Partial<ExtractedItem>): ExtractedItem => ({
  text: "BTL-12 不做了，需求变了", kind: "state_change", speaker: "user", quote: "BTL-12 不做了", targets: ["ticket:BTL-12"], importance: "high", confidence: 0.95,
  change: { op: "close_ticket", ticket: "BTL-12", feature: undefined, reason: "需求变了", closePrs: false }, ...o,
});

function setup(
  o: {
    extract?: (n: number) => Promise<ExtractOutcome>;
    autoApply?: boolean;
    memory?: string[];
    closeGate?: Promise<void>;
    previewPrs?: { closable: string[]; unclosable: { url: string; error: string }[] };
    rememberFails?: number;
    /** 关 ticket、重试剩下的依次返回这些；用完了是 done。 */
    closeSteps?: CloseStep[];
    /** 写记忆等这个（模拟写记忆时你点了撤销）。 */
    rememberGate?: Promise<void>;
    /** 写完记忆、还没把结果交回来就「退出」：模拟中途退出。 */
    crashAfterWrite?: boolean;
    /** 用真的 closeTicket / closePreview / retryClose / reopenTicket（BTL-270），像 index.ts 那样接上；PR 是这些。 */
    realClose?: { prs: ClosablePr[]; unclosable?: OpenPrs["unclosable"]; closePr: TicketCloseDeps["closePr"] };
  } = {},
) {
  const db = memDb();
  const conv = new ConvRepo(db);
  const repo = new InfoflowRepo(db);
  const msgs = new SessionMessagesRepo(db);
  let rememberFails = o.rememberFails ?? 0;
  let crashAfterWrite = o.crashAfterWrite ?? false;
  const steps = [...(o.closeSteps ?? [])];
  let now = T0;
  const sessions = new Map<string, Session>([
    ["c4", sess("c4", { featureId: 4, coordinator: true })],
    ["g", sess("g", { shipherd: true })],
    ["t12", sess("t12", { ticketKey: "BTL-12" })],
    ["t13", sess("t13", { ticketKey: "BTL-13" })],
    ["c5", sess("c5", { featureId: 5, coordinator: true })],
    ["t50", sess("t50", { ticketKey: "BTL-50" })],
  ]);
  const live = new Set(["c4", "g", "t12", "t13", "c5", "t50"]);
  const ticket = new Map([
    ["BTL-12", { key: "BTL-12", featureId: 4 as number | null, blockId: 1 as number | null, closed: false }],
    ["BTL-13", { key: "BTL-13", featureId: 4 as number | null, blockId: 2 as number | null, closed: false }],
    ["BTL-50", { key: "BTL-50", featureId: 5 as number | null, blockId: null as number | null, closed: false }],
  ]);
  /** 这些 ticket 在「找目标」那边看不到了（归档了），world 里照样找得到。 */
  const hidden = new Set<string>();
  const paused = new Set<string>();
  /** 这些 ticket 做完了（done）：排队给它的要点要撤回。 */
  const doneTickets = new Set<string>();
  const order = new Map<number, number[]>([[4, [1, 2]]]);
  const tickets = new TicketsRepo(db);
  const closedPrs = new Set<string>();
  const closeDeps: TicketCloseDeps | null = o.realClose
    ? {
        tickets, followups: new FollowupsRepo(db), transaction: (fn) => withTransaction(db, fn),
        openPrs: async () => ({ closable: o.realClose!.prs.filter((p) => !closedPrs.has(p.url)), unclosable: o.realClose!.unclosable ?? [] }),
        closePr: async (pr, reason, x) => {
          const r = await o.realClose!.closePr(pr, reason, x);
          if (r === "closed") closedPrs.add(pr.url);
          return r;
        },
        liveSessions: () => [], endSession: () => ({ ok: true }), rederive: () => {}, refreshPrs: () => {}, notify: () => {}, now: () => now, log: () => {},
      }
    : null;
  if (closeDeps) {
    insertTicket(tickets, { key: "BTL-12", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  }
  const memory = new Map<string, string[]>();
  for (const m of o.memory ?? []) memory.set("ticket:BTL-12", [...(memory.get("ticket:BTL-12") ?? []), m]);
  const sent: { from: string; to: string; body: string; wake: boolean; item: number; ref: string; id: string }[] = [];
  const withdrawn: string[] = [];
  const calls: string[] = [];
  const previews: string[] = [];
  let extracts = 0;
  const world: ActionWorld = {
    ticket: (k) => {
      const t = ticket.get(k.toUpperCase());
      if (!t) return null;
      // 接真的关闭时，关没关看库里的手动状态。
      return closeDeps ? { ...t, closed: tickets.get(t.key)?.statusManual === "closed" } : t;
    },
    block: (epic, ref) => ([1, 2].includes(Number(ref)) && (epic === null || epic === 4) ? { id: Number(ref), featureId: 4 } : null),
    blockOrder: (f) => order.get(f) ?? [],
  };
  const act: TicketActions = {
    closeTicket: async (k, r, prs, urls) => {
      if (o.closeGate) await o.closeGate;
      calls.push(`close ${k} ${r}${prs ? ` +prs ${(urls ?? []).join(",")}` : ""}`);
      ticket.get(k)!.closed = true;
      return steps.shift() ?? { kind: "done" };
    },
    retryClose: async (k, left) => {
      calls.push(`retry ${k} ${left.prErrors.map((e) => e.url).join(",")}`);
      return steps.shift() ?? { kind: "done" };
    },
    previewClose: async (k) => {
      previews.push(k);
      return o.previewPrs ?? { closable: ["https://github.com/o/r/pull/41"], unclosable: [] };
    },
    reopenTicket: async (k) => {
      calls.push(`reopen ${k}`);
      ticket.get(k)!.closed = false;
    },
    setBlock: (k, b) => {
      calls.push(`block ${k} ${b}`);
      ticket.get(k)!.blockId = b;
    },
    reorderBlocks: (f, ids) => {
      calls.push(`order ${f} ${ids}`);
      order.set(f, ids);
    },
  };
  const realAct: TicketActions | null = closeDeps
    ? infoflowTicketActions({
        tickets: { setBlock: act.setBlock }, blocks: { reorder: () => undefined }, notify: () => {},
        closer: {
          close: (k, reason, closePrs, prUrls) => closeTicket(closeDeps, k, { reason, source: "routing", closePrs, ...(prUrls && { prUrls }), endSessions: false }),
          preview: async (k) => closePreview(closeDeps, k),
          retry: (k, x) => retryClose(closeDeps, k, x),
          reopen: async (k) => reopenTicket(closeDeps, k, "routing"),
        },
      })
    : null;
  const d: InfoflowDeps = {
    repo, conv, head: (id) => sessions.get(id) ?? null, enabled: () => true, autoApply: () => o.autoApply ?? true,
    sourceOf: (s) => ({ ticketKey: s.ticketKey, featureId: s.featureId ?? (s.ticketKey ? (ticket.get(s.ticketKey)?.featureId ?? null) : null), shipherd: s.shipherd }),
    nameOf: (id) => `S(${id})`,
    context: () => ({ source: "x", epics: [], tickets: [], features: [] }),
    targets: {
      ticket: (k) => {
        const t = hidden.has(k.trim().toUpperCase()) ? undefined : ticket.get(k.trim().toUpperCase());
        return t ? { key: t.key, featureId: t.featureId } : null;
      },
      epic: (s) => (s === "4" ? 4 : s === "5" ? 5 : null),
    },
    epicOfTicket: (k) => (hidden.has(k) ? null : (ticket.get(k)?.featureId ?? null)),
    recipients: {
      ticketHeads: (k) => [...sessions.values()].filter((s) => s.ticketKey === k),
      epicHeads: (f) => [...sessions.values()].filter((s) => s.featureId === f || (s.ticketKey !== null && ticket.get(s.ticketKey)?.featureId === f)),
      coordinator: (f) => (f === 4 ? sessions.get("c4")! : f === 5 ? sessions.get("c5")! : null),
      shipherd: () => sessions.get("g")!,
      coordinators: () => [sessions.get("c4")!, sessions.get("c5")!],
      live: (id) => live.has(id),
    },
    extract: () => (o.extract ?? (async () => ({ ok: true, items: [item({})], dropped: 0 })))(++extracts),
    cwdOf: () => "/",
    paused: (id) => paused.has(id),
    remember: async (scope, text, findDup) => {
      if (o.rememberGate) await o.rememberGate;
      if (rememberFails > 0) {
        rememberFails--;
        throw new Error("memory down");
      }
      const cur = memory.get(scope) ?? [];
      const dupOf = findDup(cur);
      if (dupOf !== null) return { result: "dup", dupOf };
      memory.set(scope, [...cur, text]);
      if (crashAfterWrite) {
        crashAfterWrite = false;
        throw new Error("quit before the result came back");
      }
      return { result: "written", dupOf: null };
    },
    forget: async (scope, match) => {
      const cur = memory.get(scope) ?? [];
      memory.set(scope, cur.filter((t) => !match(t)));
      return cur.length - (memory.get(scope) ?? []).length;
    },
    send: (m) => {
      const id = `m${sent.length + 1}`;
      msgs.enqueue({ id, kind: "fact", fromSession: m.from, toSession: m.to, featureId: null, body: m.body, ref: m.ref, meta: m.meta, queuedAt: now });
      sent.push({ from: m.from, to: m.to, body: m.body, wake: m.meta.wake, item: m.meta.item, ref: m.ref, id });
      return { id };
    },
    withdraw: (ref) => {
      if (msgs.withdraw(ref)) withdrawn.push(ref);
    },
    // 和 wiring 的 finished 一样：挂的 ticket 关了（或者测试里标成做完了）。
    finished: (id) => {
      const k = sessions.get(id)?.ticketKey ?? null;
      return k !== null && (doneTickets.has(k) || (world.ticket(k)?.closed ?? false));
    },
    world, act: realAct ?? act, strings: () => MAIN_STRINGS.zh.infoflow, blockName: (id) => (id === 1 ? "登录" : id === 2 ? "导出" : null),
    notify: () => {}, now: () => now, log: () => {},
  };
  const svc = new InfoflowService(d);
  const turn = (sessionId: string, user: string, agent: string, kind: "user" | "silent" = "user", endedAt = now - FLOW_SETTLE_MS - 1) => {
    const id = conv.openTurn({ rootSessionId: sessionId, sessionId, sourceKey: `k${Math.random()}`, forkId: null, kind, at: endedAt - 10, asked: false });
    if (user) conv.addMessage({ turnId: id, rootSessionId: sessionId, sessionId, role: "user", text: user, at: endedAt - 10, forkId: null, sourceKey: null });
    conv.addMessage({ turnId: id, rootSessionId: sessionId, sessionId, role: "assistant", text: agent, at: endedAt - 5, forkId: null, sourceKey: null });
    conv.touchTurn(id, { at: endedAt, endedAt });
    return id;
  };
  const run = async () => {
    svc.poke();
    await svc.idle();
  };
  return {
    svc, repo, conv, msgs, d, sent, withdrawn, calls, previews, tickets, closedPrs, memory, ticket, live, sessions, order, turn, run, hidden, paused, doneTickets,
    extracts: () => extracts, setNow: (n: number) => (now = n), now: () => now,
  };
}

const USER = "BTL-12 不做了，需求变了，客户那边定了以后不要这个功能";
/** 不带状态变化的决定：不用等确认，马上记、发。 */
const decision = (o: Partial<ExtractedItem> = {}) => async (): Promise<ExtractOutcome> => ({ ok: true, items: [item({ kind: "decision", change: null, ...o })], dropped: 0 });
const AGENT = "好的，我记下了：BTL-12 取消，后面不再做。";

describe("InfoflowService (BTL-272)", () => {
  it("writes to the narrowest memory, sends to the ticket but not back to the source, and handles each turn once", async () => {
    const t = setup({ extract: decision() });
    const id = t.turn("c4", USER, AGENT);
    await t.run();
    expect(t.memory.get("ticket:BTL-12")).toEqual(["BTL-12 不做了，需求变了（来自 S(c4) 的对话）"]);
    expect(t.sent.map((s) => [s.from, s.to, s.wake])).toEqual([["c4", "t12", true]]);
    expect(t.sent[0].body).toContain("BTL-12 不做了，需求变了");
    const [v] = t.svc.list({ all: true });
    expect(v).toMatchObject({ turnId: id, scope: "ticket:BTL-12", memory: "written", targets: ["ticket:BTL-12"], source: "S(c4)" });
    expect(v.deliveries.map((x) => x.toSession)).toEqual(["t12"]);
    await t.run();
    expect(t.extracts()).toBe(1);
    expect(t.svc.turnText(id).messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("skips turns the prefilter drops without asking the model", async () => {
    const t = setup();
    t.turn("t12", "好", "好的。");
    await t.run();
    expect(t.extracts()).toBe(0);
    expect(t.repo.pendingTurns(0, t.now(), 10)).toEqual([]);
  });

  it("handles bad model output safely: retried a few times then final, a busy model retries until the turn is too old", async () => {
    const bad = setup({ extract: async () => ({ ok: false, later: false, error: "bad_output: items is not an array" }) });
    bad.turn("c4", USER, AGENT);
    for (let i = 0; i < FLOW_MAX_ATTEMPTS + 2; i++) await bad.run();
    expect(bad.extracts()).toBe(FLOW_MAX_ATTEMPTS);
    expect(bad.sent).toEqual([]);
    expect(bad.repo.pendingTurns(0, bad.now(), 10)).toEqual([]);

    const busy = setup({ extract: async () => ({ ok: false, later: true, error: "rate_limited" }) });
    busy.turn("c4", USER, AGENT, "user", T0 - FLOW_MAX_AGE_MS + 60_000);
    await busy.run();
    expect(busy.repo.pendingTurns(0, busy.now(), 10)).toHaveLength(1);
    busy.setNow(T0 + 30_000);
    await busy.run();
    expect(busy.extracts()).toBe(2);
    // 过了 2 小时就不再问模型。
    busy.setNow(T0 + 120_000);
    await busy.run();
    expect(busy.extracts()).toBe(2);
  });

  it("drops the result when the turn grew while the model was thinking, and redoes it with the new text", async () => {
    let turnId = 0;
    const t: ReturnType<typeof setup> = setup({
      autoApply: false,
      extract: async (n) => {
        if (n === 1) t.conv.touchTurn(turnId, { at: t.now() - FLOW_SETTLE_MS });
        return { ok: true, items: [item({ text: n === 1 ? "旧的结论" : "新的结论：BTL-12 不做了", change: null })], dropped: 0 };
      },
    });
    turnId = t.turn("c4", USER, AGENT);
    await t.run();
    expect(t.svc.list({ all: true })).toEqual([]);
    await t.run();
    expect(t.svc.list({ all: true }).map((i) => i.text)).toEqual(["新的结论：BTL-12 不做了"]);
  });

  it("does not write or send what memory or a recent item already has", async () => {
    const t = setup({ memory: ["BTL-12 不做了，需求变了（来自 S(t12) 的对话）"], extract: decision() });
    t.turn("c4", USER, AGENT);
    await t.run();
    expect(t.sent).toEqual([]);
    expect(t.svc.list({ all: true })[0].memory).toBe("dup");

    const r = setup({ extract: decision() });
    r.turn("c4", USER, AGENT);
    r.turn("g", USER, AGENT);
    await r.run();
    expect(r.sent).toHaveLength(1);
    expect(r.svc.list({ all: true }).map((i) => i.memory).sort()).toEqual(["dup", "written"]);
  });

  it("applies what the user clearly said, tells the coordinators, and can undo it", async () => {
    const t = setup();
    t.turn("t12", USER, AGENT);
    await t.run();
    expect(t.calls).toEqual(["close BTL-12 需求变了"]);
    const [s] = t.svc.synced();
    expect(s.label).toBe("关掉 BTL-12（需求变了）");
    expect(t.sent.filter((m) => m.body.startsWith("【已替用户同步")).map((m) => m.to).sort()).toEqual(["c4", "g"]);
    expect(await t.svc.act(s.id, "undo")).toBe(true);
    expect(await t.svc.act(s.id, "undo")).toBe(false);
    expect(t.calls).toEqual(["close BTL-12 需求变了", "reopen BTL-12"]);
    expect(t.svc.list({ all: true })[0].action).toMatchObject({ state: "undone", mode: "auto" });
  });

  it("asks before acting on what the agent said, on PR closing, or with auto-apply off", async () => {
    for (const [o, it] of [
      [{}, item({ speaker: "agent" })],
      [{}, item({ change: { op: "close_ticket", ticket: "BTL-12", feature: undefined, reason: null, closePrs: true } })],
      [{ autoApply: false }, item({})],
    ] as const) {
      const t = setup({ ...o, extract: async () => ({ ok: true, items: [it], dropped: 0 }) });
      t.turn("t12", USER, AGENT);
      await t.run();
      expect(t.calls).toEqual([]);
      const [p] = t.svc.proposals();
      expect(p.source).toBe("S(t12)");
      expect(await t.svc.act(p.id, "apply")).toBe(true);
      expect(await t.svc.act(p.id, "apply")).toBe(false);
      expect(t.calls).toHaveLength(1);
      expect(t.svc.proposals()).toEqual([]);
    }
  });

  it("does not redo what is already done, even when it happened while the model was thinking", async () => {
    const t: ReturnType<typeof setup> = setup({
      extract: async () => {
        // agent 在这期间用 close_ticket 工具自己关了。
        t.ticket.get("BTL-12")!.closed = true;
        return { ok: true, items: [item({})], dropped: 0 };
      },
    });
    t.turn("t12", USER, AGENT);
    await t.run();
    expect(t.calls).toEqual([]);
    expect(t.svc.list({ all: true })[0].action?.state).toBe("already");
    expect(t.svc.synced()).toEqual([]);
  });

  it("proposes the same change only once", async () => {
    const t = setup({ autoApply: false });
    t.turn("c4", USER, AGENT);
    t.turn("g", "以后不做 BTL-12 了，那个需求被砍掉了，跟大家说一下", "收到，BTL-12 取消。");
    await t.run();
    expect(t.svc.proposals()).toHaveLength(1);
  });

  it("drops a waiting card when things change, and a background turn never wakes anyone", async () => {
    const t = setup({ autoApply: false });
    t.turn("c4", USER, AGENT);
    await t.run();
    t.ticket.delete("BTL-12");
    expect(t.svc.proposals()).toEqual([]);
    expect(t.svc.list({ all: true })[0].action?.state).toBe("stale");

    const s = setup({ extract: async () => ({ ok: true, items: [item({ change: null, text: "接口一律分页返回，别再一次给全部" })], dropped: 0 }) });
    s.turn("c4", "", "已经通知了：接口一律分页返回，别再一次给全部。", "silent");
    await s.run();
    expect(s.sent.map((m) => m.wake)).toEqual([false]);
  });

  it("shows waiting cards and recent syncs as notices without writing, and sweeps stale cards on the next pass", async () => {
    const t = setup({ autoApply: false });
    t.turn("c4", USER, AGENT);
    await t.run();
    expect(t.svc.notices().map((n) => n.kind)).toEqual(["flow_proposal"]);
    t.ticket.delete("BTL-12");
    expect(t.svc.notices()).toEqual([]);
    expect(t.repo.pending()).toHaveLength(1);
    await t.run();
    expect(t.repo.pending()).toEqual([]);

    const a = setup();
    a.turn("t12", USER, AGENT);
    await a.run();
    const [n] = a.svc.notices();
    expect(n).toMatchObject({ kind: "flow_synced", label: "关掉 BTL-12（需求变了）", source: "S(t12)" });
    expect(await a.svc.act(n.kind === "flow_synced" ? n.actionId : 0, "dismiss")).toBe(true);
    expect(a.svc.notices()).toEqual([]);
  });

  it("never sends to the source when the target is the source's own scope", async () => {
    const t = setup({ extract: async () => ({ ok: true, items: [item({ change: null, targets: ["made-up"], text: "测试一律用真数据库，不要 mock" })], dropped: 0 }) });
    t.turn("t12", "以后测试一律用真数据库，不要 mock 掉，这个是硬性规定", "好的。");
    await t.run();
    // 默认目标是来源自己的 ticket：只有 t12 自己，不发。
    expect(t.sent).toEqual([]);
    expect(t.memory.get("ticket:BTL-12")).toHaveLength(1);
  });

  it("holds a waiting change: nothing written or sent until you confirm, then tells the coordinators it was confirmed", async () => {
    const t = setup({ autoApply: false });
    t.turn("c4", USER, AGENT);
    await t.run();
    expect(t.sent).toEqual([]);
    expect(t.memory.get("ticket:BTL-12")).toBeUndefined();
    expect(t.svc.list({ all: true })[0].memory).toBe("held");
    // 等确认的不算没跟进完：后台再跑一遍也不发。
    await t.run();
    expect(t.sent).toEqual([]);
    const [p] = t.svc.proposals();
    expect(await t.svc.act(p.id, "apply")).toBe(true);
    expect(t.memory.get("ticket:BTL-12")).toHaveLength(1);
    expect(t.sent.map((m) => m.to).sort()).toEqual(["g", "t12"]);
    expect(t.sent.find((m) => m.to === "g")!.body.startsWith("【已同步 · ")).toBe(true);
    expect(t.sent.find((m) => m.to === "t12")!.body.startsWith("【要点")).toBe(true);
    expect(t.repo.unfollowed(10)).toEqual([]);
  });

  it("drops what you rejected: not written, not sent, followed", async () => {
    const t = setup({ autoApply: false });
    t.turn("c4", USER, AGENT);
    await t.run();
    const [p] = t.svc.proposals();
    expect(await t.svc.act(p.id, "reject")).toBe(true);
    expect(t.sent).toEqual([]);
    expect(t.memory.get("ticket:BTL-12")).toBeUndefined();
    expect(t.svc.list({ all: true })[0]).toMatchObject({ memory: "dropped", action: { state: "rejected" } });
    expect(t.repo.unfollowed(10)).toEqual([]);
    await t.run();
    expect(t.sent).toEqual([]);
  });

  it("only remembers what an agent says back about a routed fact, so facts do not bounce between sessions", async () => {
    const t = setup({
      extract: async () => ({
        ok: true,
        items: [
          item({ kind: "decision", change: null, speaker: "agent", targets: ["epic:4"], text: "收到：导出接口一律分页" }),
          item({ kind: "convention", change: null, speaker: "user", targets: ["epic:4"], text: "以后提交前一律跑 e2e" }),
        ],
        dropped: 0,
      }),
    });
    const endedAt = t.now() - FLOW_SETTLE_MS - 1;
    t.msgs.enqueue({ id: "f0", kind: "fact", fromSession: "c4", toSession: "t13", featureId: null, body: "x", queuedAt: endedAt - 20 });
    t.msgs.delivered("f0", { at: endedAt - 8, via: "input", toSession: "t13", baseReplyId: null });
    t.turn("t13", "以后提交前一律跑 e2e，这是规定", "收到：导出接口一律分页。", "user", endedAt);
    await t.run();
    const list = t.svc.list({ all: true });
    const agent = list.find((i) => i.speaker === "agent")!;
    const user = list.find((i) => i.speaker === "user")!;
    expect(agent.memory).toBe("written");
    expect(agent.deliveries).toEqual([]);
    // 用户亲口说的照样发。
    expect(user.deliveries.map((d) => d.toSession).sort()).toEqual(["c4", "t12"]);
  });

  it("does not ask the model about a background turn that only answered a routed fact (no user words); a user turn still is", async () => {
    const t = setup({ extract: decision({ speaker: "agent" }) });
    const endedAt = t.now() - FLOW_SETTLE_MS - 1;
    t.msgs.enqueue({ id: "f0", kind: "fact", fromSession: "c4", toSession: "t13", featureId: null, body: "x", queuedAt: endedAt - 20 });
    t.msgs.delivered("f0", { at: endedAt - 8, via: "input", toSession: "t13", baseReplyId: null });
    const silent = t.turn("t13", "", "收到：导出接口一律分页，以后都按这个来。", "silent", endedAt);
    await t.run();
    expect(t.extracts()).toBe(0);
    expect(t.repo.turnHandled(silent)).toBe(true);
    // 没收到要点的后台轮、收到了要点但用户说了话的轮：照样问。
    t.turn("t12", "", "已经通知了：接口一律分页返回，别再一次给全部。", "silent");
    t.turn("t13", "以后提交前一律跑 e2e，这是规定", "收到。", "user", endedAt + 1);
    await t.run();
    expect(t.extracts()).toBe(2);
  });

  it("stops asking the model once the daily cap is reached, says so on the Now page, and goes on when the window frees up", async () => {
    const t = setup({ extract: decision() });
    t.d.dailyAsks = () => 2;
    const first = t.now();
    t.turn("t12", "以后提交前一律跑 e2e，这是规定", "好。", "user", first - FLOW_SETTLE_MS - 30);
    t.turn("t13", "以后一律先写测试再写代码，大家都照这个来", "好。", "user", first - FLOW_SETTLE_MS - 20);
    const third = t.turn("t50", "以后统一用 pnpm，不许再用 npm", "好。", "user", first - FLOW_SETTLE_MS - 10);
    await t.run();
    expect(t.extracts()).toBe(2);
    // 第三轮没记成处理过：额度回来还会问。
    expect(t.repo.turnHandled(third)).toBe(false);
    const n = t.svc.notices().find((x) => x.kind === "flow_capped");
    expect(n).toEqual({ kind: "flow_capped", used: 2, cap: 2, resumesAt: first + FLOW_DAY_MS, dropped: 0 });
    expect(noticeNeedsYou(n!)).toBe(false);
    // 重启以后照样数得到（存在库里）。
    expect(new InfoflowService(t.d).notices().some((x) => x.kind === "flow_capped")).toBe(true);

    // 最早那次满 24 小时：没有新的轮，提醒也要消失（通知刷新）。
    let notified = 0;
    t.d.notify = () => void notified++;
    t.setNow(first + FLOW_DAY_MS + 1);
    await t.run();
    expect(notified).toBeGreaterThan(0);
    expect(t.svc.notices().some((x) => x.kind === "flow_capped")).toBe(false);
    // 接着问第三轮（它在 FLOW_MAX_AGE_MS 以内才会被捡起来，这里把它挪近一点）。
    t.turn("t50", "以后统一用 pnpm，不许再用 npm", "好。");
    await t.run();
    expect(t.extracts()).toBe(3);
    expect(t.svc.notices().some((x) => x.kind === "flow_capped")).toBe(false);
  });

  it("prunes records older than FLOW_KEEP_MS on a background pass, at most every FLOW_PRUNE_EVERY_MS", async () => {
    const t = setup({ extract: decision() });
    const id = t.turn("c4", USER, AGENT);
    await t.run();
    expect(t.svc.list({ all: true })).toHaveLength(1);
    expect(t.repo.turnHandled(id)).toBe(true);
    expect(t.repo.asksSince(0).count).toBe(1);
    // 消息已经递出去（不在排队），过了留存期就清掉。
    for (const m of t.sent) t.msgs.delivered(m.id, { at: t.now(), via: "hook", toSession: m.to, baseReplyId: null });
    t.setNow(t.now() + FLOW_KEEP_MS + 1);
    await t.run();
    expect(t.svc.list({ all: true })).toEqual([]);
    expect(t.repo.turnHandled(id)).toBe(false);
    expect(t.repo.asksSince(0).count).toBe(0);
  });

  it("does not count a pass where the model was busy (later) against the cap", async () => {
    const t = setup({ extract: async () => ({ ok: false, error: "busy", later: true }) });
    t.d.dailyAsks = () => 1;
    t.turn("t12", USER, AGENT);
    await t.run();
    await t.run();
    expect(t.repo.asksSince(0).count).toBe(0);
  });

  it("never applies a task the coordinator handed over as if the user said it", async () => {
    const t = setup();
    t.turn("t12", `${TASK_PREFIX.zh}${USER}`, AGENT);
    await t.run();
    expect(t.extracts()).toBe(1);
    expect(t.calls).toEqual([]);
    expect(t.svc.proposals()).toHaveLength(1);
  });

  it("picks up where it stopped: an item left unfollowed is finished on the next pass, once", async () => {
    const t = setup({ extract: decision(), rememberFails: 1 });
    t.turn("c4", USER, AGENT);
    await t.run();
    expect(t.sent).toEqual([]);
    expect(t.repo.unfollowed(10)).toHaveLength(1);
    // 重启：新的 service 从库里接着做，不再问模型。
    const again = new InfoflowService(t.d);
    again.poke();
    await again.idle();
    expect(t.extracts()).toBe(1);
    expect(t.sent.map((m) => m.to)).toEqual(["t12"]);
    expect(t.memory.get("ticket:BTL-12")).toHaveLength(1);
    again.poke();
    await again.idle();
    expect(t.sent).toHaveLength(1);
  });

  it("on undo withdraws what is still queued and tells only those who already got it, even with no one live", async () => {
    const t = setup();
    t.turn("t12", USER, AGENT);
    await t.run();
    const c4 = t.sent.find((m) => m.to === "c4")!;
    const g = t.sent.find((m) => m.to === "g")!;
    t.msgs.delivered(c4.id, { at: t.now(), via: "hook", toSession: "c4", baseReplyId: null });
    t.live.clear();
    const [s] = t.svc.synced();
    expect(await t.svc.act(s.id, "undo")).toBe(true);
    expect(t.withdrawn).toEqual([g.ref]);
    expect(t.msgs.get(g.id)).toBeNull();
    const undone = t.sent.filter((m) => m.body.startsWith("【已撤销"));
    expect(undone.map((m) => m.to)).toEqual(["c4"]);
  });

  it("does not undo what was changed again since", async () => {
    const t = setup();
    t.turn("t12", USER, AGENT);
    await t.run();
    t.ticket.get("BTL-12")!.closed = false;
    const [s] = t.svc.synced();
    expect(await t.svc.act(s.id, "undo")).toBe(false);
    expect(t.calls).toEqual(["close BTL-12 需求变了"]);
    expect(t.svc.list({ all: true })[0].action?.state).toBe("stale");
  });

  it("stores the undo before closing, so a close interrupted by a quit counts as executed and can still be undone", async () => {
    // 关 ticket 卡在等 gh（永远不回来）：模拟这时 Shipherd 退出了。ticket 其实已经关上了。
    const t = setup({ closeGate: new Promise<void>(() => {}) });
    t.turn("t12", USER, AGENT);
    t.svc.poke();
    await new Promise((r) => setTimeout(r, 20));
    const [a] = t.svc.list({ all: true }).map((i) => i.action);
    expect(a?.state).toBe("pending");
    expect(t.repo.action(a!.id)!.undo).toBe(JSON.stringify({ op: "reopen_ticket", ticket: "BTL-12" }));
    t.ticket.get("BTL-12")!.closed = true;

    // 重启：同一个库，新的服务。不是 already（那样撤销就丢了），是 applied，带着撤销。
    const again = new InfoflowService(t.d);
    again.poke();
    await again.idle();
    expect(again.list({ all: true })[0]).toMatchObject({ action: { state: "applied", undoable: true }, memory: "written" });
    const [s] = again.synced();
    expect(await again.act(s.id, "undo")).toBe(true);
    expect(t.calls).toContain("reopen BTL-12");
    expect(t.ticket.get("BTL-12")!.closed).toBe(false);
  });

  it("an interrupted close with PRs lists the PRs still open as left over (retry / leave it), not done; a confirmed one goes on by itself after a restart", async () => {
    const t = setup({
      autoApply: false, closeGate: new Promise<void>(() => {}),
      extract: async () => ({ ok: true, items: [item({ change: { op: "close_ticket", ticket: "BTL-12", feature: undefined, reason: "需求变了", closePrs: true } })], dropped: 0 }),
    });
    t.turn("c4", USER, AGENT);
    await t.run();
    const [p] = t.svc.proposals();
    void t.svc.act(p.id, "apply");
    await new Promise((r) => setTimeout(r, 20));
    t.ticket.get("BTL-12")!.closed = true;
    // 重启：确认模式下你已经点过「照做」（存了撤销用的旧状态），不再问你一次，后台那一遍自己接着做完。
    const again = new InfoflowService(t.d);
    expect(again.proposals()).toEqual([]);
    expect(again.notices().some((n) => n.kind === "flow_proposal")).toBe(false);
    again.poke();
    await again.idle();
    const v = again.list({ all: true })[0];
    expect(v.action).toMatchObject({ state: "partial", undoable: true });
    expect(v.action?.leftovers?.prErrors).toEqual([{ url: "https://github.com/o/r/pull/41", error: MAIN_STRINGS.zh.infoflow.interrupted, kind: "failed" }]);
    expect(await again.act(p.id, "retry")).toBe(true);
    expect(t.calls.at(-1)).toBe("retry BTL-12 https://github.com/o/r/pull/41");
    expect(again.list({ all: true })[0].action?.state).toBe("applied");
  });

  it("an interrupted close the user reopened by hand while extraction was off is not closed again once it is back on", async () => {
    // 关 ticket 卡在等 gh 时 Shipherd 退出了；ticket 当时已经关上了。
    const t = setup({ closeGate: new Promise<void>(() => {}) });
    t.turn("t12", USER, AGENT);
    t.svc.poke();
    await new Promise((r) => setTimeout(r, 20));
    t.ticket.get("BTL-12")!.closed = true;
    // 假的 closeTicket 过了闸门才记一笔：卡住的那次不算，之后只要再关一次就会记下。
    const closes = () => t.calls.filter((c) => c.startsWith("close ")).length;
    expect(closes()).toBe(0);
    // 重启时「自动抽要点」关着；你手动重新打开了 ticket。
    t.d.enabled = () => false;
    t.ticket.get("BTL-12")!.closed = false;
    const again = new InfoflowService(t.d);
    again.poke();
    await again.idle();
    // 关着也先了结：被改回去了，记成作废（不花模型的钱）。
    expect(again.list({ all: true })[0].action).toMatchObject({ state: "stale" });
    expect(t.extracts()).toBe(1);
    // 再打开：不会再关一次（也不会再关 PR、再发评论），这条要点不记不发。
    t.d.enabled = () => true;
    again.poke();
    await again.idle();
    expect(closes()).toBe(0);
    expect(t.ticket.get("BTL-12")!.closed).toBe(false);
    expect(again.list({ all: true })[0]).toMatchObject({ action: { state: "stale" }, memory: "dropped" });
    expect(again.synced()).toEqual([]);
  });

  it("a close that was already so before Shipherd touched it is still already (nothing to undo)", async () => {
    const t = setup();
    t.ticket.get("BTL-12")!.closed = true;
    t.turn("t12", USER, AGENT);
    await t.run();
    expect(t.svc.list({ all: true })[0].action).toMatchObject({ state: "already" });
    expect(t.repo.action(t.svc.list({ all: true })[0].action!.id)!.undo).toBeNull();
  });

  it("ignores a reject clicked while the change is running", async () => {
    let release!: () => void;
    const t = setup({ autoApply: false, closeGate: new Promise((r) => (release = r)) });
    t.turn("c4", USER, AGENT);
    await t.run();
    const [p] = t.svc.proposals();
    const applying = t.svc.act(p.id, "apply");
    expect(t.svc.proposals()).toEqual([]);
    expect(await t.svc.act(p.id, "reject")).toBe(false);
    release();
    expect(await applying).toBe(true);
    expect(t.svc.list({ all: true })[0]).toMatchObject({ memory: "written", action: { state: "applied" } });
  });

  it("dedupes only within the scopes that cover an item: another epic saying the same thing still gets it", async () => {
    const t = setup({ extract: decision({ targets: [], text: "接口一律分页返回" }) });
    t.turn("t12", USER, AGENT);
    t.turn("t50", USER, AGENT);
    await t.run();
    expect(t.svc.list({ all: true }).map((i) => i.memory)).toEqual(["written", "written"]);
  });

  it("skips turns of a paused session without starving the others behind them", async () => {
    const t = setup({ extract: decision() });
    t.paused.add("t13");
    const base = t.now() - FLOW_SETTLE_MS - 10_000;
    for (let i = 0; i < 40; i++) t.turn("t13", USER, AGENT, "user", base + i);
    t.turn("c4", USER, AGENT, "user", base + 100);
    await t.run();
    expect(t.extracts()).toBe(1);
    expect(t.repo.pendingTurns(0, t.now(), 100)).toHaveLength(40);
  });

  it("tells the epic coordinator about a ticket that can no longer be found as a target (closed, archived)", async () => {
    const t = setup();
    t.hidden.add("BTL-12");
    t.turn("t12", USER, AGENT);
    await t.run();
    expect(t.calls).toEqual(["close BTL-12 需求变了"]);
    expect(t.sent.filter((m) => m.body.startsWith("【已替用户同步")).map((m) => m.to).sort()).toEqual(["c4", "g"]);
  });

  it("sends each session one message per item: the coordinator gets the sync note, not the fact again", async () => {
    const t = setup({ extract: async () => ({ ok: true, items: [item({ targets: ["epic:4"] })], dropped: 0 }) });
    t.turn("t12", USER, AGENT);
    await t.run();
    const to = t.sent.map((m) => m.to).sort();
    expect(to).toEqual([...new Set(to)]);
    expect(t.sent.find((m) => m.to === "c4")!.body.startsWith("【已替用户同步")).toBe(true);
    expect(t.sent.find((m) => m.to === "t13")!.body.startsWith("【要点")).toBe(true);
  });

  it("takes a repeat seriously once the earlier sync was reverted by hand", async () => {
    const t = setup();
    t.turn("t12", USER, AGENT);
    await t.run();
    expect(t.calls).toEqual(["close BTL-12 需求变了"]);
    t.ticket.get("BTL-12")!.closed = false;
    t.setNow(t.now() + 60_000);
    t.turn("t12", "BTL-12 不做了，我刚才手滑又打开了，还是关掉", AGENT);
    await t.run();
    expect(t.calls).toEqual(["close BTL-12 需求变了", "close BTL-12 需求变了"]);
    // 结果还在时再说一遍：不再提。
    t.setNow(t.now() + 60_000);
    t.turn("t12", "BTL-12 不做了，再说一遍", AGENT);
    await t.run();
    expect(t.calls).toHaveLength(2);
  });

  it("drops a half-done close once the ticket is reopened by hand, and takes the repeat as new", async () => {
    const left: CloseStep = { kind: "partial", leftovers: { prErrors: [{ url: "https://x/pull/41", error: "gh: 502", kind: "failed" }], sessionErrors: [] } };
    const t = setup({ closeSteps: [left] });
    t.turn("t12", USER, AGENT);
    await t.run();
    const v = () => t.svc.list({ all: true });
    expect(v()[0].action?.state).toBe("partial");
    expect(t.svc.notices().some((n) => n.kind === "flow_partial")).toBe(true);
    // 你在 GitHub / Shipherd 里手动重新打开了：过了「已同步」显示的那几天也照样核对。
    t.ticket.get("BTL-12")!.closed = false;
    t.setNow(t.now() + 4 * 24 * 3600_000);
    await t.run();
    expect(v()[0].action?.state).toBe("stale");
    expect(v()[0].memory).toBe("dropped");
    expect(t.svc.notices().some((n) => n.kind === "flow_partial")).toBe(false);
    // 再说一遍：是新的要求，重新关。
    t.turn("t12", "BTL-12 不做了，还是关掉", AGENT);
    await t.run();
    expect(t.calls).toEqual(["close BTL-12 需求变了", "close BTL-12 需求变了"]);
    expect(v().find((x) => x.action?.state === "applied")).toBeTruthy();
  });

  it("a longest item from a long-named session still fits one memory note, so undo finds and forgets it", async () => {
    // 抽取那边已经把要点截到 FLOW_TEXT_LIMIT（extract.test 里测）：这里就用最长的。
    const long = "长".repeat(FLOW_TEXT_LIMIT);
    const t = setup({ extract: async () => ({ ok: true, items: [item({ text: long })], dropped: 0 }) });
    t.d.nameOf = () => "名".repeat(200);
    // 和真的记忆一样：写进去的正文截到 NOTE_BODY_LIMIT。
    const write = t.d.remember;
    t.d.remember = (scope, text, findDup) => write(scope, plainNoteBody(text), findDup);
    t.turn("t12", USER, AGENT);
    await t.run();
    const [stored] = t.memory.get("ticket:BTL-12")!;
    expect(stored.length).toBeLessThanOrEqual(NOTE_BODY_LIMIT);
    // 写进去的没被截：就是记下的那一整条。
    expect(stored).toBe(t.repo.item(t.svc.list({ all: true })[0].id)!.note);
    expect(stored.startsWith(long)).toBe(true);
    for (const lang of ["zh", "en"] as const) {
      expect(MAIN_STRINGS[lang].infoflow.source("名".repeat(FLOW_SOURCE_NAME_LIMIT)).length).toBeLessThanOrEqual(FLOW_NOTE_SUFFIX_MAX);
    }
    const [s] = t.svc.synced();
    expect(await t.svc.act(s.id, "undo")).toBe(true);
    expect(t.memory.get("ticket:BTL-12")).toEqual([]);
    expect(t.svc.list({ all: true })[0].memory).toBe("retracted");
  });

  it("does not mark the item retracted when undo forgot nothing, and leaves the same sentence another session wrote", async () => {
    const t = setup();
    t.turn("t12", USER, AGENT);
    await t.run();
    const mine = t.memory.get("ticket:BTL-12")![0];
    // 另一个 session 说过同一句话：来源注记不一样，不是这条要点写的。
    const theirs = mine.replace("S(t12)", "S(t13)");
    t.memory.set("ticket:BTL-12", [theirs]);
    const [s] = t.svc.synced();
    expect(await t.svc.act(s.id, "undo")).toBe(true);
    expect(t.memory.get("ticket:BTL-12")).toEqual([theirs]);
    expect(t.svc.list({ all: true })[0].memory).toBe("written");
  });

  it("never writes a secret into memory, mail or the DB, even from a row stored before masking", async () => {
    const tok = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    // 抽取那边的打码在 extract.test 里测；这里模拟没打过码的行（这一版以前存下的），写出去之前还要再打一遍。
    const t = setup({ extract: decision({ text: `部署机器人用 ${tok} 推镜像`, quote: "部署机器人" }) });
    t.turn("c4", "部署机器人用那个 token 推镜像", AGENT);
    await t.run();
    expect(JSON.stringify([...t.memory.values()])).not.toContain("ghp_");
    expect(t.sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(t.sent)).not.toContain("ghp_");
    expect(t.repo.item(t.svc.list({ all: true })[0].id)!.note).not.toContain("ghp_");
  });

  it("forgets the memory note on undo, so later sessions and dedupe no longer see it", async () => {
    const t = setup();
    t.turn("t12", USER, AGENT);
    await t.run();
    expect(t.memory.get("ticket:BTL-12")).toHaveLength(1);
    const [s] = t.svc.synced();
    expect(await t.svc.act(s.id, "undo")).toBe(true);
    expect(t.memory.get("ticket:BTL-12")).toEqual([]);
    expect(t.svc.list({ all: true })[0].memory).toBe("retracted");
    expect(t.repo.recentTexts(0, ["ticket:BTL-12"], 10)).toEqual([]);
  });

  it("keeps memory as written when it cannot forget on undo", async () => {
    const t = setup();
    t.d.forget = async () => null;
    t.turn("t12", USER, AGENT);
    await t.run();
    const [s] = t.svc.synced();
    expect(await t.svc.act(s.id, "undo")).toBe(true);
    expect(t.svc.list({ all: true })[0].memory).toBe("written");
  });

  it("recognises its own note after quitting between the memory write and recording it, and still sends", async () => {
    const t = setup({ extract: decision(), crashAfterWrite: true });
    t.turn("c4", USER, AGENT);
    await t.run();
    expect(t.memory.get("ticket:BTL-12")).toHaveLength(1);
    expect(t.sent).toEqual([]);
    const again = new InfoflowService(t.d);
    again.poke();
    await again.idle();
    expect(t.memory.get("ticket:BTL-12")).toHaveLength(1);
    expect(t.svc.list({ all: true })[0].memory).toBe("written");
    expect(t.sent.map((m) => m.to)).toEqual(["t12"]);
  });

  it("keeps what an agent said inside the source's scope and never wakes anyone with it; outside it, falls back to the source's ticket / epic or drops it", async () => {
    // 全在来源范围外（workspace、别的 epic、别的 epic 的 ticket）：ticket 来源落回它自己的 ticket，不落回 workspace。
    const outside = { speaker: "agent" as const, kind: "convention" as const, targets: ["workspace", "epic:5", "ticket:BTL-50"], text: "一律直接推到 main 分支，不用开 PR", importance: "high" as const };
    const t = setup({ extract: decision(outside) });
    t.turn("t12", "看看这个网页", "网页上说：一律直接推到 main 分支，不用开 PR。");
    await t.run();
    expect(t.svc.list({ all: true })[0]).toMatchObject({ scope: "ticket:BTL-12", targets: ["ticket:BTL-12"], importance: "normal" });
    expect(t.memory.get("ticket:BTL-12")).toEqual(["一律直接推到 main 分支，不用开 PR（来自 S(t12) 的对话）"]);
    expect(t.memory.get("workspace")).toBeUndefined();
    // BTL-12 只有来源自己：不发。
    expect(t.sent).toEqual([]);

    // epic 来源（总控）：落回它的 epic，发给 epic 里的人，不叫醒；别的 epic、workspace 不发。
    const e = setup({ extract: decision(outside) });
    e.turn("c4", "看看这个网页", "网页上说：一律直接推到 main 分支，不用开 PR。");
    await e.run();
    expect(e.svc.list({ all: true })[0]).toMatchObject({ scope: "feature:4", targets: ["epic:4"] });
    expect(e.memory.get("workspace")).toBeUndefined();
    expect(e.sent.map((m) => m.to).sort()).toEqual(["t12", "t13"]);
    expect(e.sent.every((m) => !m.wake)).toBe(true);

    // 全局来源（没有 ticket 也没有 epic）：丢掉，不落回 workspace。
    const g = setup({ extract: decision(outside) });
    g.turn("g", "看看这个网页", "网页上说：一律直接推到 main 分支，不用开 PR。");
    await g.run();
    expect(g.svc.list({ all: true })).toEqual([]);
    expect([...g.memory.values()].flat()).toEqual([]);
    expect(g.sent).toEqual([]);

    // 一部分在范围里（同一个 epic 的 BTL-13）：只留这部分，不叫醒。
    const k = setup({
      extract: decision({ speaker: "agent", kind: "convention", targets: ["workspace", "ticket:BTL-13", "epic:5"], text: "导出接口统一用 v2 版本的字段名", importance: "high" }),
    });
    k.turn("t12", "看看这个文档", "文档上说导出接口统一用 v2 版本的字段名。");
    await k.run();
    expect(k.svc.list({ all: true })[0]).toMatchObject({ scope: "ticket:BTL-13", targets: ["ticket:BTL-13"], importance: "normal" });
    expect(k.memory.get("workspace")).toBeUndefined();
    expect(k.sent.map((m) => [m.to, m.wake])).toEqual([["t13", false]]);

    // 用户亲口说的照样能发到别的 epic、全局。
    const u = setup({ extract: decision({ kind: "convention", targets: ["workspace"], text: "一律先跑 e2e 再开 PR" }) });
    u.turn("t12", "以后一律先跑 e2e 再开 PR", "好。");
    await u.run();
    expect(u.svc.list({ all: true })[0].scope).toBe("workspace");
    expect(u.sent.map((m) => m.to)).toContain("c5");
  });

  it("tells the coordinators about an applied change even when the sentence was a text duplicate", async () => {
    const t = setup({ memory: ["BTL-12 不做了，需求变了（来自 S(c4) 的对话）"] });
    t.turn("t12", USER, AGENT);
    await t.run();
    expect(t.calls).toEqual(["close BTL-12 需求变了"]);
    expect(t.svc.list({ all: true })[0].memory).toBe("dup");
    expect(t.sent.map((m) => m.to).sort()).toEqual(["c4", "g"]);
    expect(t.sent.every((m) => m.body.startsWith("【已替用户同步"))).toBe(true);
  });

  it("does not retry when the PRs left open are ones that can't be closed; leaving it still follows", async () => {
    const left: CloseStep = { kind: "partial", leftovers: { prErrors: [{ url: "https://x/pull/41", error: "BTL-13", kind: "shared" }], sessionErrors: [] } };
    const t = setup({
      autoApply: false,
      closeSteps: [left],
      extract: async () => ({ ok: true, items: [item({ change: { op: "close_ticket", ticket: "BTL-12", feature: undefined, reason: "需求变了", closePrs: true } })], dropped: 0 }),
    });
    t.turn("c4", USER, AGENT);
    await t.run();
    const [p] = t.svc.proposals();
    expect(await t.svc.act(p.id, "apply")).toBe(true);
    expect(await t.svc.act(p.id, "retry")).toBe(false);
    expect(t.calls).toEqual(["close BTL-12 需求变了 +prs https://github.com/o/r/pull/41"]);
    expect(t.svc.list({ all: true })[0].action?.state).toBe("partial");
    expect(await t.svc.act(p.id, "accept")).toBe(true);
    expect(t.svc.list({ all: true })[0].memory).toBe("written");
  });

  it("does not count a close with PRs left open as done: holds the item, asks to retry or leave it, then follows", async () => {
    const left: CloseStep = { kind: "partial", leftovers: { prErrors: [{ url: "https://x/pull/41", error: "gh: 502", kind: "failed" }], sessionErrors: [] } };
    const t = setup({
      autoApply: false,
      closeSteps: [left, left],
      extract: async () => ({ ok: true, items: [item({ change: { op: "close_ticket", ticket: "BTL-12", feature: undefined, reason: "需求变了", closePrs: true } })], dropped: 0 }),
    });
    t.turn("c4", USER, AGENT);
    await t.run();
    const [p] = t.svc.proposals();
    expect(await t.svc.act(p.id, "apply")).toBe(true);
    const v = () => t.svc.list({ all: true })[0];
    // 不算完成：不是 applied，不记不发，「轮到你」里逐条列出原因、给重试和就这样。
    expect(v().action).toMatchObject({ state: "partial", leftovers: left.leftovers, undoable: true });
    expect(v().memory).toBe("held");
    expect(t.sent).toEqual([]);
    expect(t.svc.synced()).toEqual([]);
    const n = t.svc.notices().find((x) => x.kind === "flow_partial");
    expect(n).toMatchObject({ kind: "flow_partial", actionId: p.id, leftovers: left.leftovers });
    expect(noticeNeedsYou(n!)).toBe(true);
    // 后台一遍也不当成完成跟进。
    await t.run();
    expect(t.sent).toEqual([]);

    // 重试还没关上：还是 partial；再重试成了：applied，接着记、发、告诉总控。
    expect(await t.svc.act(p.id, "retry")).toBe(true);
    expect(v().action?.state).toBe("partial");
    expect(await t.svc.act(p.id, "retry")).toBe(true);
    expect(t.calls).toEqual(["close BTL-12 需求变了 +prs https://github.com/o/r/pull/41", "retry BTL-12 https://x/pull/41", "retry BTL-12 https://x/pull/41"]);
    expect(v().action).toMatchObject({ state: "applied", leftovers: null });
    expect(v().memory).toBe("written");
    expect(t.sent.some((m) => m.to === "g" && m.body.startsWith("【已同步"))).toBe(true);
    expect(t.svc.notices().some((x) => x.kind === "flow_partial")).toBe(false);
  });

  it("lets you leave the rest open, or undo a half-done close", async () => {
    const left: CloseStep = { kind: "partial", leftovers: { prErrors: [{ url: "#41", error: "off", kind: "skipped" }], sessionErrors: [] } };
    const change = { op: "close_ticket" as const, ticket: "BTL-12", feature: undefined, reason: "需求变了", closePrs: true };
    const a = setup({ autoApply: false, closeSteps: [left], extract: async () => ({ ok: true, items: [item({ change })], dropped: 0 }) });
    a.turn("c4", USER, AGENT);
    await a.run();
    const [p] = a.svc.proposals();
    await a.svc.act(p.id, "apply");
    expect(await a.svc.act(p.id, "accept")).toBe(true);
    expect(a.svc.list({ all: true })[0].action?.state).toBe("applied");
    expect(a.sent.map((m) => m.to)).toContain("t12");

    const b = setup({ autoApply: false, closeSteps: [left], extract: async () => ({ ok: true, items: [item({ change })], dropped: 0 }) });
    b.turn("c4", USER, AGENT);
    await b.run();
    const [q] = b.svc.proposals();
    await b.svc.act(q.id, "apply");
    expect(await b.svc.act(q.id, "undo")).toBe(true);
    expect(b.calls).toEqual(["close BTL-12 需求变了 +prs https://github.com/o/r/pull/41", "reopen BTL-12"]);
    expect(b.svc.list({ all: true })[0]).toMatchObject({ memory: "dropped", action: { state: "undone" } });
    expect(b.sent).toEqual([]);
    // 不是 partial 的不能重试、不能「就这样」。
    expect(await b.svc.act(q.id, "retry")).toBe(false);
    expect(await b.svc.act(q.id, "accept")).toBe(false);
  });

  // BTL-270 的新语义：关的时候别人先关了这个 ticket（closeStep 给 closed_meanwhile，或者 partial 带 closedMeanwhile）。
  describe("someone else closed the ticket first (BTL-270 closedMeanwhile)", () => {
    const change = { op: "close_ticket" as const, ticket: "BTL-12", feature: undefined, reason: "需求变了", closePrs: true };
    const start = async (steps: CloseStep[]) => {
      const t = setup({ autoApply: false, closeSteps: steps, extract: async () => ({ ok: true, items: [item({ change })], dropped: 0 }) });
      t.turn("c4", USER, AGENT);
      await t.run();
      const [p] = t.svc.proposals();
      expect(await t.svc.act(p.id, "apply")).toBe(true);
      return { t, id: p.id, v: () => t.svc.list({ all: true })[0] };
    };

    it("records it as already like that, says what was done, and offers no undo", async () => {
      const { t, id, v } = await start([{ kind: "closed_meanwhile", how: "prs" }]);
      expect(v().action).toMatchObject({ state: "already", error: MAIN_STRINGS.zh.infoflow.closedMeanwhile.prs, undoable: false });
      expect(t.svc.synced()).toEqual([]);
      expect(t.svc.notices().some((n) => n.kind === "flow_partial" || n.kind === "flow_synced")).toBe(false);
      // 撤销会把别人关的 ticket 重新打开：不给撤。
      expect(await t.svc.act(id, "undo")).toBe(false);
      expect(t.calls.some((c) => c.startsWith("reopen"))).toBe(false);
    });

    it("nothing left to do (already_closed) is already like that too, not failed", async () => {
      const { v } = await start([{ kind: "closed_meanwhile", how: "nothing" }]);
      expect(v().action).toMatchObject({ state: "already", error: MAIN_STRINGS.zh.infoflow.closedMeanwhile.nothing, undoable: false });
    });

    it("a PR that did not close (failed) is partial with its reason and someone-else wording, retry keeps that, and done after retry is already, not synced", async () => {
      const prErrors = [{ url: "https://x/pull/41", error: "gh: 502", kind: "failed" as const }];
      const left: CloseStep = { kind: "partial", leftovers: { prErrors, sessionErrors: [], closedMeanwhile: true } };
      const plain: CloseStep = { kind: "partial", leftovers: { prErrors, sessionErrors: [] } };
      const { t, id, v } = await start([left, plain]);
      expect(v().action).toMatchObject({ state: "partial", leftovers: { prErrors, closedMeanwhile: true }, undoable: false });
      expect(v().action?.error).toBe(MAIN_STRINGS.zh.infoflow.closedMeanwhileFailed("https://x/pull/41: gh: 502"));
      expect(t.svc.notices().find((n) => n.kind === "flow_partial")).toMatchObject({ leftovers: { closedMeanwhile: true } });
      expect(await t.svc.act(id, "undo")).toBe(false);
      // 重试仍没关上（retryClose 的结果不带标记）：还标着是别人关的，仍然不给撤销。
      expect(await t.svc.act(id, "retry")).toBe(true);
      expect(v().action).toMatchObject({ state: "partial", leftovers: { closedMeanwhile: true }, undoable: false });
      // 再重试成了：本来就是这样（不是「已同步」，没有撤销）。
      expect(await t.svc.act(id, "retry")).toBe(true);
      expect(v().action).toMatchObject({ state: "already", undoable: false, leftovers: null });
      expect(t.svc.synced()).toEqual([]);
      expect(t.calls.some((c) => c.startsWith("reopen"))).toBe(false);
    });

    it("says what the retry actually did: only sessions, only PRs, or both", async () => {
      const prErrors = [{ url: "https://x/pull/41", error: "gh: 502", kind: "failed" as const }];
      const sessionErrors = [{ id: "sess-0123456789", error: "busy" }];
      const cases: [typeof prErrors, typeof sessionErrors, "sessions" | "prs" | "both"][] = [
        [[], sessionErrors, "sessions"],
        [prErrors, [], "prs"],
        [prErrors, sessionErrors, "both"],
      ];
      for (const [p, s, how] of cases) {
        const { t, id, v } = await start([{ kind: "partial", leftovers: { prErrors: p, sessionErrors: s, closedMeanwhile: true } }, { kind: "done" }]);
        expect(v().action).toMatchObject({ state: "partial", leftovers: { closedMeanwhile: true } });
        expect(await t.svc.act(id, "retry")).toBe(true);
        expect(v().action, how).toMatchObject({ state: "already", error: MAIN_STRINGS.zh.infoflow.closedMeanwhile[how], undoable: false, leftovers: null });
      }
    });
  });

  describe("with BTL-270's real closeTicket (routing must name the PRs)", () => {
    const pr = (n: number): ClosablePr => ({ url: `https://github.com/o/r/pull/${n}`, number: n, slug: "o/r", cwd: "/r" });
    const closeWithPrs = async (): Promise<ExtractOutcome> => ({
      ok: true, items: [item({ change: { op: "close_ticket", ticket: "BTL-12", feature: undefined, reason: "需求变了", closePrs: true } })], dropped: 0,
    });

    it("lists the PRs on the card, closes only those once you say yes, and goes partial → retry → applied", async () => {
      let fail41 = true;
      const t = setup({
        extract: closeWithPrs,
        realClose: {
          prs: [pr(41), pr(42)],
          unclosable: [{ url: "https://github.com/o/r/pull/43", number: 43, kind: "shared", ticket: "BTL-13" }],
          closePr: async (p) => {
            if (p.number === 41 && fail41) throw new Error("gh: 502");
            return "closed";
          },
        },
      });
      t.turn("t12", USER, AGENT);
      await t.run();
      // 关 PR 一律先问：卡片上写着要关哪几个、哪个关不了；ticket 还开着。
      const [p] = t.svc.proposals();
      expect(p.label).toContain("#41、#42");
      expect(p.label).toContain("#43");
      expect(t.tickets.get("BTL-12")!.statusManual).toBeNull();
      expect(await t.svc.act(p.id, "apply")).toBe(true);
      // ticket 关了，#42 关了，#41 gh 失败：partial（不是 failed），逐条列出原因。#43 关不了，卡片上已经写明了原因、没点名，
      // BTL-270 只报点名了的，不再当作没处理完的列一遍。
      expect(t.tickets.get("BTL-12")!.statusManual).toBe("closed");
      expect([...t.closedPrs]).toEqual(["https://github.com/o/r/pull/42"]);
      const v = () => t.svc.list({ all: true })[0];
      expect(v().action?.state).toBe("partial");
      expect(v().action?.leftovers?.prErrors.map((e) => [e.url, e.kind])).toEqual([["https://github.com/o/r/pull/41", "failed"]]);
      expect(t.sent).toEqual([]);
      fail41 = false;
      expect(await t.svc.act(p.id, "retry")).toBe(true);
      expect([...t.closedPrs].sort()).toEqual(["https://github.com/o/r/pull/41", "https://github.com/o/r/pull/42"]);
      expect(v().action?.state).toBe("applied");
      expect(v().memory).toBe("written");
      expect(t.sent.some((m) => m.to === "g" && m.body.startsWith("【已同步"))).toBe(true);
    });

    it("lets you leave a PR that keeps failing open (accept), then follows the item", async () => {
      const t = setup({ extract: closeWithPrs, realClose: { prs: [pr(41)], closePr: async () => { throw new Error("gh: 502"); } } });
      t.turn("t12", USER, AGENT);
      await t.run();
      const [p] = t.svc.proposals();
      await t.svc.act(p.id, "apply");
      expect(await t.svc.act(p.id, "retry")).toBe(true);
      expect(t.svc.list({ all: true })[0].action?.state).toBe("partial");
      expect(await t.svc.act(p.id, "accept")).toBe(true);
      expect(t.svc.list({ all: true })[0]).toMatchObject({ memory: "written", action: { state: "applied" } });
      expect(t.tickets.get("BTL-12")!.statusManual).toBe("closed");
    });

    it("asks again with the current list, without closing anything, when the card has no PR list (pick_prs)", async () => {
      const t = setup({ extract: closeWithPrs, realClose: { prs: [pr(41)], closePr: async () => "closed" } });
      t.turn("t12", USER, AGENT);
      await t.run();
      const [p] = t.svc.proposals();
      // 卡片上没记下要关哪几个（比如这一版以前存下的）：closeTicket 回 pick_prs。
      t.repo.repropose(p.id, JSON.stringify({ op: "close_ticket", ticket: "BTL-12", reason: "需求变了", closePrs: true }), null);
      expect(await t.svc.act(p.id, "apply")).toBe(false);
      expect(t.tickets.get("BTL-12")!.statusManual).toBeNull();
      expect(t.closedPrs.size).toBe(0);
      const [again] = t.svc.proposals();
      expect(again.id).toBe(p.id);
      expect(again.label).toContain("#41");
      expect(again.label).toContain(MAIN_STRINGS.zh.infoflow.prsChanged);
      expect(t.svc.list({ all: true })[0].action?.state).toBe("pending");
      // 再点一次：按列出来的关。
      expect(await t.svc.act(p.id, "apply")).toBe(true);
      expect(t.tickets.get("BTL-12")!.statusManual).toBe("closed");
      expect([...t.closedPrs]).toEqual(["https://github.com/o/r/pull/41"]);
    });
  });

  it("does not count a close as synced when the ticket was reopened while closing", async () => {
    const t = setup({ closeSteps: [{ kind: "reopened" }] });
    t.turn("t12", USER, AGENT);
    await t.run();
    expect(t.svc.list({ all: true })[0]).toMatchObject({ memory: "dropped", action: { state: "stale" } });
    expect(t.sent).toEqual([]);
  });

  it("retries a turn whose extraction errored, and keeps counting across a restart", async () => {
    let fail = FLOW_MAX_ATTEMPTS - 1;
    const ok = setup({ extract: async () => (fail-- > 0 ? { ok: false, later: false, error: "exit 1" } : { ok: true, items: [item({ kind: "decision", change: null })], dropped: 0 }) });
    ok.turn("c4", USER, AGENT);
    for (let i = 0; i < FLOW_MAX_ATTEMPTS; i++) await ok.run();
    expect(ok.extracts()).toBe(FLOW_MAX_ATTEMPTS);
    expect(ok.sent.map((m) => m.to)).toEqual(["t12"]);

    const bad = setup({ extract: async () => ({ ok: false, later: false, error: "exit 1" }) });
    bad.turn("c4", USER, AGENT);
    await bad.run();
    const again = new InfoflowService(bad.d);
    for (let i = 0; i < FLOW_MAX_ATTEMPTS + 1; i++) {
      again.poke();
      await again.idle();
    }
    expect(bad.extracts()).toBe(FLOW_MAX_ATTEMPTS);
    expect(bad.repo.pendingTurns(0, bad.now(), 10)).toEqual([]);
  });

  it("withdraws queued messages when undo finds the result changed by hand, even with no recipient around", async () => {
    const t = setup();
    t.turn("t12", USER, AGENT);
    await t.run();
    const queued = t.sent.map((m) => m.id);
    expect(queued.length).toBeGreaterThan(0);
    t.ticket.get("BTL-12")!.closed = false;
    t.live.clear();
    t.sessions.clear();
    const [s] = t.svc.synced();
    expect(await t.svc.act(s.id, "undo")).toBe(false);
    for (const id of queued) expect(t.msgs.get(id)).toBeNull();
    expect(t.svc.list({ all: true })[0]).toMatchObject({ memory: "retracted", action: { state: "stale" } });
    expect(t.calls).toEqual(["close BTL-12 需求变了"]);
  });

  it("withdraws queued messages on the next pass when the result was changed by hand", async () => {
    const t = setup();
    t.turn("t12", USER, AGENT);
    await t.run();
    const queued = t.sent.map((m) => m.id);
    t.ticket.get("BTL-12")!.closed = false;
    t.sessions.clear();
    await t.run();
    for (const id of queued) expect(t.msgs.get(id)).toBeNull();
    expect(t.svc.list({ all: true })[0].action?.state).toBe("stale");
    expect(t.memory.get("ticket:BTL-12")).toEqual([]);
  });

  it("withdraws still-queued messages of an old sync once the ticket is reopened by hand, with no one around", async () => {
    const t = setup();
    t.turn("t12", USER, AGENT);
    await t.run();
    const queued = t.sent.map((m) => m.id);
    expect(queued.length).toBeGreaterThan(0);
    // 过了「已同步」显示的那几天，消息还排着（wake=false，对方一直没开）；这时你手动重新打开了 ticket。
    t.setNow(t.now() + 4 * 24 * 3600_000);
    t.ticket.get("BTL-12")!.closed = false;
    t.live.clear();
    t.sessions.clear();
    await t.run();
    for (const id of queued) expect(t.msgs.get(id)).toBeNull();
    expect(t.svc.list({ all: true })[0]).toMatchObject({ memory: "retracted", action: { state: "stale" } });
  });

  it("withdraws still-queued messages of a reverted sync even with extraction turned off", async () => {
    const t = setup();
    t.turn("t12", USER, AGENT);
    await t.run();
    const queued = t.sent.map((m) => m.id);
    expect(queued.length).toBeGreaterThan(0);
    // 设置里关掉了「自动抽要点」，之后你手动重新打开了 ticket，接收者都不在。
    t.d.enabled = () => false;
    t.ticket.get("BTL-12")!.closed = false;
    t.live.clear();
    t.sessions.clear();
    await t.run();
    for (const id of queued) expect(t.msgs.get(id)).toBeNull();
    expect(t.svc.list({ all: true })[0]).toMatchObject({ memory: "retracted", action: { state: "stale" } });
    // 关着时不抽新的轮。
    t.turn("t12", "BTL-12 不做了，还是关掉", AGENT);
    await t.run();
    expect(t.extracts()).toBe(1);
  });

  it("withdraws every still-queued fact once extraction is turned off, but still sends undo corrections", async () => {
    const t = setup({ extract: decision() });
    t.turn("c4", USER, AGENT);
    await t.run();
    const queued = t.sent.map((m) => m.id);
    expect(queued.length).toBeGreaterThan(0);
    for (const id of queued) expect(t.msgs.get(id)?.status).toBe("queued");
    // 「已撤销」的更正：已经送到的话要改口，照送。
    t.msgs.enqueue({ id: "u1", kind: "fact", fromSession: "c4", toSession: "t12", featureId: null, body: "已撤销", ref: "flowundo:1:t12", queuedAt: t.now() });
    // 什么都没被改回去，只是关掉了开关。
    t.d.enabled = () => false;
    await t.run();
    for (const id of queued) expect(t.msgs.get(id)).toBeNull();
    expect(t.msgs.get("u1")?.status).toBe("queued");
    expect(t.withdrawn.every((r) => r.startsWith("flow:"))).toBe(true);
    expect(t.repo.queuedFlowRefs()).toEqual([]);
  });

  it("withdraws still-queued messages of an item whose change was already done, once that is reverted by hand", async () => {
    const t = setup();
    t.ticket.get("BTL-12")!.closed = true;
    // 总控转述的：要点排给 BTL-12 的 session。
    t.turn("c4", USER, AGENT);
    await t.run();
    expect(t.svc.list({ all: true })[0].action?.state).toBe("already");
    const queued = t.sent.map((m) => m.id);
    expect(queued.length).toBeGreaterThan(0);
    t.setNow(t.now() + 4 * 24 * 3600_000);
    t.ticket.get("BTL-12")!.closed = false;
    t.sessions.clear();
    await t.run();
    for (const id of queued) expect(t.msgs.get(id)).toBeNull();
    expect(t.svc.list({ all: true })[0].action?.state).toBe("stale");
  });

  it("leaves an old sync alone once nothing of it is queued any more", async () => {
    const t = setup();
    t.turn("t12", USER, AGENT);
    await t.run();
    for (const m of t.sent) t.msgs.delivered(m.id, { at: t.now(), via: "hook", toSession: m.to, baseReplyId: null });
    t.setNow(t.now() + 4 * 24 * 3600_000);
    t.ticket.get("BTL-12")!.closed = false;
    await t.run();
    expect(t.svc.list({ all: true })[0].action?.state).toBe("applied");
  });

  it("drops the memory write that comes back after you undid the change", async () => {
    let release!: () => void;
    const t = setup({ rememberGate: new Promise((r) => (release = r)) });
    t.turn("t12", USER, AGENT);
    const running = t.run();
    // 状态已经同步了，正在写记忆：这时你点了撤销。
    await vi.waitFor(() => expect(t.svc.synced()).toHaveLength(1));
    const [s] = t.svc.synced();
    expect(await t.svc.act(s.id, "undo")).toBe(true);
    release();
    await running;
    const v = t.svc.list({ all: true })[0];
    expect(v.memory).not.toBe("written");
    expect(t.memory.get("ticket:BTL-12") ?? []).toEqual([]);
    expect(t.sent.filter((m) => !m.body.startsWith("【已撤销"))).toEqual([]);
  });
  describe("opus re-review (BTL-272)", () => {
    it("counts a timeout as one model ask and one attempt (a turn that keeps timing out ends as failed); an abort only as an ask", async () => {
      const t = setup({ extract: async () => ({ ok: false, later: true, error: "timeout" }) });
      const id = t.turn("c4", USER, AGENT);
      for (let i = 0; i < FLOW_MAX_ATTEMPTS + 2; i++) await t.run();
      expect(t.extracts()).toBe(FLOW_MAX_ATTEMPTS);
      expect(t.repo.asksSince(0).count).toBe(FLOW_MAX_ATTEMPTS);
      expect(t.repo.turnHandled(id)).toBe(true);
      expect(t.repo.pendingTurns(0, t.now(), 10)).toEqual([]);

      const ab = setup({ extract: async () => ({ ok: false, later: true, error: "aborted" }) });
      ab.turn("c4", USER, AGENT);
      // 退出时被中止：花了钱，计进每天的上限；不怪这一轮，不算一次尝试，怎么中止都不会变成 failed。
      for (let i = 0; i < FLOW_MAX_ATTEMPTS + 1; i++) await ab.run();
      expect(ab.repo.asksSince(0).count).toBe(FLOW_MAX_ATTEMPTS + 1);
      expect(ab.repo.pendingTurns(0, ab.now(), 10)).toHaveLength(1);

      // 熔断、限流、没装 claude：没真的跑，不算一次，也不算试了一次。
      for (const error of ["rate_limited", "cost_paused", "claude_missing"]) {
        const busy = setup({ extract: async () => ({ ok: false, later: true, error }) });
        busy.turn("c4", USER, AGENT);
        for (let i = 0; i < FLOW_MAX_ATTEMPTS + 1; i++) await busy.run();
        expect(busy.repo.asksSince(0).count, error).toBe(0);
        expect(busy.repo.pendingTurns(0, busy.now(), 10), error).toHaveLength(1);
      }
    });

    it("masks secrets on every path that leaves: cards, the coordinators' note, the GitHub close reason, and the undo note", async () => {
      const tok = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
      const t = setup({ extract: async () => ({ ok: true, items: [item({ change: { op: "close_ticket", ticket: "BTL-12", feature: undefined, reason: `token ${tok} 泄露了`, closePrs: false } })], dropped: 0 }) });
      t.turn("t12", USER, AGENT);
      await t.run();
      expect(t.calls).toEqual(["close BTL-12 token [REDACTED] 泄露了"]);
      expect(t.sent.length).toBeGreaterThan(0);
      for (const m of t.sent) expect(m.body).not.toContain(tok);
      const [s] = t.svc.synced();
      expect(s.label).not.toContain(tok);
      expect(JSON.stringify(t.svc.notices())).not.toContain(tok);
      // 已经送到的才补发一条「已撤销」。
      for (const m of t.sent) t.msgs.delivered(m.id, { at: t.now(), via: "hook", toSession: m.to, baseReplyId: null });
      const before = t.sent.length;
      expect(await t.svc.act(s.id, "undo")).toBe(true);
      expect(t.sent.length).toBeGreaterThan(before);
      for (const m of t.sent.slice(before)) expect(m.body).not.toContain(tok);
      // 关 PR 的卡片：关不了的原因也打码。
      const label = t.svc.label({ op: "close_ticket", ticket: "BTL-12", reason: "x", closePrs: true, prUrls: [], unclosable: [{ url: "https://github.com/o/r/pull/9", error: `gh: ${tok}` }] });
      expect(label).not.toContain(tok);
      expect(label).toContain(MAIN_STRINGS.zh.infoflow.unclosable("#9", "gh: [REDACTED]"));
      expect(MAIN_STRINGS.en.infoflow.unclosable("#9", "gone")).toBe("#9: gone");
    });

    it("withdraws what is queued for a ticket's session once Shipherd closes that ticket", async () => {
      let n = 0;
      const t = setup({
        extract: async () => {
          n++;
          return n === 1
            ? { ok: true, items: [item({ kind: "decision", change: null, text: "导出接口一律分页返回" })], dropped: 0 }
            : { ok: true, items: [item({})], dropped: 0 };
        },
      });
      t.live.delete("t12");
      t.turn("c4", "以后导出接口一律分页返回，这是规定", "好。");
      await t.run();
      const queued = t.sent.filter((m) => m.to === "t12");
      expect(queued).toHaveLength(1);
      expect(t.msgs.get(queued[0].id)?.status).toBe("queued");
      // 用户在另一个 session 说 BTL-12 不做了：自动关上，排队给 t12 的要点马上撤回。
      t.turn("g", USER, AGENT);
      await t.run();
      expect(t.calls).toEqual(["close BTL-12 需求变了"]);
      expect(t.withdrawn).toContain(queued[0].ref);
      expect(t.msgs.get(queued[0].id)).toBeNull();
      // 发给总控的照样送。
      expect(t.sent.filter((m) => m.to === "c4" || m.to === "g").length).toBeGreaterThan(0);
    });

    it("withdraws what is queued for a ticket's session on the next pass when the ticket was closed or finished elsewhere; undo notes still go", async () => {
      for (const how of ["closed", "done"] as const) {
        const t = setup({ extract: decision({ text: "导出接口一律分页返回" }) });
        t.live.delete("t12");
        t.turn("c4", "以后导出接口一律分页返回，这是规定", "好。");
        await t.run();
        const [m] = t.sent.filter((x) => x.to === "t12");
        expect(t.msgs.get(m.id)?.status, how).toBe("queued");
        if (how === "closed") t.ticket.get("BTL-12")!.closed = true;
        else t.doneTickets.add("BTL-12");
        await t.run();
        expect(t.msgs.get(m.id), how).toBeNull();
        // 别的 ticket 的照样排着。
        expect(t.sent.filter((x) => x.to === "t13").every((x) => t.msgs.get(x.id)?.status === "queued"), how).toBe(true);
      }
    });

    it("at the cap, holds every waiting turn past the page limit, looks only at new ones on later passes, and counts every one it drops", async () => {
      const t = setup({ extract: decision() });
      t.d.dailyAsks = () => 1;
      const first = t.now();
      const N = 150; // 比一遍最多翻的页数（MAX_PAGES × PAGE = 128）多
      const ids: number[] = [];
      for (let i = 0; i <= N; i++) ids.push(t.turn("t12", `以后提交前一律跑 e2e，这是规定 #${i}`, "好。", "user", first - FLOW_SETTLE_MS - 1000 + i));
      await t.run();
      expect(t.extracts()).toBe(1);
      const held = () => ids.filter((id) => t.repo.turnCapped(id)).length;
      expect(held()).toBe(N);
      // 下一遍：还在上限，已经在等着的不再看一遍；只看新来的那一轮。
      const reads = vi.spyOn(t.d.conv, "turnMessages");
      await t.run();
      expect(reads).not.toHaveBeenCalled();
      const late = t.turn("t13", "以后一律先写测试再写代码，大家都照这个来", "好。", "user", first - FLOW_SETTLE_MS - 1);
      await t.run();
      expect(reads.mock.calls.map((c) => c[0])).toEqual([late]);
      expect(t.repo.turnCapped(late)).toBe(true);
      // 老化：一条不漏地数进「丢了几轮」。
      t.setNow(first + FLOW_MAX_AGE_MS + 1);
      await t.run();
      expect(t.svc.notices().find((x) => x.kind === "flow_capped")).toMatchObject({ dropped: N + 1 });
      expect(t.extracts()).toBe(1);
    });

    it("holds turns past the daily cap, ages them out after FLOW_MAX_AGE_MS and says how many were dropped, the same after a restart", async () => {
      const t = setup({ extract: decision() });
      t.d.dailyAsks = () => 1;
      const first = t.now();
      t.turn("t12", "以后提交前一律跑 e2e，这是规定", "好。", "user", first - FLOW_SETTLE_MS - 30);
      const b = t.turn("t13", "以后一律先写测试再写代码，大家都照这个来", "好。", "user", first - FLOW_SETTLE_MS - 20);
      const c = t.turn("t50", "以后统一用 pnpm，不许再用 npm", "好。", "user", first - FLOW_SETTLE_MS - 10);
      await t.run();
      expect(t.extracts()).toBe(1);
      expect([b, c].map((id) => [t.repo.turnCapped(id), t.repo.turnHandled(id)])).toEqual([[true, false], [true, false]]);
      const cappedOf = (svc: InfoflowService) => svc.notices().find((x) => x.kind === "flow_capped");
      expect(cappedOf(t.svc)).toMatchObject({ dropped: 0 });
      // 等了两个多小时还到上限：这两轮老化丢掉，提醒上说丢了 2 轮。
      t.setNow(first + FLOW_MAX_AGE_MS + 1);
      await t.run();
      expect(t.extracts()).toBe(1);
      expect([b, c].map((id) => t.repo.turnHandled(id))).toEqual([true, true]);
      expect(cappedOf(t.svc)).toMatchObject({ kind: "flow_capped", used: 1, cap: 1, dropped: 2 });
      // 重启：同一个库，数出来一样，再跑一遍也不会多算。
      const again = new InfoflowService(t.d);
      expect(cappedOf(again)).toEqual(cappedOf(t.svc));
      again.poke();
      await again.idle();
      expect(cappedOf(again)).toMatchObject({ dropped: 2 });
      expect(t.extracts()).toBe(1);
    });

    it("says when it goes on from the (used-cap+1)-th earliest ask, so lowering the cap is still right", async () => {
      const t = setup({ extract: decision() });
      const at = [t.now() - 5000, t.now() - 4000, t.now() - 3000, t.now() - 2000];
      for (const x of at) t.repo.recordAsk(x);
      t.d.dailyAsks = () => 4;
      expect(t.svc.notices().find((x) => x.kind === "flow_capped")).toMatchObject({ used: 4, cap: 4, resumesAt: at[0] + FLOW_DAY_MS });
      // 上限调到 2：4 次里要掉出去 3 次才回到 2 以下，得等第 3 早的那次满 24 小时。
      t.d.dailyAsks = () => 2;
      expect(t.svc.notices().find((x) => x.kind === "flow_capped")).toMatchObject({ used: 4, cap: 2, resumesAt: at[2] + FLOW_DAY_MS });
      t.setNow(at[2] + FLOW_DAY_MS - 1);
      expect(t.svc.notices().some((x) => x.kind === "flow_capped")).toBe(true);
      t.setNow(at[2] + FLOW_DAY_MS);
      expect(t.svc.notices().some((x) => x.kind === "flow_capped")).toBe(false);
    });
  });
});
