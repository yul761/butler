import { describe, expect, it, vi } from "vitest";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { RepoIdentity } from "./repo-identity";
import { deliveryCounts, guidePlan, lessonTitle, planForSlug, productSuggestions, safeGuidePlan } from "./select";

const identity = () =>
  new RepoIdentity({
    exists: () => true,
    git: (p) => (p.startsWith("/none") ? null : `git@github.com:${p.slice(1).replace(/^(.*?)-(\d)$/, "$1").replace("_", "/")}.git`),
  });

const setup = () => {
  const repo = new LessonsRepo(memDb());
  repo.upsertRepo("acme/web", "/acme_web", 1);
  repo.upsertRepo("acme/api", "/acme_api", 1);
  return repo;
};
const src = { prNumber: 1, url: null, slug: "acme/web", runId: null };
const add = (repo: LessonsRepo, scope: Parameters<LessonsRepo["addLesson"]>[0]["scope"], text: string, status: "confirmed" | "pending" | "disabled" = "confirmed", at = 10) => {
  const id = repo.addLesson({ scope, text, why: "w", at, source: src });
  if (status !== "pending") repo.setStatus(id, status, at);
  return id;
};

const texts = (rows: { text: string }[]) => rows.map((l) => l.text);

describe("guidePlan", () => {
  it("packs full text by size, most hit first, and never drops one: the rest go to the index and the drip list", () => {
    const repo = setup();
    const pid = repo.createProduct("shop", ["acme/web", "acme/api"], 1);
    for (let i = 0; i < 15; i++) add(repo, { kind: "repo", slug: "acme/web" }, `web-${i}`, "confirmed", 100 + i);
    for (let i = 0; i < 15; i++) add(repo, { kind: "repo", slug: "acme/api" }, `api-${i}`, "confirmed", 200 + i);
    for (let i = 0; i < 10; i++) add(repo, { kind: "product", productId: pid }, `prod-${i}`, "confirmed", 50 + i);
    for (let i = 0; i < 3; i++) add(repo, { kind: "repo", slug: "acme/web" }, `pending-${i}`, "pending", 999);
    for (let i = 0; i < 2; i++) add(repo, { kind: "repo", slug: "acme/web" }, `disabled-${i}`, "disabled", 999);
    for (const id of repo.lessons({ status: ["pending", "disabled"] }).map((l) => l.id)) repo.hit(id, 999, { prNumber: 50 + id, url: null, slug: "acme/web", runId: null });
    const top = add(repo, { kind: "product", productId: pid }, "top", "confirmed", 1);
    repo.hit(top, 1, { prNumber: 2, url: null, slug: "acme/web", runId: null });
    repo.hit(top, 1, { prNumber: 3, url: null, slug: "acme/web", runId: null });
    // 每行 label + text + 8：放得下大约 20 行
    const plan = guidePlan(repo, identity(), ["/acme_web", "/acme_api"], { fullBudget: 20 * 22 });
    expect(plan.full[0]).toEqual({ id: top, label: "shop", text: "top" });
    // hits 相同：last_seen_at 新的在前
    expect(plan.full[1]).toMatchObject({ label: "acme/api", text: "api-14" });
    expect(plan.full.length).toBeGreaterThan(15);
    expect(plan.full.length).toBeLessThan(41);
    expect(plan.overBudget).toBe(true);
    const all = [...texts(plan.full), ...plan.index.map((r) => r.title)].join("|");
    expect(all).not.toContain("pending-");
    expect(all).not.toContain("disabled-");
    // 41 条已确认的，每条都有去处：全文 + 补送（rest） = 41，索引里的都在 rest 里
    expect(plan.full.length + plan.rest.length).toBe(41);
    expect(plan.modes.size).toBe(41);
    expect(plan.index.every((r) => plan.rest.some((x) => x.id === r.id))).toBe(true);
    expect(plan.index.length + plan.indexMore).toBe(plan.rest.length);
    expect(plan.rest.at(-1)?.text).toBe("prod-0");
  });

  it("fits everything without a budget problem: all full, nothing over", () => {
    const repo = setup();
    for (let i = 0; i < 40; i++) add(repo, { kind: "repo", slug: "acme/web" }, `w${i}`);
    const plan = guidePlan(repo, identity(), ["/acme_web"]);
    expect(plan.full).toHaveLength(40);
    expect(plan.overBudget).toBe(false);
    expect(deliveryCounts(plan)).toEqual({ full: 40, principle: 0, index: 0, drip: 0, check: 0 });
  });

  it("equal rank: lower id first", () => {
    const repo = setup();
    const pid = repo.createProduct("shop", ["acme/web"], 1);
    // confirmedFor collects repo lessons before product lessons, so the lower id arrives second
    const a = add(repo, { kind: "product", productId: pid }, "product-first", "confirmed", 10);
    const b = add(repo, { kind: "repo", slug: "acme/web" }, "repo-second", "confirmed", 10);
    expect(a).toBeLessThan(b);
    expect(texts(guidePlan(repo, identity(), ["/acme_web"]).full)).toEqual(["product-first", "repo-second"]);
  });

  it("ignores paths that resolve to no slug, and does not repeat lessons for two paths of one slug", () => {
    const repo = setup();
    const id = add(repo, { kind: "repo", slug: "acme/web" }, "only");
    expect(guidePlan(repo, identity(), ["/none/x", "/acme_web", "/acme_web", "/acme_web-2"]).full).toEqual([{ id, label: "acme/web", text: "only" }]);
    expect(guidePlan(repo, identity(), []).full).toEqual([]);
  });

  it("does not repeat a product's lessons when two repos share it", () => {
    const repo = setup();
    const pid = repo.createProduct("shop", ["acme/web", "acme/api"], 1);
    add(repo, { kind: "product", productId: pid }, "p");
    expect(texts(guidePlan(repo, identity(), ["/acme_web", "/acme_api"]).full)).toEqual(["p"]);
  });

  it("converted lessons take no room while checks run, and are sent as text when checks are off", () => {
    const repo = setup();
    const c = add(repo, { kind: "repo", slug: "acme/web" }, "no console.log");
    repo.setFields(c, { checkability: "converted" }, 1);
    add(repo, { kind: "repo", slug: "acme/web" }, "plain");
    const on = guidePlan(repo, identity(), ["/acme_web"]);
    expect(texts(on.full)).toEqual(["plain"]);
    expect(on.modes.get(c)).toBe("check");
    expect(on.rest).toEqual([]);
    const off = guidePlan(repo, identity(), ["/acme_web"], { checksActive: false });
    expect(texts(off.full)).toEqual(["no console.log", "plain"]);
    expect(off.modes.get(c)).toBe("full");
  });

  it("a converted lesson whose check was deleted, disabled or is only shadowing is sent as text again", () => {
    const repo = setup();
    const c = add(repo, { kind: "repo", slug: "acme/web" }, "no console.log");
    const d = add(repo, { kind: "repo", slug: "acme/web" }, "no debugger");
    repo.setFields(c, { checkability: "converted" }, 1);
    repo.setFields(d, { checkability: "converted" }, 1);
    const plan = guidePlan(repo, identity(), ["/acme_web"], { enforcedIn: (slug) => new Set(slug === "acme/web" ? [d] : []) });
    expect(texts(plan.full)).toEqual(["no console.log"]);
    expect(plan.modes.get(c)).toBe("full");
    expect(plan.modes.get(d)).toBe("check");
  });

  it("a converted product lesson counts as handled by a check only if the check enforces it in every repo of the session", () => {
    const repo = setup();
    const pid = repo.createProduct("shop", ["acme/web", "acme/api"], 1);
    const p = add(repo, { kind: "product", productId: pid }, "no console.log");
    repo.setFields(p, { checkability: "converted" }, 1);
    // api 仓库把产品层的检查关了：同时开两个仓库时它要当文字送；只开 web 时由检查管。
    const enforcedIn = (slug: string) => new Set(slug === "acme/web" ? [p] : []);
    expect(guidePlan(repo, identity(), ["/acme_web", "/acme_api"], { enforcedIn }).modes.get(p)).toBe("full");
    expect(guidePlan(repo, identity(), ["/acme_web"], { enforcedIn }).modes.get(p)).toBe("check");
    expect(guidePlan(repo, identity(), ["/acme_api"], { enforcedIn }).modes.get(p)).toBe("full");
  });

  it("puts unscoped lessons in full text first: scoped ones still reach the session on edit", () => {
    const repo = setup();
    const scoped = add(repo, { kind: "repo", slug: "acme/web" }, "scoped rule", "confirmed", 50);
    repo.setFields(scoped, { scopeGlobs: ["src/db/**"] }, 1);
    repo.hit(scoped, 60, { prNumber: 9, url: null, slug: "acme/web", runId: null });
    const loose = add(repo, { kind: "repo", slug: "acme/web" }, "everywhere rule", "confirmed", 10);
    const plan = guidePlan(repo, identity(), ["/acme_web"], { fullBudget: 35 });
    expect(texts(plan.full)).toEqual(["everywhere rule"]);
    expect(plan.modes.get(loose)).toBe("full");
    expect(plan.modes.get(scoped)).toBe("drip");
    expect(plan.index).toEqual([{ id: scoped, label: "acme/web", title: "scoped rule", globs: ["src/db/**"], lang: null }]);
    expect(plan.rest.map((r) => r.id)).toEqual([scoped]);
  });

  it("an unscoped lesson that does not fit goes to the index; past the index budget it is only counted", () => {
    const repo = setup();
    const a = add(repo, { kind: "repo", slug: "acme/web" }, "first. more detail here", "confirmed", 30);
    const b = add(repo, { kind: "repo", slug: "acme/web" }, "second", "confirmed", 20);
    const c = add(repo, { kind: "repo", slug: "acme/web" }, "third", "confirmed", 10);
    const plan = guidePlan(repo, identity(), ["/acme_web"], { fullBudget: 40, indexBudget: 45 });
    expect(texts(plan.full)).toEqual(["first. more detail here"]);
    expect(plan.index.map((r) => r.id)).toEqual([b]);
    expect(plan.indexMore).toBe(1);
    expect([plan.modes.get(a), plan.modes.get(b), plan.modes.get(c)]).toEqual(["full", "index", "drip"]);
  });
});

describe("lessonTitle", () => {
  it("keeps the first sentence and cuts long ones", () => {
    expect(lessonTitle("改名迁移要重写生成产物。还要写测试")).toBe("改名迁移要重写生成产物");
    expect(lessonTitle("Use tabs. Always.")).toBe("Use tabs");
    expect(lessonTitle("x".repeat(80))).toHaveLength(60);
    expect(lessonTitle("v1.2 must stay")).toBe("v1.2 must stay");
    // 冒号前太短：不在冒号处截，接着找下一个句末。
    expect(lessonTitle("注意：改名迁移要重写生成产物。还要写测试")).toBe("注意：改名迁移要重写生成产物");
    expect(lessonTitle("Rule: re-read the row in the transaction. Then write.")).toBe("Rule: re-read the row in the transaction");
    expect(lessonTitle("迁移之前一定先备份数据库：用 VACUUM INTO")).toBe("迁移之前一定先备份数据库");
    // 按字符截：emoji 不会被截成半个代理对。
    const t = lessonTitle(`${"字".repeat(58)}😀😀😀`);
    expect(Array.from(t)).toHaveLength(60);
    expect(t).toBe(`${"字".repeat(58)}😀…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t)).toBe(false); // 没有落单的高位代理
  });
});

describe("safeGuidePlan", () => {
  it("returns an empty plan and logs when selecting throws", () => {
    const repo = setup();
    const logs: string[] = [];
    vi.spyOn(repo, "lessons").mockImplementation(() => {
      throw new Error("db");
    });
    expect(safeGuidePlan(repo, identity(), ["/acme_web"], (m) => logs.push(m)).full).toEqual([]);
    expect(logs).toHaveLength(1);
  });
});

describe("planForSlug", () => {
  it("counts each confirmed repo plus product lesson by how it gets there", () => {
    const repo = setup();
    const pid = repo.createProduct("shop", ["acme/web"], 1);
    for (let i = 0; i < 25; i++) add(repo, { kind: "repo", slug: "acme/web" }, `w${i}`);
    for (let i = 0; i < 10; i++) add(repo, { kind: "product", productId: pid }, `p${i}`);
    add(repo, { kind: "repo", slug: "acme/web" }, "pend", "pending");
    const plan = planForSlug(repo, "acme/web", { fullBudget: 30 * 15 });
    const n = deliveryCounts(plan);
    expect(n.full + n.index + n.drip).toBe(35);
    expect(n.full).toBeGreaterThan(20);
    expect(n.full).toBeLessThan(35);
    expect(plan.overBudget).toBe(true);
    expect(deliveryCounts(planForSlug(repo, "acme/api"))).toEqual({ full: 0, principle: 0, index: 0, drip: 0, check: 0 });
  });
});

describe("productSuggestions", () => {
  it("suggests combos seen together at least twice", () => {
    expect(productSuggestions([["a/web", "a/api"], ["a/web", "a/api"], ["a/web", "b/x"]], [])).toEqual([{ slugs: ["a/api", "a/web"], together: 2 }]);
  });
  it("skips combos already inside one product, single-repo groups and duplicate slugs", () => {
    const products = [{ id: 1, name: "p", slugs: ["a/api", "a/web", "c/z"] }];
    expect(productSuggestions([["a/web", "a/api"], ["a/api", "a/web"]], products)).toEqual([]);
    expect(productSuggestions([["a/web", "a/web"], ["a/web"], ["a/web", "a/web"]], [])).toEqual([]);
  });
  it("sorts by together desc, then slugs", () => {
    const g = [["b/1", "b/2"], ["b/1", "b/2"], ["a/1", "a/2"], ["a/1", "a/2"], ["c/1", "c/2"], ["c/1", "c/2"], ["c/1", "c/2"]];
    expect(productSuggestions(g, []).map((s) => [s.slugs.join(","), s.together])).toEqual([["c/1,c/2", 3], ["a/1,a/2", 2], ["b/1,b/2", 2]]);
  });
});

describe("guidePlan: principles and the core guide (workstream D)", () => {
  const principle = (repo: LessonsRepo, db: ReturnType<typeof memDb>, text: string, members: number[]) => {
    const id = Number(db.prepare(`INSERT INTO lesson_principles (scope_kind, repo_slug, text, why, created_at, updated_at) VALUES ('repo', 'acme/web', ?, 'w', 1, 1)`).run(text).lastInsertRowid);
    for (const m of members) repo.setFields(m, { principleId: id }, 1);
    return id;
  };
  it("replaces the lessons of a principle by one principle line that carries them as cases", () => {
    const db = memDb();
    const repo = new LessonsRepo(db);
    repo.upsertRepo("acme/web", "/acme_web", 1);
    const a = add(repo, { kind: "repo", slug: "acme/web" }, "log errors", "confirmed", 30);
    const b = add(repo, { kind: "repo", slug: "acme/web" }, "rethrow errors", "confirmed", 20);
    const c = add(repo, { kind: "repo", slug: "acme/web" }, "report errors to the caller", "confirmed", 10);
    const d = add(repo, { kind: "repo", slug: "acme/web" }, "use tabs", "confirmed", 25);
    principle(repo, db, "Never swallow errors", [a, b, c]);
    expect(texts(guidePlan(repo, identity(), ["/acme_web"]).full)).toEqual(["log errors", "use tabs", "rethrow errors", "report errors to the caller"]);
    const on = guidePlan(repo, identity(), ["/acme_web"], { principles: true });
    expect(on.full).toEqual([
      { label: "acme/web", text: "Never swallow errors", cases: ["log errors", "rethrow errors", "report errors to the caller"] },
      { id: d, label: "acme/web", text: "use tabs" },
    ]);
    // 原则的案例在说明里只有原则那一行：也进补送名单，lessons 工具也查得到。
    expect(on.modes.get(a)).toBe("principle");
    expect(on.rest.map((r) => r.id)).toEqual([a, b, c]);
    // 一条案例被停用以后不到 3 条：原则不再显示，剩下的规矩各占一行。
    repo.setStatus(c, "disabled", 2);
    expect(texts(guidePlan(repo, identity(), ["/acme_web"], { principles: true }).full)).toEqual(["log errors", "use tabs", "rethrow errors"]);
  });

  it("uses principle lines when the plain lessons do not fit, even with the setting off", () => {
    const db = memDb();
    const repo = new LessonsRepo(db);
    repo.upsertRepo("acme/web", "/acme_web", 1);
    const ids = ["log errors and keep the stack", "rethrow errors to the caller", "report errors to the user"].map((t, i) => add(repo, { kind: "repo", slug: "acme/web" }, t, "confirmed", 30 - i));
    principle(repo, db, "Never swallow errors", ids);
    const plan = guidePlan(repo, identity(), ["/acme_web"], { fullBudget: 60 });
    expect(plan.full).toEqual([{ label: "acme/web", text: "Never swallow errors", cases: ["log errors and keep the stack", "rethrow errors to the caller", "report errors to the user"] }]);
    expect(deliveryCounts(plan).principle).toBe(3);
  });

  it("the core guide keeps at most 10 in full, most violated after confirmation first; the rest still get there", () => {
    const db = memDb();
    const repo = new LessonsRepo(db);
    repo.upsertRepo("acme/web", "/acme_web", 1);
    const ids = Array.from({ length: 12 }, (_, i) => add(repo, { kind: "repo", slug: "acme/web" }, `rule ${i}`, "confirmed", 10));
    // rule 11 在确认以后又被 review 指出了两次。
    repo.hit(ids[11], 50, { prNumber: 7, url: null, slug: "acme/web", runId: null });
    repo.hit(ids[11], 60, { prNumber: 8, url: null, slug: "acme/web", runId: null });
    const plan = guidePlan(repo, identity(), ["/acme_web"], { core: true });
    expect(plan.full).toHaveLength(10);
    expect(plan.full[0].text).toBe("rule 11");
    expect(plan.rest).toHaveLength(2);
    expect(plan.index).toHaveLength(2);
  });
});
