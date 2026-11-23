import { describe, expect, it } from "vitest";
import type { ProfileProject, RepoProfile } from "../../shared/baselines";
import type { EvidenceItem } from "../../shared/prereview";
import { applyRerun, rerunEvidence, rerunPlan, rerunVerdict, type RunFn } from "./rerun";

const proj = (dir: string, p: Partial<ProfileProject> = {}): ProfileProject => ({
  dir, langs: [], install: null, build: null, testAll: null, testOne: null, fastest: null, lint: null, typecheck: null, inferred: [], ...p,
});
const profile = (...projects: ProfileProject[]): RepoProfile => ({ projects, dirs: [], ci: [], pitfalls: [] });
const SHA = "a".repeat(40);
const full = profile(proj("", { testAll: "pnpm test", testOne: "pnpm test {test}", lint: "pnpm lint", typecheck: "pnpm typecheck", fastest: "pnpm lint" }));

/** 假 git：HEAD 和 status 按队列返回。 */
function fakeGit(heads: string[], dirty: string[] = []) {
  const calls: string[][] = [];
  return {
    calls,
    git: async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse") return `${heads.length > 1 ? heads.shift() : heads[0]}\n`;
      return dirty.length > 1 ? dirty.shift()! : (dirty[0] ?? "");
    },
  };
}

describe("rerunPlan", () => {
  it("all runs typecheck, lint and the full test command from the profile", () => {
    expect(rerunPlan(full, ["src/a.ts"], "all").map((c) => [c.category, c.command])).toEqual([
      ["typecheck", "pnpm typecheck"], ["lint", "pnpm lint"], ["test", "pnpm test"],
    ]);
  });
  it("fast runs typecheck and the fastest check, classified by matching command", () => {
    expect(rerunPlan(full, ["src/a.ts"], "fast").map((c) => [c.category, c.command])).toEqual([["typecheck", "pnpm typecheck"], ["lint", "pnpm lint"]]);
  });
  it("fast skips a fastest command that is none of lint, test or typecheck", () => {
    const p = profile(proj("", { testAll: "pnpm test", lint: "pnpm lint", typecheck: "pnpm typecheck", fastest: "pnpm test -- --changed" }));
    expect(rerunPlan(p, ["src/a.ts"], "fast").map((c) => c.category)).toEqual(["typecheck"]);
  });
  it("off runs nothing; commands needing an argument are never run", () => {
    expect(rerunPlan(full, ["a.ts"], "off")).toEqual([]);
    const p = profile(proj("", { testAll: "jest {file}" }));
    expect(rerunPlan(p, ["a.ts"], "all")).toEqual([]);
  });
  it("runs per touched project with its dir", () => {
    const p = profile(proj("api", { lint: "ruff ." }), proj("web", { lint: "eslint ." }));
    expect(rerunPlan(p, ["web/x.ts"], "all")).toEqual([{ category: "lint", command: "eslint .", dir: "web" }]);
  });
});

describe("rerunEvidence", () => {
  const plan = rerunPlan(full, ["a.ts"], "all");
  it("runs every planned command in the project dir and reports results", async () => {
    const seen: string[] = [];
    const run: RunFn = async (o) => {
      seen.push(`${o.cwd}:${o.command}:${o.timeoutMs}`);
      return o.command === "pnpm lint" ? { kind: "fail", code: 1, output: "x".repeat(5000) } : { kind: "pass" };
    };
    const g = fakeGit([SHA]);
    const r = await rerunEvidence({ cwd: "/w", sha: SHA, plan, timeoutSec: 5 }, { git: g.git, run });
    expect(r.kind).toBe("ran");
    expect(seen).toEqual(["/w:pnpm typecheck:5000", "/w:pnpm lint:5000", "/w:pnpm test:5000"]);
    expect(r.results.map((x) => x.ok)).toEqual([true, false, true]);
    expect(r.results[1]!.output.length).toBe(4000);
    expect(rerunVerdict(r)).toBe("failed");
  });
  it("skips when HEAD is not the sha or the worktree is dirty", async () => {
    const run: RunFn = async () => ({ kind: "pass" });
    expect((await rerunEvidence({ cwd: "/w", sha: SHA, plan, timeoutSec: 5 }, { git: fakeGit(["b".repeat(40)]).git, run })).kind).toBe("skipped");
    const dirty = await rerunEvidence({ cwd: "/w", sha: SHA, plan, timeoutSec: 5 }, { git: fakeGit([SHA], [" M a.ts"]).git, run });
    expect(dirty).toMatchObject({ kind: "skipped", reason: "worktree has uncommitted changes" });
    expect(rerunVerdict(dirty)).toBe("none");
  });
  it("invalidates the results when HEAD moves during the run", async () => {
    const run: RunFn = async () => ({ kind: "pass" });
    const r = await rerunEvidence({ cwd: "/w", sha: SHA, plan, timeoutSec: 5 }, { git: fakeGit([SHA, "c".repeat(40)]).git, run });
    expect(r.kind).toBe("invalidated");
    expect(rerunVerdict(r)).toBe("none");
  });
  it("stops between commands when asked and resumes from the checkpoint", async () => {
    let n = 0;
    const run: RunFn = async () => {
      n++;
      return { kind: "pass" };
    };
    const ctl = new AbortController();
    const first = await rerunEvidence({ cwd: "/w", sha: SHA, plan, timeoutSec: 5, onResult: () => ctl.abort() }, { git: fakeGit([SHA]).git, run, signal: ctl.signal });
    expect(first.kind).toBe("interrupted");
    expect(first.results).toHaveLength(1);
    const second = await rerunEvidence({ cwd: "/w", sha: SHA, plan, timeoutSec: 5, done: first.results }, { git: fakeGit([SHA]).git, run });
    expect(second.kind).toBe("ran");
    expect(second.results).toHaveLength(3);
    expect(n).toBe(3);
    expect(rerunVerdict(second)).toBe("passed");
  });
  it("drops the result of a command that was running when the job was told to stop", async () => {
    const ctl = new AbortController();
    const run: RunFn = async (o) => {
      ctl.abort();
      expect(o.signal?.aborted).toBe(true);
      return { kind: "fail", code: null, output: "killed" };
    };
    const r = await rerunEvidence({ cwd: "/w", sha: SHA, plan, timeoutSec: 5 }, { git: fakeGit([SHA]).git, run, signal: ctl.signal });
    expect(r).toEqual({ kind: "interrupted", results: [] });
  });
  it("a timeout is a non-result, not a failure", async () => {
    const run: RunFn = async () => ({ kind: "timeout", output: "" });
    const r = await rerunEvidence({ cwd: "/w", sha: SHA, plan: plan.slice(0, 1), timeoutSec: 1 }, { git: fakeGit([SHA]).git, run });
    expect(r.results[0]!.skipped).toMatch(/timed out/);
    expect(rerunVerdict(r)).toBe("none");
  });
});

describe("applyRerun", () => {
  const ev = (p: Partial<EvidenceItem>): EvidenceItem => ({
    id: 1, preReviewId: 1, prId: null, kind: "check", category: "test", name: "t", command: "echo ok", claimed: "pass",
    summary: "", verified: "pending", verifyDetail: null, rerunOutput: null, createdAt: 0, verifiedAt: null, ...p,
  });
  const res = (category: "test" | "lint", ok: boolean, skipped: string | null = null) => ({ category, command: `run ${category}`, dir: "", ok, skipped, output: ok ? "" : "boom", ms: 1 });
  it("maps rerun pass/fail onto checks of the same category, ignoring the session's own command", () => {
    const v = applyRerun([ev({ id: 1 }), ev({ id: 2, category: "lint" }), ev({ id: 3, kind: "acceptance", category: null })], { kind: "ran", results: [res("test", true), res("lint", false)] });
    expect(v).toEqual([
      { id: 1, verified: "rerun_pass", detail: "run test", rerunOutput: null },
      { id: 2, verified: "rerun_fail", detail: "claimed pass, but Shipherd's rerun failed: run lint", rerunOutput: "boom" },
    ]);
  });
  it("leaves items without a decided rerun for cross-checking; invalidated marks them unverifiable", () => {
    expect(applyRerun([ev({})], { kind: "ran", results: [res("test", false, "timed out")] })).toEqual([]);
    expect(applyRerun([ev({})], { kind: "invalidated", reason: "HEAD moved", results: [res("test", true)] })).toEqual([
      { id: 1, verified: "unverifiable", detail: "HEAD moved", rerunOutput: null },
    ]);
    expect(applyRerun([ev({})], { kind: "skipped", reason: "dirty", results: [] })).toEqual([]);
  });
});
