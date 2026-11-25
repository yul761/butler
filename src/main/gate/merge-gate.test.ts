import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GateAction } from "../../shared/gate-command";
import type { GateRequest } from "../../shared/gate";
import type { MergeEvent, Ticket, TicketRepo, WorkMode } from "../../shared/types";
import { MergeGateRepo } from "../db/merge-gate-repo";
import { M } from "../strings";
import { copyRepo, makeRepo, memDb, tempDir } from "../test-utils";
import * as git from "../tickets/git";
import type { PrInfo } from "../tickets/gh";
import { CHECK_RETRY_WINDOW_MS, commandDir, findRepoBySlug, MergeGate, prLink, type MergeGateDeps } from "./merge-gate";

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
const commitFile = (repo: string, file: string, text: string, msg: string) => {
  writeFileSync(join(repo, file), text);
  run(repo, "add", ".");
  run(repo, "commit", "-m", msg);
};

let scenarioTemplate: string | null = null;

/**
 * main 上有 app.txt；dms-1、dms-2 改它同一行，dms-3 改别的文件。当前分支 main。
 * 每个测试文件只真的建一次（十几个 git 进程），之后复制（copyRepo）：Windows runner 上这些进程会把用例
 * 推到 30 秒超时（BTL-240）。
 */
function makeScenarioRepo(): string {
  if (scenarioTemplate === null) {
    const repo = makeRepo();
    commitFile(repo, "app.txt", "base\n", "app");
    for (const [branch, file, text] of [["dms-1", "app.txt", "one\n"], ["dms-2", "app.txt", "two\n"], ["dms-3", "other.txt", "three\n"]]) {
      run(repo, "checkout", "-q", "-b", branch, "main");
      commitFile(repo, file, text, branch);
    }
    run(repo, "checkout", "-q", "main");
    scenarioTemplate = repo;
  }
  return copyRepo(scenarioTemplate);
}

function ticket(key: string, repoPath: string, branch: string, workMode: WorkMode = "worktree"): Ticket {
  const r: TicketRepo = { id: 0, ticketKey: key, repoPath, workMode, worktreePath: null, branch, createdAt: 0, worktreeRemovedAt: null, cleanupBlocked: null };
  return { key, title: null, repos: [r], status: "active", statusManual: null, createdAt: 0, archivedAt: null, featureId: null };
}

/**
 * 测试默认的裁决期限。生产的 4 秒（GATE_DEADLINE_MS）是真实计时器：慢的 Windows runner 上，一次裁决里真实的 git
 * 子进程就可能跑满 4 秒，计时器先触发，裁决变成"放行、不记"，任何一个用例都可能偶尔挂（PR #20 的 CI 42407535184）。
 * 不测期限的用例用 60 秒，结果只由裁决逻辑决定；测期限的用例用假时钟跨过它，或者自己传 deadlineMs。
 */
const TEST_DEADLINE_MS = 60_000;

function setup(o: { tickets?: (repo: string) => Ticket[]; repo?: string; pr?: (pr: string | null) => PrInfo | null; terminals?: Record<string, number>; git?: Partial<MergeGateDeps["git"]>; now?: () => number; deadlineMs?: number; repoOfSlug?: MergeGateDeps["repoOfSlug"] } = {}) {
  const repoPath = o.repo ?? makeScenarioRepo();
  const tickets = o.tickets ? o.tickets(repoPath) : ["DMS-1", "DMS-2", "DMS-3"].map((k) => ticket(k, repoPath, k.toLowerCase()));
  const db = memDb();
  const repo = new MergeGateRepo(db);
  const events: MergeEvent[] = [];
  const logs: string[] = [];
  const openTerminals = vi.fn((key: string) => o.terminals?.[key] ?? 0);
  const checkSoon = vi.fn();
  const onPrHold = vi.fn();
  const prInfo = vi.fn(async (_cwd: string, pr: string | null) => (o.pr ? o.pr(pr) : null));
  const gitDeps: MergeGateDeps["git"] = {
    mainRepoRoot: git.mainRepoRoot, mergeConflicts: vi.fn(git.mergeConflicts), isAncestor: git.isAncestor, fetchQuiet: git.fetchQuiet, upstreamRef: git.upstreamRef,
    currentBranch: vi.fn(git.currentBranch), branchExists: git.branchExists, defaultBranch: git.defaultBranch, mergeTreeSupported: git.mergeTreeSupported, ...o.git,
  };
  const gate = new MergeGate({
    tickets: { list: () => tickets, listRepos: (key: string) => tickets.find((t) => t.key === key)?.repos ?? [] },
    repo, openTerminals, git: gitDeps, prInfo, notify: (e) => events.push(e), now: o.now ?? (() => 1000), log: (m) => logs.push(m), deadlineMs: o.deadlineMs ?? TEST_DEADLINE_MS,
    whoOf: (t, b) => (t ? `${t}（支付）` : b), checkSoon, onPrHold, repoOfSlug: o.repoOfSlug,
  });
  const ask = (action: GateAction, extra: Partial<Pick<GateRequest, "session" | "ticket" | "cwd" | "phase">> = {}, meta?: { ageMs?: number }) =>
    gate.handle({ v: 1, phase: "pre", action, cwd: repoPath, session: "s-req", ticket: null, ...extra } as GateRequest, meta);
  const merge = (source: string, extra: Parameters<typeof ask>[1] = {}, meta?: { ageMs?: number }) => ask({ kind: "local_merge", dir: null, source }, extra, meta);
  const outcomes = () => db.prepare(`SELECT branch, outcome FROM merge_holds ORDER BY id`).all() as { branch: string; outcome: string | null }[];
  return { repoPath, gate, repo, db, events, logs, openTerminals, checkSoon, onPrHold, prInfo, gitDeps, ask, merge, outcomes };
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
    const r = await t.ask({ kind: "pr_merge", dir: null, pr: "7", repo: null }, { session: "s-coord", ticket: null });
    expect(r.decision).toBe("deny");
    expect((r as { reason: string }).reason).toContain("DMS-1");
    expect(t.prInfo).toHaveBeenCalledWith(t.repoPath, "7", expect.any(Number));
    expect(t.events.at(-1)).toMatchObject({ kind: "wait", ticketKey: "DMS-2", branch: "dms-2" });
  });

  it("holds an allowed PR merge as a pr hold with its URL", async () => {
    const t = setup({ pr: () => ({ number: 8, url: "https://x/pull/8", head: "dms-3", base: "main", state: "OPEN", autoMerge: false }) });
    expect(await t.ask({ kind: "pr_merge", dir: null, pr: null, repo: null })).toEqual({ v: 1, decision: "allow" });
    expect(t.repo.activeHold(t.repoPath, "dms-3")).toMatchObject({ kind: "pr", prUrl: "https://x/pull/8", target: "main", ticketKey: "DMS-3" });
  });

  it("a PR hold calls onPrHold; a local hold does not", async () => {
    const t = setup({ pr: () => ({ number: 8, url: "https://x/pull/8", head: "dms-3", base: "main", state: "OPEN", autoMerge: false }) });
    await t.ask({ kind: "pr_merge", dir: null, pr: null, repo: null });
    expect(t.onPrHold).toHaveBeenCalledTimes(1);
    expect(t.onPrHold).toHaveBeenCalledWith(t.repo.activeHold(t.repoPath, "dms-3")!.id);
    const local = setup();
    await local.merge("dms-1");
    expect(local.onPrHold).not.toHaveBeenCalled();
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
    expect(await t.ask({ kind: "pr_merge", dir: null, pr: "8", repo: null }, { session: "s-coord" })).toEqual({ v: 1, decision: "allow" });
    expect(t.repo.activeHolds()).toHaveLength(1);
    expect(t.repo.activeHold(t.repoPath, "dms-1")).toMatchObject({ id: local.id, kind: "pr", prUrl: "https://x/pull/8", target: "main", sessionId: "s-coord", ticketKey: "DMS-1", createdAt: 5000 });
    expect(t.repo.waitersOf(local.id).map((w) => w.sessionId)).toEqual(["s2"]);
    expect(t.onPrHold).toHaveBeenCalledTimes(1);
    expect(t.onPrHold).toHaveBeenCalledWith(local.id);
  });

  it("lets a branch that already holds the merge try again without waiting for anyone or recording it twice", async () => {
    const t = setup();
    await t.merge("dms-1", { session: "s1" });
    expect(t.events.map((e) => e.kind)).toEqual(["proceed_conflict"]);
    // dms-2 也占着（比如它先拿到许可后 dms-1 才改到同一行）：dms-1 再试不能反过来等 dms-2。
    t.repo.addHold({ repoPath: t.repoPath, branch: "dms-2", target: "main", kind: "local", prUrl: null, sessionId: "s2", ticketKey: "DMS-2", createdAt: 1000 });
    expect(await t.merge("dms-1", { session: "s1" })).toEqual({ v: 1, decision: "allow" });
    expect(t.events.map((e) => e.kind)).toEqual(["proceed_conflict"]);
    expect(t.repo.waitersOf(t.repo.activeHold(t.repoPath, "dms-2")!.id)).toEqual([]);
    expect(t.repo.activeHolds()).toHaveLength(2);
  });

  it("checks a PR's head as GitHub has it (origin/<head>), e.g. after \"Update branch\" on GitHub", async () => {
    const t = setup({ pr: () => ({ number: 9, url: "https://x/pull/9", head: "dms-2", base: "main", state: "OPEN", autoMerge: false }) });
    run(t.repoPath, "merge", "-q", "dms-1");
    // GitHub 上的 dms-2 已经合过最新的 main、解决了冲突；本地的 dms-2 还是旧的。
    run(t.repoPath, "checkout", "-q", "-b", "updated", "dms-2");
    run(t.repoPath, "merge", "-q", "-s", "ours", "main", "-m", "update branch");
    run(t.repoPath, "update-ref", "refs/remotes/origin/dms-2", "updated");
    run(t.repoPath, "checkout", "-q", "main");
    expect(await t.ask({ kind: "pr_merge", dir: null, pr: "9", repo: null })).toEqual({ v: 1, decision: "allow" });
    expect(t.repo.activeHold(t.repoPath, "dms-2")).toMatchObject({ kind: "pr", prUrl: "https://x/pull/9" });
    // 没有 origin/<head> 就用本地的：本地的 dms-2 和 main 冲突。
    const u = setup({ pr: () => ({ number: 9, url: "https://x/pull/9", head: "dms-2", base: "main", state: "OPEN", autoMerge: false }) });
    run(u.repoPath, "merge", "-q", "dms-1");
    expect((await u.ask({ kind: "pr_merge", dir: null, pr: "9", repo: null })).decision).toBe("deny");
  });

  it("denies a PR merge it can't look up once, allows the retry, and records nothing (BTL-267)", async () => {
    const t = setup({ pr: () => null });
    const first = await t.ask({ kind: "pr_merge", dir: null, pr: "9", repo: null });
    expect(first.decision).toBe("deny");
    expect((first as { reason: string }).reason).toContain("couldn't read the PR 9");
    expect(await t.ask({ kind: "pr_merge", dir: null, pr: "9", repo: null })).toEqual({ v: 1, decision: "allow" });
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

  it("denies once when the check throws, checks a retry again and lets it through if it throws again (BTL-267)", async () => {
    let now = 1000;
    const mergeConflicts = vi.fn(async (): Promise<string[]> => {
      throw new Error("boom\nsecond line");
    });
    const t = setup({ git: { mergeConflicts }, now: () => now });
    expect(await t.merge("dms-1")).toEqual({ v: 1, decision: "deny", reason: M().gateCheckFailed("boom") });
    expect(t.logs.at(-1)).toContain("denying once");
    expect(t.events).toEqual([]);
    expect(t.repo.activeHold(t.repoPath, "dms-1")).toBeNull();
    // 别的 session 跑同一条命令不算重试。
    expect((await t.merge("dms-1", { session: "s-other" })).decision).toBe("deny");
    now += 60_000;
    expect(await t.merge("dms-1")).toEqual({ v: 1, decision: "allow" });
    expect(mergeConflicts).toHaveBeenCalledTimes(3); // 重试也真的再查了一次
    expect(t.logs.at(-1)).toContain("allowing it unchecked");
    // 放行过一次之后，下一次又从拦一次开始。
    expect((await t.merge("dms-1")).decision).toBe("deny");
  });

  it("a retry after the window is denied again; a retry whose check works is judged normally (BTL-267)", async () => {
    let now = 1000;
    let fail = true;
    const t = setup({ now: () => now, git: { mergeConflicts: vi.fn(async (repo: string, a: string, b: string) => {
      if (fail) throw new Error("boom");
      return git.mergeConflicts(repo, a, b);
    }) } });
    expect((await t.merge("dms-3")).decision).toBe("deny");
    now += CHECK_RETRY_WINDOW_MS + 1;
    expect((await t.merge("dms-3")).decision).toBe("deny");
    fail = false;
    expect(await t.merge("dms-3")).toEqual({ v: 1, decision: "allow" });
    expect(t.repo.activeHold(t.repoPath, "dms-3")).not.toBeNull(); // 这次真查过：占了位
  });

  it("lets a merge in a directory that does not exist through: the command can't run there (BTL-267)", async () => {
    const t = setup();
    const gone = join(t.repoPath, "removed-worktree");
    expect(await t.ask({ kind: "local_merge", dir: gone, source: "dms-1" })).toEqual({ v: 1, decision: "allow" });
    expect(await t.ask({ kind: "local_merge", dir: null, source: "dms-1" }, { cwd: gone })).toEqual({ v: 1, decision: "allow" });
    expect(t.logs.at(-1)).toMatch(/not checking local_merge: .*does not exist/);
  });

  it("lets a merge outside any git repository through (BTL-267)", async () => {
    const t = setup();
    const plain = tempDir("shipherd-not-a-repo-");
    expect(await t.ask({ kind: "local_merge", dir: null, source: "dms-1" }, { cwd: plain })).toEqual({ v: 1, decision: "allow" });
    expect(await t.ask({ kind: "pr_merge", dir: null, pr: "7", repo: null }, { cwd: plain })).toEqual({ v: 1, decision: "allow" });
    expect(t.logs.at(-1)).toMatch(/not checking pr_merge: .*not in a git repository/);
    expect(t.prInfo).not.toHaveBeenCalled();
  });

  it("denies once when the command's directory is a shell variable it can't see (BTL-267)", async () => {
    const t = setup();
    const r = await t.ask({ kind: "local_merge", dir: "$WT", source: "dms-1" });
    expect(r.decision).toBe("deny");
    expect((r as { reason: string }).reason).toContain("$WT");
  });

  it("doesn't stop commands that don't depend on the shell-variable directory (BTL-267)", async () => {
    const t = setup({ pr: (pr) => (pr === "https://github.com/org/dems/pull/7" ? { number: 7, url: pr, head: "dms-3", base: "main", state: "OPEN" as const, autoMerge: false } : null), repoOfSlug: () => ({ path: t.repoPath, remote: "origin" }) });
    // 推自己的分支到同名的远端分支。
    expect(await t.ask({ kind: "push", dir: "$WT", target: "feature/x", source: "feature/x" })).toEqual({ v: 1, decision: "allow" });
    // 没有 ticket（或 ticket 不是 branch 方式）的切换。
    expect(await t.ask({ kind: "switch", dir: "$WT", branch: "foo", create: true })).toEqual({ v: 1, decision: "allow" });
    // 写了 -R 和 PR 号的 gh pr merge 不看目录。
    expect(await t.ask({ kind: "pr_merge", dir: "$FEAT", pr: "7", repo: "org/dems" })).toEqual({ v: 1, decision: "allow" });
    expect(t.repo.activeHold(t.repoPath, "dms-3")).toMatchObject({ kind: "pr", target: "main" });
  });

  it("denies a switch in a shell-variable directory once for a branch-mode ticket, with a switch message (BTL-267)", async () => {
    const t = setup({ tickets: (repo) => [ticket("DMS-1", repo, "dms-1", "branch")] });
    const r = await t.ask({ kind: "switch", dir: "$WT", branch: "foo", create: true }, { ticket: "DMS-1" });
    expect(r.decision).toBe("deny");
    expect((r as { reason: string }).reason).toBe(M().gateSwitchCheckFailed("the directory $WT in the command uses a shell variable or substitution"));
  });

  it("denies once when the PR or the repository of gh pr merge is a shell variable (BTL-267)", async () => {
    const t = setup({ repoOfSlug: () => ({ path: t.repoPath, remote: "origin" }) });
    for (const a of [{ pr: "$PR", repo: "org/dems" }, { pr: "7", repo: "$REPO" }]) {
      const r = await t.ask({ kind: "pr_merge", dir: null, ...a }, { cwd: tempDir("shipherd-feature-") });
      expect(r.decision, JSON.stringify(a)).toBe("deny");
    }
    expect(t.prInfo).not.toHaveBeenCalled();
  });
});

describe("MergeGate: gh pr merge -R from a coordinator's feature directory (BTL-267)", () => {
  const prOf = (pr: string | null) => (pr === "https://github.com/org/dems/pull/7" ? { number: 7, url: pr, head: "dms-2", base: "main", state: "OPEN" as const, autoMerge: false } : null);

  it("finds the repository by its slug and checks the PR there, though the cwd is not a git repository", async () => {
    const feature = tempDir("shipherd-feature-");
    const t = setup({ pr: prOf, repoOfSlug: (slug) => (slug === "org/dems" ? { path: t.repoPath, remote: "origin" } : null) });
    await t.merge("dms-1");
    const r = await t.ask({ kind: "pr_merge", dir: null, pr: "7", repo: "org/dems" }, { session: "s-coord", cwd: feature });
    expect(r.decision).toBe("deny");
    expect((r as { reason: string }).reason).toContain("DMS-1");
    // PR 号换成链接，在找到的仓库里查：不在 cwd 里查同号的 PR。
    expect(t.prInfo).toHaveBeenCalledWith(t.repoPath, "https://github.com/org/dems/pull/7", expect.any(Number));
    expect(t.events.at(-1)).toMatchObject({ kind: "wait", ticketKey: "DMS-2", branch: "dms-2", repoPath: t.repoPath });
  });

  it("also works with a PR link and a cwd that no longer exists", async () => {
    const t = setup({ pr: prOf, repoOfSlug: () => ({ path: t.repoPath, remote: "origin" }) });
    const r = await t.ask({ kind: "pr_merge", dir: null, pr: "https://github.com/org/dems/pull/7", repo: "org/dems" }, { cwd: join(t.repoPath, "gone") });
    expect(r).toEqual({ v: 1, decision: "allow" });
    expect(t.repo.activeHold(t.repoPath, "dms-2")).toMatchObject({ kind: "pr", target: "main" });
  });

  it("checks against the remote -R selected: upstream's main, not the fork's (BTL-267 review)", async () => {
    const prOf3 = (pr: string | null) => (pr === "https://github.com/up/dems/pull/7" ? { number: 7, url: pr, head: "dms-3", base: "main", state: "OPEN" as const, autoMerge: false } : null);
    const t = setup({ pr: prOf3, repoOfSlug: (slug) => (slug === "up/dems" ? { path: t.repoPath, remote: "upstream" } : null) });
    // upstream 的 main 已经改了 dms-3 改的文件；本地 main（fork）还没有。
    const up = copyRepo(t.repoPath, "shipherd-upstream-");
    commitFile(up, "other.txt", "upstream\n", "upstream change");
    run(t.repoPath, "remote", "add", "upstream", up);
    const r = await t.ask({ kind: "pr_merge", dir: null, pr: "7", repo: "up/dems" }, { cwd: tempDir("shipherd-feature-") });
    expect(r.decision).toBe("deny");
    expect((r as { reason: string }).reason).toContain("other.txt");
    expect(t.events.at(-1)).toMatchObject({ kind: "rebase", branch: "dms-3", files: ["other.txt"] });
    // 同一个 PR 按 origin 算（本地 main）合得进去。
    const o = setup({ repo: t.repoPath, pr: prOf3, repoOfSlug: () => ({ path: t.repoPath, remote: "origin" }) });
    expect(await o.ask({ kind: "pr_merge", dir: null, pr: "7", repo: "up/dems" }, { cwd: tempDir("shipherd-feature-") })).toEqual({ v: 1, decision: "allow" });
  });

  it("lets a PR of a repository no ticket uses through", async () => {
    const t = setup({ pr: prOf, repoOfSlug: () => null });
    expect(await t.ask({ kind: "pr_merge", dir: null, pr: "7", repo: "other/repo" }, { cwd: tempDir("shipherd-feature-") })).toEqual({ v: 1, decision: "allow" });
    expect(t.logs.at(-1)).toContain("no ticket uses other/repo");
    expect(t.prInfo).not.toHaveBeenCalled();
  });

  it("prLink turns -R and a PR number into a link, also for a github.com or GHE host", () => {
    expect(prLink("org/dems", "7")).toBe("https://github.com/org/dems/pull/7");
    expect(prLink("github.com/org/dems", "7")).toBe("https://github.com/org/dems/pull/7");
    expect(prLink("https://github.com/org/dems.git", "7")).toBe("https://github.com/org/dems/pull/7");
    expect(prLink("ghe.corp/org/dems", "7")).toBe("https://ghe.corp/org/dems/pull/7");
    expect(prLink("dems", "7")).toBe("7");
  });

  it("findRepoBySlug matches any of a repository's slugs, ignoring case and a github.com prefix", () => {
    const slugs: Record<string, string[]> = { "/a": ["org/a"], "/b": ["org/b-new", "org/b"], "/c": ["ghe.corp/org/c"] };
    const of = (p: string) => slugs[p] ?? [];
    const paths = ["/a", "/b", "/c", "/b"];
    expect(findRepoBySlug("Org/B", paths, of)).toBe("/b");
    expect(findRepoBySlug("github.com/org/a", paths, of)).toBe("/a");
    expect(findRepoBySlug("https://github.com/org/a.git", paths, of)).toBe("/a");
    expect(findRepoBySlug("ghe.corp/org/c", paths, of)).toBe("/c");
    expect(findRepoBySlug("org/zzz", paths, of)).toBeNull();
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

  it("checks a push of the current branch straight to the default branch (HEAD:main)", async () => {
    const t = setup();
    await t.merge("dms-1");
    run(t.repoPath, "checkout", "-q", "dms-2");
    const r = await t.ask({ kind: "push", dir: null, target: "main", source: "HEAD" });
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

  it("reads `git push origin main` from another branch as a push of the local main, not of the current branch", async () => {
    const t = setup();
    await t.merge("dms-1");
    run(t.repoPath, "checkout", "-q", "dms-2");
    // dms-2 和占着 main 的 dms-1 冲突，但这次推的是本地 main，不是 dms-2。
    expect(await t.ask({ kind: "push", dir: null, target: "main", source: "main" })).toEqual({ v: 1, decision: "allow" });
    expect(t.events.map((e) => e.kind)).toEqual(["proceed_conflict"]);
    expect(t.repo.activeHold(t.repoPath, "dms-2")).toBeNull();
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
    expect(await t.ask({ kind: "push", dir: null, target: "develop", source: "HEAD" })).toEqual({ v: 1, decision: "allow" });
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
    await t.ask({ kind: "pr_merge", dir: null, pr: "8", repo: null });
    expect(await t.ask({ kind: "pr_merge", dir: null, pr: "8", repo: null }, { phase: "post" })).toEqual({ v: 1, decision: "allow" });
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
    const t = setup({ now: () => clock, git: { mergeConflicts: async (r, a, b) => { clock += TEST_DEADLINE_MS + 1000; return git.mergeConflicts(r, a, b); } } });
    expect(await t.merge("dms-1")).toEqual({ v: 1, decision: "allow" });
    expect(rows(t)).toEqual(none);
    expect(t.events).toEqual([]);
  });

  it("does not record a wait the hook stopped waiting for", async () => {
    let clock = 1000;
    let slow = false;
    const t = setup({ now: () => clock, git: { mergeConflicts: async (r, a, b) => { if (slow) clock += TEST_DEADLINE_MS + 1000; return git.mergeConflicts(r, a, b); } } });
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
    expect(await t.merge("dms-1", {}, { ageMs: TEST_DEADLINE_MS })).toEqual({ v: 1, decision: "allow" });
    expect(vi.mocked(t.gitDeps.mergeConflicts).mock.calls.length).toBe(checks);
    expect(rows(t)).toEqual(before);
    expect(t.events).toHaveLength(events);
    expect(t.logs.some((l) => l.includes(`waited ${TEST_DEADLINE_MS} ms`))).toBe(true);
  });

  it("counts the time spent in the queue toward the deadline", async () => {
    let clock = 1000;
    // 每次裁决的第一次 merge-tree 在假时钟上用掉一步（STEP）。
    const STEP = 30 * 60_000;
    let first = true;
    const step = { git: { mergeConflicts: async (r: string, a: string, b: string) => { if (first) clock += STEP; first = false; return git.mergeConflicts(r, a, b); } } };
    // 真实计时器的时长是 deadline - ageMs。"晚了"那次必须让排队时间加一步超过期限，所以它的真实计时器一定短于一步。
    // 一步只有 30 秒时，两次的真实计时器是 20 秒和 40 秒：真实的 git 在负载高的 Windows runner 上慢到 20 秒，计时器就先
    // 触发、断言失败；"在期限内"那次的 40 秒又长过 Windows 上 30 秒的用例上限。一步放到 30 分钟，真实计时器至少 15 分钟，
    // 结果只由假时钟决定，用例只等真实的 git（计时器 unref，结束时清掉）。
    const deadlineMs = 4 * STEP;
    const timedOut = (t: ReturnType<typeof setup>) => t.logs.some((l) => l.includes("took too long"));
    // 排队 deadline - 半步 + 一步 > deadline：算晚了，放行、不记。
    const late = setup({ now: () => clock, deadlineMs, ...step });
    expect(await late.merge("dms-3", {}, { ageMs: deadlineMs - STEP / 2 })).toEqual({ v: 1, decision: "allow" });
    expect(rows(late)).toEqual(none);
    expect(late.logs.some((l) => l.includes("decided after the deadline"))).toBe(true);
    expect(timedOut(late)).toBe(false);
    // 排队 deadline - 两步 + 一步还在期限内：照常占位。
    const inTime = setup({ now: () => clock, deadlineMs, ...step });
    first = true;
    await inTime.merge("dms-3", {}, { ageMs: deadlineMs - 2 * STEP });
    expect(rows(inTime).holds).toEqual({ n: 1 });
    expect(timedOut(inTime)).toBe(false);
  });

  it("still releases a hold on a post request that waited in the queue", async () => {
    const t = setup();
    await t.merge("dms-3");
    run(t.repoPath, "merge", "-q", "dms-3");
    expect(await t.merge("dms-3", { phase: "post" }, { ageMs: TEST_DEADLINE_MS + 10_000 })).toEqual({ v: 1, decision: "allow" });
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

describe("commandDir", () => {
  it("resolves relative directories and ~ like bash", () => {
    expect(commandDir("/w/repo", null, "darwin", "/Users/me")).toBe("/w/repo");
    expect(commandDir("/w/repo", "../api", "darwin", "/Users/me")).toBe("/w/api");
    expect(commandDir("/w/repo", "~/Code/api", "darwin", "/Users/me")).toBe("/Users/me/Code/api");
    expect(commandDir("/w/repo", "~", "darwin", "/Users/me")).toBe("/Users/me");
  });
  it("reads Windows paths, including Git Bash's /c/... drive form", () => {
    expect(commandDir("C:\\w\\repo", "/c/Users/me/api", "win32", "C:\\Users\\me")).toBe("C:\\Users\\me\\api");
    expect(commandDir("C:\\w\\repo", "/d", "win32", "C:\\Users\\me")).toBe("D:\\");
    expect(commandDir("C:\\w\\repo", "C:\\Users\\me\\api", "win32", "C:\\Users\\me")).toBe("C:\\Users\\me\\api");
    expect(commandDir("C:\\w\\repo", "C:/Users/me/api", "win32", "C:\\Users\\me")).toBe("C:\\Users\\me\\api");
    expect(commandDir("C:\\w\\repo", "..\\api", "win32", "C:\\Users\\me")).toBe("C:\\w\\api");
    expect(commandDir("C:\\w\\repo", "~/api", "win32", "C:\\Users\\me")).toBe("C:\\Users\\me\\api");
  });
});
