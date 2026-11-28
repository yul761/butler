import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { ConvRepo } from "./conv-repo";
import { InfoflowRepo, type NewFlowItem } from "./infoflow-repo";
import { SessionMessagesRepo } from "./session-messages-repo";

const item = (o: Partial<NewFlowItem>): NewFlowItem => ({
  turnId: 1, idx: 0, sessionId: "s", rootSessionId: "s", featureId: null, targetFeatures: [], text: "x", kind: "decision", speaker: "user", quote: "",
  targets: ["workspace"], importance: "normal", confidence: 0.9, scope: "workspace", memory: "written", dupOf: null, area: "workspace", routable: true,
  changeRaw: null, createdAt: 1000, ...o,
});

describe("InfoflowRepo (BTL-272)", () => {
  it("lists ended turns once, oldest first, skipping old, unsettled and handoff turns", () => {
    const db = memDb();
    const conv = new ConvRepo(db);
    const repo = new InfoflowRepo(db);
    const turn = (kind: "user" | "silent" | "handoff", ended: number | null) => {
      const id = conv.openTurn({ rootSessionId: "r", sessionId: "s", sourceKey: `k${Math.random()}`, forkId: null, kind, at: 1, asked: false });
      if (ended !== null) conv.touchTurn(id, { at: ended, endedAt: ended });
      return id;
    };
    const old = turn("user", 50);
    const a = turn("user", 200);
    const b = turn("silent", 150);
    turn("handoff", 160);
    turn("user", null);
    const fresh = turn("user", 990);
    expect(repo.pendingTurns(100, 900, 10).map((t) => t.id)).toEqual([b, a]);
    expect(repo.markTurn({ turnId: a, sessionId: "s", state: "done", reason: null, items: 2, at: 1 })).toBe(true);
    expect(repo.markTurn({ turnId: a, sessionId: "s", state: "failed", reason: "x", items: 0, at: 2 })).toBe(false);
    expect(repo.turnHandled(a)).toBe(true);
    expect(repo.pendingTurns(100, 900, 10).map((t) => t.id)).toEqual([b]);
    expect([old, fresh]).toHaveLength(2);
  });

  it("filters the list by source epic or target epic, and keeps one item per turn position", () => {
    const repo = new InfoflowRepo(memDb());
    const a = repo.addItem(item({ turnId: 1, idx: 0, featureId: 4, text: "a" }));
    const b = repo.addItem(item({ turnId: 1, idx: 1, featureId: null, targetFeatures: [5, 4], text: "b", createdAt: 2000 }));
    repo.addItem(item({ turnId: 2, idx: 0, featureId: 5, targetFeatures: [5], text: "c" }));
    expect(repo.addItem(item({ turnId: 1, idx: 0, text: "again" }))).toBeNull();
    expect(repo.items({ featureId: 4 }, 10).map((i) => i.id)).toEqual([b, a]);
    expect(repo.items({ all: true }, 10)).toHaveLength(3);
    expect(repo.item(b!)?.targetFeatures).toEqual([5, 4]);
    repo.setMemory(a!, "dup");
    expect(repo.recentTexts(0, ["workspace"], 10)).toEqual(["b", "c"]);
  });

  it("dedupes only against the given scopes, and not against what is not written or sent yet", () => {
    const repo = new InfoflowRepo(memDb());
    repo.addItem(item({ idx: 0, area: "feature:4", text: "epic 4" }));
    repo.addItem(item({ idx: 1, area: "feature:5", text: "epic 5" }));
    repo.addItem(item({ idx: 2, area: "ticket:BTL-12", text: "pending", memory: "pending" }));
    repo.addItem(item({ idx: 3, area: "feature:4", text: "held", memory: "held" }));
    repo.addItem(item({ idx: 4, area: "feature:4", text: "dropped", memory: "dropped" }));
    expect(repo.recentTexts(0, ["ticket:BTL-12", "feature:4", "workspace"], 10)).toEqual(["epic 4"]);
    expect(repo.recentTexts(0, [], 10)).toEqual([]);
  });

  it("waits until the last word of a turn has settled, and pages past turns it skipped", () => {
    const db = memDb();
    const conv = new ConvRepo(db);
    const repo = new InfoflowRepo(db);
    const turn = (ended: number, last: number) => {
      const id = conv.openTurn({ rootSessionId: "r", sessionId: "s", sourceKey: `k${Math.random()}`, forkId: null, kind: "user", at: 1, asked: false });
      conv.touchTurn(id, { at: ended, endedAt: ended });
      // agent 停下来以后又接着说了：ended_at 不变，last_at 往后走。
      if (last !== ended) conv.touchTurn(id, { at: last });
      return id;
    };
    const a = turn(100, 100);
    const b = turn(110, 880);
    const c = turn(120, 120);
    expect(repo.pendingTurns(0, 500, 10).map((t) => t.id)).toEqual([a, c]);
    expect(repo.pendingTurns(0, 900, 1).map((t) => t.id)).toEqual([a]);
    expect(repo.pendingTurns(0, 900, 1, { endedAt: 100, id: a }).map((t) => t.id)).toEqual([b]);
    expect(repo.pendingTurns(0, 900, 5, { endedAt: 110, id: b }).map((t) => t.id)).toEqual([c]);
  });

  it("lists unfollowed items, leaving out only those waiting on a confirm card", () => {
    const repo = new InfoflowRepo(memDb());
    const plain = repo.addItem(item({ idx: 0, memory: "pending" }))!;
    const waiting = repo.addItem(item({ idx: 1, memory: "held" }))!;
    const autoHalf = repo.addItem(item({ idx: 2, memory: "pending" }))!;
    const confirmed = repo.addItem(item({ idx: 3, memory: "held" }))!;
    const done = repo.addItem(item({ idx: 4 }))!;
    // 确认模式下点了「照做」、执行到一半退出的：还是 pending，但存了撤销用的旧状态，算没跟进完。
    const clicked = repo.addItem(item({ idx: 5, memory: "held" }))!;
    const half = repo.addAction({ itemId: clicked, change: "{}", signature: "d", mode: "confirm", state: "pending", createdAt: 1 })!;
    expect(repo.setUndo(half, '{"op":"reopen_ticket","ticket":"BTL-1"}')).toBe(true);
    repo.addAction({ itemId: waiting, change: "{}", signature: "a", mode: "confirm", state: "pending", createdAt: 1 });
    repo.addAction({ itemId: autoHalf, change: "{}", signature: "b", mode: "auto", state: "pending", createdAt: 1 });
    repo.addAction({ itemId: confirmed, change: "{}", signature: "c", mode: "confirm", state: "applied", createdAt: 1 });
    repo.setFollowed(done, 5);
    repo.setFollowed(done, 9);
    expect(repo.item(done)?.followedAt).toBe(5);
    expect(repo.unfollowed(10).map((i) => i.id)).toEqual([plain, autoHalf, confirmed, clicked]);
    // 按新的 PR 列表再问一次（repropose）：撤销一起清掉，又成了等你确认的。
    expect(repo.repropose(half, '{"op":"close_ticket"}', "changed")).toBe(true);
    expect(repo.action(half)).toMatchObject({ undo: null, error: "changed", state: "pending" });
    expect(repo.unfollowed(10).map((i) => i.id)).toEqual([plain, autoHalf, confirmed]);
  });

  it("holds a capped turn as not handled, ages it out as skipped / capped, and counts the dropped ones", () => {
    const db = memDb();
    const conv = new ConvRepo(db);
    const repo = new InfoflowRepo(db);
    const turn = (ended: number) => {
      const id = conv.openTurn({ rootSessionId: "r", sessionId: "s", sourceKey: `k${Math.random()}`, forkId: null, kind: "user", at: 1, asked: false });
      conv.touchTurn(id, { at: ended, endedAt: ended });
      return id;
    };
    const a = turn(10);
    const b = turn(500);
    const retried = turn(20);
    const done = turn(30);
    repo.holdCapped({ turnId: a, sessionId: "s", at: 600 });
    repo.holdCapped({ turnId: b, sessionId: "s", at: 600 });
    // 在重试的改成等着，次数留着；处理完的不动。
    expect(repo.retryTurn({ turnId: retried, sessionId: "s", reason: "exit 1", at: 40 })).toBe(1);
    repo.holdCapped({ turnId: retried, sessionId: "s", at: 600 });
    repo.markTurn({ turnId: done, sessionId: "s", state: "done", reason: null, items: 1, at: 50 });
    repo.holdCapped({ turnId: done, sessionId: "s", at: 600 });
    expect([a, b, retried].map((id) => repo.turnCapped(id))).toEqual([true, true, true]);
    expect(repo.turnCapped(done)).toBe(false);
    expect(repo.turnHandled(a)).toBe(false);
    expect(repo.pendingTurns(0, 1000, 10).map((t) => t.id).sort()).toEqual([a, b, retried].sort());
    // 等着的照样能记成处理完、或者重试一次（次数接着数）。
    expect(repo.retryTurn({ turnId: retried, sessionId: "s", reason: "timeout", at: 700 })).toBe(2);
    expect(repo.turnCapped(retried)).toBe(false);
    // 老化：结束早于 100 的那一轮记成丢掉。
    expect(repo.expireCapped(100, 800)).toBe(1);
    expect(repo.turnHandled(a)).toBe(true);
    expect(repo.turnCapped(b)).toBe(true);
    expect(repo.cappedDropped(800)).toBe(1);
    expect(repo.cappedDropped(801)).toBe(0);
    expect(repo.expireCapped(100, 900)).toBe(0);
    expect(repo.markTurn({ turnId: b, sessionId: "s", state: "done", reason: null, items: 0, at: 900 })).toBe(true);
    expect(repo.turnHandled(b)).toBe(true);
  });

  it("finds the n-th earliest model ask in a window", () => {
    const repo = new InfoflowRepo(memDb());
    for (const at of [50, 10, 30, 30, 70]) repo.recordAsk(at);
    expect(repo.nthAskSince(20, 1)).toBe(30);
    expect(repo.nthAskSince(20, 2)).toBe(30);
    expect(repo.nthAskSince(20, 3)).toBe(50);
    expect(repo.nthAskSince(20, 4)).toBe(70);
    expect(repo.nthAskSince(20, 5)).toBeNull();
    expect(repo.nthAskSince(0, 0)).toBeNull();
    // 不含 since 那一刻（和 asksSince 一样）。
    expect(repo.nthAskSince(30, 1)).toBe(50);
    expect(repo.asksSince(30).count).toBe(2);
  });

  it("keeps a retried turn pending, counts attempts, and lets only a retry be finished", () => {
    const db = memDb();
    const conv = new ConvRepo(db);
    const repo = new InfoflowRepo(db);
    const id = conv.openTurn({ rootSessionId: "r", sessionId: "s", sourceKey: "k", forkId: null, kind: "user", at: 1, asked: false });
    conv.touchTurn(id, { at: 10, endedAt: 10 });
    expect(repo.retryTurn({ turnId: id, sessionId: "s", reason: "exit 1", at: 20 })).toBe(1);
    expect(repo.retryTurn({ turnId: id, sessionId: "s", reason: "exit 1", at: 30 })).toBe(2);
    expect(repo.turnHandled(id)).toBe(false);
    expect(repo.pendingTurns(0, 100, 10).map((t) => t.id)).toEqual([id]);
    expect(repo.markTurn({ turnId: id, sessionId: "s", state: "failed", reason: "exit 1", items: 0, at: 40 })).toBe(true);
    expect(repo.turnHandled(id)).toBe(true);
    expect(repo.retryTurn({ turnId: id, sessionId: "s", reason: "x", at: 50 })).toBeNull();
    expect(repo.markTurn({ turnId: id, sessionId: "s", state: "done", reason: null, items: 0, at: 60 })).toBe(false);
    expect(repo.pendingTurns(0, 100, 10)).toEqual([]);
  });

  it("knows whether a session got a routed fact during a turn", () => {
    const db = memDb();
    const repo = new InfoflowRepo(db);
    const msgs = new SessionMessagesRepo(db);
    msgs.enqueue({ id: "f1", kind: "fact", fromSession: "a", toSession: "t", featureId: null, body: "x", queuedAt: 1 });
    msgs.enqueue({ id: "r1", kind: "reply", fromSession: "a", toSession: "u", featureId: null, body: "x", queuedAt: 1 });
    msgs.delivered("f1", { at: 50, via: "input", toSession: "t", baseReplyId: null });
    msgs.delivered("r1", { at: 50, via: "input", toSession: "u", baseReplyId: null });
    expect(repo.factDelivered(["t"], 40, 60)).toBe(true);
    expect(repo.factDelivered(["t"], 51, 60)).toBe(false);
    expect(repo.factDelivered(["u"], 40, 60)).toBe(false);
    expect(repo.factDelivered([], 0, 100)).toBe(false);
  });

  it("records each delivery once and reads its mailbox status", () => {
    const db = memDb();
    const repo = new InfoflowRepo(db);
    const msgs = new SessionMessagesRepo(db);
    const id = repo.addItem(item({}))!;
    msgs.enqueue({ id: "m1", kind: "fact", fromSession: "s", toSession: "t", featureId: null, body: "x", queuedAt: 1 });
    expect(repo.addDelivery(id, "t", "m1", 1)).toBe(true);
    expect(repo.addDelivery(id, "t", "m2", 2)).toBe(false);
    expect(repo.addDelivery(id, "u", "gone", 3)).toBe(true);
    msgs.delivered("m1", { at: 5, via: "hook", toSession: "t", baseReplyId: null });
    expect(repo.deliveries([id]).map((d) => [d.toSession, d.status, d.deliveredAt])).toEqual([["t", "delivered", 5], ["u", null, null]]);
  });

  it("moves an action only from the expected state, and finds a live one by signature", () => {
    const repo = new InfoflowRepo(memDb());
    const i1 = repo.addItem(item({ idx: 0 }))!;
    const i2 = repo.addItem(item({ idx: 1 }))!;
    const act = repo.addAction({ itemId: i1, change: "{}", signature: "close_ticket:BTL-1", mode: "confirm", state: "pending", createdAt: 100 })!;
    expect(repo.addAction({ itemId: i1, change: "{}", signature: "x", mode: "auto", state: "applied", createdAt: 100 })).toBeNull();
    expect(repo.liveBySignature("close_ticket:BTL-1", 50)?.id).toBe(act);
    expect(repo.liveBySignature("close_ticket:BTL-1", 150)).toBeNull();
    const rej = repo.addAction({ itemId: repo.addItem(item({ idx: 7 }))!, change: "{}", signature: "close_ticket:BTL-2", mode: "confirm", state: "rejected", createdAt: 100 })!;
    // 用户拒掉的：用户自己又说一遍可以再提，别人转述的不再提。
    expect(repo.liveBySignature("close_ticket:BTL-2", 50)).toBeNull();
    expect(repo.liveBySignature("close_ticket:BTL-2", 50, true)?.id).toBe(rej);
    expect(repo.pending().map((a) => a.id)).toEqual([act]);
    expect(repo.transition(act, ["pending"], "applied", { at: 200, undo: '{"op":"reopen_ticket","ticket":"BTL-1"}' })).toBe(true);
    expect(repo.transition(act, ["pending"], "rejected", { at: 201 })).toBe(false);
    expect(repo.action(act)).toMatchObject({ state: "applied", decidedAt: 200, undo: '{"op":"reopen_ticket","ticket":"BTL-1"}' });
    const auto = repo.addAction({ itemId: i2, change: "{}", signature: "s2", mode: "auto", state: "pending", createdAt: 100 })!;
    repo.transition(auto, ["pending"], "applied", { at: 300 });
    expect(repo.synced(250).map((a) => a.id)).toEqual([auto]);
    expect(repo.dismiss(auto, 400)).toBe(true);
    expect(repo.dismiss(auto, 401)).toBe(false);
    expect(repo.synced(0)).toEqual([]);
  });

  it("prunes old turns, items, deliveries, actions and asks, but keeps what still waits on you or still has mail queued", () => {
    const db = memDb();
    const conv = new ConvRepo(db);
    const repo = new InfoflowRepo(db);
    const msgs = new SessionMessagesRepo(db);
    const old = (idx: number) => repo.addItem(item({ idx, createdAt: 100 }))!;
    const done = old(0);
    const pending = old(1);
    const partial = old(2);
    const queued = old(3);
    const fresh = repo.addItem(item({ idx: 4, createdAt: 5000 }))!;
    repo.addAction({ itemId: done, change: "{}", signature: "a", mode: "auto", state: "applied", createdAt: 100 });
    repo.addAction({ itemId: pending, change: "{}", signature: "b", mode: "confirm", state: "pending", createdAt: 100 });
    repo.addAction({ itemId: partial, change: "{}", signature: "c", mode: "auto", state: "partial", createdAt: 100 });
    msgs.enqueue({ id: "m-done", kind: "fact", fromSession: "s", toSession: "t", featureId: null, body: "x", queuedAt: 100 });
    msgs.delivered("m-done", { at: 110, via: "hook", toSession: "t", baseReplyId: null });
    repo.addDelivery(done, "t", "m-done", 100);
    msgs.enqueue({ id: "m-q", kind: "fact", fromSession: "s", toSession: "u", featureId: null, body: "x", queuedAt: 100 });
    repo.addDelivery(queued, "u", "m-q", 100);
    const t1 = conv.openTurn({ rootSessionId: "r", sessionId: "s", sourceKey: "k1", forkId: null, kind: "user", at: 1, asked: false });
    const t2 = conv.openTurn({ rootSessionId: "r", sessionId: "s", sourceKey: "k2", forkId: null, kind: "user", at: 1, asked: false });
    repo.markTurn({ turnId: t1, sessionId: "s", state: "done", reason: null, items: 1, at: 100 });
    repo.markTurn({ turnId: t2, sessionId: "s", state: "done", reason: null, items: 1, at: 5000 });
    repo.recordAsk(100);
    repo.recordAsk(4000);

    expect(repo.prune(1000, 3000)).toBeGreaterThan(0);
    const left = repo.items({ all: true }, 10).map((i) => i.id).sort((a, b) => a - b);
    expect(left).toEqual([pending, partial, queued, fresh]);
    expect(repo.deliveries([done])).toEqual([]);
    expect(repo.deliveries([queued])).toHaveLength(1);
    expect(repo.pending()).toHaveLength(1);
    expect(repo.partial()).toHaveLength(1);
    expect(repo.turnHandled(t1)).toBe(false);
    expect(repo.turnHandled(t2)).toBe(true);
    expect(repo.asksSince(0)).toEqual({ count: 1, oldest: 4000 });
    // 再清一遍没东西可删。
    expect(repo.prune(1000, 3000)).toBe(0);
  });

  it("rechecks applied actions in the short window, and partial or still-queued ones only within the keep window", () => {
    const db = memDb();
    const repo = new InfoflowRepo(db);
    const msgs = new SessionMessagesRepo(db);
    const act = (idx: number, state: "applied" | "partial" | "already", at: number) => {
      const it = repo.addItem(item({ idx, createdAt: at }))!;
      const id = repo.addAction({ itemId: it, change: "{}", signature: `s${idx}`, mode: "auto", state: "pending", createdAt: at })!;
      repo.transition(id, ["pending"], state, { at });
      return { it, id };
    };
    const recent = act(0, "applied", 900);
    const oldApplied = act(1, "applied", 300);
    const partialIn = act(2, "partial", 300);
    const partialOut = act(3, "partial", 50);
    const queuedIn = act(4, "already", 300);
    const queuedOut = act(5, "already", 50);
    for (const [q, m] of [[queuedIn, "q-in"], [queuedOut, "q-out"]] as const) {
      msgs.enqueue({ id: m, kind: "fact", fromSession: "s", toSession: "t", featureId: null, body: "x", queuedAt: 1 });
      repo.addDelivery(q.it, "t", m, 1);
    }
    const ids = repo.toRecheck(800, 100).map((a) => a.id).sort((a, b) => a - b);
    expect(ids).toEqual([recent.id, partialIn.id, queuedIn.id].sort((a, b) => a - b));
    expect(ids).not.toContain(oldApplied.id);
    expect(ids).not.toContain(partialOut.id);
    expect(ids).not.toContain(queuedOut.id);
  });
});
