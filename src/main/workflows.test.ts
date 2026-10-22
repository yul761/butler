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
  shell?: string;
  env?: Record<string, string>;
}
interface Job {
  "runs-on": string;
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix: { os: string[] } };
  steps: Step[];
}
interface Workflow {
  concurrency?: { "cancel-in-progress": string };
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
    for (const cmd of ["pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm lint", "pnpm test", "pnpm build", "pnpm build:hook", "pnpm e2e:only"]) {
      expect(runs(test), cmd).toContain(cmd);
    }
    expect(test.steps.some((s) => s.uses?.startsWith("actions/setup-node@") && s.with?.["node-version-file"] === ".node-version")).toBe(true);
  });

  it("builds unsigned installers on both platforms and only drafts a release", () => {
    expect(release.jobs.build.strategy?.matrix.os).toEqual(["macos-14", "windows-latest"]);
    // One platform's failure does not cancel the other's build; the release still waits for both.
    expect(release.jobs.build.strategy?.["fail-fast"]).toBe(false);
    expect(release.jobs.release.needs).toBe("build");
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
    const bash = steps.find((s) => s.if === "runner.os == 'Windows'" && /bash --version/.test(s.run ?? ""));
    expect(bash?.shell).toBe("bash");
    const e2e = steps.find((s) => s.run === "pnpm e2e:only");
    for (const k of ["TMPDIR", "TEMP", "TMP"]) expect(e2e?.env?.[k], k).toBe("${{ runner.temp }}");
    expect(steps.indexOf(e2e as Step)).toBeGreaterThan(steps.findIndex((s) => s.run === "pnpm build:hook"));
    const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact@") && s.if === "failure()");
    expect(String(upload?.with?.path)).toContain("test-results/");
    expect(String(upload?.with?.path)).toContain("butler-e2e-");
  });

  it("uploads only the named installers, never the NSIS uninstaller stub", () => {
    for (const job of [ci.jobs.package, release.jobs.build]) {
      const upload = job.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
      const globs = String(upload?.with?.path).trim().split("\n").map((l) => l.trim());
      expect(globs).toEqual(["dist/*.dmg", "dist/*.zip", "dist/Butler-Setup-*.exe"]);
      expect(upload?.with?.["if-no-files-found"]).toBe("error");
    }
  });

  it("downloads the Electron binary before running the tests in every job that runs them", () => {
    for (const job of [ci.jobs.test, release.jobs.build]) {
      const r = runs(job);
      const download = r.indexOf("pnpm exec install-electron");
      expect(download).toBeGreaterThan(-1);
      expect(download).toBeLessThan(r.indexOf("pnpm test"));
    }
  });

  it("only cancels superseded pull request runs", () => {
    expect(ci.concurrency?.["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it("never pushes code or publishes packages; write access is confined to the release job", () => {
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(release.permissions).toEqual({ contents: "read" });
    expect(release.jobs.release.permissions).toEqual({ contents: "write" });
    expect(release.jobs.build.permissions).toBeUndefined();
    for (const text of [read(".github/workflows/ci.yml"), read(".github/workflows/release.yml")]) {
      expect(text).not.toMatch(/git push|npm publish|pnpm publish|secrets\.(?!GITHUB_TOKEN)/);
    }
  });

  it("pins every release.yml action by 40-hex SHA and pnpm/action-setup in ci.yml", () => {
    const uses = Object.values(release.jobs).flatMap((j) => j.steps.map((s) => s.uses).filter(Boolean)) as string[];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    const pnpm = ci.jobs.test.steps.concat(ci.jobs.package.steps).filter((s) => s.uses?.startsWith("pnpm/action-setup@"));
    expect(pnpm.length).toBe(2);
    for (const s of pnpm) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
    expect(read(".github/workflows/release.yml")).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
  });

  it("refuses a release tag that differs from the package.json version", () => {
    const step = release.jobs.build.steps.find((s) => /GITHUB_REF_NAME/.test(s.run ?? "") && /package\.json/.test(s.run ?? ""));
    expect(step?.shell).toBe("bash");
    expect(step?.if).toBe("startsWith(github.ref, 'refs/tags/')");
    expect(step?.run).toContain("exit 1");
  });

  it("keeps GitHub Actions updated weekly", () => {
    const d = parse(read(".github/dependabot.yml")) as { updates: { "package-ecosystem": string; schedule: { interval: string } }[] };
    expect(d.updates).toContainEqual(expect.objectContaining({ "package-ecosystem": "github-actions", schedule: { interval: "weekly" } }));
  });

  it("keeps LF line endings on Windows checkouts", () => {
    expect(read(".gitattributes")).toContain("* text=auto eol=lf");
  });
});
