import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types";
import { ButlerMessagesRepo } from "../db/butler-messages-repo";
import type { DeliveryCheck } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import { memDb } from "../test-utils";
import { ButlerMessages, MESSAGE_WAIT_MS, REPLY_DELIVERY_MAX_AGE_MS } from "./butler-messages";

const session = (id: string): Session => ({
  id, ticketKey: null, cwd: "/w", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null, waitingForInput: true, replacedBy: null,
  dismissed: false, createdAt: 1, repoId: null, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, epicId: null, model: null, butler: false, lessonRunId: null,
});

function setup(o: { ensureRunning?: (id: string) => Promise<boolean> } = {}) {
  const repo = new ButlerMessagesRepo(memDb());
  const replaced = new Map<string, string>();
  const ids = ["butler", "coord", "coord2", "epic"];
  const state = {
    now: 1_000,
    open: new Set(ids),
    replies: new Map<string, { id: string; text: string; at: number | null }>(),
    gate: null as DeliveryCheck | null,
    result: "sent" as DeliverResult,
    n: 0,
  };
  const head = (id: string): Session | null => {
    let cur = id;
    while (replaced.has(cur)) cur = replaced.get(cur)!;
    return ids.includes(cur) || cur.startsWith("new") ? session(cur) : null;
  };
  const deliver = vi.fn<(termId: string, text: string, recheck: () => boolean) => Promise<DeliverResult>>(() => Promise.resolve(state.result));
  const notify = vi.fn();
  const svc = new ButlerMessages({
    repo, head,
    lastReply: (id) => state.replies.get(id) ?? null,
    termOf: (id) => (state.open.has(head(id)?.id ?? id) ? `term-${id}` : null),
    guard: { check: (id) => state.gate ?? { ok: true, termId: `term-${id}`, headId: id }, recheckAfter: () => () => true },
    deliver,
    ...(o.ensureRunning && { ensureRunning: o.ensureRunning }),
    targetName: (m) => (m.featureId !== null ? `feature-${m.featureId}` : `epic-${m.epicId}`),
    notify,
    now: () => state.now,
    newId: () => `req-${++state.n}`,
    log: () => undefined,
  });
  return { repo, svc, state, deliver, notify, replaced };
}

describe("ButlerMessagesRepo", () => {
  it("moves through the statuses only from the expected one", () => {
    const repo = new ButlerMessagesRepo(memDb());
    repo.insert({ id: "a", fromSession: "b", targetSession: null, featureId: 1, epicId: null, text: "hi", baseReplyId: null, queuedAt: 10 });
    repo.replied("a", { id: "r", text: "x", at: 11 });
    expect(repo.get("a")?.status).toBe("sending");
    repo.sent("a", "t");
    repo.failed("a", "nope");
    expect(repo.get("a")).toMatchObject({ status: "waiting", targetSession: "t", error: null });
    repo.replied("a", { id: "r", text: "x", at: 11 });
    repo.delivered(["a"], 12);
    expect(repo.get("a")).toMatchObject({ status: "delivered", replyId: "r", replyText: "x", repliedAt: 11, deliveredAt: 12 });
    repo.insert({ id: "b", fromSession: "b", targetSession: "t", featureId: null, epicId: 2, text: "x", baseReplyId: "r0", queuedAt: 20 });
    repo.failed("b", "blocked");
    expect(repo.get("b")).toMatchObject({ status: "failed", error: "blocked", epicId: 2, baseReplyId: "r0" });
    expect(repo.recent(10).map((m) => m.id)).toEqual(["b", "a"]);
  });

  it("expires messages with no reply and replies that never got back", () => {
    const repo = new ButlerMessagesRepo(memDb());
    const add = (id: string, at: number) => repo.insert({ id, fromSession: "b", targetSession: "t", featureId: 1, epicId: null, text: "x", baseReplyId: null, queuedAt: at });
    add("old", 0);
    add("fresh", 900);
    add("rep", 0);
    repo.sent("old", "t");
    repo.sent("fresh", "t");
    repo.sent("rep", "t");
    repo.replied("rep", { id: "r", text: "x", at: 50 });
    expect(repo.expire(1000, 500, 900)).toBe(2);
    expect(repo.get("old")).toMatchObject({ status: "expired", error: "no_reply" });
    expect(repo.get("rep")).toMatchObject({ status: "expired", error: "not_delivered" });
    expect(repo.get("fresh")?.status).toBe("waiting");
    // 了结了的、够旧的删掉；还在等的不删。
    expect(repo.prune(100)).toBe(2);
    expect(repo.get("old")).toBeNull();
    expect(repo.get("fresh")?.status).toBe("waiting");
  });
});

describe("ButlerMessages", () => {
  it("records the base reply, takes the next new reply on Stop and delivers it to the sender", async () => {
    const { svc, state, deliver, repo } = setup();
    state.replies.set("coord", { id: "r0", text: "old", at: 500 });
    const id = svc.begin({ from: "butler", target: "coord", featureId: 7, epicId: null, text: "status?" });
    expect(id).toBe("req-1");
    svc.settled(id, "coord", "sent");
    // 还是送之前那条：不算。
    await svc.targetStopped("coord");
    expect(repo.get(id)?.status).toBe("waiting");
    state.now = 2_000;
    state.replies.set("coord", { id: "r1", text: "all green", at: 1_900 });
    await svc.targetStopped("coord");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe("term-butler");
    expect(deliver.mock.calls[0][1]).toContain("feature-7");
    expect(deliver.mock.calls[0][1]).toContain("req-1");
    expect(deliver.mock.calls[0][1]).toContain("all green");
    expect(repo.get(id)).toMatchObject({ status: "delivered", replyText: "all green", deliveredAt: 2_000 });
  });

  it("ignores an older reply seen after a resume, and follows the target and sender across a refresh", async () => {
    const { svc, state, deliver, repo, replaced } = setup();
    state.now = 1_000;
    const id = svc.begin({ from: "butler", target: null, featureId: 7, epicId: null, text: "go" });
    // 打开终端：接着 coord 的对话，拿到新 head。
    replaced.set("coord", "new1");
    svc.settled(id, "coord", "sent");
    expect(repo.get(id)?.targetSession).toBe("new1");
    state.replies.set("new1", { id: "r-old", text: "earlier", at: 900 });
    await svc.targetStopped("new1");
    expect(repo.get(id)?.status).toBe("waiting");
    state.replies.set("new1", { id: "r2", text: "done", at: 1_100 });
    // 总控自己换新了：送到新的 head。
    replaced.set("butler", "new2");
    state.open.add("new2");
    await svc.targetStopped("new1");
    expect(deliver.mock.calls[0][0]).toBe("term-new2");
    expect(repo.get(id)?.status).toBe("delivered");
  });

  it("keeps the reply until the sender is running and its guard lets it in", async () => {
    const { svc, state, deliver, repo } = setup();
    const id = svc.begin({ from: "butler", target: "coord", featureId: 7, epicId: null, text: "go" });
    svc.settled(id, "coord", "sent");
    state.open.delete("butler");
    state.replies.set("coord", { id: "r1", text: "done", at: 2_000 });
    await svc.targetStopped("coord");
    expect(deliver).not.toHaveBeenCalled();
    expect(repo.get(id)?.status).toBe("replied");
    state.open.add("butler");
    state.gate = { ok: false, block: "typing" };
    await svc.flush();
    expect(deliver).not.toHaveBeenCalled();
    state.gate = null;
    state.result = "timeout";
    await svc.flush();
    expect(repo.get(id)?.status).toBe("replied");
    state.result = "sent";
    await svc.flush();
    expect(repo.get(id)?.status).toBe("delivered");
  });

  it("uses the injected ensureRunning hook", async () => {
    const ensure = vi.fn(() => Promise.resolve(false));
    const { svc, state, deliver } = setup({ ensureRunning: ensure });
    expect(await svc.ensureRunning("coord")).toBe(false);
    const id = svc.begin({ from: "butler", target: "coord", featureId: 7, epicId: null, text: "go" });
    svc.settled(id, "coord", "sent");
    state.replies.set("coord", { id: "r1", text: "done", at: 2_000 });
    await svc.targetStopped("coord");
    expect(ensure).toHaveBeenCalledWith("butler");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("combines replies for one sender, posting a shared reply once", async () => {
    const { svc, state, deliver } = setup();
    const a = svc.begin({ from: "butler", target: "coord", featureId: 7, epicId: null, text: "a" });
    const b = svc.begin({ from: "butler", target: "coord", featureId: 7, epicId: null, text: "b" });
    const c = svc.begin({ from: "butler", target: "epic", featureId: null, epicId: 3, text: "c" });
    for (const [id, t] of [[a, "coord"], [b, "coord"], [c, "epic"]]) svc.settled(id, t, "sent");
    state.open.delete("butler");
    state.replies.set("coord", { id: "r1", text: "coord says", at: 2_000 });
    state.replies.set("epic", { id: "r2", text: "epic says", at: 2_000 });
    await svc.targetStopped("coord");
    await svc.targetStopped("epic");
    state.open.add("butler");
    await svc.flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    const text = deliver.mock.calls[0][1];
    expect(text.match(/coord says/g)).toHaveLength(1);
    expect(text).toContain("req-1");
    expect(text).toContain("req-2");
    expect(text).toContain("epic-3");
  });

  it("takes the reply when the target stopped before the deliver result came back", async () => {
    const { svc, state, deliver, repo } = setup();
    state.replies.set("coord", { id: "r0", text: "old", at: 500 });
    const id = svc.begin({ from: "butler", target: "coord", featureId: 7, epicId: null, text: "status?" });
    // 目标已经答完、停下了，消息还是 sending。
    state.now = 1_100;
    state.replies.set("coord", { id: "r1", text: "done fast", at: 1_050 });
    await svc.targetStopped("coord");
    expect(repo.get(id)?.status).toBe("sending");
    svc.settled(id, "coord", "sent");
    await vi.waitFor(() => expect(repo.get(id)?.status).toBe("delivered"));
    expect(deliver.mock.calls[0][1]).toContain("done fast");
  });

  it("does not look again on settle when the target has not stopped since", () => {
    const { svc, state, repo } = setup();
    state.replies.set("coord", { id: "r0", text: "old", at: 500 });
    const id = svc.begin({ from: "butler", target: "coord", featureId: 7, epicId: null, text: "status?" });
    state.replies.set("coord", { id: "r1", text: "unrelated", at: 1_050 });
    svc.settled(id, "coord", "sent");
    expect(repo.get(id)?.status).toBe("waiting");
  });

  it("records failures and expiry, and lists recent messages newest first", async () => {
    const { svc, state, repo } = setup();
    const a = svc.begin({ from: "butler", target: "coord", featureId: 7, epicId: null, text: "a" });
    svc.settled(a, "coord", "timeout");
    expect(repo.get(a)).toMatchObject({ status: "failed", error: "timeout" });
    const b = svc.begin({ from: "butler", target: "coord", featureId: 7, epicId: null, text: "b" });
    svc.failed(b, "typing");
    state.now = 1_001;
    const c = svc.begin({ from: "butler", target: "coord", featureId: 7, epicId: null, text: "c" });
    svc.settled(c, "coord", "sent");
    state.now += MESSAGE_WAIT_MS + 1;
    await svc.flush();
    expect(repo.get(c)).toMatchObject({ status: "expired", error: "no_reply" });
    expect(REPLY_DELIVERY_MAX_AGE_MS).toBeLessThan(MESSAGE_WAIT_MS);
    const recent = svc.recent();
    expect(recent.map((m) => m.requestId)).toEqual([c, b, a]);
    expect(recent[0]).toMatchObject({ target: "feature-7", status: "expired", queuedAt: new Date(1_001).toISOString(), reply: null });
  });
});
