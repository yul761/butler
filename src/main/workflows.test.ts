import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (f: string) => readFileSync(`${root}${f}`, "utf8");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  if?: string;
}
interface Job {
  "runs-on": string;
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix: { os: string[] } };
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const runs = (job: Job) => job.steps.map((s) => s.run ?? "").filter(Boolean);

describe("CI workflows (design 1.3, 11)", () => {
  const ci = parse(read(".github/workflows/ci.yml")) as Workflow;
  const release = parse(read(".github/workflows/release.yml")) as Workflow;

  it("tests on macOS and Windows with every check, the E2E suite included", () => {
    const test = ci.jobs.test;
    expect(test.strategy?.matrix.os).toEqual(["macos-14", "windows-latest"]);
    expect(test.strategy?.["fail-fast"]).toBe(false);
    for (const cmd of ["pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm lint", "pnpm test", "pnpm build", "pnpm build:hook", "pnpm e2e"]) {
      expect(runs(test), cmd).toContain(cmd);
    }
    expect(test.steps.some((s) => s.uses?.startsWith("actions/setup-node@") && s.with?.["node-version-file"] === ".node-version")).toBe(true);
  });

  it("builds unsigned installers on both platforms and only drafts a release", () => {
    expect(release.jobs.build.strategy?.matrix.os).toEqual(["macos-14", "windows-latest"]);
    expect(runs(release.jobs.build)).toContain("pnpm dist");
    const publish = runs(release.jobs.release).join("\n");
    expect(publish).toContain("gh release create");
    expect(publish).toContain("--draft");
  });

  it("packages unsigned, builds the hook first, and verifies the package contents", () => {
    for (const job of [ci.jobs.package, release.jobs.build]) {
      expect(job.env?.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
      const r = runs(job);
      expect(r.indexOf("pnpm build:hook")).toBeGreaterThan(r.indexOf("pnpm build"));
      expect(r.indexOf("pnpm dist")).toBeGreaterThan(r.indexOf("pnpm build:hook"));
      expect(r.indexOf("node scripts/verify-package.mjs dist")).toBeGreaterThan(r.indexOf("pnpm dist"));
    }
  });

  it("checks Git Bash on Windows and uploads E2E logs when the suite fails", () => {
    const steps = ci.jobs.test.steps;
    expect(steps.some((s) => s.if === "runner.os == 'Windows'" && /bash --version/.test(s.run ?? ""))).toBe(true);
    const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact@") && s.if === "failure()");
    expect(String(upload?.with?.path)).toContain("test-results/");
    expect(String(upload?.with?.path)).toContain("butler-e2e-");
  });

  it("never pushes code or publishes packages, and asks for the least permissions", () => {
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(release.permissions).toEqual({ contents: "write" });
    for (const text of [read(".github/workflows/ci.yml"), read(".github/workflows/release.yml")]) {
      expect(text).not.toMatch(/git push|npm publish|pnpm publish|secrets\.(?!GITHUB_TOKEN)/);
    }
  });

  it("keeps LF line endings on Windows checkouts", () => {
    expect(read(".gitattributes")).toContain("* text=auto eol=lf");
  });
});
