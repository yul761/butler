import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { makeRepo, memDb, tempDir } from "../test-utils";
import { branchExists, currentBranch } from "./git";
import { TicketError, TicketService } from "./ticket-service";
import { cleanupIfMerged, cleanupTicketWorktrees } from "./worktree-cleanup";

async function setup(workMode: "worktree" | "branch" = "worktree") {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const ticketService = new TicketService({ tickets, settings: new SettingsRepo(db), now: () => 1, workspacesDir: tempDir("butler-ws-") });
  const repo = makeRepo();
  const t = await ticketService.create({ key: "DMS-1", repoPath: repo, workMode });
  const r = t.repos[0];
  let busy = false;
  const clean = () => cleanupTicketWorktrees({ tickets, ticketService, repoBusy: () => busy, now: () => 500 }, "DMS-1");
  const g = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  return { tickets, ticketService, repo, r, dir: r.worktreePath!, clean, g, setBusy: (b: boolean) => (busy = b) };
}

describe("cleanupTicketWorktrees", () => {
  it("removes a clean worktree and keeps its branch", async () => {
    const { clean, dir, repo, r, tickets } = await setup();
    expect(await clean()).toEqual([{ repoId: r.id, result: "removed" }]);
    expect(existsSync(dir)).toBe(false);
    expect(await branchExists(repo, r.branch)).toBe(true);
    expect(tickets.getRepo(r.id)).toMatchObject({ worktreeRemovedAt: 500, cleanupBlocked: null });
  });

  it("removes a worktree that only has ignored files (node_modules)", async () => {
    const { clean, dir, g } = await setup();
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    g(dir, "add", ".gitignore");
    g(dir, "commit", "-m", "ignore");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "x.js"), "x");
    expect((await clean())[0].result).toBe("removed");
    expect(existsSync(dir)).toBe(false);
  });

  it("removes a worktree whose commits were never pushed: they stay on the local branch", async () => {
    const { clean, dir, repo, r, g } = await setup();
    writeFileSync(join(dir, "a.txt"), "a");
    g(dir, "add", "a.txt");
    g(dir, "commit", "-m", "local only");
    expect((await clean())[0].result).toBe("removed");
    expect(execFileSync("git", ["log", "--format=%s", "-1", r.branch], { cwd: repo, encoding: "utf8" }).trim()).toBe("local only");
  });

  it("blocks on untracked or uncommitted files and says why", async () => {
    const { clean, dir, r, tickets } = await setup();
    writeFileSync(join(dir, "new.txt"), "n");
    const [out] = await clean();
    expect(out).toMatchObject({ repoId: r.id, result: "blocked" });
    expect(existsSync(dir)).toBe(true);
    expect(tickets.getRepo(r.id)?.cleanupBlocked).toBe("worktree 里有未提交的改动或未跟踪的文件");
    expect(tickets.getRepo(r.id)?.worktreeRemovedAt).toBeNull();
  });

  it("blocks while the repo's own terminal runs, and clears the reason once it can clean", async () => {
    const { clean, r, tickets, setBusy } = await setup();
    setBusy(true);
    expect((await clean())[0].result).toBe("blocked");
    expect(tickets.getRepo(r.id)?.cleanupBlocked).toBe("这个仓库的终端还在运行");
    setBusy(false);
    expect((await clean())[0].result).toBe("removed");
    expect(tickets.getRepo(r.id)?.cleanupBlocked).toBeNull();
  });

  it("blocks on commits on a detached HEAD that no branch has", async () => {
    const { clean, dir, g } = await setup();
    g(dir, "checkout", "--detach");
    writeFileSync(join(dir, "d.txt"), "d");
    g(dir, "add", "d.txt");
    g(dir, "commit", "-m", "detached");
    expect((await clean())[0]).toMatchObject({ result: "blocked", reason: "游离 HEAD 上有不在任何分支上的提交" });
  });

  it("skips branch-mode repos and worktrees already removed", async () => {
    expect(await (await setup("branch")).clean()).toEqual([]);
    const { clean } = await setup();
    await clean();
    expect(await clean()).toEqual([]);
  });

  it("skips everything while the ticket is being changed", async () => {
    const { tickets, r, repo } = await setup();
    const busy = { exclusive: async () => { throw new TicketError("busy", "x"); } };
    expect(await cleanupTicketWorktrees({ tickets, ticketService: busy, repoBusy: () => false, now: () => 1 }, "DMS-1")).toEqual([
      { repoId: r.id, result: "skipped" },
    ]);
    expect(existsSync(r.worktreePath!)).toBe(true);
    expect(repo).toBeTruthy();
  });
});

describe("cleanup safety (final review)", () => {
  it("still sees untracked files when git is set to hide them (status.showUntrackedFiles=no)", async () => {
    const { clean, dir, repo, g } = await setup();
    g(repo, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(dir, "untracked.txt"), "keep me");
    expect((await clean())[0]).toMatchObject({ result: "blocked", reason: "worktree 里有未提交的改动或未跟踪的文件" });
    expect(existsSync(join(dir, "untracked.txt"))).toBe(true);
  });

  it("holds the ticket's lock while it runs, so a second pass or an open waits its turn", async () => {
    const { clean, ticketService, r, tickets } = await setup();
    const first = clean();
    expect(ticketService.updating("DMS-1")).toBe(true);
    const second = await clean();
    expect(second).toEqual([{ repoId: r.id, result: "skipped" }]);
    expect((await first)[0].result).toBe("removed");
    expect(ticketService.updating("DMS-1")).toBe(false);
    expect(tickets.getRepo(r.id)?.cleanupBlocked).toBeNull();
  });

  it("checks the repo's terminals again right before removing", async () => {
    const { tickets, ticketService, r, dir } = await setup();
    let calls = 0;
    const out = await cleanupTicketWorktrees({ tickets, ticketService, repoBusy: () => ++calls > 1, now: () => 1 }, "DMS-1");
    expect(out[0]).toMatchObject({ result: "blocked", reason: "这个仓库的终端还在运行" });
    expect(existsSync(dir)).toBe(true);
    expect(r).toBeTruthy();
  });
});

describe("cleanupIfMerged", () => {
  const merged = { latestValid: () => ({ payload: { prs: [{ number: 1, url: "u", state: "merged", review: null }] } }) } as never;
  const open = { latestValid: () => ({ payload: { prs: [{ number: 2, url: "u", state: "open", review: null }] } }) } as never;

  it("cleans a merged ticket and only clears old reasons for one that is no longer merged", async () => {
    const { tickets, ticketService, r, dir, setBusy } = await setup();
    const d = { tickets, ticketService, repoBusy: () => false, now: () => 1 };
    setBusy(true);
    await cleanupTicketWorktrees({ ...d, repoBusy: () => true }, "DMS-1");
    expect(tickets.getRepo(r.id)?.cleanupBlocked).not.toBeNull();
    expect(await cleanupIfMerged(d, open, "DMS-1")).toEqual([]);
    expect(tickets.getRepo(r.id)?.cleanupBlocked).toBeNull();
    expect(existsSync(dir)).toBe(true);
    expect((await cleanupIfMerged(d, merged, "DMS-1"))[0].result).toBe("removed");
  });
});

describe("TicketService.ensureWorktree", () => {
  it("rebuilds a removed worktree on its branch", async () => {
    const { clean, dir, r, ticketService, tickets } = await setup();
    await clean();
    const back = await ticketService.ensureWorktree(tickets.getRepo(r.id)!);
    expect(existsSync(dir)).toBe(true);
    expect(await currentBranch(dir)).toBe(r.branch);
    expect(back).toMatchObject({ worktreeRemovedAt: null, worktreePath: dir });
    expect(tickets.getRepo(r.id)?.worktreeRemovedAt).toBeNull();
  });

  it("refuses to adopt a plain directory that took the cleaned worktree's place", async () => {
    const { clean, dir, r, ticketService, tickets } = await setup();
    await clean();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "x.ts"), "written after cleanup");
    await expect(ticketService.ensureWorktree(tickets.getRepo(r.id)!)).rejects.toMatchObject({ code: "worktree_exists" });
    expect(tickets.getRepo(r.id)?.worktreeRemovedAt).not.toBeNull();
  });

  it("leaves a repo whose worktree was never removed alone", async () => {
    const { r, ticketService } = await setup();
    expect(await ticketService.ensureWorktree(r)).toBe(r);
  });
});
