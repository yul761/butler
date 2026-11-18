import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BranchOwnersRepo } from "../db/branch-owners-repo";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { memDb } from "../test-utils";
import type { HookEnvelope } from "../../shared/hook-envelope";
import { BranchOwnership, shipFromEnvelope, type BranchOwnershipDeps } from "./branch-owners";
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
  });
});

function setup(o: { branches?: Record<string, string>; roots?: Record<string, string> } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  tickets.insert({ key: "T-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const repoId = tickets.addRepo({ ticketKey: "T-1", repoPath: "/repo", workMode: "branch", worktreePath: null, branch: "feature/T-1", createdAt: 1 });
  const prs = new TicketPrsRepo(db);
  const owners = new BranchOwnersRepo(db);
  const linker = new PrLinker({ prs, tickets, slugOf: (p) => (p === "/repo" ? "o/r" : null), now: () => 9 });
  // 实现里的目录都过 resolve（Windows 上是 D:\...）：这里的键也一样。
  const keyed = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [resolve(k), v]));
  const branches = keyed({ "/repo": "feature/T-1", "/wt/a": "feat/a", ...o.branches });
  const roots = keyed({ "/repo": "/repo", "/wt/a": "/repo", ...o.roots });
  const deps = {
    tickets: { get: (k: string) => tickets.get(k) },
    sessionTicket: vi.fn<BranchOwnershipDeps["sessionTicket"]>(() => null),
    currentBranch: vi.fn(async (d: string) => {
      if (!(d in branches)) throw new Error(`not a repo: ${d}`);
      return branches[d];
    }),
    mainRepoRoot: vi.fn(async (d: string) => {
      if (!(d in roots)) throw new Error(`not a repo: ${d}`);
      return roots[d];
    }),
    owners, linker, soon: vi.fn<(repoId: number) => void>(), now: () => 100, log: vi.fn<(msg: string, err?: unknown) => void>(),
  } satisfies BranchOwnershipDeps;
  return { db, tickets, repoId, prs, owners, deps, b: new BranchOwnership(deps) };
}

describe("BranchOwnership", () => {
  it("records the session that pushed a worktree branch (git -C / cd relative to cwd) and asks the watcher to look", async () => {
    const s = setup();
    await s.b.handle(env("cd ../wt/a && git push -u origin HEAD", { cwd: "/repo" }));
    expect(s.owners.get("T-1", s.repoId, "feat/a")).toMatchObject({ sessionId: "b1", dir: resolve("/wt/a"), at: 100 });
    expect(s.deps.soon).toHaveBeenCalledWith(s.repoId);
    await s.b.handle(env("git -C /wt/a push origin feat/a:feat/renamed", { butlerSession: "b2" }));
    expect(s.owners.get("T-1", s.repoId, "feat/renamed")).toMatchObject({ sessionId: "b2" });
  });

  it("links the PR that gh pr create printed, on the branch it was opened from (the missing-link case)", async () => {
    const s = setup();
    await s.b.handle(env("cd /wt/a && gh pr create --fill", { prUrls: ["https://github.com/o/r/pull/34"] }));
    expect(s.owners.get("T-1", s.repoId, "feat/a")).toMatchObject({ sessionId: "b1" });
    expect(s.prs.byTicket("T-1")).toEqual([expect.objectContaining({ number: 34, repoId: s.repoId, headBranch: "feat/a", source: "branch", state: "open" })]);
    // --head 指定的分支，PR 链接不在 ticket 的仓库里：分支照样记，PR 链接上但没有仓库。
    await s.b.handle(env("gh pr create -H me:feat/h", { prUrls: ["https://github.com/x/y/pull/2"] }));
    expect(s.owners.get("T-1", s.repoId, "feat/h")).not.toBeNull();
    expect(s.prs.byTicket("T-1").find((p) => p.number === 2)).toMatchObject({ repoId: null, headBranch: "feat/h" });
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
});
