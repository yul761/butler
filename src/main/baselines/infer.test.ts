import { describe, expect, it, vi } from "vitest";
import { scanFiles } from "./scan";
import { resolveRules } from "./rules";
import { mergeInferred, runInference, INFER_JSON_SCHEMA, type InferRunner } from "./infer";
import { CI_ONLY_REPO, JS_REPO } from "./__fixtures__/repos";
import type { HeadlessExecResult } from "../handoff/headless-exec";

const scan = (repo: Record<string, string>) => scanFiles({ files: Object.keys(repo), read: (p) => repo[p] ?? null, rules: resolveRules([]) });
const route = { task: "repo_scan_infer", requestedTier: "mid", actualModel: null, fallbackFrom: null, degraded: false, sameModelReview: false } as const;
const ok = (value: unknown): HeadlessExecResult => ({ ok: true, value, rawText: JSON.stringify(value), result: {} as never, route: route as never });

const ANSWER = {
  inferred_checks: [
    { dir: "", category: "test", tool: "check sh", command: "./tools/check.sh", changedFiles: false, evidence: ".gitlab-ci.yml" },
    { dir: "", category: "lint", tool: "acme", command: "./bin/acme-verify --strict", fileCommand: "./bin/acme-verify {file}", stages: ["ci"] },
    { dir: "nowhere", category: "build", tool: "x", command: "make" },
    { dir: "", category: "nonsense", tool: "x", command: "x" },
    { dir: "", category: "format", tool: "x", command: "a\nb" },
  ],
  profiles: [{ dir: "", testAll: "./tools/check.sh", install: null, lint: "make verify" }, { dir: "", testAll: 5 }],
  notes: "read .gitlab-ci.yml",
};

describe("inferred fallback", () => {
  it("is asked for the unknown-language repo and not for a well-known one", () => {
    expect(scan(CI_ONLY_REPO).inferReasons.length).toBeGreaterThan(0);
    expect(scan(JS_REPO).inferReasons).toEqual([]);
  });

  it("merges valid items as low confidence and drops bad ones one by one", () => {
    const out = scan(CI_ONLY_REPO);
    const m = mergeInferred(out, ANSWER, Object.keys(CI_ONLY_REPO));
    expect(m.added).toBe(2);
    expect(m.dropped).toBe(4);
    expect(m.out.checks).toEqual([
      expect.objectContaining({ category: "test", tool: "check-sh", command: "./tools/check.sh", source: "inferred", confidence: "low", shipherdStage: "push", evidence: [".gitlab-ci.yml"] }),
      expect.objectContaining({ category: "lint", tool: "acme", fileCommand: "./bin/acme-verify {file}", stages: ["ci"], shipherdStage: "edit", changedFiles: true, evidence: ["inferred"] }),
    ]);
    expect(m.out.profile.projects).toEqual([expect.objectContaining({ dir: "", testAll: "./tools/check.sh", lint: "make verify", install: null, inferred: ["testAll", "lint"] })]);
  });

  it("never replaces a deterministic check or profile field", () => {
    const out = scan(JS_REPO);
    const m = mergeInferred(out, { inferred_checks: [{ dir: "", category: "lint", tool: "other", command: "other lint" }], profiles: [{ dir: "", testAll: "nope", build: "vite build --x" }] }, Object.keys(JS_REPO));
    expect(m.added).toBe(0);
    expect(m.out.checks).toEqual(out.checks);
    expect(m.out.profile.projects[0].testAll).toBe("pnpm test");
    expect(m.out.profile.projects[0].build).toBe("pnpm build");
  });

  it("runs through the router task with read-only tools and keeps the deterministic result on failure", async () => {
    const out = scan(CI_ONLY_REPO);
    const run = vi.fn<InferRunner>(async () => ok(ANSWER));
    const r = await runInference(run, { slug: "acme/ci-only", root: "/repo", out, files: Object.keys(CI_ONLY_REPO) });
    expect(r.state).toBe("ran");
    expect(r.out.checks).toHaveLength(2);
    const req = run.mock.calls[0][0];
    expect(req).toMatchObject({ task: "repo_scan_infer", cwd: "/repo" });
    expect(req.args.join(" ")).toContain("--allowedTools Read Grep Glob");
    expect(req.args).toContain(INFER_JSON_SCHEMA);
    expect(req.prompt).toContain("./tools/check.sh");
    expect(req.prompt).toContain("ci_unclassified");

    const failed = await runInference(async () => ({ ok: false, reason: "limit", message: "usage limit", limit: null, stderr: "", result: null, rawText: null, route }) as never, { slug: "s", root: "/r", out, files: [] });
    expect(failed).toMatchObject({ state: "failed", detail: expect.stringContaining("usage limit") });
    expect(failed.out).toBe(out);
    const threw = await runInference(async () => Promise.reject(new Error("spawn ENOENT")), { slug: "s", root: "/r", out, files: [] });
    expect(threw).toMatchObject({ state: "failed", detail: "spawn ENOENT" });
  });
});
