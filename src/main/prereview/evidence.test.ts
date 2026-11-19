import { describe, expect, it } from "vitest";
import type { ProfileProject, RepoProfile } from "../../shared/baselines";
import { defaultPrPolicy } from "../../shared/pr-policy";
import type { EvidenceItem } from "../../shared/prereview";
import { evidenceStatus, hasVerifiedTest, projectsFor, requiredEvidence } from "./evidence";

const proj = (dir: string, p: Partial<ProfileProject> = {}): ProfileProject => ({
  dir, langs: [], install: null, build: null, testAll: null, testOne: null, fastest: null, lint: null, typecheck: null, inferred: [], ...p,
});
const profile = (...projects: ProfileProject[]): RepoProfile => ({ projects, dirs: [], ci: [], pitfalls: [] });
const pol = () => defaultPrPolicy().evidence;

let nextId = 1;
const item = (p: Partial<EvidenceItem>): EvidenceItem => ({
  id: nextId++, preReviewId: 1, prId: null, kind: "check", category: "test", name: "tests", command: "pnpm test", claimed: "pass",
  summary: "", verified: "pending", verifyDetail: null, rerunOutput: null, createdAt: 0, verifiedAt: null, ...p,
});

describe("projectsFor", () => {
  it("assigns each file to the longest matching project dir", () => {
    const root = proj(".");
    const web = proj("apps/web/");
    const hit = projectsFor(profile(root, web), ["apps/web/src/a.ts"]);
    expect(hit).toEqual([web]);
    expect(projectsFor(profile(root, web), ["README.md", "apps/web/x.ts"])).toEqual([root, web]);
  });
  it("does not match a sibling dir that only shares a prefix", () => {
    expect(projectsFor(profile(proj("apps/web")), ["apps/webby/x.ts"])).toEqual([]);
  });
});

describe("requiredEvidence", () => {
  it("auto asks only for test without a profile", () => {
    expect(requiredEvidence(null, ["a.ts"], pol())).toEqual(["test"]);
  });
  it("auto follows the commands of the touched projects", () => {
    const p = profile(proj("", { testAll: "pnpm test", lint: "pnpm lint", typecheck: "pnpm typecheck", build: "pnpm build" }));
    // build defaults to off.
    expect(requiredEvidence(p, ["src/a.ts"], pol())).toEqual(["test", "lint", "typecheck"]);
  });
  it("auto skips categories the touched project has no command for", () => {
    const p = profile(proj("api", { lint: "ruff" }), proj("web", { testAll: "vitest", typecheck: "tsc" }));
    expect(requiredEvidence(p, ["api/x.py"], pol())).toEqual(["lint"]);
  });
  it("on and off override the profile", () => {
    const p = pol();
    p.require = { test: "off", lint: "on", typecheck: "auto", build: "on" };
    expect(requiredEvidence(null, ["a.ts"], p)).toEqual(["lint", "build"]);
  });
});

describe("evidenceStatus", () => {
  it("a verified check per category and an acceptance item leave no gaps", () => {
    const items = [item({ verified: "rerun_pass" }), item({ category: "lint", verified: "consistent" }), item({ kind: "acceptance", category: null, name: "AC1" })];
    expect(evidenceStatus(items, ["test", "lint"])).toEqual([]);
    expect(hasVerifiedTest(items)).toBe(true);
  });
  it("reports missing, bad and explained categories and a missing acceptance", () => {
    const items = [
      item({ verified: "rerun_fail", verifyDetail: "claimed pass, but rerun failed" }),
      item({ kind: "not_run", category: null, name: "typecheck", summary: "no tsconfig yet", claimed: null }),
    ];
    expect(evidenceStatus(items, ["test", "typecheck", "lint"])).toEqual([
      { category: "test", state: "bad", detail: "claimed pass, but rerun failed" },
      { category: "typecheck", state: "explained", detail: "no tsconfig yet" },
      { category: "lint", state: "missing", detail: "" },
      { category: "acceptance", state: "missing", detail: "" },
    ]);
    expect(hasVerifiedTest(items)).toBe(false);
  });
  it("an unverifiable check counts as missing, with the reason", () => {
    const gaps = evidenceStatus([item({ verified: "unverifiable", verifyDetail: "HEAD moved" }), item({ kind: "acceptance", category: null })], ["test"]);
    expect(gaps).toEqual([{ category: "test", state: "missing", detail: "HEAD moved" }]);
  });
});

describe("a check the session itself reports as failed", () => {
  it("never counts as evidence, even when the cross-check calls it consistent", () => {
    const failed = item({ claimed: "fail", verified: "consistent", summary: "3 failed", verifyDetail: "output shows 3 failures as claimed" });
    expect(evidenceStatus([failed, item({ kind: "acceptance", category: null, name: "AC", claimed: null, verified: "consistent" })], ["test"])).toEqual([
      { category: "test", state: "bad", detail: "output shows 3 failures as claimed" },
    ]);
    expect(hasVerifiedTest([failed])).toBe(false);
  });
});

