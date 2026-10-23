import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

describe("TicketService.create input checks", () => {
  it("rejects an empty repository with a friendly message", async () => {
    const { service, tickets } = setup();
    const dir = tempDir("butler-empty-");
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    await expect(service.create({ key: "PROJ-20", repoPath: dir, workMode: "branch" })).rejects.toMatchObject({
      code: "empty_repo",
      message: "这个仓库还没有任何提交",
    });
    expect(tickets.get("PROJ-20")).toBeNull();
  });

  it("rejects a rendered branch that starts with a dash (template and ticket pattern disagree)", async () => {
    const db = memDb();
    const settings = new SettingsRepo(db);
    settings.set("ticketPattern", "-\\d+");
    settings.set("branchTemplate", "{key}");
    const service = new TicketService({ tickets: new TicketsRepo(db), settings, now: () => 1000 });
    expect(await code(service.create({ key: "-5", repoPath: makeRepo(), workMode: "branch" }))).toBe("invalid_branch");
  });

  it("rejects branch names git would refuse or expand", async () => {
    const { service } = setup();
    const repo = makeRepo();
    for (const branch of ["has space", "-x", "a..b", "@{-1}", "end/"]) {
      expect(await code(service.create({ key: "PROJ-21", repoPath: repo, workMode: "branch", branch }))).toBe("invalid_branch");
    }
    expect(await code(service.create({ key: "PROJ-21", repoPath: repo, workMode: "branch", branch: "yc/功能-1" }))).toBe("no-error");
  });

  it("maps git failures to git_failed with git's own reason and stores nothing", async () => {
    const { service, tickets } = setup();
    const repo = makeRepo();
    // main 已经在主工作区检出，git 不允许再给它建 worktree。
    const err = await service.create({ key: "PROJ-22", repoPath: repo, workMode: "worktree", branch: "main" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TicketError);
    expect(err).toMatchObject({ code: "git_failed" });
    expect((err as Error).message).toMatch(/^git 操作失败：/);
    expect((err as Error).message).not.toMatch(/fatal:/);
    expect(tickets.get("PROJ-22")).toBeNull();
  });
});

describe("TicketService archived keys", () => {
  it("tells an archived key apart from an active one, and the key works again after restoring", async () => {
    const { service, tickets } = setup();
    const repo = makeRepo();
    await service.create({ key: "PROJ-30", repoPath: repo, workMode: "worktree" });
    tickets.archive("PROJ-30", 2000);
    expect(tickets.list().map((t) => t.key)).toEqual([]);
    expect(tickets.listArchived().map((t) => t.key)).toEqual(["PROJ-30"]);
    expect(await code(service.create({ key: "proj-30", repoPath: repo, workMode: "branch" }))).toBe("archived");

    tickets.unarchive("PROJ-30");
    expect(tickets.list().map((t) => t.key)).toEqual(["PROJ-30"]);
    expect(tickets.listArchived()).toEqual([]);
    expect(await code(service.create({ key: "PROJ-30", repoPath: repo, workMode: "branch" }))).toBe("exists");
  });
});

describe("TicketService.update", () => {
  const open = { terminalsOpen: false };

  it("changes only the title without touching git, even with terminals open", async () => {
    const { service, tickets } = setup();
    const t = await service.create({ key: "PROJ-40", title: "old", repoPath: makeRepo(), workMode: "worktree" });
    await service.update({ key: "PROJ-40", title: "  new  " }, { terminalsOpen: true });
    expect(tickets.get("PROJ-40")).toMatchObject({ title: "new", workMode: "worktree", worktreePath: t.worktreePath, branch: t.branch });
    await service.update({ key: "PROJ-40", title: "" }, open);
    expect(tickets.get("PROJ-40")?.title).toBeNull();
  });

  it("worktree → branch mode: the worktree leaves the branch but keeps its files, so the repo can check the branch out", async () => {
    const { service, tickets } = setup();
    const repo = makeRepo();
    const t = await service.create({ key: "PROJ-41", repoPath: repo, workMode: "worktree" });
    const wt = t.worktreePath!;
    writeFileSync(join(wt, ".env"), "ignored-but-kept\n");
    writeFileSync(join(wt, ".gitignore"), ".env\n");
    await git(wt, ["add", ".gitignore"]);
    await git(wt, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "ignore env"]);

    const u = await service.update({ key: "PROJ-41", workMode: "branch" }, open);
    expect(u).toMatchObject({ workMode: "branch", worktreePath: null, branch: "feature/PROJ-41" });
    expect(tickets.get("PROJ-41")).toMatchObject({ workMode: "branch", worktreePath: null });
    expect(existsSync(join(wt, ".env"))).toBe(true);
    expect(await currentBranch(wt)).toBe("HEAD");
    expect(service.workDir(u)).toBe(repo);
    await service.switchBranch(u);
    expect(await currentBranch(repo)).toBe("feature/PROJ-41");
  });

  it("branch → worktree mode creates the worktree, and going back and forth reuses it", async () => {
    const { service } = setup();
    const repo = makeRepo();
    await service.create({ key: "PROJ-42", repoPath: repo, workMode: "branch" });
    const w = await service.update({ key: "PROJ-42", workMode: "worktree" }, open);
    const expected = join(dirname(repo), `${basename(repo)}-worktrees`, "PROJ-42");
    expect(w).toMatchObject({ workMode: "worktree", worktreePath: expected });
    expect(await currentBranch(expected)).toBe("feature/PROJ-42");

    await service.update({ key: "PROJ-42", workMode: "branch" }, open);
    const again = await service.update({ key: "PROJ-42", workMode: "worktree" }, open);
    expect(again.worktreePath).toBe(expected);
    expect(await currentBranch(expected)).toBe("feature/PROJ-42");
  });

  it("refuses branch → worktree while the repo itself is on the ticket branch", async () => {
    const { service, tickets } = setup();
    const repo = makeRepo();
    const t = await service.create({ key: "PROJ-43", repoPath: repo, workMode: "branch" });
    await service.switchBranch(t);
    expect(await code(service.update({ key: "PROJ-43", workMode: "worktree" }, open))).toBe("branch_checked_out");
    expect(tickets.get("PROJ-43")).toMatchObject({ workMode: "branch", worktreePath: null });
  });

  it("changes the branch: switches inside the worktree, or just records it in branch mode", async () => {
    const { service, tickets } = setup();
    const repo = makeRepo();
    const w = await service.create({ key: "PROJ-44", repoPath: repo, workMode: "worktree" });
    await service.update({ key: "PROJ-44", branch: "fix/PROJ-44" }, open);
    expect(await currentBranch(w.worktreePath!)).toBe("fix/PROJ-44");
    expect(tickets.get("PROJ-44")?.branch).toBe("fix/PROJ-44");

    await service.create({ key: "PROJ-45", repoPath: repo, workMode: "branch" });
    await service.update({ key: "PROJ-45", branch: "fix/PROJ-45" }, open);
    expect(await branchExists(repo, "fix/PROJ-45")).toBe(true);
    expect(await currentBranch(repo)).toBe("main");
    expect(tickets.get("PROJ-45")?.branch).toBe("fix/PROJ-45");
  });

  it("refuses git changes with terminals open, a dirty worktree or a bad branch name, and stores nothing", async () => {
    const { service, tickets } = setup();
    const t = await service.create({ key: "PROJ-46", repoPath: makeRepo(), workMode: "worktree" });
    expect(await code(service.update({ key: "PROJ-46", workMode: "branch" }, { terminalsOpen: true }))).toBe("sessions_open");
    expect(await code(service.update({ key: "PROJ-46", branch: "a..b" }, open))).toBe("invalid_branch");
    writeFileSync(join(t.worktreePath!, "README.md"), "changed\n");
    expect(await code(service.update({ key: "PROJ-46", workMode: "branch" }, open))).toBe("dirty");
    expect(tickets.get("PROJ-46")).toMatchObject({ workMode: "worktree", worktreePath: t.worktreePath, branch: t.branch });
    expect(await code(service.update({ key: "NOPE-1", title: "x" }, open))).toBe("not_found");
  });

  it("recreates a worktree whose directory was deleted by hand", async () => {
    const { service } = setup();
    const t = await service.create({ key: "PROJ-47", repoPath: makeRepo(), workMode: "worktree" });
    rmSync(t.worktreePath!, { recursive: true, force: true });
    const u = await service.update({ key: "PROJ-47", branch: "fix/PROJ-47" }, open);
    expect(u.worktreePath).toBe(t.worktreePath);
    expect(await currentBranch(u.worktreePath!)).toBe("fix/PROJ-47");
  });
});
