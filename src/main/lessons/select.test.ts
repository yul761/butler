import { describe, expect, it, vi } from "vitest";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { RepoIdentity } from "./repo-identity";
import { overflowFor, productSuggestions, safeSessionLessons, sessionLessons } from "./select";

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
const src = { prNumber: 1, url: null };
const add = (repo: LessonsRepo, scope: Parameters<LessonsRepo["addLesson"]>[0]["scope"], text: string, status: "confirmed" | "pending" | "disabled" = "confirmed", at = 10) => {
  const id = repo.addLesson({ scope, text, why: "w", at, source: src });
  if (status !== "pending") repo.setStatus(id, status, at);
  return id;
};

describe("sessionLessons", () => {
  it("caps at 30 confirmed lessons from repos and products, most hit first, newest seen first on ties", () => {
    const repo = setup();
    const pid = repo.createProduct("shop", ["acme/web", "acme/api"], 1);
    for (let i = 0; i < 15; i++) add(repo, { kind: "repo", slug: "acme/web" }, `web-${i}`, "confirmed", 100 + i);
    for (let i = 0; i < 15; i++) add(repo, { kind: "repo", slug: "acme/api" }, `api-${i}`, "confirmed", 200 + i);
    for (let i = 0; i < 10; i++) add(repo, { kind: "product", productId: pid }, `prod-${i}`, "confirmed", 50 + i);
    for (let i = 0; i < 3; i++) add(repo, { kind: "repo", slug: "acme/web" }, `pending-${i}`, "pending", 999);
    for (let i = 0; i < 2; i++) add(repo, { kind: "repo", slug: "acme/web" }, `disabled-${i}`, "disabled", 999);
    for (const id of repo.lessons({ status: ["pending", "disabled"] }).map((l) => l.id)) repo.hit(id, 999, { prNumber: 50 + id, url: null });
    const top = add(repo, { kind: "product", productId: pid }, "top", "confirmed", 1);
    repo.hit(top, 1, { prNumber: 2, url: null });
    repo.hit(top, 1, { prNumber: 3, url: null });
    const out = sessionLessons(repo, identity(), ["/acme_web", "/acme_api"]);
    expect(out).toHaveLength(30);
    expect(out[0]).toEqual({ label: "shop", text: "top" });
    // hits 相同：last_seen_at 新的在前
    expect(out[1]).toEqual({ label: "acme/api", text: "api-14" });
    const texts = out.map((l) => l.text).join("|");
    expect(texts).not.toContain("pending-");
    expect(texts).not.toContain("disabled-");
    expect(out.find((l) => l.text === "web-0")).toBeUndefined();
  });

  it("equal rank: lower id first", () => {
    const repo = setup();
    const a = add(repo, { kind: "repo", slug: "acme/web" }, "first", "confirmed", 10);
    const b = add(repo, { kind: "repo", slug: "acme/web" }, "second", "confirmed", 10);
    expect(a).toBeLessThan(b);
    expect(sessionLessons(repo, identity(), ["/acme_web"]).map((l) => l.text)).toEqual(["first", "second"]);
  });

  it("ignores paths that resolve to no slug, and does not repeat lessons for two paths of one slug", () => {
    const repo = setup();
    add(repo, { kind: "repo", slug: "acme/web" }, "only");
    expect(sessionLessons(repo, identity(), ["/none/x", "/acme_web", "/acme_web", "/acme_web-2"])).toEqual([{ label: "acme/web", text: "only" }]);
    expect(sessionLessons(repo, identity(), [])).toEqual([]);
  });

  it("does not repeat a product's lessons when two repos share it", () => {
    const repo = setup();
    const pid = repo.createProduct("shop", ["acme/web", "acme/api"], 1);
    add(repo, { kind: "product", productId: pid }, "p");
    expect(sessionLessons(repo, identity(), ["/acme_web", "/acme_api"])).toEqual([{ label: "shop", text: "p" }]);
  });
});

describe("safeSessionLessons", () => {
  it("returns [] and logs when selecting throws", () => {
    const repo = setup();
    const logs: string[] = [];
    vi.spyOn(repo, "lessons").mockImplementation(() => {
      throw new Error("db");
    });
    expect(safeSessionLessons(repo, identity(), ["/acme_web"], (m) => logs.push(m))).toEqual([]);
    expect(logs).toHaveLength(1);
  });
});

describe("overflowFor", () => {
  it("counts confirmed repo plus product lessons beyond the limit", () => {
    const repo = setup();
    const pid = repo.createProduct("shop", ["acme/web"], 1);
    for (let i = 0; i < 25; i++) add(repo, { kind: "repo", slug: "acme/web" }, `w${i}`);
    for (let i = 0; i < 10; i++) add(repo, { kind: "product", productId: pid }, `p${i}`);
    add(repo, { kind: "repo", slug: "acme/web" }, "pend", "pending");
    expect(overflowFor(repo, "acme/web")).toBe(5);
    expect(overflowFor(repo, "acme/api")).toBe(0);
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
