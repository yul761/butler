import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { migrate } from "../db/database";
import { CiTriageRepo } from "../db/ci-triage-repo";
import { CommentItemsRepo } from "../db/comment-items-repo";
import { effectDays, LoopStats } from "./stats";

describe("LoopStats", () => {
  it("summarises comments and CI over a window", () => {
    const db = memDb();
    migrate(db);
    const comments = new CommentItemsRepo(db);
    const triage = new CiTriageRepo(db);
    const a = comments.seen({ prId: 1, key: "1", kind: "inline", threadId: "T", databaseId: 1, author: "c", who: "copilot", path: "a", line: 1, body: "b", url: null, commentedAt: 1, seenSha: "s" }, 10).item;
    comments.update(a.id, { state: "addressed", deliveredAt: 20, addressedAt: 30, repliedAt: 31, resolvedAt: 32 }, 30);
    const row = triage.create({ item: { kind: "pr", id: 1 }, repoSlug: "o/r", ticketKey: "T-1", headSha: "s", runId: 5, checks: ["test"], now: 40 });
    triage.update(row.id, { state: "passed", category: "env", reruns: 1, passedAt: 50 }, 50);
    triage.addFlaky({ repoSlug: "o/r", kind: "check", name: "test", triageId: row.id, at: 50, wastedMs: 10 });
    const e = new LoopStats({ comments, triage }).summary({ since: 0, until: 100 });
    expect(e.comments).toEqual({ autoHandled: 1, byWho: { copilot: 1, human: 0 }, delivered: 1, replied: 1, resolved: 1, waitingForYou: 0 });
    expect(e.ci).toMatchObject({ triaged: 1, byCategory: { env: 1, flaky: 0, code: 0 }, reruns: 1, passedAfterRerun: 1, flakyWastedMs: 10 });
    expect(e.ci.topFlaky).toEqual([{ repoSlug: "o/r", kind: "check", name: "test", count: 1, wastedMs: 10, listed: false }]);
  });

  it("clamps the day count", () => {
    expect(effectDays(7)).toBe(7);
    expect(effectDays(0)).toBe(30);
    expect(effectDays("9")).toBe(30);
  });
});
