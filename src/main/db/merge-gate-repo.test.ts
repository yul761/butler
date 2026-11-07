import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { MergeGateRepo, type MergeHold } from "./merge-gate-repo";

const hold = (o: Partial<Omit<MergeHold, "id">> = {}): Omit<MergeHold, "id"> => ({
  repoPath: "/r", branch: "feat-a", target: "main", kind: "pr", prUrl: "https://x/pull/1", sessionId: "s1", ticketKey: "BTL-1", createdAt: 100, ...o,
});

describe("MergeGateRepo", () => {
  it("adds a hold, finds it by repo and branch, and drops it from the active list once released", () => {
    const repo = new MergeGateRepo(memDb());
    const id = repo.addHold(hold());
    expect(repo.activeHold("/r", "feat-a")).toMatchObject({ id, branch: "feat-a", kind: "pr", ticketKey: "BTL-1" });
    expect(repo.activeHold("/r", "other")).toBeNull();
    expect(repo.activeHolds().map((h) => h.id)).toEqual([id]);
    repo.releaseHold(id, "cancelled", 200);
    expect(repo.activeHolds()).toEqual([]);
    expect(repo.activeHold("/r", "feat-a")).toBeNull();
  });

  it("keeps one waiter per hold and session", () => {
    const repo = new MergeGateRepo(memDb());
    const id = repo.addHold(hold());
    const w = { holdId: id, sessionId: "s2", ticketKey: "BTL-2", branch: "feat-b", createdAt: 150 };
    repo.addWaiter(w);
    repo.addWaiter({ ...w, createdAt: 160 });
    repo.addWaiter({ ...w, sessionId: "s3" });
    expect(repo.waitersOf(id).map((x) => x.sessionId)).toEqual(["s2", "s3"]);
  });

  it("pendingNotices returns released holds (any outcome) whose waiters were not notified yet, with the outcome", () => {
    const repo = new MergeGateRepo(memDb());
    const merged = repo.addHold(hold());
    const cancelled = repo.addHold(hold({ branch: "feat-c" }));
    const open = repo.addHold(hold({ branch: "feat-d" }));
    const expired = repo.addHold(hold({ branch: "feat-f" }));
    for (const holdId of [merged, cancelled, open, expired]) {
      repo.addWaiter({ holdId, sessionId: "s2", ticketKey: "BTL-2", branch: "feat-b", createdAt: 150 });
      repo.addWaiter({ holdId, sessionId: "s3", ticketKey: null, branch: "feat-e", createdAt: 150 });
    }
    repo.releaseHold(merged, "merged", 200);
    repo.releaseHold(cancelled, "cancelled", 210);
    repo.releaseHold(expired, "expired", 220);
    const notices = repo.pendingNotices();
    expect(notices.map((n) => [n.sessionId, n.otherBranch, n.outcome, n.releasedAt])).toEqual([
      ["s2", "feat-a", "merged", 200], ["s3", "feat-a", "merged", 200],
      ["s2", "feat-c", "cancelled", 210], ["s3", "feat-c", "cancelled", 210],
      ["s2", "feat-f", "expired", 220], ["s3", "feat-f", "expired", 220],
    ]);
    expect(notices[0]).toMatchObject({ sessionId: "s2", otherTicket: "BTL-1", otherBranch: "feat-a" });
    repo.markNotified(notices[0].waiterId, 300);
    expect(repo.pendingNotices()).toHaveLength(5);
    expect(repo.pendingNotices()[0].sessionId).toBe("s3");
  });

  it("waitingSessionIds lists the sessions still waiting on an active hold and not yet told", () => {
    const repo = new MergeGateRepo(memDb());
    const open = repo.addHold(hold());
    const released = repo.addHold(hold({ branch: "feat-c" }));
    repo.addWaiter({ holdId: open, sessionId: "s2", ticketKey: "BTL-2", branch: "feat-b", createdAt: 150 });
    repo.addWaiter({ holdId: open, sessionId: "s3", ticketKey: "BTL-3", branch: "feat-e", createdAt: 150 });
    repo.addWaiter({ holdId: open, sessionId: null, ticketKey: null, branch: "feat-g", createdAt: 150 });
    repo.addWaiter({ holdId: released, sessionId: "s4", ticketKey: "BTL-4", branch: "feat-h", createdAt: 150 });
    repo.releaseHold(released, "merged", 200);
    const s3 = repo.waitersOf(open).find((w) => w.sessionId === "s3")!;
    repo.markNotified(s3.id, 210);
    expect(repo.waitingSessionIds()).toEqual(new Set(["s2"]));
  });

  it("returns recent events newest first with files restored, and finds the last proceed_conflict against a branch", () => {
    const repo = new MergeGateRepo(memDb());
    const base = { repoPath: "/r", ticketKey: "BTL-2", branch: "feat-b", otherTicket: "BTL-1", otherBranch: "feat-a" };
    repo.addEvent({ ...base, kind: "wait", files: [], createdAt: 100 });
    repo.addEvent({ ...base, kind: "proceed_conflict", files: ["a.ts", "b dir/c.ts"], createdAt: 200 });
    repo.addEvent({ ...base, kind: "proceed_conflict", otherBranch: "zzz", files: ["z"], createdAt: 300 });
    const ev = repo.recentEvents(50, 10);
    expect(ev.map((e) => e.createdAt)).toEqual([300, 200, 100]);
    expect(ev[1].files).toEqual(["a.ts", "b dir/c.ts"]);
    expect(repo.recentEvents(250, 10).map((e) => e.createdAt)).toEqual([300]);
    expect(repo.recentEvents(0, 1)).toHaveLength(1);
    expect(repo.lastProceedAgainst("/r", "feat-a")?.createdAt).toBe(200);
    expect(repo.lastProceedAgainst("/r", "nope")).toBeNull();
  });
});
