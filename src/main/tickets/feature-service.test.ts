import { existsSync, mkdirSync, realpathSync, renameSync, symlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { FeaturesRepo } from "../db/features-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { makeRepo, memDb, tempDir } from "../test-utils";
import { featureDirName } from "../util/ticket-file";
import { FeatureService } from "./feature-service";
import { currentBranch } from "./git";
import { TicketError, TicketService } from "./ticket-service";

/** ~/Code/shop/{frontend,backend} 这样的布局。 */
function shop() {
  const code = tempDir("butler-code-");
  const parent = join(code, "shop");
  const frontend = join(parent, "frontend");
  const backend = join(parent, "backend");
  mkdirSync(parent);
  renameSync(makeRepo(), frontend);
  renameSync(makeRepo(), backend);
  return { code, parent, frontend, backend };
}

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const features = new FeaturesRepo(db);
  const settings = new SettingsRepo(db);
  settings.set("branchTemplate", "{key_lower}-{title}");
  const archived: string[] = [];
  let now = 1000;
  const clock = () => now;
  const home = tempDir("butler-home-");
  const featureService = new FeatureService({ features, tickets, now: clock, onTicketArchived: (k) => archived.push(k), homeDir: home });
  const ticketService = new TicketService({ tickets, features, settings, now: clock, workspacesDir: tempDir("butler-ws-") });
  return { tickets, features, featureService, ticketService, archived, home, tick: (n: number) => (now = n) };
}

const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
    return "no-error";
  } catch (e) {
    return e instanceof TicketError ? e.code : `other:${(e as Error).message}`;
  }
};

describe("featureDirName", () => {
  it("keeps non-ASCII names and spaces", () => {
    expect(featureDirName("结账 改版")).toBe("结账 改版");
    expect(featureDirName("  checkout  ")).toBe("checkout");
  });

  it("always stays inside the parent directory", () => {
    const base = tempDir("butler-base-");
    for (const name of ["../../etc", "a/b", "C:\\x", "..", ".", "", "   ", "a:b*c?", "CON", "x".repeat(200)]) {
      const dir = featureDirName(name);
      expect(dir, name).not.toMatch(/[/\\]/);
      expect(dir, name).not.toMatch(/^\.*$/);
      expect(dir.length, name).toBeLessThanOrEqual(80);
      expect(join(base, dir).startsWith(base + sep), name).toBe(true);
    }
  });
});

describe("FeatureService", () => {
  it("defaults the workspace to <parent>-features/<name> next to the repos' parent", () => {
    const { featureService } = setup();
    expect(featureService.defaultWorkspace([join("/c", "shop", "frontend"), join("/c", "shop", "backend")], "checkout")).toBe(join("/c", "shop-features", "checkout"));
  });

  it("creates a feature over two repos and its workspace directory", async () => {
    const { featureService } = setup();
    const s = shop();
    const f = await featureService.create({ name: "checkout", repoPaths: [s.frontend, s.backend] });
    expect(f.workspaceDir).toBe(join(s.code, "shop-features", "checkout"));
    expect(existsSync(f.workspaceDir)).toBe(true);
    expect(f.repos.map((r) => r.repoPath)).toEqual([s.frontend, s.backend]);
  });

  it("refuses an empty name, a non-repo path and a workspace another feature uses", async () => {
    const { featureService } = setup();
    const s = shop();
    expect(await code(featureService.create({ name: "  ", repoPaths: [s.frontend] }))).toBe("invalid_name");
    expect(await code(featureService.create({ name: "x", repoPaths: [tempDir()] }))).toBe("not_git_repo");
    await featureService.create({ name: "x", repoPaths: [s.frontend] });
    expect(await code(featureService.create({ name: "x", repoPaths: [s.backend] }))).toBe("workspace_taken");
  });

  it("expands ~, refuses a relative workspace and stores the real path behind a symlink", async () => {
    const { featureService, home } = setup();
    const s = shop();
    expect(await code(featureService.create({ name: "a", repoPaths: [s.frontend], workspaceDir: "ws/a" }))).toBe("invalid_workspace");
    const tilde = await featureService.create({ name: "b", repoPaths: [s.frontend], workspaceDir: "~/features/b" });
    expect(tilde.workspaceDir).toBe(join(home, "features", "b"));
    expect(existsSync(tilde.workspaceDir)).toBe(true);
    const real = tempDir("butler-real-");
    const link = join(tempDir("butler-link-"), "ln");
    symlinkSync(real, link);
    const linked = await featureService.create({ name: "c", repoPaths: [s.frontend], workspaceDir: join(link, "c") });
    expect(linked.workspaceDir).toBe(join(realpathSync(real), "c"));
  });

  it("adds, removes and renames", async () => {
    const { featureService } = setup();
    const s = shop();
    const f = await featureService.create({ name: "x", repoPaths: [s.frontend] });
    const added = await featureService.addRepo(f.id, join(s.backend, "."));
    expect(added.repoPath).toBe(s.backend);
    expect(await code(featureService.addRepo(f.id, s.backend))).toBe("repo_exists");
    featureService.removeRepo(added.id);
    featureService.rename(f.id, "y");
    expect(featureService.get(f.id)).toMatchObject({ name: "y", repos: [{ repoPath: s.frontend }] });
  });

  it("archives a feature with its tickets and restores the ones archived with it", async () => {
    const { featureService, ticketService, tickets, archived, tick } = setup();
    const s = shop();
    const f = await featureService.create({ name: "x", repoPaths: [s.frontend] });
    await ticketService.create({ key: "DMS-1", featureId: f.id });
    await ticketService.create({ key: "DMS-2", featureId: f.id });
    tick(2000);
    tickets.archive("DMS-2", 2000);
    expect(await code(() => featureService.archive(f.id, { terminalsOpen: true }))).toBe("sessions_open");
    tick(3000);
    featureService.archive(f.id, { terminalsOpen: false });
    expect(archived).toEqual(["DMS-1"]);
    expect(tickets.get("DMS-1")?.archivedAt).toBe(3000);
    featureService.unarchive(f.id);
    expect(featureService.get(f.id)?.archivedAt).toBeNull();
    expect(tickets.get("DMS-1")?.archivedAt).toBeNull();
    expect(tickets.get("DMS-2")?.archivedAt).toBe(2000);
  });
});

describe("tickets in a feature", () => {
  it("puts each ticket's worktree in the workspace, two tickets in one repo side by side", async () => {
    const { featureService, ticketService } = setup();
    const s = shop();
    const f = await featureService.create({ name: "checkout", repoPaths: [s.frontend, s.backend] });
    const a = await ticketService.create({ key: "DMS-1234", title: "Cart page", featureId: f.id, repoPaths: [s.frontend], workMode: "worktree" });
    const b = await ticketService.create({ key: "DMS-1235", title: "Cart totals", featureId: f.id, repoPaths: [s.frontend], workMode: "worktree" });
    expect(a.featureId).toBe(f.id);
    expect(a.repos[0].worktreePath).toBe(join(f.workspaceDir, "frontend-dms-1234"));
    expect(b.repos[0].worktreePath).toBe(join(f.workspaceDir, "frontend-dms-1235"));
    expect(await currentBranch(a.repos[0].worktreePath!)).toBe("dms-1234-cart-page");
    expect(await currentBranch(b.repos[0].worktreePath!)).toBe("dms-1235-cart-totals");
    expect(await currentBranch(s.frontend)).toBe("main");
  });

  it("adds every picked repo to one ticket", async () => {
    const { featureService, ticketService } = setup();
    const s = shop();
    const f = await featureService.create({ name: "checkout", repoPaths: [s.frontend, s.backend] });
    const t = await ticketService.create({ key: "DMS-1", featureId: f.id, repoPaths: [s.frontend, s.backend], workMode: "worktree" });
    expect(t.repos.map((r) => r.worktreePath)).toEqual([join(f.workspaceDir, "frontend-dms-1"), join(f.workspaceDir, "backend-dms-1")]);
  });

  it("keeps the workspace path when the work mode changes back to worktree", async () => {
    const { featureService, ticketService } = setup();
    const s = shop();
    const f = await featureService.create({ name: "checkout", repoPaths: [s.frontend] });
    const t = await ticketService.create({ key: "DMS-1", featureId: f.id, repoPaths: [s.frontend], workMode: "branch" });
    const r = await ticketService.updateRepo({ repoId: t.repos[0].id, workMode: "worktree" }, { terminalsOpen: false });
    expect(r.worktreePath).toBe(join(f.workspaceDir, "frontend-dms-1"));
  });

  it("refuses a missing or archived feature", async () => {
    const { featureService, ticketService } = setup();
    const s = shop();
    expect(await code(ticketService.create({ key: "DMS-1", featureId: 99 }))).toBe("not_found");
    const f = await featureService.create({ name: "x", repoPaths: [s.frontend] });
    featureService.archive(f.id, { terminalsOpen: false });
    expect(await code(ticketService.create({ key: "DMS-2", featureId: f.id }))).toBe("archived");
  });
});
