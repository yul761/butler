import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { makeRepo, memDb, tempDir } from "../test-utils";
import { branchExists, currentBranch, git } from "./git";
import { TicketError, TicketService } from "./ticket-service";

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const service = new TicketService({ tickets, settings: new SettingsRepo(db), now: () => 1000 });
  return { tickets, service };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "no-error";
  } catch (e) {
    return e instanceof TicketError ? e.code : `other:${(e as Error).message}`;
  }
};

describe("TicketService.create", () => {
  it("branch mode creates the branch without switching the working tree", async () => {
    const { service } = setup();
    const repo = makeRepo();
    const t = await service.create({ key: "proj-1", repoPath: repo, workMode: "branch" });
    expect(t).toMatchObject({ key: "PROJ-1", branch: "feature/PROJ-1", workMode: "branch", worktreePath: null, status: "active", createdAt: 1000 });
    expect(await branchExists(repo, "feature/PROJ-1")).toBe(true);
    expect(await currentBranch(repo)).toBe("main");
    expect(service.workDir(t)).toBe(repo);
  });

  it("worktree mode creates a sibling worktree on the ticket branch", async () => {
    const { service } = setup();
    const repo = makeRepo();
    const t = await service.create({ key: "PROJ-2", repoPath: repo, workMode: "worktree" });
    const expected = join(dirname(repo), `${basename(repo)}-worktrees`, "PROJ-2");
    expect(t.worktreePath).toBe(expected);
    expect(existsSync(join(expected, "README.md"))).toBe(true);
    expect(await currentBranch(expected)).toBe("feature/PROJ-2");
    expect(service.workDir(t)).toBe(expected);
  });

  it("worktree mode reuses an existing branch", async () => {
    const { service } = setup();
    const repo = makeRepo();
    await git(repo, ["branch", "custom/PROJ-3"]);
    const t = await service.create({ key: "PROJ-3", repoPath: repo, workMode: "worktree", branch: "custom/PROJ-3" });
    expect(await currentBranch(t.worktreePath!)).toBe("custom/PROJ-3");
  });

  it("accepts a subdirectory of the repo and stores the repo root", async () => {
    const { service } = setup();
    const repo = makeRepo();
    const sub = join(repo, "sub");
    mkdirSync(sub);
    const t = await service.create({ key: "PROJ-4", repoPath: sub, workMode: "branch" });
    expect(t.repoPath).toBe(repo);
  });

  it("rejects invalid keys, duplicates, non-repos and existing worktree dirs", async () => {
    const { service } = setup();
    const repo = makeRepo();
    expect(await code(service.create({ key: "nope", repoPath: repo, workMode: "branch" }))).toBe("invalid_key");
    await service.create({ key: "PROJ-5", repoPath: repo, workMode: "branch" });
    expect(await code(service.create({ key: "PROJ-5", repoPath: repo, workMode: "branch" }))).toBe("exists");
    expect(await code(service.create({ key: "PROJ-6", repoPath: tempDir(), workMode: "branch" }))).toBe("not_git_repo");
    mkdirSync(join(dirname(repo), `${basename(repo)}-worktrees`, "PROJ-7"), { recursive: true });
    expect(await code(service.create({ key: "PROJ-7", repoPath: repo, workMode: "worktree" }))).toBe("worktree_exists");
  });
});

describe("TicketService branch checks", () => {
  it("reports mismatch with dirty flag and refuses to switch a dirty tree", async () => {
    const { service } = setup();
    const repo = makeRepo();
    const t = await service.create({ key: "PROJ-8", repoPath: repo, workMode: "branch" });
    expect(await service.checkBranch(t)).toEqual({ ok: false, current: "main", expected: "feature/PROJ-8", dirty: false });

    writeFileSync(join(repo, "README.md"), "changed\n");
    expect(await service.checkBranch(t)).toEqual({ ok: false, current: "main", expected: "feature/PROJ-8", dirty: true });
    expect(await code(service.switchBranch(t))).toBe("dirty");

    await git(repo, ["checkout", "--", "README.md"]);
    await service.switchBranch(t);
    expect(await service.checkBranch(t)).toEqual({ ok: true });
  });

  it("worktree tickets always pass the check", async () => {
    const { service } = setup();
    const t = await service.create({ key: "PROJ-9", repoPath: makeRepo(), workMode: "worktree" });
    expect(await service.checkBranch(t)).toEqual({ ok: true });
  });
});
