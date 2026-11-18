import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRepo, tempDir } from "../test-utils";
import { isAncestor, parseGitVersion, parseWorktreeList, refsUnder, supportsUpdateRefs } from "./git-stack";
import { runEngine, type EngineLayer } from "./rebase-engine";

const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function commit(repo: string, file: string, text: string, msg: string): string {
  writeFileSync(join(repo, file), text);
  g(repo, "add", file);
  g(repo, "commit", "-q", "-m", msg);
  return g(repo, "rev-parse", "HEAD");
}

/** main ← a ← b ← c ← d，每层两个提交、各改自己的文件。 */
function fourLayers() {
  const repo = makeRepo();
  const tips: Record<string, string> = {};
  let parent = "main";
  for (const b of ["a", "b", "c", "d"]) {
    g(repo, "checkout", "-q", "-b", b, parent);
    commit(repo, `${b}.txt`, `${b}1\n`, `${b} one`);
    tips[b] = commit(repo, `${b}.txt`, `${b}1\n${b}2\n`, `${b} two`);
    parent = b;
  }
  g(repo, "checkout", "-q", "main");
  return { repo, tips };
}

const layers = (repo: string, names: string[], start = 0): EngineLayer[] =>
  names.map((b, i) => ({ position: start + i, branch: b, tip: g(repo, "rev-parse", b), base: null }));

const input = (repo: string, extra: Partial<Parameters<typeof runEngine>[0]>) => ({
  repo, workRoot: tempDir("butler-stack-work-"), runId: 1, trunk: g(repo, "rev-parse", "main"), layers: [] as EngineLayer[],
  bottomOldParent: null, mode: "update_refs" as const, execPath: process.execPath, ...extra,
});

async function chained(repo: string, trunk: string, tips: { newTip: string }[]) {
  let parent = trunk;
  for (const t of tips) {
    expect(await isAncestor(repo, parent, t.newTip)).toBe(true);
    parent = t.newTip;
  }
}

describe("git-stack parsing", () => {
  it("reads the git version and update-refs support", () => {
    expect(parseGitVersion("git version 2.37.1 (Apple Git-137)")).toEqual([2, 37]);
    expect(supportsUpdateRefs([2, 37])).toBe(false);
    expect(supportsUpdateRefs([2, 38])).toBe(true);
    expect(supportsUpdateRefs([3, 0])).toBe(true);
    expect(supportsUpdateRefs(null)).toBe(false);
  });

  it("maps branches to worktrees", () => {
    const m = parseWorktreeList("worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /w\nHEAD 2\ndetached\n\nworktree /x\nHEAD 3\nbranch refs/heads/feat/a\n");
    expect([...m.keys()]).toEqual(["main", "feat/a"]);
  });
});

describe.each(["update_refs", "per_layer"] as const)("runEngine (%s)", (mode) => {
  it("restacks every layer when main moves, without touching real branches", async () => {
    const { repo, tips } = fourLayers();
    const trunk = commit(repo, "main.txt", "m\n", "main moves");
    g(repo, "branch", "bystander", tips.b!);
    const r = await runEngine(input(repo, { mode, layers: layers(repo, ["a", "b", "c", "d"]), trunk }));
    expect(r.kind).toBe("rebased");
    if (r.kind !== "rebased") return;
    expect(r.tips.map((t) => t.branch)).toEqual(["a", "b", "c", "d"]);
    await chained(repo, trunk, r.tips);
    expect(r.tips.map((t) => t.newBase)).toEqual([trunk, r.tips[0]!.newTip, r.tips[1]!.newTip, r.tips[2]!.newTip]);
    for (const b of ["a", "b", "c", "d"]) expect(g(repo, "rev-parse", b)).toBe(tips[b]);
    expect(g(repo, "rev-parse", "bystander")).toBe(tips.b);
    expect(await refsUnder(repo, "refs/heads/butler-stack")).toEqual([]);
    expect(g(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  });

  it("is a no-op when the stack is already on main", async () => {
    const { repo } = fourLayers();
    const r = await runEngine(input(repo, { mode, layers: layers(repo, ["a", "b", "c", "d"]) }));
    expect(r.kind).toBe("noop");
  });

  it("replays only the remaining layers after a squash merge of the bottom", async () => {
    const { repo, tips } = fourLayers();
    g(repo, "merge", "-q", "--squash", "a");
    const trunk = (g(repo, "commit", "-q", "-m", "a (#1)"), g(repo, "rev-parse", "HEAD"));
    const r = await runEngine(input(repo, { mode, layers: layers(repo, ["b", "c", "d"], 1), trunk, bottomOldParent: tips.a! }));
    expect(r.kind).toBe("rebased");
    if (r.kind !== "rebased") return;
    await chained(repo, trunk, r.tips);
    // b 只剩自己的两个提交
    expect(g(repo, "rev-list", "--count", `${trunk}..${r.tips[0]!.newTip}`)).toBe("2");
    expect(g(repo, "rev-list", "--count", `${trunk}..${r.tips[2]!.newTip}`)).toBe("6");
  });

  it("rebases the rest onto main after a merge-commit merge of the bottom", async () => {
    const { repo } = fourLayers();
    g(repo, "merge", "-q", "--no-ff", "-m", "Merge a", "a");
    const trunk = g(repo, "rev-parse", "HEAD");
    const r = await runEngine(input(repo, { mode, layers: layers(repo, ["b", "c", "d"], 1), trunk }));
    expect(r.kind).toBe("rebased");
    if (r.kind !== "rebased") return;
    await chained(repo, trunk, r.tips);
    expect(g(repo, "rev-list", "--count", `${trunk}..${r.tips[0]!.newTip}`)).toBe("2");
  });

  it("reports the conflicting layer and its files and leaves everything as it was", async () => {
    const { repo, tips } = fourLayers();
    const trunk = commit(repo, "c.txt", "main's c\n", "main edits c");
    const r = await runEngine(input(repo, { mode, layers: layers(repo, ["a", "b", "c", "d"]), trunk }));
    expect(r).toMatchObject({ kind: "conflict", branch: "c", position: 2, files: ["c.txt"] });
    for (const b of ["a", "b", "c", "d"]) expect(g(repo, "rev-parse", b)).toBe(tips[b]);
    expect(await refsUnder(repo, "refs/heads/butler-stack")).toEqual([]);
  });
});

describe("runEngine special cases", () => {
  it("does not mind layers checked out in other worktrees", async () => {
    const { repo, tips } = fourLayers();
    const wt = join(tempDir(), "wt-b");
    g(repo, "worktree", "add", "-q", wt, "b");
    const trunk = commit(repo, "main.txt", "m\n", "main moves");
    const r = await runEngine(input(repo, { layers: layers(repo, ["a", "b", "c", "d"]), trunk }));
    expect(r.kind).toBe("rebased");
    expect(g(wt, "rev-parse", "HEAD")).toBe(tips.b);
  });

  it("starts from the first layer that moved and keeps the ones below", async () => {
    const { repo, tips } = fourLayers();
    g(repo, "checkout", "-q", "b");
    commit(repo, "b.txt", "b1\nb2\nb3\n", "b three");
    g(repo, "checkout", "-q", "main");
    const ls = layers(repo, ["a", "b", "c", "d"]);
    ls[2]!.base = tips.b!;
    ls[3]!.base = tips.c!;
    const r = await runEngine(input(repo, { layers: ls }));
    expect(r.kind).toBe("rebased");
    if (r.kind !== "rebased") return;
    expect(r.tips[0]!.newTip).toBe(tips.a);
    expect(r.tips[1]!.newTip).toBe(g(repo, "rev-parse", "b"));
    await chained(repo, g(repo, "rev-parse", "main"), r.tips);
    expect(g(repo, "rev-list", "--count", `${r.tips[1]!.newTip}..${r.tips[2]!.newTip}`)).toBe("2");
  });

  it("folds fixups in place without changing any layer's content", async () => {
    const { repo, tips } = fourLayers();
    g(repo, "checkout", "-q", "b");
    commit(repo, "b-extra.txt", "x\n", "fixup! b one");
    g(repo, "checkout", "-q", "main");
    const g2 = await runEngine(input(repo, { layers: layers(repo, ["a", "b"]), autosquash: true }));
    expect(g2.kind).toBe("rebased");
    if (g2.kind !== "rebased") return;
    expect(g2.tips[0]!.newTip).toBe(tips.a);
    expect(g(repo, "log", "--format=%s", `${tips.a}..${g2.tips[1]!.newTip}`)).toBe("b two\nb one");
  });

  it("replays a resolution rerere already knows", async () => {
    const { repo, tips } = fourLayers();
    const trunk = commit(repo, "c.txt", "main's c\n", "main edits c");
    const rr = (...a: string[]) => {
      try {
        return g(repo, "-c", "rerere.enabled=true", ...a);
      } catch {
        return "";
      }
    };
    // 用户以前手动解过一次同样的冲突
    rr("checkout", "-q", "-b", "practice", tips.c!);
    rr("rebase", "-q", trunk);
    writeFileSync(join(repo, "c.txt"), "c1\n");
    g(repo, "add", "c.txt");
    execFileSync("git", ["-c", "rerere.enabled=true", "-c", "core.editor=true", "rebase", "--continue"], { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_EDITOR: "true" } });
    g(repo, "checkout", "-q", "main");
    g(repo, "branch", "-D", "practice");
    const r = await runEngine(input(repo, { layers: layers(repo, ["a", "b", "c", "d"]), trunk }));
    expect(r.kind).toBe("rebased");
  });
});
