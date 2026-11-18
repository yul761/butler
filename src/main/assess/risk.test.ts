import { describe, expect, it } from "vitest";
import { defaultPrPolicy, expandPrPolicy, PR_POLICY_DEFAULTS } from "../../shared/pr-policy";
import type { DiffFile } from "../../shared/prereview";
import { computeRisk, type RiskInput } from "./risk";
import { inferTicketType } from "./ticket-type";

const f = (path: string, added = 5, deleted = 0): DiffFile => ({ path, added, deleted, binary: false });
const P = defaultPrPolicy().risk;
const base = (o: Partial<RiskInput> = {}): RiskInput => ({
  files: [f("src/util.test.ts")], openRepoCount: 1, ci: "passing", rerun: "passed", unresolvedHits: 0, checksAbsent: null,
  mustViolations: 0, evidenceGaps: [], verifiedTest: true, ticketType: null, ...o,
});
const rules = (r: ReturnType<typeof computeRisk>) => r.reasons.map((x) => x.rule);

describe("computeRisk (rules v1)", () => {
  it("low: small, test/doc-only change, CI green and a verified test", () => {
    expect(computeRisk(base(), P)).toMatchObject({ level: "low", reasons: [{ rule: "low" }] });
    // 改动 ≤ 20 行的非测试文件也可以是低风险。
    expect(computeRisk(base({ files: [f("src/a.ts", 10, 5)] }), P).level).toBe("low");
  });

  it("R1: a migration is always high, even when everything else is low", () => {
    for (const p of ["db/migrations/001_init.ts", "migrations/002.sql", "prisma/schema.prisma", "src/db/schema.ts", "x/alembic/v1.py"]) {
      const r = computeRisk(base({ files: [f(p, 1)] }), P);
      expect(r.level).toBe("high");
      expect(rules(r)).toContain("migration");
    }
  });

  it("R1 cannot be turned off by policy: builtin migration list is locked", () => {
    const pol = expandPrPolicy({ ...PR_POLICY_DEFAULTS, "risk.paths.migration": [] } as typeof PR_POLICY_DEFAULTS).risk;
    expect(computeRisk(base({ files: [f("db/migrations/1.ts", 1)] }), pol).level).toBe("high");
    const extra = expandPrPolicy(PR_POLICY_DEFAULTS, { migration: ["db/changes/**"] }).risk;
    expect(computeRisk(base({ files: [f("db/changes/x.ts", 1)] }), extra).level).toBe("high");
  });

  it("R2-R5: auth, public API, config, CI config paths are high and name the files", () => {
    const cases: [string, string][] = [["src/auth/login.ts", "auth"], ["api/v1/users.ts", "public_api"], [".env.local", "config"], [".github/workflows/ci.yml", "ci_config"]];
    for (const [p, rule] of cases) {
      const r = computeRisk(base({ files: [f(p, 1)] }), P);
      expect(r.level).toBe("high");
      expect(r.reasons.find((x) => x.rule === rule)?.files).toEqual([p]);
    }
  });

  it("R6: large diffs are high; generated files do not count", () => {
    expect(computeRisk(base({ files: [f("src/a.ts", 900)] }), P).level).toBe("high");
    expect(computeRisk(base({ files: Array.from({ length: 41 }, (_, i) => f(`src/f${i}.ts`, 1)) }), P).level).toBe("high");
    const r = computeRisk(base({ files: [f("pnpm-lock.yaml", 5000), f("src/a.test.ts", 3)] }), P);
    expect(r.level).toBe("low");
    expect(r.stats).toEqual({ lines: 3, files: 1, generated: 1 });
  });

  it("R7: more than one repo with open PRs is high", () => {
    expect(rules(computeRisk(base({ openRepoCount: 2 }), P))).toContain("multi_repo");
  });

  it("R8: CI failing, unresolved hits, checks_absent or must violations are high", () => {
    for (const o of [{ ci: "failing" as const }, { unresolvedHits: 1 }, { checksAbsent: "hook missing" }, { mustViolations: 2 }]) {
      const r = computeRisk(base(o), P);
      expect(r.level).toBe("high");
      expect(rules(r)).toContain("check_warnings");
    }
  });

  it("R9: missing evidence raises one level and does not go past high", () => {
    const gap = [{ category: "lint" as const, state: "missing" as const, detail: "" }];
    expect(computeRisk(base({ evidenceGaps: gap }), P)).toMatchObject({ level: "medium" });
    expect(computeRisk(base({ evidenceGaps: gap, files: [f("src/a.ts", 50)] }), P).level).toBe("high");
    const r = computeRisk(base({ evidenceGaps: gap, files: [f("src/auth/x.ts")] }), P);
    expect(r.level).toBe("high");
    expect(rules(r)).toContain("missing_evidence");
  });

  it("R10: ticket type floors (hotfix high, bug medium, docs none)", () => {
    expect(computeRisk(base({ ticketType: "hotfix" }), P).level).toBe("high");
    expect(computeRisk(base({ ticketType: "bug" }), P).level).toBe("medium");
    expect(computeRisk(base({ ticketType: "docs" }), P).level).toBe("low");
  });

  it("acceptance: a PR with no verified test output is never low", () => {
    const r = computeRisk(base({ verifiedTest: false }), P);
    expect(r.level).toBe("medium");
    expect(r.reasons[0]!.detail).toContain("no verified test output");
    // 预审关着：没有证据、也没有缺口，仍然到不了 low。
    expect(computeRisk(base({ verifiedTest: false, evidenceGaps: [] }), P).level).not.toBe("low");
  });

  it("without a PR, a passing rerun stands in for CI", () => {
    expect(computeRisk(base({ ci: null, rerun: "passed" }), P).level).toBe("low");
    expect(computeRisk(base({ ci: null, rerun: "none" }), P).level).toBe("medium");
    expect(computeRisk(base({ ci: "pending" }), P).level).toBe("medium");
  });
});

describe("inferTicketType", () => {
  it("label first, then the longest matching branch prefix, else null", () => {
    expect(inferTicketType(["Security"], "fix/x", P.types)).toBe("security");
    expect(inferTicketType([], "hotfix/x", P.types)).toBe("hotfix");
    expect(inferTicketType([], "fix/x", P.types)).toBe("bug");
    expect(inferTicketType(["enhancement"], "feat/x", P.types)).toBeNull();
    expect(inferTicketType([], null, P.types)).toBeNull();
  });
});
