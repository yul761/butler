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
  const archivedKeys: string[] = [];
  const featureService = new FeatureService({
    features, tickets, epics, db, now: () => now, homeDir: home,
    onTicketArchived: (k) => archivedKeys.push(k),
    onRepoAdded: (fid, repo) => epicService.ensureFeatureRepo(fid, repo),
  });
  const epicService = new EpicService({ epics, features, featureService, db, now: () => now, homeDir: home });
  return { epics, features, tickets, epicService, featureService, archivedKeys, tick: (n: number) => (now = n) };
}

const NONE = { terminalsOpen: () => false, featureTerminalsOpen: () => false };

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
    await epicService.archive(e.id, NONE);
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
    await epicService.archive(e.id, NONE);
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
    await epicService.archive(e.id, NONE);
    featureService.unarchive(f1);
    expect(epicService.get(e.id).archivedAt).toBeNull();
    expect(features.get(f1)?.archivedAt).toBeNull();
    expect(features.get(f2)?.archivedAt).toBe(2000);
  });
});

describe("EpicService archive summarizes first", () => {
  function archiveSetup(refresh: (ids: number[]) => Promise<void>) {
    const db = memDb();
    const epics = new EpicsRepo(db);
    const features = new FeaturesRepo(db);
    const tickets = new TicketsRepo(db);
    const featureService = new FeatureService({ features, tickets, epics, db, now: () => 2000, refreshBeforeArchive: refresh, log: () => undefined });
    const archivedCalls: [number, number[]][] = [];
    const epicService = new EpicService({ epics, features, featureService, db, now: () => 2000, onArchived: (id, ids) => archivedCalls.push([id, [...ids].sort()]) });
    const epicId = epics.insert({ name: "e", workspaceDir: "/e", createdAt: 1 });
    const f1 = features.insert({ name: "f1", workspaceDir: "/f1", createdAt: 1, epicId });
    const f2 = features.insert({ name: "f2", workspaceDir: "/f2", createdAt: 1, epicId });
    const done = features.insert({ name: "done", workspaceDir: "/done", createdAt: 1, epicId });
    features.archive(done, 500);
    return { epicService, epics, features, epicId, f1, f2, done, archivedCalls };
  }

  it("reports the epic and exactly the features it archived, once it has archived them", async () => {
    const t = archiveSetup(async () => undefined);
    await t.epicService.archive(t.epicId, NONE);
    expect(t.archivedCalls).toEqual([[t.epicId, [t.f1, t.f2].sort()]]);
    await t.epicService.archive(t.epicId, NONE);
    expect(t.archivedCalls).toHaveLength(1);
  });

  it("reports nothing when the archive is refused", async () => {
    const t = archiveSetup(async () => undefined);
    await code(() => t.epicService.archive(t.epicId, { terminalsOpen: () => true, featureTerminalsOpen: () => false }));
    expect(t.archivedCalls).toEqual([]);
  });

  it("asks once for all unarchived features, then archives them together", async () => {
    const asked: number[][] = [];
    const t = archiveSetup(async (ids) => {
      asked.push([...ids].sort());
      expect(t.epics.get(t.epicId)?.archivedAt).toBeNull();
      expect(t.features.get(t.f1)?.archivedAt).toBeNull();
    });
    await t.epicService.archive(t.epicId, NONE);
    expect(asked).toEqual([[t.f1, t.f2].sort()]);
    expect(t.epics.get(t.epicId)?.archivedAt).toBe(2000);
    expect(t.features.get(t.f1)?.archivedAt).toBe(2000);
    expect(t.features.get(t.f2)?.archivedAt).toBe(2000);
    expect(t.features.get(t.done)?.archivedAt).toBe(500);
  });

  it("archives anyway when the summaries fail", async () => {
    const t = archiveSetup(() => Promise.reject(new Error("boom")));
    await t.epicService.archive(t.epicId, NONE);
    expect(t.epics.get(t.epicId)?.archivedAt).toBe(2000);
  });

  it("runs once for two clicks", async () => {
    let runs = 0;
    let finish: () => void = () => undefined;
    const t = archiveSetup(() => {
      runs++;
      return new Promise((r) => (finish = r));
    });
    const a = t.epicService.archive(t.epicId, NONE);
    const b = t.epicService.archive(t.epicId, NONE);
    await Promise.resolve();
    finish();
    await Promise.all([a, b]);
    expect(runs).toBe(1);
  });

  it("does not summarize when a terminal is open, and refuses if one opened while it ran", async () => {
    let runs = 0;
    let open = false;
    const t = archiveSetup(async () => {
      runs++;
      open = true;
    });
    expect(await code(() => t.epicService.archive(t.epicId, { terminalsOpen: () => true, featureTerminalsOpen: () => false }))).toBe("sessions_open");
    expect(runs).toBe(0);
    expect(await code(() => t.epicService.archive(t.epicId, { terminalsOpen: () => false, featureTerminalsOpen: () => open }))).toBe("sessions_open");
    expect(runs).toBe(1);
    expect(t.epics.get(t.epicId)?.archivedAt).toBeNull();
    expect(t.features.get(t.f1)?.archivedAt).toBeNull();
  });
});

describe("EpicService archive cascade and guard", () => {
  const ticket = (key: string, featureId: number, archivedAt: number | null = null) =>
    ({ key, title: null, status: "active" as const, statusManual: null, createdAt: 1, archivedAt, featureId });

  it("archives tickets under the features like FeatureService.archive, and restores only those archived together", async () => {
    const { epicService, features, tickets, archivedKeys, tick } = setup();
    const s = shop();
    const e = await epicService.create({ name: "e", repoPaths: [s.frontend] });
    const f1 = features.insert({ name: "f1", workspaceDir: "/f1", createdAt: 1, epicId: e.id });
    tickets.insert(ticket("A-1", f1));
    tickets.insert(ticket("A-2", f1, 100));
    tick(2000);
    await epicService.archive(e.id, NONE);
    expect(tickets.get("A-1")?.archivedAt).toBe(2000);
    expect(tickets.get("A-2")?.archivedAt).toBe(100);
    expect(archivedKeys).toEqual(["A-1"]);
    epicService.unarchive(e.id);
    expect(tickets.get("A-1")?.archivedAt).toBeNull();
    expect(tickets.get("A-2")?.archivedAt).toBe(100);
    expect(features.get(f1)?.archivedAt).toBeNull();
  });

  it("refuses with sessions_open, changing nothing, when the epic's own session or a feature's terminal is open", async () => {
    const { epicService, features, tickets } = setup();
    const s = shop();
    const e = await epicService.create({ name: "e", repoPaths: [s.frontend] });
    const f1 = features.insert({ name: "f1", workspaceDir: "/f1", createdAt: 1, epicId: e.id });
    const f2 = features.insert({ name: "f2", workspaceDir: "/f2", createdAt: 1, epicId: e.id });
    tickets.insert(ticket("A-1", f1));
    expect(await code(() => epicService.archive(e.id, { terminalsOpen: () => true, featureTerminalsOpen: () => false }))).toBe("sessions_open");
    expect(await code(() => epicService.archive(e.id, { terminalsOpen: () => false, featureTerminalsOpen: (id) => id === f2 }))).toBe("sessions_open");
    expect(epicService.get(e.id).archivedAt).toBeNull();
    expect(features.get(f1)?.archivedAt).toBeNull();
    expect(tickets.get("A-1")?.archivedAt).toBeNull();
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

  it("tells both epics about a move, and a failing callback does not fail it", async () => {
    const { epicService, featureService, features, epics, tickets } = setup();
    const s = shop();
    const e1 = await epicService.create({ name: "e1", repoPaths: [s.frontend] });
    const e2 = await epicService.create({ name: "e2", repoPaths: [s.frontend] });
    const f = await featureService.create({ name: "f", repoPaths: [s.frontend] });
    const changed: number[] = [];
    const svc = new EpicService({ epics, features, featureService: new FeatureService({ features, tickets, epics, now: () => 1 }), now: () => 1, onEpicChanged: (id) => void changed.push(id) });
    svc.moveFeature(f.id, e1.id);
    expect(changed).toEqual([e1.id]);
    changed.length = 0;
    svc.moveFeature(f.id, e2.id);
    expect(changed).toEqual([e1.id, e2.id]);
    changed.length = 0;
    svc.moveFeature(f.id, null);
    expect(changed).toEqual([e2.id]);
    const boom = new EpicService({ epics, features, featureService, now: () => 1, onEpicChanged: () => { throw new Error("x"); } });
    expect(() => boom.moveFeature(f.id, e1.id)).not.toThrow();
    expect(features.get(f.id)?.epicId).toBe(e1.id);
  });

  it("refuses an archived epic or a missing feature or epic", async () => {
    const { epicService, featureService } = setup();
    const s = shop();
    const e = await epicService.create({ name: "e", repoPaths: [s.frontend] });
    const f = await featureService.create({ name: "f", repoPaths: [s.frontend] });
    await epicService.archive(e.id, NONE);
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
