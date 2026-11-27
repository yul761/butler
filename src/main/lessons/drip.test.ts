import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { RepoIdentity } from "./repo-identity";
import { dripManifest, dripRoots, prepareSessionDrip, pruneDrip, writeDripManifest } from "./drip";
import { guidePlan } from "./select";
import { DRIP_LOCK_STALE_MS, runLessonDrip, realDripDeps } from "../../../hook/lessons";

// /wt/<repo>-<n> 是 worktree，/<owner>_<repo> 是仓库本身；两个仓库的 worktree 用同名分支。
const identity = () =>
  new RepoIdentity({
    exists: () => true,
    git: (p) => {
      const m = /^\/(?:wt\/)?(\w+)[_/](\w+)/.exec(p);
      return m ? `git@github.com:${m[1]}/${m[2]}.git` : null;
    },
  });
const src = { prNumber: 1, url: null, slug: "acme/web", runId: null };

describe("dripRoots", () => {
  it("groups the session's dirs by repo, adds real paths and drops what resolves to no repo", () => {
    const roots = dripRoots(identity(), ["/wt/acme/web-btl-1", "/acme_web", "/wt/acme/api-btl-1", "/nowhere"], (p) => (p === "/acme_web" ? "/real/acme_web" : null));
    expect(roots).toEqual([
      { slug: "acme/web", dirs: ["/wt/acme/web-btl-1", "/acme_web", "/real/acme_web"] },
      { slug: "acme/api", dirs: ["/wt/acme/api-btl-1"] },
    ]);
  });
});

describe("dripManifest", () => {
  const setup = () => {
    const repo = new LessonsRepo(memDb());
    repo.upsertRepo("acme/web", "/acme_web", 1);
    repo.upsertRepo("acme/api", "/acme_api", 1);
    return repo;
  };
  const add = (repo: LessonsRepo, scope: Parameters<LessonsRepo["addLesson"]>[0]["scope"], text: string, globs: string[] = []) => {
    const id = repo.addLesson({ scope, text, why: "w", at: 1, source: src });
    repo.setStatus(id, "confirmed", 1);
    if (globs.length) repo.setFields(id, { scopeGlobs: globs }, 1);
    return id;
  };

  it("carries every lesson that missed the full text, product lessons to each repo of the product", () => {
    const repo = setup();
    const pid = repo.createProduct("shop", ["acme/web", "acme/api"], 1);
    const w = add(repo, { kind: "repo", slug: "acme/web" }, "web rule", ["src/**"]);
    const a = add(repo, { kind: "repo", slug: "acme/api" }, "api rule", ["src/**"]);
    const p = add(repo, { kind: "product", productId: pid }, "shop rule");
    const plan = guidePlan(repo, identity(), ["/acme_web", "/acme_api"], { fullBudget: 0 });
    const roots = [{ slug: "acme/web", dirs: ["/wt/acme/web-x"] }, { slug: "acme/api", dirs: ["/wt/acme/api-x"] }];
    const m = dripManifest(repo, plan, roots, "en")!;
    expect(m.lessons.map((l) => [l.id, l.slugs])).toEqual(expect.arrayContaining([[w, ["acme/web"]], [a, ["acme/api"]], [p, ["acme/web", "acme/api"]]]));
    expect(dripManifest(repo, { rest: [] }, roots, "en")).toBeNull();
  });

  it("end to end: an edit in one repo of a two-repo ticket only gets that repo's lessons (same branch, same relative path)", () => {
    const repo = setup();
    const w = add(repo, { kind: "repo", slug: "acme/web" }, "web rule", ["src/**"]);
    const a = add(repo, { kind: "repo", slug: "acme/api" }, "api rule", ["src/**"]);
    const plan = guidePlan(repo, identity(), ["/acme_web", "/acme_api"], { fullBudget: 0 });
    const dir = mkdtempSync(join(tmpdir(), "drip-"));
    const roots = dripRoots(identity(), ["/wt/acme/web-btl-9", "/wt/acme/api-btl-9"], () => null);
    writeDripManifest(dir, "sess-1", dripManifest(repo, plan, roots, "en"));
    const run = (file: string) => runLessonDrip(JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file } }), { SHIPHERD_SESSION: "sess-1" }, dir, { ...realDripDeps, platform: "linux" });
    const web = run("/wt/acme/web-btl-9/src/index.ts");
    expect(web.out).toContain(`#${w} [acme/web] web rule`);
    expect(web.out).not.toContain(`#${a}`);
    web.commit();
    const api = run("/wt/acme/api-btl-9/src/index.ts");
    expect(api.out).toContain(`#${a} [acme/api] api rule`);
    expect(api.out).not.toContain(`#${w}`);
    api.commit();
    expect(existsSync(join(dir, "sess-1.json"))).toBe(true);
    // 再开（恢复）这个 session：清单重写，已送的不会再送。
    writeDripManifest(dir, "sess-1", dripManifest(repo, plan, roots, "en"));
    expect(run("/wt/acme/web-btl-9/src/index.ts").out).toBe("");
    expect(readdirSync(dir).filter((n) => n.endsWith(".lock"))).toEqual([]);
  });

  it("real lock file: a live lock blocks the second edit, a stale one (crashed hook) is taken over", () => {
    const dir = mkdtempSync(join(tmpdir(), "drip-"));
    const roots = [{ slug: "acme/web", dirs: ["/wt/web"] }];
    writeDripManifest(dir, "s", { v: 1, lang: "en", roots, lessons: [{ id: 7, label: "acme/web", text: "rule", why: "", globs: [], lang: null, slugs: ["acme/web"] }] });
    const deps = { ...realDripDeps, platform: "linux" as const, sleep: () => {} };
    const run = () => runLessonDrip(JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/wt/web/a.ts" } }), { SHIPHERD_SESSION: "s" }, dir, deps);
    const first = run();
    expect(first.out).toContain("#7");
    expect(run().out).toBe("");
    first.commit();
    expect(existsSync(join(dir, "s.sent.lock"))).toBe(false);
    rmSync(join(dir, "s.sent"));
    // 上一个 hook 拿着锁死掉了：锁放得够久就算过期，照送。
    writeFileSync(join(dir, "s.sent.lock"), "");
    const old = (Date.now() - DRIP_LOCK_STALE_MS - 5_000) / 1000;
    utimesSync(join(dir, "s.sent.lock"), old, old);
    const again = run();
    expect(again.out).toContain("#7");
    again.release();
    expect(existsSync(join(dir, "s.sent.lock"))).toBe(false);
  });
});

describe("writeDripManifest / pruneDrip", () => {
  it("removes the manifest when there is nothing to drip, and prunes old files", () => {
    const dir = mkdtempSync(join(tmpdir(), "drip-"));
    writeDripManifest(dir, "s", { v: 1, lang: "zh", roots: [], lessons: [] });
    expect(JSON.parse(readFileSync(join(dir, "s.json"), "utf8")).v).toBe(1);
    writeDripManifest(dir, "s", null);
    expect(existsSync(join(dir, "s.json"))).toBe(false);
    const old = join(dir, "old.sent");
    writeFileSync(old, "1\n");
    utimesSync(old, 1, 1);
    writeFileSync(join(dir, "new.sent"), "1\n");
    expect(pruneDrip(dir, Date.now())).toBe(1);
    expect(existsSync(join(dir, "new.sent"))).toBe(true);
    expect(pruneDrip(join(dir, "missing"), Date.now())).toBe(0);
  });
});

describe("prepareSessionDrip", () => {
  const m = { v: 1 as const, lang: "zh" as const, roots: [{ slug: "acme/web", dirs: ["/wt/web"] }], lessons: [] };
  it("says drip happens only when the manifest is really on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "drip-"));
    const logs: string[] = [];
    const run = (o: { hook?: boolean; manifest?: () => typeof m | null; dir?: string }) =>
      prepareSessionDrip({ hookInstalled: o.hook ?? true, dir: o.dir ?? dir, sessionId: "s", manifest: o.manifest ?? (() => m), log: (msg) => logs.push(msg) });
    expect(run({})).toBe(true);
    expect(existsSync(join(dir, "s.json"))).toBe(true);
    // 没有要补送的：删掉旧清单，说明里不写补送。
    expect(run({ manifest: () => null })).toBe(false);
    expect(existsSync(join(dir, "s.json"))).toBe(false);
    // 没装 hook：连清单都不算。
    let asked = false;
    expect(run({ hook: false, manifest: () => ((asked = true), m) })).toBe(false);
    expect(asked).toBe(false);
    // 写失败（目录其实是个文件）：记日志，不写补送。
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    expect(run({ dir: file })).toBe(false);
    expect(logs).toEqual(["lesson drip manifest not written"]);
    // 算清单时抛错也一样。
    expect(run({ manifest: () => { throw new Error("db"); } })).toBe(false);
  });
});
