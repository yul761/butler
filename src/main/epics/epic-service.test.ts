import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EpicsRepo } from "../db/epics-repo";
import { FeaturesRepo } from "../db/features-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { FeatureService } from "../tickets/feature-service";
import { TicketError } from "../tickets/ticket-service";
import { makeRepo, memDb, tempDir } from "../test-utils";
import { EpicService } from "./epic-service";

/** ~/Code/shop/{frontend,backend} 这样的布局。 */
function shop() {
  const code = tempDir("butler-code-");
  const parent = join(code, "shop");
  const frontend = join(parent, "frontend");
  const backend = join(parent, "backend");
  mkdirSync(parent);
  renameSync(makeRepo(), frontend);
  renameSync(makeRepo(), backend);
  return { code, frontend, backend };
}

function setup() {
  const db = memDb();
  const epics = new EpicsRepo(db);
  const features = new FeaturesRepo(db);
  const tickets = new TicketsRepo(db);
  let now = 1000;
  const home = tempDir("butler-home-");
  const epicService = new EpicService({ epics, features, db, now: () => now, homeDir: home });
  const featureService = new FeatureService({
    features, tickets, epics, db, now: () => now, homeDir: home,
    onRepoAdded: (fid, repo) => epicService.ensureFeatureRepo(fid, repo),
  });
  return { epics, features, epicService, featureService, tick: (n: number) => (now = n) };
}

const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
    return "no-error";
  } catch (e) {
    return e instanceof TicketError ? e.code : `other:${(e as Error).message}`;
  }
};

describe("EpicService create", () => {
  it("defaults the workspace to <parent>-epics/<name> and creates it", async () => {
    const { epicService } = setup();
    const s = shop();
    const e = await epicService.create({ name: "payments", repoPaths: [s.frontend, s.backend] });
    expect(e.workspaceDir).toBe(join(s.code, "shop-epics", "payments"));
    expect(existsSync(e.workspaceDir)).toBe(true);
    expect(e.repos.map((r) => r.repoPath)).toEqual([s.frontend, s.backend]);
  });

  it("validates the name, the repos and the workspace like a feature does", async () => {
    const { epicService } = setup();
    const s = shop();
    expect(await code(epicService.create({ name: "  ", repoPaths: [s.frontend] }))).toBe("invalid_name");
    expect(await code(epicService.create({ name: "x".repeat(101), repoPaths: [s.frontend] }))).toBe("invalid_name");
    expect(await code(epicService.create({ name: "e", repoPaths: [] }))).toBe("not_git_repo");
    expect(await code(epicService.create({ name: "e", repoPaths: [tempDir()] }))).toBe("not_git_repo");
    expect(await code(epicService.create({ name: "e", repoPaths: [s.frontend], workspaceDir: "relative/dir" }))).toBe("invalid_workspace");
    await epicService.create({ name: "e", repoPaths: [s.frontend] });
    expect(await code(epicService.create({ name: "e", repoPaths: [s.backend] }))).toBe("workspace_taken");
  });

  it("renames and adds / removes repos", async () => {
    const { epicService } = setup();
    const s = shop();
    const e = await epicService.create({ name: "e", repoPaths: [s.frontend] });
    expect(epicService.rename(e.id, " 新名字 ").name).toBe("新名字");
    expect(await code(() => epicService.rename(e.id, ""))).toBe("invalid_name");
    const r = await epicService.addRepo(e.id, s.backend);
    expect(await code(epicService.addRepo(e.id, s.backend))).toBe("repo_exists");
    epicService.removeRepo(r.id);
    expect(epicService.get(e.id).repos.map((x) => x.repoPath)).toEqual([s.frontend]);
    expect(await code(() => epicService.removeRepo(r.id))).toBe("not_found");
    expect(await code(() => epicService.get(999))).toBe("not_found");
  });
});

describe("EpicService archive", () => {
  it("archives the epic with its unarchived features under one timestamp", async () => {
    const { epicService, features, tick } = setup();
    const s = shop();
    const e = await epicService.create({ name: "e", repoPaths: [s.frontend] });
    const f1 = features.insert({ name: "f1", workspaceDir: "/f1", createdAt: 1, epicId: e.id });
    const f2 = features.insert({ name: "f2", workspaceDir: "/f2", createdAt: 1, epicId: e.id });
    const outside = features.insert({ name: "out", workspaceDir: "/out", createdAt: 1 });
    features.archive(f2, 500);
    tick(2000);
    epicService.archive(e.id);
    expect(epicService.get(e.id).archivedAt).toBe(2000);
    expect(features.get(f1)?.archivedAt).toBe(2000);
    expect(features.get(f2)?.archivedAt).toBe(500);
    expect(features.get(outside)?.archivedAt).toBeNull();
  });

  it("restores only the features archived together with the epic", async () => {
    const { epicService, features, tick } = setup();
    const s = shop();
    const e = await epicService.create({ name: "e", repoPaths: [s.frontend] });
    const f1 = features.insert({ name: "f1", workspaceDir: "/f1", createdAt: 1, epicId: e.id });
    const f2 = features.insert({ name: "f2", workspaceDir: "/f2", createdAt: 1, epicId: e.id });
    features.archive(f2, 500);
    tick(2000);
    epicService.archive(e.id);
    epicService.unarchive(e.id);
    expect(epicService.get(e.id).archivedAt).toBeNull();
    expect(features.get(f1)?.archivedAt).toBeNull();
    expect(features.get(f2)?.archivedAt).toBe(500);
  });

  it("restores the epic (only) when one of its features is restored on its own", async () => {
    const { epicService, featureService, features, tick } = setup();
    const s = shop();
    const e = await epicService.create({ name: "e", repoPaths: [s.frontend] });
    const f1 = features.insert({ name: "f1", workspaceDir: "/f1", createdAt: 1, epicId: e.id });
    const f2 = features.insert({ name: "f2", workspaceDir: "/f2", createdAt: 1, epicId: e.id });
    tick(2000);
    epicService.archive(e.id);
    featureService.unarchive(f1);
    expect(epicService.get(e.id).archivedAt).toBeNull();
    expect(features.get(f1)?.archivedAt).toBeNull();
    expect(features.get(f2)?.archivedAt).toBe(2000);
  });
});

describe("EpicService moveFeature", () => {
  it("moves a feature in, between epics and out without touching its workspace; missing repos join the target", async () => {
    const { epicService, featureService, features } = setup();
    const s = shop();
    const e1 = await epicService.create({ name: "e1", repoPaths: [s.frontend] });
    const e2 = await epicService.create({ name: "e2", repoPaths: [s.frontend, s.backend] });
    const f = await featureService.create({ name: "f", repoPaths: [s.frontend, s.backend] });
    const dir = f.workspaceDir;

    epicService.moveFeature(f.id, e1.id);
    expect(features.get(f.id)).toMatchObject({ epicId: e1.id, workspaceDir: dir });
    expect(epicService.get(e1.id).repos.map((r) => r.repoPath)).toEqual([s.frontend, s.backend]);

    epicService.moveFeature(f.id, e2.id);
    expect(features.get(f.id)).toMatchObject({ epicId: e2.id, workspaceDir: dir });
    expect(epicService.get(e2.id).repos).toHaveLength(2);

    epicService.moveFeature(f.id, null);
    expect(features.get(f.id)).toMatchObject({ epicId: null, workspaceDir: dir });
    expect(epicService.get(e1.id).repos).toHaveLength(2);
    expect(existsSync(dir)).toBe(true);
  });

  it("refuses an archived epic or a missing feature or epic", async () => {
    const { epicService, featureService } = setup();
    const s = shop();
    const e = await epicService.create({ name: "e", repoPaths: [s.frontend] });
    const f = await featureService.create({ name: "f", repoPaths: [s.frontend] });
    epicService.archive(e.id);
    expect(await code(() => epicService.moveFeature(f.id, e.id))).toBe("epic_archived");
    expect(await code(() => epicService.moveFeature(f.id, 999))).toBe("not_found");
    expect(await code(() => epicService.moveFeature(999, null))).toBe("not_found");
  });

  it("adds a repo a feature gains later to its epic, and ignores features outside any epic", async () => {
    const { epicService, featureService } = setup();
    const s = shop();
    const e = await epicService.create({ name: "e", repoPaths: [s.frontend] });
    const f = await featureService.create({ name: "f", repoPaths: [s.frontend] });
    const loose = await featureService.create({ name: "loose", repoPaths: [s.frontend] });
    epicService.moveFeature(f.id, e.id);
    await featureService.addRepo(f.id, s.backend);
    expect(epicService.get(e.id).repos.map((r) => r.repoPath)).toEqual([s.frontend, s.backend]);
    await featureService.addRepo(loose.id, s.backend);
    expect(epicService.get(e.id).repos).toHaveLength(2);
  });
});
