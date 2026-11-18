import { describe, expect, it } from "vitest";
import { defaultPrPolicy, expandPrPolicy, PR_POLICY_DEFAULTS } from "../../shared/pr-policy";
import { checkDescription, computeReadiness, stripButlerBlocks, type ReadinessInput } from "./readiness";

const P = defaultPrPolicy().readiness;
const DESC = "## What\nChanges the retry loop.\n\n## Why\nThe old loop never backed off.\n\n## How verified\nUnit tests added and pnpm test passes.";
const base = (o: Partial<ReadinessInput> = {}): ReadinessInput => ({
  ci: "passing", blockFailures: 0, preReviewEnabled: true, preReview: { headSha: "s1", status: "done", verdict: "clean", should: 0 },
  headSha: "s1", evidenceGaps: [], openComments: 0, mergeable: "MERGEABLE", waitingOnGate: false, description: DESC, ...o,
});
const state = (r: ReturnType<typeof computeReadiness>, k: string) => r.conditions.find((c) => c.key === k)!.state;

describe("computeReadiness", () => {
  it("all six pass → ready", () => {
    const r = computeReadiness(base(), P);
    expect(r.ready).toBe(true);
    expect(r.conditions.map((c) => c.state)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass"]);
  });

  it("checks: CI pending is unknown (not ready), failing or block failures fail", () => {
    expect(state(computeReadiness(base({ ci: "pending" }), P), "checks")).toBe("unknown");
    expect(computeReadiness(base({ ci: "pending" }), P).ready).toBe(false);
    expect(state(computeReadiness(base({ ci: "failing" }), P), "checks")).toBe("fail");
    expect(state(computeReadiness(base({ blockFailures: 1 }), P), "checks")).toBe("fail");
  });

  it("pre_review: off when disabled, fail for an older sha or violations, should-level blocks only by policy", () => {
    expect(state(computeReadiness(base({ preReviewEnabled: false }), P), "pre_review")).toBe("off");
    expect(computeReadiness(base({ preReviewEnabled: false, evidenceGaps: null, preReview: null }), P).ready).toBe(true);
    expect(computeReadiness(base({ headSha: "s2" }), P).missing[0]).toMatchObject({ key: "pre_review", state: "fail", detail: "pre-review is for an older commit" });
    expect(state(computeReadiness(base({ preReview: { headSha: "s1", status: "done", verdict: "violations", should: 0 } }), P), "pre_review")).toBe("fail");
    expect(state(computeReadiness(base({ preReview: { headSha: "s1", status: "running", verdict: null, should: 0 } }), P), "pre_review")).toBe("unknown");
    const should = base({ preReview: { headSha: "s1", status: "done", verdict: "clean", should: 2 } });
    expect(state(computeReadiness(should, P), "pre_review")).toBe("pass");
    const strict = expandPrPolicy({ ...PR_POLICY_DEFAULTS, "readiness.shouldBlocks": true } as typeof PR_POLICY_DEFAULTS).readiness;
    expect(state(computeReadiness(should, strict), "pre_review")).toBe("fail");
  });

  it("acceptance: missing evidence → not ready and names what is missing", () => {
    const r = computeReadiness(base({ evidenceGaps: [{ category: "test", state: "missing", detail: "" }] }), P);
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual([{ key: "evidence", state: "fail", detail: "missing test output" }]);
    const zh = computeReadiness(base({ evidenceGaps: [{ category: "test", state: "missing", detail: "" }] }), P, "zh");
    expect(zh.missing[0]!.detail).toBe("缺测试输出");
  });

  it("comments, mergeable and the merge gate", () => {
    expect(state(computeReadiness(base({ openComments: 2 }), P), "comments")).toBe("fail");
    expect(state(computeReadiness(base({ openComments: null }), P), "comments")).toBe("unknown");
    expect(state(computeReadiness(base({ mergeable: "CONFLICTING" }), P), "mergeable")).toBe("fail");
    expect(state(computeReadiness(base({ mergeable: "UNKNOWN" }), P), "mergeable")).toBe("unknown");
    expect(state(computeReadiness(base({ waitingOnGate: true }), P), "mergeable")).toBe("fail");
  });

  it("each condition switch turns its condition off and it no longer blocks", () => {
    for (const k of ["checks", "pre_review", "evidence", "comments", "mergeable", "description"]) {
      const pol = expandPrPolicy({ ...PR_POLICY_DEFAULTS, [`readiness.${k}.enabled`]: false } as typeof PR_POLICY_DEFAULTS).readiness;
      const bad = base({ ci: "failing", headSha: "s2", evidenceGaps: [{ category: "test", state: "missing", detail: "" }], openComments: 1, mergeable: "CONFLICTING", description: "x" });
      const r = computeReadiness(bad, pol);
      expect(state(r, k)).toBe("off");
      expect(r.missing.map((m) => m.key)).not.toContain(k);
    }
  });

  it("description: Butler blocks are ignored; length and three keyword groups", () => {
    expect(stripButlerBlocks(`hi <!-- butler:brief -->\nlots of text\n<!-- /butler:brief --> there`)).toBe("hi  there");
    expect(checkDescription(DESC, P)).toMatchObject({ ok: true, missing: [] });
    expect(checkDescription(`${"x".repeat(100)} what changed`, P).missing).toEqual(["why", "verify"]);
    const onlyBlock = `<!-- butler:brief -->\n${DESC}\n<!-- /butler:brief -->`;
    expect(state(computeReadiness(base({ description: onlyBlock }), P), "description")).toBe("fail");
    expect(checkDescription("改动：重试逻辑。原因：旧的不退避，导致上游被打满，影响所有调用方的稳定性和延迟表现。验证：加了单元测试并全部通过，手工也复现过。", { ...P, descriptionMinChars: 20 }).ok).toBe(true);
  });
});
