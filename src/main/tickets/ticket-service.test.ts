import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsRepo } from "../db/settings-repo";
import type { Ticket } from "../../shared/types";
import { TicketsRepo } from "../db/tickets-repo";
import { makeRepo, memDb, tempDir } from "../test-utils";
import { branchExists, currentBranch, git } from "./git";
import { TicketError, TicketService } from "./ticket-service";

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const service = new TicketService({ tickets, settings: new SettingsRepo(db), now: () => 1000, workspacesDir: tempDir("butler-ws-") });
  /** 单仓库 ticket 的那个仓库。 */
  const repoOf = (key: string) => tickets.get(key)!.repos[0];
  return { tickets, service, repoOf };
}

const only = (t: Ticket) => t.repos[0];

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
    expect(t).toMatchObject({ key: "PROJ-1", status: "active", createdAt: 1000 });
    expect(only(t)).toMatchObject({ ticketKey: "PROJ-1", repoPath: repo, branch: "feature/PROJ-1", workMode: "branch", worktreePath: null });
    expect(await branchExists(repo, "feature/PROJ-1")).toBe(true);
    expect(await currentBranch(repo)).toBe("main");
    expect(service.workDir(only(t))).toBe(repo);
  });

  it("worktree mode creates a sibling worktree on the ticket branch", async () => {
    const { service } = setup();
    const repo = makeRepo();
    const t = await service.create({ key: "PROJ-2", repoPath: repo, workMode: "worktree" });
    const expected = join(dirname(repo), `${basename(repo)}-worktrees`, "PROJ-2");
    expect(only(t).worktreePath).toBe(expected);
    expect(existsSync(join(expected, "README.md"))).toBe(true);
    expect(await currentBranch(expected)).toBe("feature/PROJ-2");
    expect(service.workDir(only(t))).toBe(expected);
  });

  it("worktree mode reuses an existing branch", async () => {
    const { service } = setup();
    const repo = makeRepo();
    await git(repo, ["branch", "custom/PROJ-3"]);
    const t = await service.create({ key: "PROJ-3", repoPath: repo, workMode: "worktree", branch: "custom/PROJ-3" });
    expect(await currentBranch(only(t).worktreePath!)).toBe("custom/PROJ-3");
  });

  it("accepts a subdirectory of the repo and stores the repo root", async () => {
    const { service } = setup();
    const repo = makeRepo();
    const sub = join(repo, "sub");
    mkdirSync(sub);
    const t = await service.create({ key: "PROJ-4", repoPath: sub, workMode: "branch" });
    expect(only(t).repoPath).toBe(repo);
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
    expect(await service.checkBranch(only(t))).toEqual({ ok: false, current: "main", expected: "feature/PROJ-8", dirty: false });

    writeFileSync(join(repo, "README.md"), "changed\n");
    expect(await service.checkBranch(only(t))).toEqual({ ok: false, current: "main", expected: "feature/PROJ-8", dirty: true });
    expect(await code(service.switchBranch(only(t)))).toBe("dirty");

    await git(repo, ["checkout", "--", "README.md"]);
    await service.switchBranch(only(t));
    expect(await service.checkBranch(only(t))).toEqual({ ok: true });
  });

  it("worktree tickets always pass the check", async () => {
    const { service } = setup();
    const t = await service.create({ key: "PROJ-9", repoPath: makeRepo(), workMode: "worktree" });
    expect(await service.checkBranch(only(t))).toEqual({ ok: true });
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
    const service = new TicketService({ tickets: new TicketsRepo(db), settings, now: () => 1000, workspacesDir: tempDir("butler-ws-") });
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
    // 另一个 worktree 已经检出了 taken，git 不允许再给它建 worktree。
    await git(repo, ["worktree", "add", "-b", "taken", join(tempDir(), "elsewhere")]);
    const err = await service.create({ key: "PROJ-22", repoPath: repo, workMode: "worktree", branch: "taken" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TicketError);
    expect(err).toMatchObject({ code: "git_failed" });
    expect((err as Error).message).toMatch(/^git 操作失败：/);
    expect((err as Error).message).not.toMatch(/fatal:/);
    expect(tickets.get("PROJ-22")).toBeNull();
  });

  it("refuses a worktree on the branch the repo itself has checked out, with a clear reason", async () => {
    const { service } = setup();
    expect(await code(service.create({ key: "PROJ-23", repoPath: makeRepo(), workMode: "worktree", branch: "main" }))).toBe("branch_checked_out");
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
    await service.setTitle("PROJ-40", "  new  ");
    expect(tickets.get("PROJ-40")).toMatchObject({ title: "new", repos: [{ workMode: "worktree", worktreePath: only(t).worktreePath, branch: only(t).branch }] });
    await service.setTitle("PROJ-40", "");
    expect(tickets.get("PROJ-40")?.title).toBeNull();
  });

  it("worktree → branch mode: the worktree leaves the branch but keeps its files, so the repo can check the branch out", async () => {
    const { service, repoOf } = setup();
    const repo = makeRepo();
    const t = await service.create({ key: "PROJ-41", repoPath: repo, workMode: "worktree" });
    const wt = only(t).worktreePath!;
    writeFileSync(join(wt, ".env"), "ignored-but-kept\n");
    writeFileSync(join(wt, ".gitignore"), ".env\n");
    await git(wt, ["add", ".gitignore"]);
    await git(wt, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "ignore env"]);

    const u = await service.updateRepo({ repoId: repoOf("PROJ-41").id, workMode: "branch" }, open);
    expect(u).toMatchObject({ workMode: "branch", worktreePath: null, branch: "feature/PROJ-41" });
    expect(repoOf("PROJ-41")).toMatchObject({ workMode: "branch", worktreePath: null });
    expect(existsSync(join(wt, ".env"))).toBe(true);
    expect(await currentBranch(wt)).toBe("HEAD");
    expect(service.workDir(u)).toBe(repo);
    await service.switchBranch(u);
    expect(await currentBranch(repo)).toBe("feature/PROJ-41");
  });

  it("branch → worktree mode creates the worktree, and going back and forth reuses it", async () => {
    const { service, repoOf } = setup();
    const repo = makeRepo();
    await service.create({ key: "PROJ-42", repoPath: repo, workMode: "branch" });
    const w = await service.updateRepo({ repoId: repoOf("PROJ-42").id, workMode: "worktree" }, open);
    const expected = join(dirname(repo), `${basename(repo)}-worktrees`, "PROJ-42");
    expect(w).toMatchObject({ workMode: "worktree", worktreePath: expected });
    expect(await currentBranch(expected)).toBe("feature/PROJ-42");

    await service.updateRepo({ repoId: repoOf("PROJ-42").id, workMode: "branch" }, open);
    const again = await service.updateRepo({ repoId: repoOf("PROJ-42").id, workMode: "worktree" }, open);
    expect(again.worktreePath).toBe(expected);
    expect(await currentBranch(expected)).toBe("feature/PROJ-42");
  });

  it("refuses branch → worktree while the repo itself is on the ticket branch", async () => {
    const { service, repoOf } = setup();
    const repo = makeRepo();
    const t = await service.create({ key: "PROJ-43", repoPath: repo, workMode: "branch" });
    await service.switchBranch(only(t));
    expect(await code(service.updateRepo({ repoId: repoOf("PROJ-43").id, workMode: "worktree" }, open))).toBe("branch_checked_out");
    expect(repoOf("PROJ-43")).toMatchObject({ workMode: "branch", worktreePath: null });
  });

  it("changes the branch: switches inside the worktree, or just records it in branch mode", async () => {
    const { service, repoOf } = setup();
    const repo = makeRepo();
    const w = await service.create({ key: "PROJ-44", repoPath: repo, workMode: "worktree" });
    await service.updateRepo({ repoId: repoOf("PROJ-44").id, branch: "fix/PROJ-44" }, open);
    expect(await currentBranch(only(w).worktreePath!)).toBe("fix/PROJ-44");
    expect(repoOf("PROJ-44").branch).toBe("fix/PROJ-44");

    await service.create({ key: "PROJ-45", repoPath: repo, workMode: "branch" });
    await service.updateRepo({ repoId: repoOf("PROJ-45").id, branch: "fix/PROJ-45" }, open);
    expect(await branchExists(repo, "fix/PROJ-45")).toBe(true);
    expect(await currentBranch(repo)).toBe("main");
    expect(repoOf("PROJ-45").branch).toBe("fix/PROJ-45");
  });

  it("refuses git changes with terminals open, a dirty worktree or a bad branch name, and stores nothing", async () => {
    const { service, repoOf } = setup();
    const t = await service.create({ key: "PROJ-46", repoPath: makeRepo(), workMode: "worktree" });
    expect(await code(service.updateRepo({ repoId: repoOf("PROJ-46").id, workMode: "branch" }, { terminalsOpen: true }))).toBe("sessions_open");
    expect(await code(service.updateRepo({ repoId: repoOf("PROJ-46").id, branch: "a..b" }, open))).toBe("invalid_branch");
    writeFileSync(join(only(t).worktreePath!, "README.md"), "changed\n");
    expect(await code(service.updateRepo({ repoId: repoOf("PROJ-46").id, workMode: "branch" }, open))).toBe("dirty");
    expect(repoOf("PROJ-46")).toMatchObject({ workMode: "worktree", worktreePath: only(t).worktreePath, branch: only(t).branch });
    expect(await code(Promise.resolve().then(() => service.setTitle("NOPE-1", "x")))).toBe("not_found");
  });

  it("recreates a worktree whose directory was deleted by hand", async () => {
    const { service, repoOf } = setup();
    const t = await service.create({ key: "PROJ-47", repoPath: makeRepo(), workMode: "worktree" });
    rmSync(only(t).worktreePath!, { recursive: true, force: true });
    const u = await service.updateRepo({ repoId: repoOf("PROJ-47").id, branch: "fix/PROJ-47" }, open);
    expect(u.worktreePath).toBe(only(t).worktreePath);
    expect(await currentBranch(u.worktreePath!)).toBe("fix/PROJ-47");
  });
});

describe("TicketService.update keeps the user's work", () => {
  const open = { terminalsOpen: false };
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), `${file}\n`);
    return git(cwd, ["add", file]).then(() => git(cwd, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", file]));
  };

  it("frees the branch of a hand-deleted worktree when switching to branch mode", async () => {
    const { service, repoOf } = setup();
    const repo = makeRepo();
    const t = await service.create({ key: "PROJ-50", repoPath: repo, workMode: "worktree" });
    rmSync(only(t).worktreePath!, { recursive: true, force: true });
    const u = await service.updateRepo({ repoId: repoOf("PROJ-50").id, workMode: "branch" }, open);
    await service.switchBranch(u);
    expect(await currentBranch(repo)).toBe("feature/PROJ-50");
  });

  it("starts a renamed branch from the ticket's old branch, not from whatever the repo has checked out", async () => {
    const { service, repoOf } = setup();
    const repo = makeRepo();
    const t = await service.create({ key: "PROJ-51", repoPath: repo, workMode: "worktree" });
    await commit(only(t).worktreePath!, "work.txt");
    const u = await service.updateRepo({ repoId: repoOf("PROJ-51").id, workMode: "branch", branch: "fix/PROJ-51" }, open);
    await service.switchBranch(u);
    expect(existsSync(join(repo, "work.txt"))).toBe(true);
  });

  it("refuses to leave a detached worktree that has commits on no branch", async () => {
    const { service, repoOf } = setup();
    const t = await service.create({ key: "PROJ-52", repoPath: makeRepo(), workMode: "worktree" });
    await service.updateRepo({ repoId: repoOf("PROJ-52").id, workMode: "branch" }, open);
    // 旧 session 在离开分支的 worktree 里继续提交。
    await commit(only(t).worktreePath!, "stray.txt");
    expect(await code(service.updateRepo({ repoId: repoOf("PROJ-52").id, workMode: "worktree" }, open))).toBe("unbranched_commits");
    expect(repoOf("PROJ-52")).toMatchObject({ workMode: "branch", worktreePath: null });
  });

  it("refuses a second update, and reports the ticket busy, while one is running", async () => {
    const { service, repoOf } = setup();
    await service.create({ key: "PROJ-53", repoPath: makeRepo(), workMode: "worktree" });
    const first = service.updateRepo({ repoId: repoOf("PROJ-53").id, workMode: "branch" }, open);
    expect(service.updating("PROJ-53")).toBe(true);
    expect(await code(service.updateRepo({ repoId: repoOf("PROJ-53").id, branch: "x/y" }, open))).toBe("busy");
    await first;
    expect(service.updating("PROJ-53")).toBe(false);
  });
});

describe("TicketService with several repos", () => {
  const open = { terminalsOpen: false };

  it("creates a ticket without a repo, then adds repos with their own work modes", async () => {
    const { service, tickets } = setup();
    const t = await service.create({ key: "MULTI-1", title: "全栈" });
    expect(t.repos).toEqual([]);
    const web = makeRepo();
    const api = makeRepo();
    const w = await service.addRepo({ ticketKey: "MULTI-1", repoPath: web, workMode: "worktree" });
    const a = await service.addRepo({ ticketKey: "MULTI-1", repoPath: join(api, "."), workMode: "branch", branch: "api/MULTI-1" });
    expect(tickets.get("MULTI-1")!.repos.map((r) => [r.repoPath, r.workMode, r.branch])).toEqual([
      [web, "worktree", "feature/MULTI-1"],
      [api, "branch", "api/MULTI-1"],
    ]);
    expect(await currentBranch(w.worktreePath!)).toBe("feature/MULTI-1");
    expect(await branchExists(api, "api/MULTI-1")).toBe(true);
    expect(a.worktreePath).toBeNull();
  });

  it("refuses the same repo twice (also through a subdirectory), and unknown tickets", async () => {
    const { service } = setup();
    const repo = makeRepo();
    await service.create({ key: "MULTI-2", repoPath: repo, workMode: "branch" });
    mkdirSync(join(repo, "sub"));
    expect(await code(service.addRepo({ ticketKey: "MULTI-2", repoPath: join(repo, "sub"), workMode: "worktree" }))).toBe("repo_exists");
    expect(await code(service.addRepo({ ticketKey: "NOPE-2", repoPath: repo, workMode: "branch" }))).toBe("not_found");
  });

  it("removes a repo from the ticket without touching the disk, but not while its terminals run", async () => {
    const { service, tickets } = setup();
    const t = await service.create({ key: "MULTI-3", repoPath: makeRepo(), workMode: "worktree" });
    const r = only(t);
    expect(() => service.removeRepo(r.id, { terminalsOpen: true })).toThrow(expect.objectContaining({ code: "sessions_open" }));
    service.removeRepo(r.id, open);
    expect(tickets.get("MULTI-3")!.repos).toEqual([]);
    expect(existsSync(r.worktreePath!)).toBe(true);
    expect(await branchExists(r.repoPath, r.branch)).toBe(true);
  });

  it("finds the repo a directory belongs to", async () => {
    const { service, tickets } = setup();
    const web = makeRepo();
    const api = makeRepo();
    await service.create({ key: "MULTI-4", repoPath: web, workMode: "worktree" });
    await service.addRepo({ ticketKey: "MULTI-4", repoPath: api, workMode: "branch" });
    const t = tickets.get("MULTI-4")!;
    expect(service.repoForCwd(t, join(t.repos[0].worktreePath!, "src"))?.id).toBe(t.repos[0].id);
    expect(service.repoForCwd(t, api)?.id).toBe(t.repos[1].id);
    // worktree 模式仓库的主目录也算这个仓库。
    expect(service.repoForCwd(t, web)?.id).toBe(t.repos[0].id);
    expect(service.repoForCwd(t, `${api}-other`)).toBeNull();
    expect(service.placement("MULTI-4", join(api, "x"))).toEqual({ repoId: t.repos[1].id, coordinator: false });
    expect(service.placement("MULTI-4", service.workspacePath("MULTI-4"))).toEqual({ repoId: null, coordinator: true });
  });

  it("runs background claude in the first repo with the others added, or in the workspace when there is none", async () => {
    const { service, tickets } = setup();
    const web = makeRepo();
    await service.create({ key: "MULTI-5", repoPath: web, workMode: "branch" });
    expect(service.headlessDirs(tickets.get("MULTI-5")!)).toEqual({ cwd: web, addDirs: [], repoDirs: [web] });
    const api = makeRepo();
    await service.addRepo({ ticketKey: "MULTI-5", repoPath: api, workMode: "branch" });
    expect(service.headlessDirs(tickets.get("MULTI-5")!)).toEqual({ cwd: web, addDirs: [api], repoDirs: [web, api] });
    await service.create({ key: "MULTI-6" });
    const bare = service.headlessDirs(tickets.get("MULTI-6")!);
    expect(bare).toMatchObject({ addDirs: [], repoDirs: [] });
    expect(basename(bare.cwd)).toBe("MULTI-6");
    expect(existsSync(bare.cwd)).toBe(true);
  });

  it("re-adds a removed repo, picking up the worktree it left behind (or freeing its branch for branch mode)", async () => {
    const { service, tickets } = setup();
    const repo = makeRepo();
    const t = await service.create({ key: "MULTI-8", repoPath: repo, workMode: "worktree" });
    const wt = only(t).worktreePath!;
    service.removeRepo(only(t).id, { terminalsOpen: false });
    const again = await service.addRepo({ ticketKey: "MULTI-8", repoPath: repo, workMode: "worktree" });
    expect(again.worktreePath).toBe(wt);
    expect(await currentBranch(wt)).toBe("feature/MULTI-8");

    service.removeRepo(again.id, { terminalsOpen: false });
    const branchMode = await service.addRepo({ ticketKey: "MULTI-8", repoPath: repo, workMode: "branch" });
    await service.switchBranch(branchMode);
    expect(await currentBranch(repo)).toBe("feature/MULTI-8");
    expect(tickets.get("MULTI-8")!.repos).toHaveLength(1);
  });

  it("does not add repos to an archived ticket", async () => {
    const { service, tickets } = setup();
    await service.create({ key: "MULTI-9" });
    tickets.archive("MULTI-9", 2);
    expect(await code(service.addRepo({ ticketKey: "MULTI-9", repoPath: makeRepo(), workMode: "branch" }))).toBe("archived");
  });

  it("locks the whole ticket while one of its repos changes", async () => {
    const { service, tickets } = setup();
    await service.create({ key: "MULTI-7", repoPath: makeRepo(), workMode: "worktree" });
    const [r] = tickets.get("MULTI-7")!.repos;
    const pending = service.updateRepo({ repoId: r.id, workMode: "branch" }, open);
    expect(await code(service.addRepo({ ticketKey: "MULTI-7", repoPath: makeRepo(), workMode: "branch" }))).toBe("busy");
    expect(() => service.removeRepo(r.id, open)).toThrow(expect.objectContaining({ code: "busy" }));
    await pending;
  });
});
