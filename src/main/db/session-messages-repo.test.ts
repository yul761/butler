import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { SessionMessagesRepo } from "./session-messages-repo";

const base = { kind: "report" as const, fromSession: "a", toSession: "c", featureId: 1, body: "hi", queuedAt: 10 };

describe("SessionMessagesRepo", () => {
  it("clears why it was blocked once it is delivered (review suggestion 4)", () => {
    const repo = new SessionMessagesRepo(memDb());
    repo.enqueue({ ...base, id: "m1", kind: "instruction", expectsReply: true, interrupt: false, meta: null });
    repo.setBlocked(["m1"], "needs_you", 15);
    expect(repo.get("m1")).toMatchObject({ blockedReason: "needs_you", blockedSince: 15 });
    repo.delivered("m1", { at: 20, via: "input", toSession: "c", baseReplyId: null });
    expect(repo.get("m1")).toMatchObject({ status: "delivered", blockedReason: null, blockedSince: null });
  });

  it("queues, delivers and records a reply; each step only moves forward", () => {
    const repo = new SessionMessagesRepo(memDb());
    repo.enqueue({ ...base, id: "m1", kind: "instruction", expectsReply: true, interrupt: true, meta: { items: [1, 2] } });
    const m = repo.get("m1");
    expect(m).toMatchObject({ status: "queued", interrupt: true, expectsReply: true, meta: { items: [1, 2] }, via: null });
    expect(repo.replied("m1", { text: "x", at: 1 })).toBe(false);
    expect(repo.delivered("m1", { at: 20, via: "hook", toSession: "c2", baseReplyId: "r0" })).toBe(true);
    expect(repo.delivered("m1", { at: 21, via: "input", toSession: "c3", baseReplyId: null })).toBe(false);
    expect(repo.get("m1")).toMatchObject({ status: "delivered", via: "hook", toSession: "c2", baseReplyId: "r0", deliveredAt: 20 });
    expect(repo.awaitingReply(0).map((x) => x.id)).toEqual(["m1"]);
    expect(repo.awaitingReply(21)).toEqual([]);
    expect(repo.replied("m1", { text: "done", at: 30 })).toBe(true);
    expect(repo.get("m1")).toMatchObject({ status: "replied", replyText: "done", repliedAt: 30 });
    expect(repo.awaitingReply(0)).toEqual([]);
  });

  it("a second message with the same ref replaces the queued one instead of adding another", () => {
    const repo = new SessionMessagesRepo(memDb());
    expect(repo.enqueue({ ...base, id: "m1", ref: "answer:7" })).toEqual({ id: "m1", replaced: false });
    expect(repo.enqueue({ ...base, id: "m2", ref: "answer:7", body: "new", toSession: "d" })).toEqual({ id: "m1", replaced: true });
    expect(repo.queued().map((x) => [x.id, x.body, x.toSession])).toEqual([["m1", "new", "d"]]);
    expect(repo.queuedByRef("answer:7")?.id).toBe("m1");
    // 送到以后同一个 ref 可以再排一条。
    repo.delivered("m1", { at: 11, via: "input", toSession: "d", baseReplyId: null });
    expect(repo.queuedByRef("answer:7")).toBeNull();
    expect(repo.enqueue({ ...base, id: "m3", ref: "answer:7" })).toEqual({ id: "m3", replaced: false });
    expect(repo.withdraw("answer:7")).toBe("m3");
    expect(repo.withdraw("answer:7")).toBeNull();
    expect(repo.get("m1")?.status).toBe("delivered");
  });

  it("lists recent messages by feature or by sessions, newest first, and prunes old ones", () => {
    const repo = new SessionMessagesRepo(memDb());
    repo.enqueue({ ...base, id: "a", queuedAt: 1 });
    repo.enqueue({ ...base, id: "b", queuedAt: 2, featureId: 2, fromSession: "shipherd", toSession: "x" });
    repo.enqueue({ ...base, id: "c", queuedAt: 3, featureId: null, fromSession: "y", toSession: "shipherd" });
    expect(repo.recent({ featureId: 1 }, 10).map((x) => x.id)).toEqual(["a"]);
    expect(repo.recent({ sessions: ["shipherd"] }, 10).map((x) => x.id)).toEqual(["c", "b"]);
    expect(repo.recent({ sessions: ["shipherd"] }, 1).map((x) => x.id)).toEqual(["c"]);
    expect(repo.recent({ sessions: [] }, 10)).toEqual([]);
    expect(repo.prune(3)).toBe(2);
    expect(repo.queued().map((x) => x.id)).toEqual(["c"]);
  });
});
