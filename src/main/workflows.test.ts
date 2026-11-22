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
  environment?: string;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix: { os: string[] } };
  steps: Step[];
}
interface Workflow {
  concurrency?: { "cancel-in-progress": string };
  on: Record<string, { inputs?: Record<string, { type?: string; default?: unknown }> } | null | undefined>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const runs = (job: Job) => job.steps.map((s) => s.run ?? "").filter(Boolean);
const SIGNING_SECRETS = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY_P8", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];
const DEVELOPER_ID = "steps.signing.outputs.mode == 'developer-id'";
/** BTL-259：环境 release 的部署策略只放行分支 main 和 v* tag，workflow 里判断「这次能不能签名」用的是同一个条件。 */
const SIGNING_REF = "(github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v'))";

describe("CI workflows (design 1.3, 11)", () => {
  const ci = parse(read(".github/workflows/ci.yml")) as Workflow;
  const release = parse(read(".github/workflows/release.yml")) as Workflow;

  it("tests on macOS and Windows with every check, the E2E suite included", () => {
    const test = ci.jobs.test;
    expect(test.strategy?.matrix.os).toEqual(["macos-15", "windows-latest"]);
    expect(test.strategy?.["fail-fast"]).toBe(false);
    for (const cmd of ["pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm lint", "pnpm test", "pnpm build", "pnpm build:hook", "pnpm e2e:only"]) {
      expect(runs(test), cmd).toContain(cmd);
    }
    expect(test.steps.some((s) => s.uses?.startsWith("actions/setup-node@") && s.with?.["node-version-file"] === ".node-version")).toBe(true);
  });

  it("builds installers on both platforms and only drafts a release, from a pushed tag", () => {
    expect(release.jobs.build.strategy?.matrix.os).toEqual(["macos-15", "windows-latest"]);
    // One platform's failure does not cancel the other's build; the release still waits for both.
    expect(release.jobs.build.strategy?.["fail-fast"]).toBe(false);
    expect(release.jobs.release.needs).toBe("build");
    // BTL-258: a manual run (workflow_dispatch) only builds and uploads, even when started on a tag ref.
    expect(release.jobs.release.if).toBe("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')");
    expect(runs(release.jobs.build)).toContain("pnpm dist");
    const publish = runs(release.jobs.release).join("\n");
    expect(publish).toContain("gh release create");
    expect(publish).toContain("--draft");
  });

  it("never looks for a signing identity on its own, builds the hook first, and verifies the package and the macOS signature", () => {
    for (const job of [ci.jobs.package, release.jobs.build]) {
      expect(job.env?.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
      const r = runs(job);
      expect(r.indexOf("pnpm build:hook")).toBeGreaterThan(r.indexOf("pnpm build"));
      expect(r.indexOf("pnpm dist")).toBeGreaterThan(r.indexOf("pnpm build:hook"));
      expect(r.indexOf("node scripts/verify-package.mjs dist")).toBeGreaterThan(r.lastIndexOf("pnpm dist"));
      const verify = job.steps.find((s) => s.run?.startsWith("node scripts/verify-mac-signing.mjs dist --mode "));
      expect(verify?.if).toBe("runner.os == 'macOS'");
      expect(job.steps.indexOf(verify as Step)).toBeGreaterThan(job.steps.findIndex((s) => s.run === "node scripts/verify-package.mjs dist"));
    }
    // ci.yml never signs: ad-hoc only.
    expect(ci.jobs.package.steps.find((s) => s.run?.startsWith("node scripts/verify-mac-signing.mjs"))?.run).toBe("node scripts/verify-mac-signing.mjs dist --mode ad-hoc");
    expect(release.jobs.build.steps.find((s) => s.run?.startsWith("node scripts/verify-mac-signing.mjs"))?.run).toBe(
      "node scripts/verify-mac-signing.mjs dist --mode ${{ steps.signing.outputs.mode }}",
    );
  });

  it("signs macOS with Developer ID only when the signing secrets are set, and ad-hoc otherwise, never both (BTL-258)", () => {
    const steps = release.jobs.build.steps;
    const decide = steps.find((s) => s.run === "node scripts/mac-signing.cjs release") as Step & { id?: string };
    expect(decide?.id).toBe("signing");
    expect(decide?.if).toBe("runner.os == 'macOS'");
    // The decision sees only whether each secret is set, never its value.
    for (const n of SIGNING_SECRETS) expect(decide?.env?.[`HAS_${n}`], n).toBe(`\${{ secrets.${n} != '' }}`);
    expect(decide?.env?.REQUIRE_SIGNING).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.require_signing }}");

    const dists = steps.filter((s) => s.run === "pnpm dist");
    expect(dists.map((s) => s.if)).toEqual(["steps.signing.outputs.mode != 'developer-id'", DEVELOPER_ID]);
    // electron-builder treats an empty CSC_LINK as set, so the ad-hoc build must not see these names at all.
    expect(dists[0].env).toBeUndefined();
    expect(dists[1].env).toEqual({
      CSC_LINK: "${{ secrets.CSC_LINK }}",
      CSC_KEY_PASSWORD: "${{ secrets.CSC_KEY_PASSWORD }}",
      CSC_IDENTITY_AUTO_DISCOVERY: "true",
      APPLE_API_KEY_ID: "${{ secrets.APPLE_API_KEY_ID }}",
      APPLE_API_ISSUER: "${{ secrets.APPLE_API_ISSUER }}",
    });
    const all = steps.indexOf(decide);
    for (const d of dists) expect(steps.indexOf(d)).toBeGreaterThan(all);
  });

  it("writes the App Store Connect key to a private temporary file, deletes it whatever happens, and never prints it", () => {
    const steps = release.jobs.build.steps;
    const write = steps.find((s) => s.env?.APPLE_API_KEY_P8 !== undefined);
    expect(write?.if).toBe(DEVELOPER_ID);
    expect(write?.env).toEqual({ APPLE_API_KEY_P8: "${{ secrets.APPLE_API_KEY_P8 }}" });
    expect(write?.run).toMatch(/mktemp -d "\$RUNNER_TEMP\//);
    expect(write?.run).toContain("umask 077");
    expect(write?.run).toContain('echo "APPLE_API_KEY=$dir/AuthKey.p8" >> "$GITHUB_ENV"');
    // Only the path goes to the log or the environment, never the contents.
    expect(write?.run).not.toMatch(/echo[^\n]*APPLE_API_KEY_P8|cat |set -x/);
    const del = steps.find((s) => s.name === "Delete the App Store Connect API key");
    expect(del?.if).toBe("always() && runner.os == 'macOS'");
    expect(del?.run).toContain('rm -rf "$(dirname "$APPLE_API_KEY")"');
    expect(steps.indexOf(del as Step)).toBeGreaterThan(steps.indexOf(write as Step));
    expect(steps.indexOf(del as Step)).toBeGreaterThan(steps.findIndex((s) => s.name === "Notarize and staple the dmg"));
    for (const s of steps) if (s.run && /set -x|printenv|env \|/.test(s.run)) throw new Error(`${s.name}: prints the environment`);
  });

  it("passes signing secrets only to steps that run for the Developer ID build", () => {
    const text = read(".github/workflows/release.yml");
    const named = [...text.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(named)).toEqual(new Set(SIGNING_SECRETS));
    for (const s of release.jobs.build.steps) {
      for (const [k, v] of Object.entries(s.env ?? {})) {
        if (/secrets\.\w+ != ''/.test(v)) continue; // only whether it is set
        if (/secrets\./.test(v)) expect(s.if, `${s.name}: ${k}`).toBe(DEVELOPER_ID);
      }
      expect(s.run ?? "", String(s.name)).not.toMatch(/secrets\./);
      expect(s.with ? JSON.stringify(s.with) : "", String(s.name)).not.toMatch(/secrets\./);
    }
    // The release job only learns whether the macOS build was signed.
    const draft = release.jobs.release.steps.find((s) => /gh release create/.test(s.run ?? ""));
    expect(draft?.env?.MAC_SIGNED).toBe("${{ secrets.CSC_LINK != '' }}");
  });

  it("can be run by hand to try the signing, failing instead of falling back to ad-hoc", () => {
    const input = release.on.workflow_dispatch?.inputs?.require_signing;
    expect(input).toMatchObject({ type: "boolean", default: true });
  });

  it("takes the signing secrets only from the protected environment release, and only for macOS on main or a v* tag (BTL-259)", () => {
    // An expression that comes out empty means no environment: Windows and every other ref run without one, so they are
    // never refused with "not allowed to deploy", and they get no environment secrets (macOS goes ad-hoc).
    expect(release.jobs.build.environment).toBe(`\${{ startsWith(matrix.os, 'macos') && ${SIGNING_REF} && 'release' || '' }}`);
    // The release job runs only for a pushed v* tag, which the environment allows; it needs it to tell whether CSC_LINK is set.
    expect(release.jobs.release.environment).toBe("release");
    expect(ci.jobs.test.environment).toBeUndefined();
    expect(ci.jobs.package.environment).toBeUndefined();
  });

  it("fails a manual run that requires signing on any ref but main or a v* tag, before building anything (BTL-259)", () => {
    const steps = release.jobs.build.steps;
    const guard = steps.find((s) => s.name === "Signing needs main or a v* tag");
    // Same ref condition as the environment, negated: the guard fires exactly where the environment is not used.
    expect(guard?.if).toBe(
      "runner.os == 'macOS' && github.event_name == 'workflow_dispatch' && inputs.require_signing && github.ref != 'refs/heads/main' && !startsWith(github.ref, 'refs/tags/v')",
    );
    expect(guard?.shell).toBe("bash");
    expect(guard?.run).toContain("::error::require_signing is on, but signing is only available on main or a v* tag");
    expect(guard?.run).toContain("exit 1");
    expect(guard?.env).toBeUndefined();
    expect(steps.indexOf(guard as Step)).toBe(0);
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
      expect(text).not.toMatch(/git push|npm publish|pnpm publish/);
    }
    // ci.yml (pull requests, forks) never sees a secret. release.yml sees only the five signing secrets (BTL-258), and
    // only in the Developer ID steps: see "passes signing secrets only to steps that run for the Developer ID build".
    expect(read(".github/workflows/ci.yml")).not.toMatch(/secrets\./);
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
