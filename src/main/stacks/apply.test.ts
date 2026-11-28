import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeRepo, tempDir } from "../test-utils";
import { applyTips, backupRef, type ApplyLayer } from "./apply";
import { pushBranch } from "./git-stack";

// 真的 git 仓库、每次 rebase 还要起一次 node（sequence editor）：整套并行跑时 5 秒不够
vi.setConfig({ testTimeout: 30_000 });

const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function commit(repo: string, file: string, text: string, msg: string): string {
  writeFileSync(join(repo, file), text);
  g(repo, "add", file);
  g(repo, "commit", "-q", "-m", msg);
  return g(repo, "rev-parse", "HEAD");
}

/** a ← b 两层，各自在 main 的旧提交上；再在别处做出「新顶端」（直接造两个提交当作 rebase 结果）。 */
function setup() {
  const repo = makeRepo();
  g(repo, "checkout", "-q", "-b", "a");
  const a = commit(repo, "a.txt", "a\n", "a");
  g(repo, "checkout", "-q", "-b", "b");
  const b = commit(repo, "b.txt", "b\n", "b");
  g(repo, "checkout", "-q", "main");
  commit(repo, "m.txt", "m\n", "m");
  g(repo, "checkout", "-q", "--detach");
  g(repo, "cherry-pick", a);
  const a2 = g(repo, "rev-parse", "HEAD");
  g(repo, "cherry-pick", b);
  const b2 = g(repo, "rev-parse", "HEAD");
  g(repo, "checkout", "-q", "main");
  const layers: ApplyLayer[] = [
    { position: 0, branch: "a", oldTip: a, newTip: a2, checkout: null, remoteTip: null, remoteOkSha: null },
    { position: 1, branch: "b", oldTip: b, newTip: b2, checkout: null, remoteTip: null, remoteOkSha: null },
  ];
  return { repo, a, b, a2, b2, layers };
}

const base = (repo: string, layers: ApplyLayer[]) => ({ repo, stackId: 1, runId: 9, layers, sessionBusy: () => false, push: vi.fn(async () => true) });

describe("applyTips", () => {
  it("backs up, moves every branch and pushes the ones the remote has", async () => {
    const s = setup();
    const remote = tempDir("shipherd-remote-");
    g(remote, "init", "-q", "--bare");
    g(s.repo, "remote", "add", "origin", remote);
    g(s.repo, "push", "-q", "origin", "a");
    s.layers[0]!.remoteTip = s.a;
    const push = vi.fn(async (l: ApplyLayer) => (await pushBranch(s.repo, "origin", l.branch, l.remoteTip, l.newTip), true));
    const r = await applyTips({ ...base(s.repo, s.layers), push });
    expect(r).toMatchObject({ kind: "applied", pushed: ["a"], unpushed: [] });
    expect(g(s.repo, "rev-parse", "a")).toBe(s.a2);
    expect(g(s.repo, "rev-parse", "b")).toBe(s.b2);
    expect(g(s.repo, "rev-parse", backupRef(1, 9, 0))).toBe(s.a);
    expect(g(s.repo, "rev-parse", backupRef(1, 9, 1))).toBe(s.b);
    expect(g(remote, "rev-parse", "a")).toBe(s.a2);
  });

  it("moves a branch checked out in a managed worktree with reset --keep", async () => {
    const s = setup();
    const wt = join(tempDir(), "wt");
    g(s.repo, "worktree", "add", "-q", wt, "b");
    writeFileSync(join(wt, "untracked.txt"), "keep me\n");
    s.layers[1]!.checkout = { path: wt, managed: true };
    const r = await applyTips(base(s.repo, s.layers));
    expect(r.kind).toBe("applied");
    expect(g(wt, "rev-parse", "HEAD")).toBe(s.b2);
    expect(g(wt, "status", "--porcelain")).toBe("?? untracked.txt");
  });

  it.each([
    ["a branch checked out somewhere Shipherd does not manage", (s: ReturnType<typeof setup>, wt: string) => (s.layers[1]!.checkout = { path: wt, managed: false }), "checked_out"],
    ["uncommitted changes", (s: ReturnType<typeof setup>, wt: string) => {
      s.layers[1]!.checkout = { path: wt, managed: true };
      writeFileSync(join(wt, "b.txt"), "edited\n");
    }, "dirty"],
    ["a remote with commits we do not have", (s: ReturnType<typeof setup>) => (s.layers[0]!.remoteTip = s.b2), "remote_ahead"],
    ["an untracked file the new tip would overwrite", (s: ReturnType<typeof setup>, wt: string) => {
      s.layers[1]!.checkout = { path: wt, managed: true };
      writeFileSync(join(wt, "m.txt"), "mine\n");
    }, "untracked"],
  ])("defers without changing anything on %s", async (_n, arrange, code) => {
    const s = setup();
    const wt = join(tempDir(), "wt");
    g(s.repo, "worktree", "add", "-q", wt, "b");
    arrange(s, wt);
    const r = await applyTips(base(s.repo, s.layers));
    expect(r).toMatchObject({ kind: "deferred", reason: { code } });
    expect(g(s.repo, "rev-parse", "a")).toBe(s.a);
    expect(g(s.repo, "for-each-ref", "refs/shipherd")).toBe("");
  });

  it("defers while the session is busy", async () => {
    const s = setup();
    const wt = join(tempDir(), "wt");
    g(s.repo, "worktree", "add", "-q", wt, "b");
    s.layers[1]!.checkout = { path: wt, managed: true };
    const r = await applyTips({ ...base(s.repo, s.layers), sessionBusy: (p) => p === wt });
    expect(r).toMatchObject({ kind: "deferred", reason: { code: "session_busy" } });
  });

  it("accepts a remote still at the commit Shipherd last replaced", async () => {
    const s = setup();
    s.layers[0]!.remoteTip = "1111111111111111111111111111111111111111";
    s.layers[0]!.remoteOkSha = "1111111111111111111111111111111111111111";
    const r = await applyTips(base(s.repo, s.layers));
    expect(r).toMatchObject({ kind: "applied", pushed: ["a"] });
  });

  it("rolls back every moved branch when a later one fails and keeps the backups", async () => {
    const s = setup();
    const wt = join(tempDir(), "wt");
    g(s.repo, "worktree", "add", "-q", wt, "b");
    s.layers[1]!.checkout = { path: wt, managed: true };
    g(s.repo, "branch", "c", s.b);
    // 新顶端是个不存在的对象：预检不看它，update-ref 才失败
    s.layers.push({ position: 2, branch: "c", oldTip: s.b, newTip: "0123456789012345678901234567890123456789", checkout: null, remoteTip: null, remoteOkSha: null });
    const r = await applyTips(base(s.repo, s.layers));
    expect(r.kind).toBe("rolled_back");
    expect(g(s.repo, "rev-parse", "a")).toBe(s.a);
    expect(g(wt, "rev-parse", "HEAD")).toBe(s.b);
    expect(g(s.repo, "rev-parse", "c")).toBe(s.b);
    expect(g(s.repo, "rev-parse", backupRef(1, 9, 0))).toBe(s.a);
    expect(g(s.repo, "rev-parse", backupRef(1, 9, 1))).toBe(s.b);
  });

  it("does not write backups when restoring", async () => {
    const s = setup();
    const r = await applyTips({ ...base(s.repo, s.layers), backup: false });
    expect(r).toMatchObject({ kind: "applied", layers: [{ backupRef: null }, { backupRef: null }] });
    expect(g(s.repo, "for-each-ref", "refs/shipherd")).toBe("");
  });
});
