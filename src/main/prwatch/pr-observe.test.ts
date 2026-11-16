import { describe, expect, it } from "vitest";
import type { PrWatchRow } from "../db/pr-watch-repo";
import type { PrComment, PrStatus } from "../tickets/gh";
import { derivePrStages } from "./pr-stages";
import { prObservations } from "./pr-observe";
import type { PrTarget } from "./pr-watcher";

const t: PrTarget = { ticketKey: "BTL-1", repoId: 3, repoPath: "/r", cwd: "/w", branch: "b", sessionOpen: true };
const next = (o: Partial<Omit<PrWatchRow, "deliveredKey">> = {}): Omit<PrWatchRow, "deliveredKey"> => ({
  ticketKey: "BTL-1", repoId: 3, repoPath: "/r", branch: "b", number: 7, url: "u", state: "open", review: null, ci: "pending", headSha: "a1", checkedAt: 100, failed: [], ...o,
});
const prev = (o: Partial<PrWatchRow> = {}): PrWatchRow => ({ ...next(), deliveredKey: null, ...o });
const comment = (id: string, o: Partial<PrComment> = {}): PrComment => ({ id, author: "bob", body: "hi", createdAt: 50, url: null, path: null, line: null, reviewId: null, ...o });
const pr = (o: Partial<PrStatus> = {}): PrStatus => ({
  number: 7, url: "u", state: "OPEN", isDraft: false, review: null, headSha: "a1", headBranch: "b", checks: [], ci: "pending", author: "me", createdAt: null, mergedAt: null, closedAt: null,
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
    expect(keys(o)).toEqual(["3:first_commit:b", "3:opened:b:7", "3:ci:b:a1:pending:1000", "3:review:b:r1:COMMENTED", "3:review:b:r2:APPROVED", "3:comment:b:c1", "3:comment:b:i1"]);
    expect(o[0].event).toMatchObject({ kind: "first_commit", at: 5, ticketKey: "BTL-1", repoId: 3, branch: "b" });
    expect(o[2].event).toMatchObject({ kind: "ci", at: 1000, data: { result: "pending", sha: "a1" } });
    expect(o[3].event).toMatchObject({ kind: "review", at: 10, data: { id: "r1", who: "copilot", state: "COMMENTED" } });
    expect(o[4].event.data).toMatchObject({ who: "human", author: "alice" });
    expect(o[6].event.data).toMatchObject({ id: "i1", reviewId: "r1", who: "human", path: "a.ts", line: 3 });
  });

  it("repeats reviews but not push or CI when nothing changed", () => {
    const o = prObservations(t, prev(), next(), pr(), [], null, 1000);
    expect(keys(o)).toEqual(["3:review:b:r1:COMMENTED", "3:review:b:r2:APPROVED", "3:comment:b:c1"]);
  });

  it("keeps a repeated CI result on the same sha (a rerun) as its own event", () => {
    const seq: Array<["pending" | "passing" | "failing", "pending" | "passing" | "failing", number]> = [
      ["pending", "passing", 1000], ["passing", "pending", 2000], ["pending", "failing", 3000], ["failing", "pending", 4000], ["pending", "passing", 5000],
    ];
    const all = seq.flatMap(([a, b, now]) => prObservations(t, prev({ ci: a }), next({ ci: b }), null, [], null, now));
    const ciKeys = all.filter((o) => o.event.kind === "ci").map((o) => o.dedupeKey);
    expect(new Set(ciKeys).size).toBe(5);
    expect(all.at(-1)?.event.data).toMatchObject({ result: "passing" });
  });

  it("puts the push before the CI of the new sha, so they sort that way at the same time", () => {
    const o = prObservations(t, prev({ ci: "passing" }), next({ headSha: "b2", ci: "pending" }), null, [], null, 1000);
    expect(keys(o)).toEqual(["3:push:b:b2", "3:ci:b:b2:pending:1000"]);
    expect(o[0].event.at).toBe(o[1].event.at);
  });

  it("uses GitHub's times for opened, merged and closed, and now when they are missing", () => {
    const o = prObservations(t, null, next({ state: "merged" }), pr({ createdAt: 11, mergedAt: 22 }), [], null, 1000);
    expect(o.find((x) => x.event.kind === "pr_opened")?.event.at).toBe(11);
    expect(o.find((x) => x.event.kind === "merged")?.event.at).toBe(22);
    expect(o.find((x) => x.event.kind === "ci")?.event.at).toBe(22);
    expect(prObservations(t, prev(), next({ state: "merged" }), pr(), [], null, 1000).find((x) => x.event.kind === "merged")?.event.at).toBe(1000);
    expect(prObservations(t, prev(), next({ state: "closed" }), pr({ closedAt: 33 }), [], null, 1000).find((x) => x.event.kind === "closed")?.event.at).toBe(33);
  });

  it("records the CI of a PR that appears on the sha CI already ran on", () => {
    const o = prObservations(t, prev({ number: null, state: null, ci: "passing" }), next({ ci: "passing" }), pr({ ci: "passing" }), [], null, 1000);
    expect(keys(o).filter((k) => k !== "3:review:b:r1:COMMENTED" && k !== "3:review:b:r2:APPROVED" && k !== "3:comment:b:c1")).toEqual(["3:opened:b:7", "3:ci:b:a1:passing:1000"]);
  });

  it("records no CI without a PR", () => {
    expect(prObservations(t, null, next({ number: null, state: null, ci: "passing" }), null, [], null, 1000)).toEqual([]);
  });

  it("records merged and closed when the state changes", () => {
    expect(keys(prObservations(t, prev(), next({ state: "merged" }), null, [], null, 1000))).toEqual(["3:merged:b:7"]);
    expect(keys(prObservations(t, prev(), next({ state: "closed" }), null, [], null, 1000))).toEqual(["3:closed:b:7"]);
  });

  describe("a PR that merges", () => {
    const merged = (events: ReturnType<typeof prObservations>) =>
      derivePrStages({
        ticketKey: "BTL-1", featureId: null, repoId: 3, repoName: "r", branch: "b", ticketCreatedAt: 0, upperDesign: [], reports: [],
        events: events.map((o, i) => ({ id: i + 1, ...o.event })), pr: { number: 7, url: "u", state: "merged" }, skillTracking: true,
      }).stages.map((c) => `${c.id}:${c.state}`);
    const done = (cells: string[]) => {
      expect(cells.filter((c) => c.endsWith(":active"))).toEqual([]);
      expect(cells).toContain("merge:done");
    };

    it("CI passing and merging in the same poll ends with merge done", () => {
      const r1 = prObservations(t, null, next(), pr({ createdAt: 1000, reviews: [] }), [], 500, 2000);
      const r2 = prObservations(t, prev(), next({ ci: "passing", state: "merged" }), pr({ state: "MERGED", ci: "passing", mergedAt: 5000, reviews: [] }), [], null, 9000);
      expect(r2.filter((o) => o.event.kind === "ci").map((o) => o.event.at)).toEqual([5000]);
      expect(merged([...r1, ...r2])).toContain("merge:done");
      done(merged([...r1, ...r2]));
    });

    it("first sighting of an already merged PR ends with merge done", () => {
      const o = prObservations(t, prev({ number: null, state: null, ci: "passing" }), next({ ci: "passing", state: "merged" }), pr({ state: "MERGED", ci: "passing", createdAt: 1000, mergedAt: 5000 }), [], 500, 9000);
      done(merged(o));
    });
  });

  it("uses REST bot info for suffix-less app logins, in reviews and in same-login comments; real humans stay human", () => {
    const p = pr({
      reviews: [{ id: "r9", author: "someapp", state: "APPROVED", body: "", submittedAt: 10 }, { id: "r8", author: "alice", state: "APPROVED", body: "", submittedAt: 11 }],
      comments: [comment("c9", { author: "SomeApp" }), comment("c8", { author: "alice" })],
    });
    const o = prObservations(t, prev(), next(), p, [], null, 1000, { botReviewIds: new Set(["r9"]), botLogins: new Set(["someapp"]) });
    const who = Object.fromEntries(o.filter((x) => x.event.kind !== "ci").map((x) => [x.dedupeKey, x.event.data.who]));
    expect(who).toMatchObject({ "3:review:b:r9:APPROVED": "bot", "3:review:b:r8:APPROVED": "human", "3:comment:b:c9": "bot", "3:comment:b:c8": "human" });
  });

  it("a DISMISSED review is stamped with the time it was seen, not GitHub's original submittedAt", () => {
    const p = pr({ reviews: [{ id: "r2", author: "alice", state: "DISMISSED", body: "", submittedAt: 20 }] });
    const o = prObservations(t, prev(), next(), p, [], null, 1000).find((x) => x.event.kind === "review");
    expect(o?.event.at).toBe(1000);
    expect(o?.event.data.state).toBe("DISMISSED");
  });

  it("keys carry the branch: the same sha and PR number on a new branch are new events; the same branch repeats the same keys", () => {
    const on = (branch: string) => prObservations({ ...t, branch }, prev({ headSha: "a0", branch }), next({ branch }), pr(), [], null, 1000);
    const a = keys(on("b"));
    const c = keys(on("c"));
    expect(a.filter((k) => c.includes(k))).toEqual([]);
    expect(keys(on("b"))).toEqual(a);
    expect(a.some((k) => k.includes(":push:b:a1"))).toBe(true);
  });

  it("a review that changes state (approved, then dismissed) gets a new key; PENDING stays skipped", () => {
    const p = (state: "APPROVED" | "DISMISSED") => pr({ reviews: [{ id: "r2", author: "alice", state, body: "", submittedAt: 20 }, { id: "r3", author: "alice", state: "PENDING", body: "", submittedAt: 30 }], comments: [] });
    const rk = (state: "APPROVED" | "DISMISSED") => keys(prObservations(t, prev(), next(), p(state), [], null, 1000)).filter((k) => k.includes(":review:"));
    expect(rk("APPROVED")).toEqual(["3:review:b:r2:APPROVED"]);
    expect(rk("DISMISSED")).toEqual(["3:review:b:r2:DISMISSED"]);
  });
});
