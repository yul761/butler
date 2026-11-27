import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { RepoIdentity } from "./repo-identity";
import { LOOKUP_MAX, lookupLessons } from "./lookup";

const identity = () =>
  new RepoIdentity({
    exists: () => true,
    git: (p) => {
      const m = /^\/(?:wt\/)?(\w+)[_/](\w+)/.exec(p);
      return m ? `git@github.com:${m[1]}/${m[2]}.git` : null;
    },
  });
const src = { prNumber: 1, url: null, slug: "acme/web", runId: null };

const setup = () => {
  const repo = new LessonsRepo(memDb());
  repo.upsertRepo("acme/web", "/acme_web", 1);
  repo.upsertRepo("acme/api", "/acme_api", 1);
  const add = (scope: Parameters<LessonsRepo["addLesson"]>[0]["scope"], text: string, globs: string[] = [], why = "w") => {
    const id = repo.addLesson({ scope, text, why, at: 1, source: src });
    repo.setStatus(id, "confirmed", 1);
    if (globs.length) repo.setFields(id, { scopeGlobs: globs }, 1);
    return id;
  };
  return { repo, add };
};
// 同一个 ticket 的两个仓库，worktree 用同名分支。
const roots = [{ slug: "acme/web", dirs: ["/wt/acme/web-btl-1"] }, { slug: "acme/api", dirs: ["/wt/acme/api-btl-1"] }];
const paths = ["/acme_web", "/acme_api"];

describe("lookupLessons", () => {
  it("with absolute paths, only returns lessons of the repo the file is in, even when both repos share the relative path", () => {
    const { repo, add } = setup();
    const w = add({ kind: "repo", slug: "acme/web" }, "web db rule", ["src/db/**"]);
    const a = add({ kind: "repo", slug: "acme/api" }, "api db rule", ["src/db/**"]);
    const r = lookupLessons(repo, identity(), paths, roots, { paths: ["/wt/acme/web-btl-1/src/db/x.ts"] });
    expect(r.lessons.map((l) => l.id)).toEqual([w]);
    expect(r.lessons[0].matched).toEqual(["acme/web:src/db/x.ts"]);
    expect(lookupLessons(repo, identity(), paths, roots, { paths: ["/wt/acme/api-btl-1/src/db/x.ts"] }).lessons.map((l) => l.id)).toEqual([a]);
    // 相对路径：按调用的 session 的 cwd 归到它的仓库；认不出时不猜，列进 unresolved。
    expect(lookupLessons(repo, identity(), paths, roots, { paths: ["src/db/x.ts"], cwd: "/wt/acme/api-btl-1" }).lessons.map((l) => l.id)).toEqual([a]);
    const lost = lookupLessons(repo, identity(), paths, roots, { paths: ["src/db/x.ts"] });
    expect(lost.lessons).toEqual([]);
    expect(lost.unresolved).toEqual(["src/db/x.ts"]);
    expect(lookupLessons(repo, identity(), paths, roots, { paths: ["/elsewhere/src/db/x.ts"] }).lessons).toEqual([]);
  });

  // 和 hook/lessons.test.ts 里补送的 locate 用例一样（同一份 locateInRoots）：Windows 路径、大小写、嵌套目录最长优先。
  it("matches Windows paths without caring about case or slashes, and only folds case where the file system does", () => {
    const { repo, add } = setup();
    const w = add({ kind: "repo", slug: "acme/web" }, "web rule", ["src/**"]);
    const a = add({ kind: "repo", slug: "acme/api" }, "api rule", ["src/**"]);
    const win = [{ slug: "acme/web", dirs: ["C:\\wt\\acme\\web-btl-1"] }, { slug: "acme/api", dirs: ["C:\\wt\\acme\\api-btl-1"] }];
    const r = lookupLessons(repo, identity(), paths, win, { paths: ["c:\\WT\\acme\\web-btl-1\\src\\A.ts"] }, {}, "win32");
    expect(r.lessons.map((l) => l.id)).toEqual([w]);
    expect(r.lessons[0].matched).toEqual(["acme/web:src/A.ts"]);
    // 相对路径 + Windows 的 cwd
    expect(lookupLessons(repo, identity(), paths, win, { paths: ["src\\db\\x.ts"], cwd: "C:\\wt\\acme\\api-btl-1" }, {}, "win32").lessons.map((l) => l.id)).toEqual([a]);
    // linux 区分大小写；目录名只是前缀相同的不算
    expect(lookupLessons(repo, identity(), paths, roots, { paths: ["/WT/acme/web-btl-1/src/a.ts"] }, {}, "linux").unresolved).toEqual(["/WT/acme/web-btl-1/src/a.ts"]);
    expect(lookupLessons(repo, identity(), paths, roots, { paths: ["/wt/acme/web-btl-12/src/a.ts"] }, {}, "linux").unresolved).toEqual(["/wt/acme/web-btl-12/src/a.ts"]);
  });

  it("collapses . and .. before deciding which repo a path is in", () => {
    const { repo, add } = setup();
    add({ kind: "repo", slug: "acme/web" }, "web rule");
    const a = add({ kind: "repo", slug: "acme/api" }, "api rule", ["src/**"]);
    // 从 web 的 worktree 查 ../api-btl-1/src/a.ts：是 api 仓库的文件，不能把 web 的规矩带出来。
    const r = lookupLessons(repo, identity(), paths, roots, { paths: ["../api-btl-1/src/a.ts"], cwd: "/wt/acme/web-btl-1" }, {}, "linux");
    expect(r.lessons.map((l) => l.id)).toEqual([a]);
    expect(r.lessons[0].matched).toEqual(["acme/api:src/a.ts"]);
    expect(lookupLessons(repo, identity(), paths, roots, { paths: ["/wt/acme/web-btl-1/../api-btl-1/./src/a.ts"] }, {}, "linux").lessons.map((l) => l.id)).toEqual([a]);
    // 只有一个仓库时，跑到仓库外面的相对路径不算在它头上。
    const one = [{ slug: "acme/api", dirs: ["/wt/acme/api-btl-1"] }];
    expect(lookupLessons(repo, identity(), ["/acme_api"], one, { paths: ["../x/src/a.ts"] }, {}, "linux").unresolved).toEqual(["../x/src/a.ts"]);
  });

  it("nested directories: the longest one wins", () => {
    const { repo, add } = setup();
    add({ kind: "repo", slug: "acme/web" }, "web rule", ["**/c.ts"]);
    const a = add({ kind: "repo", slug: "acme/api" }, "api rule", ["c.ts"]);
    const nested = [{ slug: "acme/web", dirs: ["/a"] }, { slug: "acme/api", dirs: ["/a/b"] }];
    const r = lookupLessons(repo, identity(), paths, nested, { paths: ["/a/b/c.ts"] }, {}, "linux");
    expect(r.lessons.map((l) => l.id)).toEqual([a]);
    expect(r.lessons[0].matched).toEqual(["acme/api:c.ts"]);
  });

  it("a product lesson applies in each repo of the product; unscoped lessons apply to every file", () => {
    const { repo, add } = setup();
    const pid = repo.createProduct("shop", ["acme/web", "acme/api"], 1);
    const p = add({ kind: "product", productId: pid }, "plain names");
    const r = lookupLessons(repo, identity(), paths, roots, { paths: ["/wt/acme/api-btl-1/a.ts"] });
    expect(r.lessons).toEqual([expect.objectContaining({ id: p, label: "shop", text: "plain names", matched: ["acme/api:a.ts"], delivery: "full" })]);
  });

  it("finds by #id or by every keyword, and returns the full text, why, scope and delivery", () => {
    const { repo, add } = setup();
    const a = add({ kind: "repo", slug: "acme/web" }, "Re-read the row in the write transaction", ["src/main/**"], "a race lost edits");
    add({ kind: "repo", slug: "acme/web" }, "Use tabs");
    expect(lookupLessons(repo, identity(), paths, roots, { query: `#${a}` }).lessons).toEqual([
      { id: a, label: "acme/web", text: "Re-read the row in the write transaction", why: "a race lost edits", scope: { globs: ["src/main/**"], lang: null }, delivery: "full" },
    ]);
    expect(lookupLessons(repo, identity(), paths, roots, { query: "WRITE race" }).lessons.map((l) => l.id)).toEqual([a]);
    expect(lookupLessons(repo, identity(), paths, roots, { query: "nothing like it" }).lessons).toEqual([]);
    expect(lookupLessons(repo, identity(), paths, roots, {}).total).toBe(2);
  });

  it("caps the answer and says it was cut", () => {
    const { repo, add } = setup();
    for (let i = 0; i < LOOKUP_MAX + 5; i++) add({ kind: "repo", slug: "acme/web" }, `rule ${i}`);
    const r = lookupLessons(repo, identity(), paths, roots, {});
    expect(r.lessons).toHaveLength(LOOKUP_MAX);
    expect(r.total).toBe(LOOKUP_MAX + 5);
    expect(r.truncated).toBe(true);
  });

  it("shows lessons sent only as an index line with that delivery", () => {
    const { repo, add } = setup();
    const id = add({ kind: "repo", slug: "acme/web" }, "a long rule that will not fit in a tiny budget", ["src/**"]);
    expect(lookupLessons(repo, identity(), paths, roots, { query: `${id}` }, { fullBudget: 10 }).lessons[0].delivery).toBe("drip");
  });
});
