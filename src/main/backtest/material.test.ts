import { describe, expect, it } from "vitest";
import { BacktestRepo } from "../db/backtest-repo";
import { memDb } from "../test-utils";
import { anchorsFor, materialState, MAX_REPO_ATTEMPTS, prefetchRepo, type BacktestGh } from "./material";
import type { CommentAnchor } from "./gh-backtest";

const anchor = (id: number, path: string, line: number, author = "rev", commit = "a".repeat(40)): CommentAnchor => ({ id, author, path, line, originalLine: line, originalCommit: commit });

function fakeGh(over: Partial<BacktestGh> = {}): BacktestGh & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    mergedPrs: async () => [{ number: 3, mergedAt: 3 }, { number: 2, mergedAt: 2 }, { number: 1, mergedAt: 1 }],
    prDiff: async (_c, n) => (calls.push(`diff ${n}`), `diff for ${n}`),
    anchors: async (_c, n) => (calls.push(`anchors ${n}`), n === 9 ? [anchor(90, "src/a.ts", 4)] : []),
    fileAt: async (_c, sha, p) => (calls.push(`file ${sha.slice(0, 1)} ${p}`), { status: "ok", content: "x\n" }),
    ...over,
  };
}

const live = () => new AbortController().signal;

describe("backtest material", () => {
  it("fetches the window, source PR comments and the source file, then reports ready", async () => {
    const repo = new BacktestRepo(memDb());
    const gh = fakeGh();
    const sources = [{ id: 1, prNumber: 9, path: "src/a.ts", line: 4, reviewer: "Rev" }];
    expect(materialState(repo, "o/r", sources).kind).toBe("missing");
    const r = await prefetchRepo({ repo, gh, now: () => 10 }, { slug: "o/r", cwd: "/x", recentPrs: 2, sources }, live());
    expect(r).toMatchObject({ kind: "ok", window: [3, 2] });
    expect(gh.calls).toContain("diff 3");
    expect(gh.calls).not.toContain("diff 1");
    expect(gh.calls).toContain("anchors 9");
    expect(gh.calls).toContain("file a src/a.ts");
    expect(repo.diffs("o/r", [3, 2]).map((p) => p.number)).toEqual([3, 2]);
    expect(materialState(repo, "o/r", sources)).toEqual({ kind: "ready", window: [3, 2] });
    // 第二次：都缓存了，不再调 gh。
    gh.calls.length = 0;
    await prefetchRepo({ repo, gh, now: () => 11 }, { slug: "o/r", cwd: "/x", recentPrs: 2, sources }, live());
    expect(gh.calls).toEqual([]);
  });

  it("stops on abort and continues where it left off", async () => {
    const repo = new BacktestRepo(memDb());
    const ac = new AbortController();
    const gh = fakeGh({ prDiff: async (_c, n) => (ac.abort(), `d${n}`) });
    const r = await prefetchRepo({ repo, gh, now: () => 1 }, { slug: "o/r", cwd: "/x", recentPrs: 3, sources: [] }, ac.signal);
    expect(r.kind).toBe("aborted");
    expect(repo.diffsToFetch("o/r", [3, 2, 1])).toHaveLength(2);
  });

  it("retries failed PRs at most three times and gives up on a repo whose gh keeps failing", async () => {
    const repo = new BacktestRepo(memDb());
    const gh = fakeGh({ prDiff: async () => null });
    for (let i = 0; i < 4; i++) await prefetchRepo({ repo, gh, now: () => i }, { slug: "o/r", cwd: "/x", recentPrs: 1, sources: [] }, live());
    expect(repo.diffsToFetch("o/r", [3])).toEqual([]);
    const bad = fakeGh({ mergedPrs: async () => null });
    let last;
    for (let i = 0; i < MAX_REPO_ATTEMPTS; i++) last = await prefetchRepo({ repo, gh: bad, now: () => i }, { slug: "x/y", cwd: "/x", recentPrs: 1, sources: [] }, live());
    expect(last).toEqual({ kind: "failed", gaveUp: true });
    expect(materialState(repo, "x/y", []).kind).toBe("no_gh");
  });

  it("gives up at once when gh is not installed", async () => {
    const repo = new BacktestRepo(memDb());
    const gh = fakeGh({ mergedPrs: async () => null, available: async () => false });
    const r = await prefetchRepo({ repo, gh, now: () => 1 }, { slug: "o/r", cwd: "/x", recentPrs: 1, sources: [] }, live());
    expect(r).toEqual({ kind: "failed", gaveUp: true });
    expect(materialState(repo, "o/r", []).kind).toBe("no_gh");
  });

  it("matches source comments by path, reviewer and line", () => {
    const as = [anchor(1, "src/a.ts", 4, "rev"), anchor(2, "src/a.ts", 9, "rev"), anchor(3, "src\\a.ts", 4, "other")];
    expect(anchorsFor({ id: 1, prNumber: 1, path: "src/a.ts", line: 4, reviewer: "REV" }, as).map((a) => a.id)).toEqual([1]);
    expect(anchorsFor({ id: 1, prNumber: 1, path: "src/a.ts", line: null, reviewer: null }, as).map((a) => a.id)).toEqual([1, 2, 3]);
    expect(anchorsFor({ id: 1, prNumber: 1, path: null, line: 4, reviewer: null }, as)).toEqual([]);
  });
});
