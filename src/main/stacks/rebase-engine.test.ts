import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { copyRepo, makeRepo, tempDir } from "../test-utils";
import { isAncestor, parseGitVersion, parseWorktreeList, refsUnder, supportsUpdateRefs } from "./git-stack";
import { runEngine, type EngineLayer } from "./rebase-engine";

// 真的 git 仓库、每次 rebase 还要起一次 node（sequence editor）：整套并行跑时 5 秒不够。
// 夹具已经按文件共享（BTL-240），剩下的是被测代码自己的 git 调用（一个用例几十到上百个进程）：Windows runner 上
// 起一个进程是 macOS 的好几倍、整套并行跑时再翻倍，这里的用例那边常要 10～20 秒，偶尔贴着 30 秒，所以只在 Windows 上给 60 秒。
vi.setConfig({ testTimeout: process.platform === "win32" ? 60_000 : 30_000 });

const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function commit(repo: string, file: string, text: string, msg: string): string {
  writeFileSync(join(repo, file), text);
  g(repo, "add", file);
  g(repo, "commit", "-q", "-m", msg);
  return g(repo, "rev-parse", "HEAD");
}

let fourLayersTemplate: { repo: string; tips: Record<string, string> } | null = null;

/**
 * main ← a ← b ← c ← d，每层两个提交、各改自己的文件。
 * 每个测试文件只真的建一次（近 30 个 git 进程），之后复制（copyRepo）：Windows runner 上这些进程是这个文件
 * 30 秒超时的一大块（BTL-240）。复制出来的提交 SHA 和模板一样，tips 照用。
 */
function fourLayers() {
  if (!fourLayersTemplate) {
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
    fourLayersTemplate = { repo, tips };
  }
  return { repo: copyRepo(fourLayersTemplate.repo), tips: { ...fourLayersTemplate.tips } };
}

const layers = (repo: string, names: string[], start = 0): EngineLayer[] =>
  names.map((b, i) => ({ position: start + i, branch: b, tip: g(repo, "rev-parse", b), base: null }));

const input = (repo: string, extra: Partial<Parameters<typeof runEngine>[0]>) => ({
  repo, workRoot: tempDir("shipherd-stack-work-"), runId: 1, trunk: g(repo, "rev-parse", "main"), layers: [] as EngineLayer[],
  bottomOldParent: null, mode: "update_refs" as const, execPath: process.execPath, ...extra,
});

async function chained(repo: string, trunk: string, tips: { newTip: string }[]) {
  let parent = trunk;
  for (const t of tips) {
    expect(await isAncestor(repo, parent, t.newTip)).toBe(true);
    parent = t.newTip;
  }
}

/** 照冲突提示在那一层自己的 worktree 里 rebase，冲突的文件写成 content 再接着走。返回新的顶端。 */
function resolveAsSession(repo: string, branch: string, onto: string, upstream: string, file: string, content: string): string {
  const wt = join(tempDir(), `wt-${branch}`);
  g(repo, "worktree", "add", "-q", wt, branch);
  const env = { ...process.env, GIT_EDITOR: "true" };
  let done = false;
  try {
    execFileSync("git", ["rebase", "-q", "--onto", onto, upstream], { cwd: wt, stdio: "ignore", env });
    done = true;
  } catch {
    // 冲突
  }
  for (let n = 0; n < 5 && !done; n++) {
    writeFileSync(join(wt, file), content);
    g(wt, "add", file);
    try {
      execFileSync("git", ["rebase", "--continue"], { cwd: wt, stdio: "ignore", env });
      done = true;
    } catch {
      // 下一个提交又冲突
    }
  }
  expect(done).toBe(true);
  return g(wt, "rev-parse", "HEAD");
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
    expect(await refsUnder(repo, "refs/heads/shipherd-stack")).toEqual([]);
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
    expect(await refsUnder(repo, "refs/heads/shipherd-stack")).toEqual([]);
  });

  it("gives a middle layer a command onto its parent's new tip, and the next run picks up the session's resolution", async () => {
    const { repo, tips } = fourLayers();
    const trunk = commit(repo, "c.txt", "main's c\n", "main edits c");
    const r = await runEngine(input(repo, { mode, layers: layers(repo, ["a", "b", "c", "d"]), trunk }));
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") return;
    // onto 是 b rebase 到新 main 上之后的顶端（不是 b 的旧顶端），upstream 是 b 的旧顶端：只重放 c 自己的两个提交
    expect(r.upstream).toBe(tips.b);
    expect(r.onto).not.toBe(tips.b);
    expect(await isAncestor(repo, trunk, r.onto)).toBe(true);
    expect(g(repo, "rev-list", "--count", `${trunk}..${r.onto}`)).toBe("4");
    // session 照提示在自己的 worktree 里做
    const resolved = resolveAsSession(repo, "c", r.onto, r.upstream, "c.txt", "c1\n");
    expect(g(repo, "rev-list", "--count", `${r.onto}..${resolved}`)).toBe("2");
    const ls = layers(repo, ["a", "b", "c", "d"]);
    ls[2]!.base = tips.b!;
    ls[2]!.conflictOnto = r.onto;
    ls[3]!.base = tips.c!;
    const again = await runEngine(input(repo, { mode, layers: ls, trunk, runId: 2 }));
    expect(again.kind).toBe("rebased");
    if (again.kind !== "rebased") return;
    await chained(repo, trunk, again.tips);
    expect(g(repo, "rev-list", "--count", `${again.tips[1]!.newTip}..${again.tips[2]!.newTip}`)).toBe("2");
    expect(g(repo, "rev-list", "--count", `${again.tips[2]!.newTip}..${again.tips[3]!.newTip}`)).toBe("2");
    expect(g(repo, "show", `${again.tips[2]!.newTip}:c.txt`)).toBe("c1\nc2");
  });

  it("after a squash merge, a bottom the session already moved onto main is kept and the layers above follow it", async () => {
    const { repo, tips } = fourLayers();
    g(repo, "merge", "-q", "--squash", "a");
    g(repo, "commit", "-q", "-m", "a (#1)");
    const trunk = commit(repo, "b.txt", "main's b\n", "main edits b");
    const r = await runEngine(input(repo, { mode, layers: layers(repo, ["b", "c", "d"], 1), trunk, bottomOldParent: tips.a! }));
    expect(r).toMatchObject({ kind: "conflict", branch: "b", onto: trunk, upstream: tips.a });
    if (r.kind !== "conflict") return;
    const resolved = resolveAsSession(repo, "b", r.onto, r.upstream, "b.txt", "b1\n");
    const ls = layers(repo, ["b", "c", "d"], 1);
    ls[0]!.conflictOnto = r.onto;
    ls[1]!.base = tips.b!;
    ls[2]!.base = tips.c!;
    const again = await runEngine(input(repo, { mode, layers: ls, trunk, bottomOldParent: tips.a!, runId: 2 }));
    expect(again.kind).toBe("rebased");
    if (again.kind !== "rebased") return;
    expect(again.tips[0]!.newTip).toBe(resolved);
    await chained(repo, trunk, again.tips);
    expect(g(repo, "rev-list", "--count", `${resolved}..${again.tips[1]!.newTip}`)).toBe("2");
  });

  it("leaves other branches alone even with rebase.abbreviateCommands on", async () => {
    const { repo, tips } = fourLayers();
    g(repo, "config", "rebase.abbreviateCommands", "true");
    g(repo, "config", "rebase.updateRefs", "true");
    g(repo, "branch", "bystander", tips.b!);
    const trunk = commit(repo, "main.txt", "m\n", "main moves");
    const r = await runEngine(input(repo, { mode, layers: layers(repo, ["a", "b", "c", "d"]), trunk }));
    expect(r.kind).toBe("rebased");
    for (const b of ["a", "b", "c", "d"]) expect(g(repo, "rev-parse", b)).toBe(tips[b]);
    expect(g(repo, "rev-parse", "bystander")).toBe(tips.b);
  });

  it("treats a merged head that was never fetched as unknown instead of failing", async () => {
    const { repo } = fourLayers();
    g(repo, "merge", "-q", "--squash", "a");
    const trunk = (g(repo, "commit", "-q", "-m", "a (#1)"), g(repo, "rev-parse", "HEAD"));
    const ls = layers(repo, ["b", "c", "d"], 1);
    ls[0]!.base = g(repo, "rev-parse", "a");
    const r = await runEngine(input(repo, { mode, layers: ls, trunk, bottomOldParent: "1234567890abcdef1234567890abcdef12345678" }));
    expect(r.kind).toBe("rebased");
    if (r.kind !== "rebased") return;
    expect(g(repo, "rev-list", "--count", `${trunk}..${r.tips[0]!.newTip}`)).toBe("2");
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
