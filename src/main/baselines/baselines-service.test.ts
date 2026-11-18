import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { BatchRecorder } from "../batches/batch-recorder";
import { checkAdapter, lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";
import { LessonBatchService } from "../lessons/lesson-batches";
import { ChecksService } from "../checks/checks-service";
import { BaselineService, AUTO_RESCAN_GAP_MS, type BaselinesConfig } from "./baselines-service";
import { inProcessRunner } from "./runner";
import type { InferRunner } from "./infer";
import type { HeadlessExecResult } from "../handoff/headless-exec";
import { CI_ONLY_REPO, JS_REPO, MONO_REPO, PY_REPO } from "./__fixtures__/repos";
import { writeRepo } from "./test-repo";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const repoDir = (files: Record<string, string>, git = true) => {
  const r = writeRepo(files, { git });
  roots.push(r);
  return r;
};

const ANSWER = {
  inferred_checks: [
    { dir: "", category: "test", tool: "check sh", command: "./tools/check.sh" },
    { dir: "", category: "lint", tool: "acme", command: "make verify" },
  ],
  profiles: [{ dir: "", testAll: "./tools/check.sh", lint: "make verify" }],
  notes: "",
};
const inferOk: InferRunner = async () => ({ ok: true, value: ANSWER, rawText: "", result: {} as never, route: {} as never }) as HeadlessExecResult;

function setup(o: { paths?: Record<string, string | null>; infer?: InferRunner; cfg?: Partial<BaselinesConfig> } = {}) {
  const db = memDb();
  const lessons = new LessonsRepo(db);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db), checkAdapter(db)]);
  let t = 1_000_000;
  const now = () => (t += 1000);
  const checks = new ChecksService({ db, lessons, recorder, now, config: () => ({ enabled: true, editTimeoutSec: 8, pushTimeoutSec: 600, ticketPattern: "[A-Z]+-\\d+" }) });
  const batches = new LessonBatchService({ db, repo: lessons, recorder, now, onChecksChanged: () => {} });
  const paths = o.paths ?? {};
  for (const [slug, p] of Object.entries(paths)) lessons.upsertRepo(slug, p ?? "", 1);
  const cfg: BaselinesConfig = { infer: "auto", autoRescan: true, guideChars: 1200, ...o.cfg };
  const changed: string[] = [];
  const svc = new BaselineService({
    db, lessons, checks, localPath: (slug) => paths[slug] ?? null, runner: inProcessRunner, infer: o.infer, config: () => cfg, lang: () => "en", now,
    onChanged: (s) => changed.push(s),
  });
  return { db, lessons, checks, batches, svc, cfg, changed, advance: (ms: number) => (t += ms) };
}

describe("BaselineService scanning", () => {
  it("skips repos it cannot read, with the reason", async () => {
    const plain = repoDir({ "a.txt": "x" }, false);
    const { svc } = setup({ paths: { "a/none": null, "a/gone": "/definitely/not/here", "a/plain": plain } });
    expect(await svc.scan("a/none", { infer: false })).toEqual({ slug: "a/none", status: "skipped", reason: "not_cloned" });
    expect(await svc.scan("a/gone", { infer: false })).toMatchObject({ status: "skipped", reason: "not_cloned" });
    expect(await svc.scan("a/plain", { infer: false })).toMatchObject({ status: "skipped", reason: "not_git" });
    expect(svc.latest("a/plain")).toBeNull();
    expect(svc.repo.latest("a/plain")).toMatchObject({ status: "skipped", skipReason: "not_git" });
    expect(svc.summary({ kind: "global" }).skipped.map((s) => s.reason).sort()).toEqual(["not_cloned", "not_cloned", "not_git"]);
  });

  it("scans a JS repo, stores checks and profile, and does not store an unchanged rescan", async () => {
    const root = repoDir(JS_REPO);
    const { svc, changed } = setup({ paths: { "a/web": root } });
    expect(await svc.scan("a/web", { infer: true })).toEqual({ slug: "a/web", status: "ok" });
    const b = svc.latest("a/web")!;
    expect(b.checks.map((c) => c.tool)).toEqual(expect.arrayContaining(["eslint", "tsc", "vitest"]));
    expect(b.profile.projects[0].testAll).toBeTruthy();
    expect(b.inferred).toBe("none");
    expect(changed).toContain("a/web");
    expect(await svc.scan("a/web", { infer: true })).toEqual({ slug: "a/web", status: "unchanged" });
    expect(svc.repo.history("a/web")).toHaveLength(1);
    expect(await svc.scan("a/web", { infer: true, force: true })).toMatchObject({ status: "ok" });
    expect(svc.repo.history("a/web")).toHaveLength(2);
  });

  it("keeps at most 10 scans per repo", async () => {
    const root = repoDir(PY_REPO);
    const { svc } = setup({ paths: { "a/svc": root } });
    for (let i = 0; i < 12; i++) await svc.scan("a/svc", { infer: false, force: true });
    expect(svc.repo.history("a/svc")).toHaveLength(10);
  });

  it("asks the model only for an unknown repo, marks its checks inferred / low, and refuses to adopt them unconfirmed", async () => {
    const infer = vi.fn(inferOk);
    const root = repoDir(CI_ONLY_REPO);
    const { svc, checks } = setup({ paths: { "a/ci": root, "a/web": repoDir(JS_REPO) }, infer });
    await svc.scan("a/web", { infer: true });
    expect(infer).not.toHaveBeenCalled();
    expect(await svc.scan("a/ci", { infer: true })).toMatchObject({ status: "ok" });
    expect(infer).toHaveBeenCalledTimes(1);
    expect(infer.mock.calls[0][0]).toMatchObject({ task: "repo_scan_infer", cwd: root });
    const b = svc.latest("a/ci")!;
    expect(b.inferred).toBe("ran");
    expect(b.checks.map((c) => [c.category, c.source, c.confidence])).toEqual([["test", "inferred", "low"], ["lint", "inferred", "low"]]);
    const low = svc.suggestedChecks("a/ci");
    expect(low).toEqual([expect.objectContaining({ needsConfirm: true, confidence: "low" })]);
    expect(svc.adopt("a/ci", low.map((d) => d.id), [])).toMatchObject({ ok: false });
    expect(checks.effective({ kind: "repo", slug: "a/ci" })).toEqual([]);
    expect(svc.adopt("a/ci", low.map((d) => d.id), low.map((d) => d.id))).toMatchObject({ ok: true, created: 1 });
    expect(svc.summary({ kind: "repo", slug: "a/ci" })).toMatchObject({ scanned: 1, toConfirm: 2, byConfidence: { low: 2 } });
    expect(svc.profileFor("a/ci")).toContain("./tools/check.sh");
  });

  it("marks a scan partial when inference fails, and skips the model when it is off", async () => {
    const fail: InferRunner = async () => ({ ok: false, reason: "exit", message: "boom" }) as unknown as HeadlessExecResult;
    const a = setup({ paths: { "a/ci": repoDir(CI_ONLY_REPO) }, infer: fail });
    expect(await a.svc.scan("a/ci", { infer: true })).toMatchObject({ status: "partial" });
    expect(a.svc.latest("a/ci")?.inferred).toBe("failed");
    const infer = vi.fn(inferOk);
    const b = setup({ paths: { "a/ci": repoDir(CI_ONLY_REPO) }, infer, cfg: { infer: "off" } });
    expect(await b.svc.scan("a/ci", { infer: true })).toMatchObject({ status: "ok" });
    expect(infer).not.toHaveBeenCalled();
    expect(b.svc.latest("a/ci")?.inferred).toBe("skipped_off");
  });

  it("an automatic rescan keeps what the model added before without calling it again", async () => {
    const infer = vi.fn(inferOk);
    const root = repoDir(CI_ONLY_REPO);
    const { svc } = setup({ paths: { "a/ci": root }, infer });
    await svc.scan("a/ci", { infer: true });
    writeFileSync(join(root, ".gitlab-ci.yml"), `${CI_ONLY_REPO[".gitlab-ci.yml"]}\n# touched\n`);
    expect(svc.checkStale("a/ci")).toBe(true);
    expect(await svc.scan("a/ci", { infer: false })).toMatchObject({ status: "ok" });
    expect(infer).toHaveBeenCalledTimes(1);
    const b = svc.latest("a/ci")!;
    expect(b.inferred).toBe("ran");
    expect(b.profile.projects.find((p) => p.dir === "")?.testAll).toBe("./tools/check.sh");
    expect(b.staleAt).toBeNull();
  });

  it("marks a baseline stale when a config file changes and rescans in the background at most every 10 minutes", async () => {
    const root = repoDir(JS_REPO);
    const { svc, advance } = setup({ paths: { "a/web": root } });
    await svc.scan("a/web", { infer: false });
    expect(svc.checkStale("a/web")).toBe(false);
    writeFileSync(join(root, "package.json"), JS_REPO["package.json"].replace('"lint"', '"lint:all"'));
    expect(svc.checkStale("a/web")).toBe(true);
    expect(svc.latest("a/web")?.staleAt).not.toBeNull();
    expect(svc.profileFor("a/web")).toContain("Config files changed since this scan");
    expect(svc.maybeRescan("a/web")).toBe(true);
    expect(svc.maybeRescan("a/web")).toBe(false);
    await vi.waitFor(() => expect(svc.isRunning("a/web")).toBe(false));
    advance(AUTO_RESCAN_GAP_MS - 5000);
    expect(svc.maybeRescan("a/web")).toBe(false);
    advance(10_000);
    expect(svc.maybeRescan("a/web")).toBe(true);
  });

  it("cancels a running scan", async () => {
    const root = repoDir(JS_REPO);
    const { svc } = setup({ paths: { "a/web": root } });
    const p = svc.scan("a/web", { infer: false });
    expect(svc.cancel("a/web")).toBe(true);
    expect(await p).toMatchObject({ status: "skipped", reason: "cancelled" });
    expect(svc.cancel("a/web")).toBe(false);
  });
});

describe("BaselineService profile in the session guide", () => {
  it("gives one profile per ticket repo with a baseline, marks stale ones, and stays within twice the per-repo limit", async () => {
    const web = repoDir(JS_REPO);
    const py = repoDir(PY_REPO);
    const { svc, cfg } = setup({ paths: { "a/web": web, "a/py": py, "a/none": null } });
    await svc.scan("a/web", { infer: false });
    await svc.scan("a/py", { infer: false });
    const text = svc.guideProfile([{ slug: "a/web", root: web }, { slug: "a/py", root: py }, { slug: "a/none", root: null }, { slug: "a/web", root: web }], false);
    expect(text).toContain("a/web");
    expect(text).toContain("pnpm test");
    expect(text).toContain("a/py");
    expect(text).toContain("pytest");
    expect(text).not.toContain("a/none");
    expect(text.split("a/web").length).toBe(2);
    expect(text).not.toContain("Config files changed");
    // worktree 里的配置改了：标过期
    writeFileSync(join(web, "package.json"), JS_REPO["package.json"].replace('"lint"', '"lint:all"'));
    expect(svc.guideProfile([{ slug: "a/web", root: web }], true)).toContain("Config files changed since this scan");
    cfg.guideChars = 200;
    expect(svc.guideProfile([{ slug: "a/web", root: web }, { slug: "a/py", root: py }], true).length).toBeLessThanOrEqual(400);
  });
});

describe("BaselineService for lessons and checks", () => {
  it("finds the checks that already cover a lesson, across a product's repos", async () => {
    const { svc, lessons } = setup({ paths: { "a/web": repoDir(JS_REPO), "a/svc": repoDir(PY_REPO) } });
    await svc.scanScope({ kind: "global" }, { infer: false });
    const pid = lessons.createProduct("Shop", ["a/web", "a/svc"], 1);
    expect(svc.coveredBy({ scope: { kind: "repo", slug: "a/web" }, text: "No console.log in shipped code" })[0]).toMatchObject({ slug: "a/web", strength: "strong" });
    const hits = svc.coveredBy({ scope: { kind: "product", productId: pid }, text: "Remove unused imports" });
    expect(new Set(hits.map((h) => h.slug))).toEqual(new Set(["a/web", "a/svc"]));
    expect(svc.coveredBy({ scope: { kind: "repo", slug: "a/web" }, text: "Name things after the domain" })).toEqual([]);
    expect(svc.forScope({ kind: "product", productId: pid }).map((x) => x.slug).sort()).toEqual(["a/svc", "a/web"]);
    expect(svc.checksByCategory("a/svc", "typecheck").map((c) => c.tool)).toEqual(["mypy"]);
    const text = svc.describeForPrompt(["a/web", "a/svc"], 4000);
    expect(text).toContain("repo a/web");
    expect(text).toContain("ruff");
    expect(svc.describeForPrompt(["a/web"], 50).length).toBeLessThanOrEqual(50);
  });

  it("turns repo commands into shadow run_command drafts and adopts them in one undoable batch", async () => {
    const { svc, checks, batches } = setup({ paths: { "a/mono": repoDir(MONO_REPO) } });
    await svc.scan("a/mono", { infer: false });
    const drafts = svc.suggestedChecks("a/mono");
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((d) => d.input.type === "run_command" && d.input.mode === "shadow")).toBe(true);
    const web = drafts.find((d) => d.id.startsWith("packages/web|lint"))!;
    expect(String(web.input.params.command)).toMatch(/^cd packages\/web && /);
    expect(web.input.globs[0]).toMatch(/^packages\/web\/\*\*/);
    const ids = drafts.filter((d) => !d.needsConfirm).map((d) => d.id);
    const r = svc.adopt("a/mono", ids, []);
    expect(r).toMatchObject({ ok: true, created: ids.length });
    const made = checks.effective({ kind: "repo", slug: "a/mono" });
    expect(made).toHaveLength(ids.length);
    expect(new Set(made.map((c) => checks.repo.get(c.id)!.batchId)).size).toBe(1);
    expect(svc.suggestedChecks("a/mono").filter((d) => ids.includes(d.id)).every((d) => d.exists)).toBe(true);
    expect(svc.adopt("a/mono", ids, [])).toMatchObject({ ok: true, created: 0 });
    batches.undo(checks.repo.get(made[0].id)!.batchId!);
    expect(checks.effective({ kind: "repo", slug: "a/mono" })).toEqual([]);
  });

  it("per-file drafts keep the file path quoted from the subdirectory", async () => {
    const { svc } = setup({ paths: { "a/mono": repoDir(MONO_REPO) } });
    await svc.scan("a/mono", { infer: false });
    const perFile = svc.suggestedChecks("a/mono").find((d) => d.input.params.stage === "edit" && String(d.input.params.command).startsWith("cd "));
    expect(perFile).toBeDefined();
    expect(String(perFile!.input.params.command)).toContain('"$OLDPWD/$BUTLER_CHECK_FILE"');
  });
});

describe("BaselineService rule layers", () => {
  it("overrides a built-in rule per layer, disables it in a repo, and adds a new one", async () => {
    const { svc, lessons } = setup({ paths: { "a/web": repoDir(JS_REPO) } });
    const pid = lessons.createProduct("Shop", ["a/web"], 1);
    expect(svc.ruleSave({ kind: "global" }, "kw:custom-verify", JSON.stringify({ kind: "keyword", category: "lint", tool: "acme", match: "acme-verify" }), true)).toEqual({ ok: true });
    expect(svc.rulesFor("a/web").keywords.some((k) => k.key === "kw:custom-verify")).toBe(true);
    const builtin = svc.rulesView({ kind: "global" }).find((r) => r.origin === "builtin")!;
    expect(svc.ruleSave({ kind: "product", productId: pid }, builtin.key, JSON.stringify({ priority: 99 }), true)).toEqual({ ok: true });
    const rv = svc.rulesView({ kind: "repo", slug: "a/web" }).find((r) => r.key === builtin.key)!;
    expect(rv).toMatchObject({ origin: "product", overridden: false, enabled: true });
    expect(svc.ruleSave({ kind: "repo", slug: "a/web" }, builtin.key, "", false)).toEqual({ ok: true });
    expect(svc.rulesView({ kind: "repo", slug: "a/web" }).find((r) => r.key === builtin.key)).toMatchObject({ enabled: false, overridden: true });
    expect(svc.rulesView({ kind: "global" }).find((r) => r.key === builtin.key)).toMatchObject({ enabled: true });
    expect(svc.ruleSave({ kind: "global" }, "bad key!", "{}", true).ok).toBe(false);
    expect(svc.ruleSave({ kind: "global" }, "kw:broken", JSON.stringify({ kind: "keyword" }), true).ok).toBe(false);
    expect(svc.ruleSave({ kind: "global" }, "kw:x", "{not json", true).ok).toBe(false);
    expect(svc.ruleRemove({ kind: "repo", slug: "a/web" }, builtin.key)).toEqual({ ok: true });
    expect(svc.ruleRemove({ kind: "repo", slug: "a/web" }, builtin.key).ok).toBe(false);
  });
});
