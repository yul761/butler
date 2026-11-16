import { describe, expect, it, vi } from "vitest";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { RepoIdentity } from "./repo-identity";
import { LessonsService } from "./lessons-service";

const git = (p: string): string | null => (p.startsWith("/none") ? null : `git@github.com:${p.slice(1).replace("_", "/")}.git`);
const src = { prNumber: 1, url: "https://github.com/acme/web/pull/1" };

const setup = (over: { paths?: string[]; groups?: string[][] } = {}) => {
  const repo = new LessonsRepo(memDb());
  const openExternal = vi.fn();
  const notify = vi.fn();
  const backfill = vi.fn(async () => ({ ok: true as const, enqueued: 3 }));
  const svc = new LessonsService({
    repo, identity: new RepoIdentity({ git }), runner: { backfill },
    knownRepoPaths: () => over.paths ?? ["/acme_web", "/acme_api", "/none_x"],
    repoGroups: () => over.groups ?? [],
    ghAvailable: () => true, openExternal, now: () => 100, notify,
  });
  svc.state();
  const add = (slug: string, text = "t") => repo.addLesson({ scope: { kind: "repo", slug }, text, why: "w", at: 1, source: src });
  return { repo, svc, openExternal, notify, backfill, add };
};

describe("LessonsService.state", () => {
  it("splits known paths into repos and unknown repos, one repo per slug", () => {
    const { svc } = setup({ paths: ["/acme_web", "/acme_web", "/acme_api", "/none_x"] });
    const s = svc.state();
    expect(s.repos.map((r) => r.slug)).toEqual(["acme/api", "acme/web"]);
    expect(s.unknownRepos).toEqual([{ path: "/none_x", reason: "not_git" }]);
    expect(s.ghAvailable).toBe(true);
  });

  it("reports queued/failed, overflow and hides rejected lessons", () => {
    const { svc, repo, add } = setup();
    for (let i = 0; i < 35; i++) repo.setStatus(add("acme/web", `l${i}`), "confirmed", 2);
    const rej = add("acme/web", "no");
    repo.setStatus(rej, "rejected", 2);
    repo.enqueue("acme/web", [1, 2, 3], "backfill", 1);
    const a = repo.take(1)!;
    repo.finish(a.id, "failed", 2, "boom");
    const web = svc.state().repos.find((r) => r.slug === "acme/web")!;
    expect(web.overflow).toBe(5);
    expect(web.failed).toBe(1);
    expect(web.queued).toBe(2);
    const s = svc.state();
    expect(s.lessons).toHaveLength(35);
    expect(s.lessons.some((l) => l.id === rej)).toBe(false);
  });

  it("suggests products from repo groups mapped to slugs", () => {
    const { svc } = setup({ groups: [["/acme_web", "/acme_api"], ["/acme_api", "/acme_web"], ["/none_x"]] });
    expect(svc.state().suggestions).toEqual([{ slugs: ["acme/api", "acme/web"], together: 2 }]);
  });
});

describe("LessonsService.act", () => {
  it("confirm with text sets the text first and notifies", async () => {
    const { svc, repo, add, notify } = setup();
    svc.state();
    const id = add("acme/web", "old");
    expect(await svc.act({ op: "confirm", id, text: "新正文" })).toEqual({ ok: true });
    expect(repo.get(id)).toMatchObject({ status: "confirmed", text: "新正文" });
    expect(notify).toHaveBeenCalled();
  });

  it("merge rejects different scopes, same lesson and missing lessons", async () => {
    const { svc, repo, add, notify } = setup();
    const a = add("acme/web");
    const b = add("acme/api");
    expect(await svc.act({ op: "merge", keepId: a, dropId: b, text: "x" })).toEqual({ ok: false, reason: "scope_mismatch" });
    expect(await svc.act({ op: "merge", keepId: a, dropId: a, text: "x" })).toEqual({ ok: false, reason: "same_lesson" });
    expect(await svc.act({ op: "merge", keepId: a, dropId: 999, text: "x" })).toEqual({ ok: false, reason: "not_found" });
    expect(repo.get(a)?.hits).toBe(1);
    expect(notify).not.toHaveBeenCalled();
    const c = add("acme/web");
    expect(await svc.act({ op: "merge", keepId: a, dropId: c, text: "x" })).toEqual({ ok: true });
    expect(repo.get(c)).toBeNull();
  });

  it("returns not_found for a lesson id that does not exist", async () => {
    const { svc } = setup();
    expect(await svc.act({ op: "reject", id: 42 })).toEqual({ ok: false, reason: "not_found" });
    expect(await svc.act({ op: "edit", id: 42, text: "x" })).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects an existing product name", async () => {
    const { svc } = setup();
    expect(await svc.act({ op: "createProduct", name: "shop", slugs: [] })).toEqual({ ok: true });
    expect(await svc.act({ op: "createProduct", name: "shop", slugs: [] })).toEqual({ ok: false, reason: "name_taken" });
  });

  it("openSource only opens https urls", async () => {
    const { svc, repo, add, openExternal } = setup();
    const id = add("acme/web");
    const good = repo.get(id)!.sources[0]!.id;
    expect(await svc.act({ op: "openSource", sourceId: good })).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/web/pull/1");
    repo.hit(id, 2, { prNumber: 2, url: "javascript:alert(1)" });
    const bad = repo.get(id)!.sources.find((s) => s.prNumber === 2)!.id;
    expect(await svc.act({ op: "openSource", sourceId: bad })).toEqual({ ok: false, reason: "bad_url" });
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("backfill returns the runner result as is", async () => {
    const { svc, backfill } = setup();
    expect(await svc.act({ op: "backfill", slug: "acme/web" })).toEqual({ ok: true, enqueued: 3 });
    expect(backfill).toHaveBeenCalledWith("acme/web");
  });
});

describe("LessonsService.pendingCount", () => {
  it("counts pending only", () => {
    const { svc, repo, add } = setup();
    add("acme/web");
    add("acme/web");
    repo.setStatus(add("acme/web"), "confirmed", 2);
    expect(svc.pendingCount()).toBe(2);
  });
});
