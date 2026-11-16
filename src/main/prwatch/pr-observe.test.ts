import { describe, expect, it } from "vitest";
import type { PrComment, PrStatus } from "../tickets/gh";
import { derivePrStages } from "./pr-stages";
import { firstCommitObservation, prObservations, scopeOf, type ObsScope, type PrSnapshot } from "./pr-observe";
import type { BranchTarget } from "./pr-schedule";

const s: ObsScope = { ticketKey: "BTL-1", prId: 11, repoId: 3, scope: "3", branch: "b" };
const next = (o: Partial<PrSnapshot> = {}): PrSnapshot => ({ number: 7, state: "open", review: null, ci: "pending", headSha: "a1", failed: [], checkedAt: 1000, ...o });
/** 读过一次的上一轮。 */
const prev = (o: Partial<PrSnapshot> = {}): PrSnapshot => ({ ...next(), checkedAt: 100, ...o });
/** 链接了、还没读过。 */
const unread = (o: Partial<PrSnapshot> = {}): PrSnapshot => prev({ checkedAt: 0, review: null, ci: "unknown", headSha: null, ...o });
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
const kinds = (o: ReturnType<typeof prObservations>, kind: string) => o.filter((x) => x.event.kind === kind);

describe("prObservations", () => {
  it("records a PR on its first read with its CI, reviews and comments, all carrying the PR id", () => {
    const o = prObservations(s, unread(), next(), pr(), [comment("i1", { reviewId: "r1", path: "a.ts", line: 3 })], 1000, null, null);
    expect(keys(o)).toEqual(["3:opened:b:7", "3:ci:b:a1:pending:1000", "3:review:b:r1:COMMENTED", "3:review:b:r2:APPROVED", "3:comment:b:c1", "3:comment:b:i1"]);
    expect(o.every((x) => x.event.prId === 11 && x.event.repoId === 3 && x.event.ticketKey === "BTL-1" && x.event.branch === "b")).toBe(true);
    expect(o[1].event).toMatchObject({ kind: "ci", at: 1000, data: { result: "pending", sha: "a1" } });
    expect(o[2].event).toMatchObject({ kind: "review", data: { id: "r1", who: "copilot", state: "COMMENTED" } });
    expect(o[3].event.data).toMatchObject({ who: "human", author: "alice" });
    expect(o[5].event.data).toMatchObject({ id: "i1", reviewId: "r1", who: "human", path: "a.ts", line: 3 });
  });

  it("a gh blip does not produce a second CI passed event", () => {
    // 上一轮 gh 失败（行上的 ci 留着），这一轮读到的和最后一条 ci 事件一样：passing@s1。
    const o = prObservations(s, prev({ ci: "passing", headSha: "s1" }), next({ ci: "passing", headSha: "s1" }), pr({ headSha: "s1", ci: "passing" }), [], 2000, null, { sha: "s1", result: "passing" });
    expect(kinds(o, "ci")).toEqual([]);
    // 行上是 unknown 也不算：只和最后一条 ci 事件比。
    expect(kinds(prObservations(s, prev({ ci: "unknown", headSha: "s1" }), next({ ci: "passing", headSha: "s1" }), null, [], 2000, null, { sha: "s1", result: "passing" }), "ci")).toEqual([]);
    expect(kinds(prObservations(s, prev({ ci: "passing", headSha: "s1" }), next({ ci: "passing", headSha: "s1" }), null, [], 2000, null, null), "ci")).toHaveLength(1);
  });

  it("records CI when the result or the sha differs from the last CI event; a rerun with the same result on the same sha later is its own event", () => {
    const at = (ci: "pending" | "passing" | "failing", sha: string, last: { sha: string | null; result: string } | null, now: number) =>
      kinds(prObservations(s, prev(), next({ ci, headSha: sha }), null, [], now, null, last), "ci").map((x) => x.dedupeKey);
    expect(at("passing", "a1", { sha: "a1", result: "pending" }, 1000)).toEqual(["3:ci:b:a1:passing:1000"]);
    expect(at("pending", "a2", { sha: "a1", result: "pending" }, 1000)).toEqual(["3:ci:b:a2:pending:1000"]);
    expect(at("passing", "a1", { sha: "a1", result: "passing" }, 1000)).toEqual([]);
    expect(kinds(prObservations(s, prev(), next({ ci: "none" }), null, [], 1000, null, null), "ci")).toEqual([]);
  });

  it("repeats reviews and comments but not push or CI when nothing changed", () => {
    const o = prObservations(s, prev(), next(), pr(), [], 1000, null, { sha: "a1", result: "pending" });
    expect(keys(o)).toEqual(["3:opened:b:7", "3:review:b:r1:COMMENTED", "3:review:b:r2:APPROVED", "3:comment:b:c1"]);
  });

  it("puts the push before the CI of the new sha, so they sort that way at the same time", () => {
    const o = prObservations(s, prev({ ci: "passing" }), next({ headSha: "b2", ci: "pending" }), null, [], 1000, null, { sha: "a1", result: "passing" });
    expect(keys(o)).toEqual(["3:push:b:b2", "3:ci:b:b2:pending:1000"]);
    expect(o[0].event.at).toBe(o[1].event.at);
  });

  it("a review seen on a later read is placed at observation time; on the first read at min(submittedAt, seen)", () => {
    const p = pr({ reviews: [{ id: "r2", author: "alice", state: "APPROVED", body: "", submittedAt: 20 }, { id: "r5", author: "bob", state: "APPROVED", body: "", submittedAt: 5000 }] });
    const reviewAt = (o: ReturnType<typeof prObservations>) => kinds(o, "review").map((x) => [x.event.data.id, x.event.at]);
    // 第一次读：GitHub 的时间，但不晚于看到的时间（GitHub 和本机的钟可能不一致）。
    expect(reviewAt(prObservations(s, unread(), next(), p, [], 1000, null, null))).toEqual([["r2", 20], ["r5", 1000]]);
    expect(reviewAt(prObservations(s, null, next(), p, [], 1000, null, null))).toEqual([["r2", 20], ["r5", 1000]]);
    // 之后的读：看到的时间。
    expect(reviewAt(prObservations(s, prev(), next(), p, [], 1000, null, null))).toEqual([["r2", 1000], ["r5", 1000]]);
  });

  it("a DISMISSED review is stamped with the time it was seen, also on the first read", () => {
    const p = pr({ reviews: [{ id: "r2", author: "alice", state: "DISMISSED", body: "", submittedAt: 20 }] });
    for (const before of [prev(), unread()]) {
      const o = kinds(prObservations(s, before, next(), p, [], 1000, null, null), "review")[0];
      expect(o.event.at).toBe(1000);
      expect(o.event.data.state).toBe("DISMISSED");
    }
  });

  it("uses GitHub's times for opened, merged and closed, never later than now, and now when they are missing", () => {
    const o = prObservations(s, unread(), next({ state: "merged" }), pr({ createdAt: 11, mergedAt: 22 }), [], 1000, null, null);
    expect(kinds(o, "pr_opened")[0].event.at).toBe(11);
    expect(kinds(o, "merged")[0].event.at).toBe(22);
    expect(kinds(o, "ci")[0].event.at).toBe(22);
    expect(kinds(prObservations(s, prev(), next({ state: "merged" }), pr(), [], 1000, null, null), "merged")[0].event.at).toBe(1000);
    expect(kinds(prObservations(s, prev(), next({ state: "merged" }), pr({ mergedAt: 9000 }), [], 1000, null, null), "merged")[0].event.at).toBe(1000);
    expect(kinds(prObservations(s, prev(), next({ state: "closed" }), pr({ closedAt: 33 }), [], 1000, null, null), "closed")[0].event.at).toBe(33);
  });

  it("records merged and closed when the state changes, and on the first read of a PR linked as merged", () => {
    expect(keys(prObservations(s, prev(), next({ state: "merged" }), null, [], 1000, null, { sha: "a1", result: "pending" }))).toEqual(["3:merged:b:7"]);
    expect(keys(prObservations(s, prev(), next({ state: "closed" }), null, [], 1000, null, { sha: "a1", result: "pending" }))).toEqual(["3:closed:b:7"]);
    expect(kinds(prObservations(s, prev({ state: "merged" }), next({ state: "merged" }), null, [], 1000, null, null), "merged")).toEqual([]);
    expect(kinds(prObservations(s, unread({ state: "merged" }), next({ state: "merged" }), null, [], 1000, null, null), "merged")).toHaveLength(1);
  });

  it("slug-only scope keys include the ticket", () => {
    expect(scopeOf("BTL-1", 3, "acme/app")).toBe("3");
    expect(scopeOf("BTL-1", null, "acme/app")).toBe("BTL-1@acme/app");
    const a = prObservations({ ...s, repoId: null, scope: scopeOf("BTL-1", null, "acme/app") }, unread(), next(), pr(), [], 1000, null, null);
    const b = prObservations({ ...s, ticketKey: "BTL-2", prId: 12, repoId: null, scope: scopeOf("BTL-2", null, "acme/app") }, unread(), next(), pr(), [], 1000, null, null);
    expect(keys(a)[0]).toBe("BTL-1@acme/app:opened:b:7");
    expect(keys(a).every((k) => k.startsWith("BTL-1@acme/app:"))).toBe(true);
    expect(keys(a).filter((k) => keys(b).includes(k))).toEqual([]);
    expect(a[0].event).toMatchObject({ ticketKey: "BTL-1", repoId: null, prId: 11 });
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
      const r1 = prObservations(s, unread(), next(), pr({ createdAt: 1000, reviews: [] }), [], 2000, null, null);
      const r2 = prObservations(s, prev(), next({ ci: "passing", state: "merged" }), pr({ state: "MERGED", ci: "passing", mergedAt: 5000, reviews: [] }), [], 9000, null, { sha: "a1", result: "pending" });
      expect(kinds(r2, "ci").map((o) => o.event.at)).toEqual([5000]);
      done(merged([...r1, ...r2]));
    });

    it("first read of an already merged PR ends with merge done", () => {
      const o = prObservations(s, unread({ state: "merged" }), next({ ci: "passing", state: "merged" }), pr({ state: "MERGED", ci: "passing", createdAt: 1000, mergedAt: 5000 }), [], 9000, null, null);
      done(merged(o));
    });
  });

  it("uses REST bot info for suffix-less app logins, in reviews and in same-login comments; real humans stay human", () => {
    const p = pr({
      reviews: [{ id: "r9", author: "someapp", state: "APPROVED", body: "", submittedAt: 10 }, { id: "r8", author: "alice", state: "APPROVED", body: "", submittedAt: 11 }],
      comments: [comment("c9", { author: "SomeApp" }), comment("c8", { author: "alice" })],
    });
    const o = prObservations(s, prev(), next(), p, [], 1000, { botReviewIds: new Set(["r9"]), botLogins: new Set(["someapp"]) }, null);
    const who = Object.fromEntries(o.filter((x) => x.event.kind === "review" || x.event.kind === "comment").map((x) => [x.dedupeKey, x.event.data.who]));
    expect(who).toEqual({ "3:review:b:r9:APPROVED": "bot", "3:review:b:r8:APPROVED": "human", "3:comment:b:c9": "bot", "3:comment:b:c8": "human" });
  });

  it("keys carry the branch: the same sha and PR number on a new branch are new events; the same branch repeats the same keys", () => {
    const on = (branch: string) => prObservations({ ...s, branch }, prev({ headSha: "a0" }), next(), pr(), [], 1000, null, null);
    const a = keys(on("b"));
    const c = keys(on("c"));
    expect(a.filter((k) => c.includes(k))).toEqual([]);
    expect(keys(on("b"))).toEqual(a);
    expect(a.some((k) => k.includes(":push:b:a1"))).toBe(true);
  });

  it("a review that changes state (approved, then dismissed) gets a new key; PENDING stays skipped", () => {
    const p = (state: "APPROVED" | "DISMISSED") => pr({ reviews: [{ id: "r2", author: "alice", state, body: "", submittedAt: 20 }, { id: "r3", author: "alice", state: "PENDING", body: "", submittedAt: 30 }], comments: [] });
    const rk = (state: "APPROVED" | "DISMISSED") => keys(prObservations(s, prev(), next(), p(state), [], 1000, null, null)).filter((k) => k.includes(":review:"));
    expect(rk("APPROVED")).toEqual(["3:review:b:r2:APPROVED"]);
    expect(rk("DISMISSED")).toEqual(["3:review:b:r2:DISMISSED"]);
  });
});

describe("firstCommitObservation", () => {
  const t: BranchTarget = { ticketKey: "BTL-1", repoId: 3, repoPath: "/r", cwd: "/w", branch: "b", sessionOpen: false };

  it("keys the first commit by repo and branch, with an :after: suffix for a later round", () => {
    expect(firstCommitObservation(t, 42, null)).toEqual({
      event: { ticketKey: "BTL-1", repoId: 3, prId: null, branch: "b", featureId: null, epicId: null, sessionId: null, kind: "first_commit", at: 42, data: {} },
      dedupeKey: "3:first_commit:b",
    });
    expect(firstCommitObservation(t, 42, 9).dedupeKey).toBe("3:first_commit:b:after:9");
  });
});
