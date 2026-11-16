import { describe, expect, it } from "vitest";
import type { PrWatchRow } from "../db/pr-watch-repo";
import type { PrComment, PrStatus } from "../tickets/gh";
import { prObservations } from "./pr-observe";
import type { PrTarget } from "./pr-watcher";

const t: PrTarget = { ticketKey: "BTL-1", repoId: 3, repoPath: "/r", cwd: "/w", branch: "b", sessionOpen: true };
const next = (o: Partial<Omit<PrWatchRow, "deliveredKey">> = {}): Omit<PrWatchRow, "deliveredKey"> => ({
  ticketKey: "BTL-1", repoId: 3, repoPath: "/r", branch: "b", number: 7, url: "u", state: "open", review: null, ci: "pending", headSha: "a1", checkedAt: 100, failed: [], ...o,
});
const prev = (o: Partial<PrWatchRow> = {}): PrWatchRow => ({ ...next(), deliveredKey: null, ...o });
const comment = (id: string, o: Partial<PrComment> = {}): PrComment => ({ id, author: "bob", body: "hi", createdAt: 50, url: null, path: null, line: null, reviewId: null, ...o });
const pr = (o: Partial<PrStatus> = {}): PrStatus => ({
  number: 7, url: "u", state: "OPEN", isDraft: false, review: null, headSha: "a1", checks: [], ci: "pending", author: "me",
  reviews: [
    { id: "r1", author: "copilot-pull-request-reviewer", state: "COMMENTED", body: "x", submittedAt: 10 },
    { id: "r2", author: "alice", state: "APPROVED", body: "ok", submittedAt: 20 },
    { id: "r3", author: "alice", state: "PENDING", body: "", submittedAt: 30 },
  ],
  comments: [comment("c1")], firstCommitAt: null, ...o,
});
const keys = (o: ReturnType<typeof prObservations>) => o.map((x) => x.dedupeKey);

describe("prObservations", () => {
  it("records a new PR with its CI, reviews and comments", () => {
    const o = prObservations(t, null, next(), pr(), [comment("i1", { reviewId: "r1", path: "a.ts", line: 3 })], 5, 1000);
    expect(keys(o)).toEqual(["3:first_commit:b", "3:opened:7", "3:ci:a1:pending", "3:review:r1", "3:review:r2", "3:comment:c1", "3:comment:i1"]);
    expect(o[0].event).toMatchObject({ kind: "first_commit", at: 5, ticketKey: "BTL-1", repoId: 3, branch: "b" });
    expect(o[2].event).toMatchObject({ kind: "ci", at: 1000, data: { result: "pending", sha: "a1" } });
    expect(o[3].event).toMatchObject({ kind: "review", at: 10, data: { id: "r1", who: "copilot", state: "COMMENTED" } });
    expect(o[4].event.data).toMatchObject({ who: "human", author: "alice" });
    expect(o[6].event.data).toMatchObject({ id: "i1", reviewId: "r1", who: "human", path: "a.ts", line: 3 });
  });

  it("repeats reviews but not push or CI when nothing changed", () => {
    const o = prObservations(t, prev(), next(), pr(), [], null, 1000);
    expect(keys(o)).toEqual(["3:review:r1", "3:review:r2", "3:comment:c1"]);
  });

  it("puts the push before the CI of the new sha, so they sort that way at the same time", () => {
    const o = prObservations(t, prev({ ci: "passing" }), next({ headSha: "b2", ci: "pending" }), null, [], null, 1000);
    expect(keys(o)).toEqual(["3:push:b2", "3:ci:b2:pending"]);
    expect(o[0].event.at).toBe(o[1].event.at);
  });

  it("records no CI without a PR", () => {
    expect(prObservations(t, null, next({ number: null, state: null, ci: "passing" }), null, [], null, 1000)).toEqual([]);
  });

  it("records merged and closed when the state changes", () => {
    expect(keys(prObservations(t, prev(), next({ state: "merged" }), null, [], null, 1000))).toEqual(["3:merged:7"]);
    expect(keys(prObservations(t, prev(), next({ state: "closed" }), null, [], null, 1000))).toEqual(["3:closed:7"]);
  });
});
