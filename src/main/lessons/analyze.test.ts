import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { toCliJsonSchema, validate } from "../handoff/schema";
import { AnalysisSchema, analysisPrompt, applyAnalysis, type Analysis } from "./analyze";
import type { Material } from "./material";

type Finding = Analysis["findings"][number];
const finding = (rule: Partial<NonNullable<Finding["rule"]>> | null, over: Partial<Finding> = {}): Finding => ({
  comment_url: "https://x/7#c1", summary: "s", avoidable: true, why_missed: "w",
  rule: rule && { text: "rule text", why: "because", scope: "repo", product_id: null, same_as: null, ...rule },
  ...over,
});
const setup = () => {
  const repo = new LessonsRepo(memDb());
  repo.upsertRepo("acme/web", "/w", 1);
  repo.upsertRepo("acme/api", "/a", 1);
  const shop = repo.createProduct("shop", ["acme/web", "acme/api"], 1);
  const other = repo.createProduct("other", ["acme/api"], 1);
  return { repo, shop, other };
};
const seed = (repo: LessonsRepo, status: "confirmed" | "rejected", slug = "acme/web") => {
  const id = repo.addLesson({ scope: { kind: "repo", slug }, text: "old", why: "w", at: 5, source: { prNumber: 3, url: null } });
  repo.setStatus(id, status, 6);
  return id;
};
const PR_URL = "https://github.com/acme/web/pull/7";
const ALLOWED = new Set(["https://x/7#c1", "u1", "u2"]);
const apply = (repo: LessonsRepo, ...f: Finding[]) => applyAnalysis(repo, "acme/web", 7, { findings: f }, 100, { allowed: ALLOWED, prUrl: PR_URL });

describe("applyAnalysis", () => {
  it("new repo rule becomes pending with source PR 7 and the comment url", () => {
    const { repo } = setup();
    expect(apply(repo, finding({}))).toEqual({ created: 1, hit: 0, dropped: 0 });
    const [l] = repo.lessons();
    expect(l).toMatchObject({ scope: { kind: "repo", slug: "acme/web" }, status: "pending", text: "rule text" });
    expect(l.sources).toMatchObject([{ prNumber: 7, url: "https://x/7#c1" }]);
  });

  it("keeps only comment urls from the material; anything else becomes the PR url", () => {
    const { repo } = setup();
    apply(repo, finding({ text: "a" }, { comment_url: "https://evil.example/x" }), finding({ text: "b" }, { comment_url: null }), finding({ text: "c" }));
    expect(repo.lessons().map((l) => l.sources[0]!.url)).toEqual([PR_URL, PR_URL, "https://x/7#c1"]);
  });

  it("product scope attaches to the product of this repo; unrelated product falls back to repo", () => {
    const { repo, shop, other } = setup();
    apply(repo, finding({ scope: "product", product_id: shop }), finding({ scope: "product", product_id: other }));
    expect(repo.lessons().map((l) => l.scope)).toEqual([
      { kind: "product", productId: shop },
      { kind: "repo", slug: "acme/web" },
    ]);
  });

  it("same_as a confirmed lesson hits it", () => {
    const { repo } = setup();
    const id = seed(repo, "confirmed");
    expect(apply(repo, finding({ same_as: id }))).toEqual({ created: 0, hit: 1, dropped: 0 });
    expect(repo.lessons()).toHaveLength(1);
    expect(repo.get(id)).toMatchObject({ hits: 2, status: "confirmed" });
  });

  it("two findings with the same same_as count two hits", () => {
    const { repo } = setup();
    const id = seed(repo, "confirmed");
    const r = apply(repo, finding({ same_as: id }, { comment_url: "u1" }), finding({ same_as: id }, { comment_url: "u2" }));
    expect(r.hit).toBe(2);
    expect(repo.get(id)?.hits).toBe(3);
  });

  it("same_as a rejected lesson drops without change", () => {
    const { repo } = setup();
    const id = seed(repo, "rejected");
    expect(apply(repo, finding({ same_as: id }))).toEqual({ created: 0, hit: 0, dropped: 1 });
    expect(repo.lessons()).toHaveLength(1);
    expect(repo.get(id)).toMatchObject({ hits: 1, status: "rejected" });
  });

  it("same_as pointing at another repo's lesson, or a missing id, creates a new pending lesson", () => {
    const { repo } = setup();
    repo.upsertRepo("other/x", "/o", 1);
    const foreign = repo.addLesson({ scope: { kind: "repo", slug: "other/x" }, text: "f", why: "w", at: 1, source: { prNumber: 1, url: null } });
    expect(apply(repo, finding({ same_as: 9999 }), finding({ same_as: foreign }))).toEqual({ created: 2, hit: 0, dropped: 0 });
    expect(repo.get(foreign)?.hits).toBe(1);
    expect(repo.lessons({ scope: { kind: "repo", slug: "acme/web" } })).toHaveLength(2);
  });

  it("same_as a lesson of this repo's product hits it", () => {
    const { repo, shop } = setup();
    const id = repo.addLesson({ scope: { kind: "product", productId: shop }, text: "p", why: "w", at: 1, source: { prNumber: 1, url: null } });
    expect(apply(repo, finding({ same_as: id })).hit).toBe(1);
  });

  it("ignores non-avoidable findings and findings without a rule", () => {
    const { repo } = setup();
    expect(apply(repo, finding({}, { avoidable: false }), finding(null))).toEqual({ created: 0, hit: 0, dropped: 0 });
    expect(repo.lessons()).toHaveLength(0);
  });

  it("is atomic: a failure midway rolls back earlier findings", () => {
    const { repo } = setup();
    const bad = finding({}, { comment_url: "u2" });
    (bad.rule as { text: unknown }).text = null; // NOT NULL violation
    expect(() => apply(repo, finding({}), bad)).toThrow();
    expect(repo.lessons()).toHaveLength(0);
  });
});

describe("analysisPrompt / schema", () => {
  const m = { pr: { number: 7, title: "T", body: "", url: "https://x/7", author: "a", headRefName: "h", mergedAt: null, reviews: [], comments: [], inline: [], commits: [], botLogins: new Set() }, items: [], fixes: [], butler: null } as unknown as Material;
  it("lists existing lessons with id and status, and products with product_id", () => {
    const { repo, shop } = setup();
    const a = seed(repo, "confirmed");
    const b = seed(repo, "rejected");
    const p = analysisPrompt("zh", "acme/web", m, repo.lessons(), repo.productsOf("acme/web"));
    expect(p).toContain(`#${a} [confirmed] old`);
    expect(p).toContain(`#${b} [rejected] old`);
    expect(p).toContain(`${shop} shop：acme/api, acme/web`);
    expect(p).toContain("acme/web");
  });

  it("schema json has findings; validate accepts a good answer and rejects a bad one", () => {
    expect(Object.keys(JSON.parse(toCliJsonSchema(AnalysisSchema)).properties)).toContain("findings");
    expect(validate(AnalysisSchema, { findings: [finding({})] }).ok).toBe(true);
    expect(validate(AnalysisSchema, { findings: [{ summary: 1 }] }).ok).toBe(false);
  });
});
