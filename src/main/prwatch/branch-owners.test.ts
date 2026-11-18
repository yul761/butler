import { win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BranchOwnersRepo } from "../db/branch-owners-repo";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { memDb } from "../test-utils";
import type { HookEnvelope } from "../../shared/hook-envelope";
import { BranchOwnership, pathKey, resolveShipDir, shipFromEnvelope, type BranchOwnershipDeps } from "./branch-owners";
import { PrLinker } from "./pr-links";

const env = (command: string, o: { cwd?: string; ticket?: string | null; butlerSession?: string | null; prUrls?: string[]; event?: string; tool?: string } = {}): HookEnvelope => ({
  v: 1, receivedAt: 5, ticket: o.ticket === undefined ? "T-1" : o.ticket, butlerSession: o.butlerSession === undefined ? "b1" : o.butlerSession,
  payload: { hook_event_name: o.event ?? "PostToolUse", session_id: "c1", tool_name: o.tool ?? "Bash", cwd: o.cwd ?? "/repo", tool_input: { command }, pr_urls: o.prUrls ?? [] },
});

describe("shipFromEnvelope", () => {
  it("reads the session, cwd, commands and PR links of a Bash PostToolUse", () => {
    expect(shipFromEnvelope(env("cd /wt/a && git push -u origin feat/a", { prUrls: [] }))).toEqual({
      sessionId: "b1", ticket: "T-1", cwd: "/repo", commands: [{ kind: "push", dir: "/wt/a", branch: "feat/a" }], prUrls: [],
    });
    // 没有 BUTLER_SESSION（不是 Butler 开的终端）：用 Claude 的 session id。
    expect(shipFromEnvelope(env("git push", { butlerSession: null }))?.sessionId).toBe("c1");
    expect(shipFromEnvelope(env("ls"))).toBeNull();
    expect(shipFromEnvelope(env("git push", { event: "PreToolUse" }))).toBeNull();
    expect(shipFromEnvelope(env("git push", { tool: "Skill" }))).toBeNull();
    expect(shipFromEnvelope({ ...env("git push"), payload: "x" })).toBeNull();
    // Butler 自己的后台 claude：不算。
    expect(shipFromEnvelope(env("git push", { butlerSession: "headless:r1" }))).toBeNull();
    // 失败的命令（PostToolUseFailure）里的推送也算：`git push && gh pr create` 里 gh 失败了。
    expect(shipFromEnvelope(env("git push origin feat/a && gh pr create", { event: "PostToolUseFailure" }))?.commands).toHaveLength(2);
  });

  it("uses the ship the hook parsed from the full command (the command itself is truncated)", () => {
    const e = env("git commit -m \"xxxx", {});
    (e.payload as Record<string, unknown>).ship = [{ kind: "push", dir: null, branch: "feat/long" }];
    expect(shipFromEnvelope(e)?.commands).toEqual([{ kind: "push", dir: null, branch: "feat/long" }]);
    // 格式不对就自己解析命令。
    (e.payload as Record<string, unknown>).ship = [{ kind: "rm", dir: null }];
    expect(shipFromEnvelope(e)).toBeNull();
  });
});

describe("pathKey", () => {
  it("ignores slashes, drive case and path case on Windows, and nothing on posix", () => {
    const k = (p: string) => pathKey(p, true);
    expect(k("C:\\Users\\me\\proj")).toBe(k("c:/users/ME/proj/"));
    expect(k("/c/Users/me/proj")).toBe(k("C:\\Users\\me\\proj"));
    expect(k("C:\\Users\\me\\proj")).not.toBe(k("D:\\Users\\me\\proj"));
    expect(pathKey("/repo/", false)).toBe(pathKey("/repo", false));
    expect(pathKey("/Repo", false)).not.toBe(pathKey("/repo", false));
  });
});

describe("resolveShipDir", () => {
  it("expands ~ and $HOME, and maps Git Bash drive paths on Windows", () => {
    expect(resolveShipDir("/repo", null, { home: "/h", win: false })).toBe("/repo");
    expect(resolveShipDir("/repo", "~/wt", { home: "/h", win: false })).toBe("/h/wt");
    expect(resolveShipDir("/repo", "$HOME/wt", { home: "/h", win: false })).toBe("/h/wt");
    expect(resolveShipDir("/repo", "../wt", { home: "/h", win: false })).toBe("/wt");
    expect(resolveShipDir("C:\\Users\\me\\proj", "/c/Users/me/wt", { home: "C:\\Users\\me", win: true })).toBe("C:\\Users\\me\\wt");
    expect(resolveShipDir("C:\\Users\\me\\proj", "/d", { home: "C:\\Users\\me", win: true })).toBe("D:\\");
    expect(resolveShipDir("C:\\Users\\me\\proj", "~/wt", { home: "C:\\Users\\me", win: true })).toBe("C:\\Users\\me\\wt");
    expect(resolveShipDir("C:\\Users\\me\\proj", "../wt", { home: "C:\\Users\\me", win: true })).toBe("C:\\Users\\me\\wt");
    // hook 的 cwd 是小写盘符或 Git Bash 路径，命令里是正斜杠：都统一成大写盘符、反斜杠。
    expect(resolveShipDir("c:\\users\\me\\proj", "../wt", { home: "C:\\Users\\me", win: true })).toBe("C:\\users\\me\\wt");
    expect(resolveShipDir("/c/Users/me/proj", null, { home: "C:\\Users\\me", win: true })).toBe("C:\\Users\\me\\proj");
    expect(resolveShipDir("C:\\Users\\me\\proj", "d:/src/x", { home: "C:\\Users\\me", win: true })).toBe("D:\\src\\x");
  });
});

function setup(o: { branches?: Record<string, string>; roots?: Record<string, string>; repoPath?: string; win?: boolean; home?: string } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  tickets.insert({ key: "T-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const repoId = tickets.addRepo({ ticketKey: "T-1", repoPath: o.repoPath ?? "/repo", workMode: "branch", worktreePath: null, branch: "feature/T-1", createdAt: 1 });
  const prs = new TicketPrsRepo(db);
  const owners = new BranchOwnersRepo(db);
  const linker = new PrLinker({ prs, tickets, slugOf: (p) => (p === "/repo" ? "o/r" : null), now: () => 9 });
  // posix 用例的路径原样当键（deps.win 为 false 时实现走 posix，CI 的 Windows 上也一样）；
  // Windows 用例像 git 一样不管斜杠和大小写。
  const win = o.win ?? false;
  const key = (d: string) => (win ? win32.resolve(d).toLowerCase() : d);
  const keyed = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [key(k), v]));
  const branches = win ? keyed({ ...o.branches }) : keyed({ "/repo": "feature/T-1", "/wt/a": "feat/a", ...o.branches });
  const roots = win ? keyed({ ...o.roots }) : keyed({ "/repo": "/repo", "/wt/a": "/repo", ...o.roots });
  const deps = {
    tickets: { get: (k: string) => tickets.get(k) },
    sessionTicket: vi.fn<BranchOwnershipDeps["sessionTicket"]>(() => null),
    currentBranch: vi.fn(async (d: string) => {
      if (!(key(d) in branches)) throw new Error(`not a repo: ${d}`);
      return branches[key(d)];
    }),
    mainRepoRoot: vi.fn(async (d: string) => {
      if (!(key(d) in roots)) throw new Error(`not a repo: ${d}`);
      return roots[key(d)];
    }),
    owners, linker, soon: vi.fn<(repoId: number) => void>(), now: () => 100, log: vi.fn<(msg: string, err?: unknown) => void>(),
    isCoordinator: vi.fn<(id: string) => boolean>(() => false), isOpen: vi.fn<(id: string) => boolean>(() => true),
    exists: vi.fn<(dir: string) => boolean>(() => true), home: o.home ?? "/h", win,
  } satisfies BranchOwnershipDeps;
  return { db, tickets, repoId, prs, owners, deps, b: new BranchOwnership(deps) };
}

describe("BranchOwnership", () => {
  it("records the session that pushed a worktree branch (git -C / cd relative to cwd) and asks the watcher to look", async () => {
    const s = setup();
    await s.b.handle(env("cd ../wt/a && git push -u origin HEAD", { cwd: "/repo" }));
    expect(s.owners.get("T-1", s.repoId, "feat/a")).toMatchObject({ sessionId: "b1", dir: "/wt/a", at: 100 });
    expect(s.deps.soon).toHaveBeenCalledWith(s.repoId);
    await s.b.handle(env("git -C /wt/a push origin feat/a:feat/renamed", { butlerSession: "b2" }));
    expect(s.owners.get("T-1", s.repoId, "feat/renamed")).toMatchObject({ sessionId: "b2" });
  });

  it("links the PR that gh pr create printed, on the branch it was opened from (the missing-link case)", async () => {
    const s = setup();
    await s.b.handle(env("cd /wt/a && gh pr create --fill", { prUrls: ["https://github.com/o/r/pull/34"] }));
    expect(s.owners.get("T-1", s.repoId, "feat/a")).toMatchObject({ sessionId: "b1" });
    expect(s.prs.byTicket("T-1")).toEqual([expect.objectContaining({ number: 34, repoId: s.repoId, headBranch: "feat/a", source: "branch", state: "open" })]);
    // --head 指定的分支，PR 链接不是这个仓库的（同一条命令里别的输出）：分支照样记，PR 不链接。
    await s.b.handle(env("gh pr create -H me:feat/h", { prUrls: ["https://github.com/x/y/pull/2"] }));
    expect(s.owners.get("T-1", s.repoId, "feat/h")).not.toBeNull();
    expect(s.prs.byTicket("T-1").find((p) => p.number === 2)).toBeUndefined();
    // 打出来好几个链接（gh pr create && gh pr list）：只认最后一个。
    await s.b.handle(env("cd /wt/a && gh pr create --fill", { prUrls: ["https://github.com/o/r/pull/30", "https://github.com/o/r/pull/35"] }));
    expect(s.prs.byTicket("T-1").map((p) => p.number).sort()).toEqual([34, 35]);
  });

  it("the coordinator force-pushing a child's branch does not take it from the open child", async () => {
    const s = setup();
    s.deps.isCoordinator.mockImplementation((id) => id === "coord");
    await s.b.handle(env("git -C /wt/a push origin feat/a", { butlerSession: "child" }));
    await s.b.handle(env("git -C /wt/a push --force-with-lease origin feat/a", { butlerSession: "coord" }));
    expect(s.owners.get("T-1", s.repoId, "feat/a")).toMatchObject({ sessionId: "child" });
    // 子 session 关了：总控接过来。
    s.deps.isOpen.mockReturnValue(false);
    await s.b.handle(env("git -C /wt/a push --force-with-lease origin feat/a", { butlerSession: "coord" }));
    expect(s.owners.get("T-1", s.repoId, "feat/a")).toMatchObject({ sessionId: "coord" });
  });

  it("matches a ticket repo that is itself a linked worktree, skips tag pushes, and falls back to cwd when cd's target is gone", async () => {
    const s = setup({ repoPath: "/wt/main", roots: { "/wt/main": "/repo", "/wt/b": "/repo" }, branches: { "/wt/b": "feat/b" } });
    await s.b.handle(env("cd /wt/b && git push"));
    expect(s.owners.get("T-1", s.repoId, "feat/b")).not.toBeNull();
    await s.b.handle(env("git -C /wt/b push origin v2.1.0"));
    expect(s.owners.get("T-1", s.repoId, "v2.1.0")).toBeNull();
    // hook 的 cwd 已经是 cd 进去以后的目录：sub/sub 不存在，就用 cwd。
    s.deps.exists.mockImplementation((d) => d !== "/wt/b/b");
    await s.b.handle(env("cd b && git push origin feat/c", { cwd: "/wt/b" }));
    expect(s.owners.get("T-1", s.repoId, "feat/c")).toMatchObject({ dir: "/wt/b" });
  });

  it("uses the session's ticket when BUTLER_TICKET is missing, and logs why it records nothing", async () => {
    const s = setup();
    s.deps.sessionTicket.mockReturnValue("T-1");
    await s.b.handle(env("git push", { ticket: null }));
    expect(s.deps.sessionTicket).toHaveBeenCalledWith("b1");
    expect(s.owners.get("T-1", s.repoId, "feature/T-1")).not.toBeNull();
    s.deps.sessionTicket.mockReturnValue(null);
    await s.b.handle(env("git push", { ticket: null }));
    await s.b.handle(env("git push", { ticket: "NOPE" }));
    await s.b.handle(env("cd /elsewhere && git push origin x"));
    const lines = s.deps.log.mock.calls.map((c) => c[0]).filter((m) => !m.includes(" -> "));
    expect(lines).toEqual([
      expect.stringMatching(/branch owner: .*no ticket/),
      expect.stringMatching(/branch owner: .*ticket NOPE not found/),
      expect.stringMatching(/branch owner: .*elsewhere is not in a git repository/),
    ]);
  });

  it("does not record a directory that belongs to another repository", async () => {
    const s = setup({ branches: { "/other": "main" }, roots: { "/other": "/other" } });
    await s.b.handle(env("cd /other && git push"));
    expect(s.owners.since(0)).toEqual([]);
    expect(s.deps.log).toHaveBeenCalledWith(expect.stringMatching(/branch owner: .*other is not one of T-1's repos/));
  });

  it("on Windows, matches the ticket repo however the hook and git spell the path (slashes, drive case, Git Bash)", async () => {
    // 票里的仓库是 C:\Users\me\proj；hook 的 cwd 是小写盘符；git 打出来的主仓库根是正斜杠。
    const s = setup({
      win: true, home: "C:\\Users\\me", repoPath: "C:\\Users\\me\\proj",
      roots: { "C:\\Users\\me\\proj": "C:/Users/me/proj", "C:\\Users\\me\\wt\\a": "c:/users/ME/proj", "C:\\Users\\me\\wt\\b": "C:/Users/me/proj" },
      branches: { "C:\\Users\\me\\proj": "feature/T-1", "C:\\Users\\me\\wt\\a": "feat/a", "C:\\Users\\me\\wt\\b": "feat/b" },
    });
    await s.b.handle(env("git -C C:/Users/me/wt/a push", { cwd: "c:\\users\\me\\proj" }));
    expect(s.owners.get("T-1", s.repoId, "feat/a")).toMatchObject({ dir: "C:\\Users\\me\\wt\\a" });
    await s.b.handle(env("cd /c/Users/me/wt/b && git push", { cwd: "C:\\Users\\me\\proj" }));
    expect(s.owners.get("T-1", s.repoId, "feat/b")).toMatchObject({ dir: "C:\\Users\\me\\wt\\b" });
    // hook 的 cwd 本身是 Git Bash 路径、命令里是 ~：都对得上。
    await s.b.handle(env("git push origin feature/T-1", { cwd: "/c/Users/me/proj" }));
    expect(s.owners.get("T-1", s.repoId, "feature/T-1")).toMatchObject({ dir: "C:\\Users\\me\\proj" });
    await s.b.handle(env("cd ~/wt/a && git push origin feat/a2", { cwd: "C:\\Users\\me\\proj", butlerSession: "b3" }));
    expect(s.owners.get("T-1", s.repoId, "feat/a2")).toMatchObject({ sessionId: "b3", dir: "C:\\Users\\me\\wt\\a" });
  });
});
