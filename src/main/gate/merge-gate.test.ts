import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GateAction } from "../../shared/gate-command";
import type { GateRequest } from "../../shared/gate";
import type { MergeEvent, Ticket, TicketRepo, WorkMode } from "../../shared/types";
import { MergeGateRepo } from "../db/merge-gate-repo";
import { M } from "../strings";
import { makeRepo, memDb } from "../test-utils";
import * as git from "../tickets/git";
import type { PrInfo } from "../tickets/gh";
import { MergeGate, type MergeGateDeps } from "./merge-gate";

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
const commitFile = (repo: string, file: string, text: string, msg: string) => {
  writeFileSync(join(repo, file), text);
  run(repo, "add", ".");
  run(repo, "commit", "-m", msg);
};

/** main 上有 app.txt；dms-1、dms-2 改它同一行，dms-3 改别的文件。当前分支 main。 */
function makeScenarioRepo(): string {
  const repo = makeRepo();
  commitFile(repo, "app.txt", "base\n", "app");
  for (const [branch, file, text] of [["dms-1", "app.txt", "one\n"], ["dms-2", "app.txt", "two\n"], ["dms-3", "other.txt", "three\n"]]) {
    run(repo, "checkout", "-q", "-b", branch, "main");
    commitFile(repo, file, text, branch);
  }
  run(repo, "checkout", "-q", "main");
  return repo;
}

function ticket(key: string, repoPath: string, branch: string, workMode: WorkMode = "worktree"): Ticket {
  const r: TicketRepo = { id: 0, ticketKey: key, repoPath, workMode, worktreePath: null, branch, createdAt: 0, worktreeRemovedAt: null, cleanupBlocked: null };
  return { key, title: null, repos: [r], status: "active", statusManual: null, createdAt: 0, archivedAt: null, featureId: null };
}

function setup(o: { tickets?: (repo: string) => Ticket[]; repo?: string; pr?: (pr: string | null) => PrInfo | null; terminals?: Record<string, number>; git?: Partial<MergeGateDeps["git"]>; now?: () => number; deadlineMs?: number } = {}) {
  const repoPath = o.repo ?? makeScenarioRepo();
  const tickets = o.tickets ? o.tickets(repoPath) : ["DMS-1", "DMS-2", "DMS-3"].map((k) => ticket(k, repoPath, k.toLowerCase()));
  const db = memDb();
  const repo = new MergeGateRepo(db);
  const events: MergeEvent[] = [];
  const logs: string[] = [];
  const openTerminals = vi.fn((key: string) => o.terminals?.[key] ?? 0);
  const checkSoon = vi.fn();
  const prInfo = vi.fn(async (_cwd: string, pr: string | null) => (o.pr ? o.pr(pr) : null));
  const gitDeps: MergeGateDeps["git"] = {
    mainRepoRoot: git.mainRepoRoot, mergeConflicts: vi.fn(git.mergeConflicts), isAncestor: git.isAncestor, fetchQuiet: git.fetchQuiet, upstreamRef: git.upstreamRef,
    currentBranch: vi.fn(git.currentBranch), branchExists: git.branchExists, defaultBranch: git.defaultBranch, mergeTreeSupported: git.mergeTreeSupported, ...o.git,
  };
  const gate = new MergeGate({
    tickets: { list: () => tickets, listRepos: (key: string) => tickets.find((t) => t.key === key)?.repos ?? [] },
    repo, openTerminals, git: gitDeps, prInfo, notify: (e) => events.push(e), now: o.now ?? (() => 1000), log: (m) => logs.push(m), deadlineMs: o.deadlineMs,
    whoOf: (t, b) => (t ? `${t}（支付）` : b), checkSoon,
  });
  const ask = (action: GateAction, extra: Partial<Pick<GateRequest, "session" | "ticket" | "cwd" | "phase">> = {}, meta?: { ageMs?: number }) =>
    gate.handle({ v: 1, phase: "pre", action, cwd: repoPath, session: "s-req", ticket: null, ...extra } as GateRequest, meta);
  const merge = (source: string, extra: Parameters<typeof ask>[1] = {}, meta?: { ageMs?: number }) => ask({ kind: "local_merge", dir: null, source }, extra, meta);
  const outcomes = () => db.prepare(`SELECT branch, outcome FROM merge_holds ORDER BY id`).all() as { branch: string; outcome: string | null }[];
  return { repoPath, gate, repo, db, events, logs, openTerminals, checkSoon, prInfo, gitDeps, ask, merge, outcomes };
}

describe("MergeGate: merges", () => {
  it("lets a branch that conflicts with nobody merge, holds it, and records nothing", async () => {
    const t = setup();
    expect(await t.merge("dms-3", { ticket: "DMS-3" })).toEqual({ v: 1, decision: "allow" });
    expect(t.repo.activeHold(t.repoPath, "dms-3")).toMatchObject({ kind: "local", target: "main", ticketKey: "DMS-3", sessionId: "s-req", prUrl: null });
    expect(t.events).toEqual([]);
  });

  it("lets the first of two conflicting branches merge and notes that the other must rebase later", async () => {
    const t = setup();
    expect(await t.merge("dms-1")).toEqual({ v: 1, decision: "allow" });
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({ kind: "proceed_conflict", repoPath: t.repoPath, ticketKey: "DMS-1", branch: "dms-1", otherTicket: "DMS-2", otherBranch: "dms-2", files: ["app.txt"] });
    expect(t.events[0].id).toBeGreaterThan(0);
  });

  it("makes the second one wait while the first still holds the merge", async () => {
    const t = setup();
    await t.merge("dms-1");
    const r = await t.merge("dms-2", { session: "s2" });
    expect(r.decision).toBe("deny");
    const reason = (r as { reason: string }).reason;
    expect(reason).toContain("DMS-1");
    expect(reason).toContain("app.txt");
    expect(reason).toBe(M().gateWait("DMS-1（支付）", ["app.txt"]));
    const hold = t.repo.activeHold(t.repoPath, "dms-1")!;
    expect(t.repo.waitersOf(hold.id)).toEqual([{ id: expect.any(Number), sessionId: "s2", ticketKey: "DMS-2", branch: "dms-2" }]);
    expect(t.events.map((e) => e.kind)).toEqual(["proceed_conflict", "wait"]);
    expect(t.events[1]).toMatchObject({ ticketKey: "DMS-2", branch: "dms-2", otherTicket: "DMS-1", otherBranch: "dms-1", files: ["app.txt"] });
    expect(t.repo.activeHold(t.repoPath, "dms-2")).toBeNull();
  });

  it("tells the later one to rebase once the first is really in main, naming where the conflict came from", async () => {
    const t = setup();
    await t.merge("dms-1");
    run(t.repoPath, "merge", "-q", "dms-1");
    const r = await t.merge("dms-2");
    expect(r).toEqual({ v: 1, decision: "deny", reason: M().gateRebase("DMS-1（支付）", ["app.txt"]) });
    expect(t.events.at(-1)).toMatchObject({ kind: "rebase", ticketKey: "DMS-2", branch: "dms-2", otherTicket: "DMS-1", otherBranch: "dms-1", files: ["app.txt"] });
  });

  it("asks for a rebase without naming anyone when nobody was recorded as going first", async () => {
    const t = setup();
    run(t.repoPath, "merge", "-q", "dms-1");
    const r = await t.merge("dms-2");
    expect(r).toEqual({ v: 1, decision: "deny", reason: M().gateRebase(null, ["app.txt"]) });
    expect(t.events.at(-1)).toMatchObject({ kind: "rebase", otherTicket: null, otherBranch: null });
  });

  it("finds the ticket by the PR's head branch when a feature coordinator merges a PR", async () => {
    const t = setup({ pr: () => ({ number: 7, url: "https://x/pull/7", head: "dms-2", base: "main", state: "OPEN", autoMerge: false }) });
    await t.merge("dms-1");
    const r = await t.ask({ kind: "pr_merge", dir: null, pr: "7" }, { session: "s-coord", ticket: null });
    expect(r.decision).toBe("deny");
    expect((r as { reason: string }).reason).toContain("DMS-1");
    expect(t.prInfo).toHaveBeenCalledWith(t.repoPath, "7", expect.any(Number));
    expect(t.events.at(-1)).toMatchObject({ kind: "wait", ticketKey: "DMS-2", branch: "dms-2" });
  });

  it("holds an allowed PR merge as a pr hold with its URL", async () => {
    const t = setup({ pr: () => ({ number: 8, url: "https://x/pull/8", head: "dms-3", base: "main", state: "OPEN", autoMerge: false }) });
    expect(await t.ask({ kind: "pr_merge", dir: null, pr: null })).toEqual({ v: 1, decision: "allow" });
    expect(t.repo.activeHold(t.repoPath, "dms-3")).toMatchObject({ kind: "pr", prUrl: "https://x/pull/8", target: "main", ticketKey: "DMS-3" });
  });

  it("makes a branch that belongs to no ticket wait for a conflicting held one", async () => {
    const t = setup();
    run(t.repoPath, "checkout", "-q", "-b", "hotfix", "main");
    commitFile(t.repoPath, "app.txt", "hot\n", "hotfix");
    run(t.repoPath, "checkout", "-q", "main");
    await t.merge("dms-1");
    const r = await t.merge("hotfix");
    expect(r.decision).toBe("deny");
    expect((r as { reason: string }).reason).toContain("DMS-1");
    expect(t.events.at(-1)).toMatchObject({ kind: "wait", ticketKey: null, branch: "hotfix" });
  });

  it("turns the branch's local hold (e.g. left by a rejected push) into a PR hold when its PR is merged, keeping the waiters", async () => {
    const t = setup({ pr: () => ({ number: 8, url: "https://x/pull/8", head: "dms-1", base: "main", state: "OPEN", autoMerge: false }), now: () => 5000 });
    await t.merge("dms-1", { session: "s1" });
    await t.merge("dms-2", { session: "s2" });
    const local = t.repo.activeHold(t.repoPath, "dms-1")!;
    expect(local.kind).toBe("local");
    expect(await t.ask({ kind: "pr_merge", dir: null, pr: "8" }, { session: "s-coord" })).toEqual({ v: 1, decision: "allow" });
    expect(t.repo.activeHolds()).toHaveLength(1);
    expect(t.repo.activeHold(t.repoPath, "dms-1")).toMatchObject({ id: local.id, kind: "pr", prUrl: "https://x/pull/8", target: "main", sessionId: "s-coord", ticketKey: "DMS-1", createdAt: 5000 });
    expect(t.repo.waitersOf(local.id).map((w) => w.sessionId)).toEqual(["s2"]);
  });

  it("allows a PR merge it can't look up, and records nothing", async () => {
    const t = setup({ pr: () => null });
    expect(await t.ask({ kind: "pr_merge", dir: null, pr: "9" })).toEqual({ v: 1, decision: "allow" });
    expect(t.events).toEqual([]);
    expect(t.repo.activeHolds()).toEqual([]);
  });

  it("does not add a second hold for the same branch", async () => {
    const t = setup();
    await t.merge("dms-3");
    await t.merge("dms-3");
    expect(t.repo.activeHolds()).toHaveLength(1);
  });

  it("does not check a merge of main into a ticket's own branch (updating the branch is not merging into a target)", async () => {
    const t = setup();
    run(t.repoPath, "checkout", "-q", "dms-2");
    expect(await t.merge("main", { ticket: "DMS-2" })).toEqual({ v: 1, decision: "allow" });
    expect(t.gitDeps.mergeConflicts).not.toHaveBeenCalled();
    expect(t.repo.activeHolds()).toEqual([]);
  });

  it("leaves alone a merge that brings nothing new into the target (e.g. `git merge origin/main` on main)", async () => {
    const t = setup();
    await t.merge("dms-1");
    run(t.repoPath, "update-ref", "refs/remotes/origin/main", "main");
    expect(await t.merge("origin/main")).toEqual({ v: 1, decision: "allow" });
    expect(t.events.map((e) => e.kind)).toEqual(["proceed_conflict"]);
    expect(t.repo.activeHold(t.repoPath, "origin/main")).toBeNull();
  });

  it("resolves a relative -C directory against the request's cwd", async () => {
    const t = setup();
    const r = await t.gate.handle({ v: 1, phase: "pre", action: { kind: "local_merge", dir: "./", source: "dms-3" }, cwd: t.repoPath, session: null, ticket: null });
    expect(r).toEqual({ v: 1, decision: "allow" });
    expect(t.repo.activeHold(t.repoPath, "dms-3")).not.toBeNull();
  });

  it("fails open and logs when the conflict check throws", async () => {
    const t = setup({ git: { mergeConflicts: vi.fn(async () => { throw new Error("boom"); }) } });
    expect(await t.merge("dms-1")).toEqual({ v: 1, decision: "allow" });
    expect(t.logs.length).toBeGreaterThan(0);
    expect(t.events).toEqual([]);
  });
});

describe("MergeGate: pushes", () => {
  it("does not check a push to a branch that is neither the default branch nor a PR base", async () => {
    const t = setup({ pr: () => null });
    expect(await t.ask({ kind: "push", dir: null, target: "scratch" })).toEqual({ v: 1, decision: "allow" });
    expect(t.gitDeps.mergeConflicts).not.toHaveBeenCalled();
    expect(t.repo.activeHolds()).toEqual([]);
  });

  it("reads a HEAD push as a push of the current branch and leaves it alone", async () => {
    const t = setup({ pr: () => null });
    run(t.repoPath, "checkout", "-q", "dms-2");
    expect(await t.ask({ kind: "push", dir: null, target: "HEAD" })).toEqual({ v: 1, decision: "allow" });
    expect(t.gitDeps.mergeConflicts).not.toHaveBeenCalled();
  });

  it("checks a push straight to the default branch, from the current branch", async () => {
    const t = setup();
    await t.merge("dms-1");
    run(t.repoPath, "checkout", "-q", "dms-2");
    const r = await t.ask({ kind: "push", dir: null, target: "main" });
    expect(r.decision).toBe("deny");
    expect(t.events.at(-1)).toMatchObject({ kind: "wait", ticketKey: "DMS-2", branch: "dms-2" });
  });

  it("leaves alone a push of the target branch itself (its merges were already checked), and the later rebase still names the first ticket", async () => {
    const t = setup();
    run(t.repoPath, "update-ref", "refs/remotes/origin/main", "main");
    await t.merge("dms-1");
    run(t.repoPath, "merge", "-q", "dms-1");
    await t.merge("dms-1", { phase: "post" });
    // 本地 main 已经含 dms-1，origin/main 还没有：这次 push 才把它推上去。
    expect(await t.ask({ kind: "push", dir: null, target: "main" })).toEqual({ v: 1, decision: "allow" });
    expect(await t.ask({ kind: "push", dir: null, target: "HEAD" })).toEqual({ v: 1, decision: "allow" });
    run(t.repoPath, "update-ref", "refs/remotes/origin/main", "main");
    expect(t.events.map((e) => e.kind)).toEqual(["proceed_conflict"]);
    expect(t.repo.activeHold(t.repoPath, "main")).toBeNull();
    expect(await t.merge("dms-2")).toEqual({ v: 1, decision: "deny", reason: M().gateRebase("DMS-1（支付）", ["app.txt"]) });
  });

  it("checks the source of an explicit src:dst push, not the current branch", async () => {
    const t = setup();
    await t.merge("dms-1");
    // 在 main 上 git push origin dms-2:main：合进 main 的是 dms-2。
    const r = await t.ask({ kind: "push", dir: null, target: "main", source: "dms-2" }, { session: "s2" });
    expect(r.decision).toBe("deny");
    expect(t.events.at(-1)).toMatchObject({ kind: "wait", ticketKey: "DMS-2", branch: "dms-2", otherBranch: "dms-1" });
    // HEAD:main 是当前分支。
    run(t.repoPath, "checkout", "-q", "dms-3");
    expect(await t.ask({ kind: "push", dir: null, target: "main", source: "HEAD" })).toEqual({ v: 1, decision: "allow" });
    expect(t.repo.activeHold(t.repoPath, "dms-3")).toMatchObject({ kind: "local", target: "main" });
  });

  it("releases the hold of an explicit src:dst push after it ran", async () => {
    const t = setup();
    expect(await t.ask({ kind: "push", dir: null, target: "main", source: "dms-3" })).toEqual({ v: 1, decision: "allow" });
    expect(t.repo.activeHold(t.repoPath, "dms-3")).not.toBeNull();
    run(t.repoPath, "update-ref", "refs/remotes/origin/main", "dms-3");
    await t.ask({ kind: "push", dir: null, target: "main", source: "dms-3" }, { phase: "post" });
    expect(t.outcomes()).toEqual([{ branch: "dms-3", outcome: "merged" }]);
  });

  it("checks a push to a branch that a ticket's PR targets", async () => {
    const t = setup({ pr: (pr) => (pr === "dms-1" ? { number: 1, url: "https://x/pull/1", head: "dms-1", base: "develop", state: "OPEN", autoMerge: false } : null) });
    run(t.repoPath, "branch", "develop", "main");
    run(t.repoPath, "checkout", "-q", "dms-3");
    expect(await t.ask({ kind: "push", dir: null, target: "develop" })).toEqual({ v: 1, decision: "allow" });
    expect(t.gitDeps.mergeConflicts).toHaveBeenCalled();
    expect(t.repo.activeHold(t.repoPath, "dms-3")).toMatchObject({ kind: "local", target: "develop" });
  });
});

describe("MergeGate: after the command ran", () => {
  it("releases a local hold as merged when the branch is now in the target, and asks for a check soon", async () => {
    const t = setup();
    await t.merge("dms-3");
    run(t.repoPath, "merge", "-q", "dms-3");
    expect(await t.merge("dms-3", { phase: "post" })).toEqual({ v: 1, decision: "allow" });
    expect(t.outcomes()).toEqual([{ branch: "dms-3", outcome: "merged" }]);
    expect(t.checkSoon).toHaveBeenCalled();
  });

  it("releases a local hold as cancelled when the merge did not happen", async () => {
    const t = setup();
    await t.merge("dms-3");
    expect(await t.merge("dms-3", { phase: "post" })).toEqual({ v: 1, decision: "allow" });
    expect(t.outcomes()).toEqual([{ branch: "dms-3", outcome: "cancelled" }]);
  });

  it("leaves a PR hold for the watcher", async () => {
    const t = setup({ pr: () => ({ number: 8, url: "https://x/pull/8", head: "dms-3", base: "main", state: "OPEN", autoMerge: true }) });
    await t.ask({ kind: "pr_merge", dir: null, pr: "8" });
    expect(await t.ask({ kind: "pr_merge", dir: null, pr: "8" }, { phase: "post" })).toEqual({ v: 1, decision: "allow" });
    expect(t.outcomes()).toEqual([{ branch: "dms-3", outcome: null }]);
    expect(t.checkSoon).toHaveBeenCalled();
  });
});

describe("MergeGate: switching branches in a shared directory", () => {
  /** DMS-4、DMS-5 都用 branch 方式共用同一个目录，目录在 dms-4 上。 */
  function shared(o: { terminals?: Record<string, number>; mode5?: WorkMode } = {}) {
    const repo = makeScenarioRepo();
    run(repo, "branch", "dms-5", "main");
    run(repo, "checkout", "-q", "-b", "dms-4", "main");
    return setup({ repo, terminals: o.terminals, tickets: (r) => [ticket("DMS-4", r, "dms-4", "branch"), ticket("DMS-5", r, "dms-5", o.mode5 ?? "branch")] });
  }
  const sw = (branch: string, create = false): GateAction => ({ kind: "switch", dir: null, branch, create });

  it("stops a switch while another ticket with an open session uses the directory", async () => {
    const t = shared({ terminals: { "DMS-4": 1 } });
    const r = await t.ask(sw("dms-5"), { ticket: "DMS-5", session: "s5" });
    expect(r).toEqual({ v: 1, decision: "deny", reason: M().gateDirBusy("DMS-4（支付）", "dms-4") });
    expect(t.events).toEqual([expect.objectContaining({ kind: "dir_busy", ticketKey: "DMS-5", otherTicket: "DMS-4", otherBranch: "dms-4", files: [] })]);
  });

  it("stops creating a new branch there too", async () => {
    const t = shared({ terminals: { "DMS-4": 1 } });
    expect((await t.ask(sw("dms-5-b", true), { ticket: "DMS-5" })).decision).toBe("deny");
  });

  it("allows the switch when that ticket has no open terminal", async () => {
    const t = shared();
    expect(await t.ask(sw("dms-5"), { ticket: "DMS-5" })).toEqual({ v: 1, decision: "allow" });
    expect(t.events).toEqual([]);
  });

  it("does not look when the switching ticket works in its own worktree", async () => {
    const t = shared({ terminals: { "DMS-4": 1 }, mode5: "worktree" });
    expect(await t.ask(sw("dms-5"), { ticket: "DMS-5" })).toEqual({ v: 1, decision: "allow" });
    expect(t.openTerminals).not.toHaveBeenCalled();
  });

  it("treats `git checkout <file>` (no such branch) as not a switch", async () => {
    const t = shared({ terminals: { "DMS-4": 1 } });
    expect(await t.ask(sw("app.txt"), { ticket: "DMS-5" })).toEqual({ v: 1, decision: "allow" });
  });

  it("does not look for a session that belongs to no ticket", async () => {
    const t = shared({ terminals: { "DMS-4": 1 } });
    expect(await t.ask(sw("dms-5"), { ticket: null })).toEqual({ v: 1, decision: "allow" });
  });

  it("dirBusy reports the other ticket only while the directory is on its branch", async () => {
    const t = shared({ terminals: { "DMS-4": 1 } });
    const mine = ticket("DMS-5", t.repoPath, "dms-5", "branch").repos[0];
    expect(await t.gate.dirBusy(mine)).toEqual({ ticket: "DMS-4", branch: "dms-4" });
    run(t.repoPath, "checkout", "-q", "main");
    expect(await t.gate.dirBusy(mine)).toBeNull();
  });
});

describe("MergeGate: deadline", () => {
  const rows = (t: ReturnType<typeof setup>) => ({
    holds: t.db.prepare(`SELECT COUNT(*) AS n FROM merge_holds`).get() as { n: number },
    waiters: t.db.prepare(`SELECT COUNT(*) AS n FROM merge_waiters`).get() as { n: number },
    events: t.db.prepare(`SELECT COUNT(*) AS n FROM merge_events`).get() as { n: number },
  });
  const none = { holds: { n: 0 }, waiters: { n: 0 }, events: { n: 0 } };

  it("allows and writes nothing once the checks ran past the deadline", async () => {
    let clock = 1000;
    const t = setup({ now: () => clock, git: { mergeConflicts: async (r, a, b) => { clock += 5000; return git.mergeConflicts(r, a, b); } } });
    expect(await t.merge("dms-1")).toEqual({ v: 1, decision: "allow" });
    expect(rows(t)).toEqual(none);
    expect(t.events).toEqual([]);
  });

  it("does not record a wait the hook stopped waiting for", async () => {
    let clock = 1000;
    let slow = false;
    const t = setup({ now: () => clock, git: { mergeConflicts: async (r, a, b) => { if (slow) clock += 5000; return git.mergeConflicts(r, a, b); } } });
    await t.merge("dms-2");
    const before = rows(t);
    slow = true;
    expect(await t.merge("dms-1")).toEqual({ v: 1, decision: "allow" });
    expect(rows(t)).toEqual(before);
  });

  it("allows at once and writes nothing when the request already waited past the deadline in the queue", async () => {
    const t = setup();
    await t.merge("dms-2");
    const before = rows(t);
    const events = t.events.length;
    const checks = vi.mocked(t.gitDeps.mergeConflicts).mock.calls.length;
    expect(await t.merge("dms-1", {}, { ageMs: 4000 })).toEqual({ v: 1, decision: "allow" });
    expect(vi.mocked(t.gitDeps.mergeConflicts).mock.calls.length).toBe(checks);
    expect(rows(t)).toEqual(before);
    expect(t.events).toHaveLength(events);
    expect(t.logs.some((l) => l.includes("waited 4000 ms"))).toBe(true);
  });

  it("counts the time spent in the queue toward the deadline", async () => {
    let clock = 1000;
    // 每次裁决的第一次 merge-tree 用掉 600 毫秒。
    let first = true;
    const step = { git: { mergeConflicts: async (r: string, a: string, b: string) => { if (first) clock += 600; first = false; return git.mergeConflicts(r, a, b); } } };
    // 排队 3.5 秒 + 一步 600 毫秒 > 4 秒：算晚了，放行、不记。
    const late = setup({ now: () => clock, ...step });
    expect(await late.merge("dms-3", {}, { ageMs: 3500 })).toEqual({ v: 1, decision: "allow" });
    expect(rows(late)).toEqual(none);
    // 排队 3 秒 + 600 毫秒还在期限内：照常占位。
    const inTime = setup({ now: () => clock, ...step });
    first = true;
    await inTime.merge("dms-3", {}, { ageMs: 3000 });
    expect(rows(inTime).holds).toEqual({ n: 1 });
  });

  it("still releases a hold on a post request that waited in the queue", async () => {
    const t = setup();
    await t.merge("dms-3");
    run(t.repoPath, "merge", "-q", "dms-3");
    expect(await t.merge("dms-3", { phase: "post" }, { ageMs: 10_000 })).toEqual({ v: 1, decision: "allow" });
    expect(t.outcomes()).toEqual([{ branch: "dms-3", outcome: "merged" }]);
  });

  it("answers allow when a step hangs, and writes nothing when it finishes later", async () => {
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => (release = r));
    const t = setup({ deadlineMs: 50, git: { mergeConflicts: async (r, a, b) => { await gateOpen; return git.mergeConflicts(r, a, b); } } });
    const started = Date.now();
    expect(await t.merge("dms-1")).toEqual({ v: 1, decision: "allow" });
    expect(Date.now() - started).toBeLessThan(2000);
    release();
    await new Promise((r) => setTimeout(r, 300));
    expect(rows(t)).toEqual(none);
    expect(t.events).toEqual([]);
  });
});
