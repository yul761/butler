import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { copyRepo, makeRepo, tempDir } from "../test-utils";
import { isAncestor, parseGitVersion, parseWorktreeList, refsUnder, supportsUpdateRefs } from "./git-stack";
import { batchByLength, markersAdded, runEngine, type EngineLayer } from "./rebase-engine";

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

/** 一次 rev-parse 解析全部引用（每个 git 进程在 Windows runner 上都不便宜，见文件头）。 */
const revs = (repo: string, refs: readonly string[]): string[] => g(repo, "rev-parse", ...refs).split(/\r?\n/);

const layers = (repo: string, names: string[], start = 0): EngineLayer[] => {
  const tips = revs(repo, names);
  return names.map((b, i) => ({ position: start + i, branch: b, tip: tips[i]!, base: null }));
};

const input = (repo: string, extra: Partial<Parameters<typeof runEngine>[0]>) => ({
  repo, workRoot: tempDir("shipherd-stack-work-"), runId: 1, trunk: extra.trunk ?? g(repo, "rev-parse", "main"), layers: [] as EngineLayer[],
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
    expect(revs(repo, ["a", "b", "c", "d", "bystander"])).toEqual(["a", "b", "c", "d", "b"].map((b) => tips[b]));
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
    expect(revs(repo, ["a", "b", "c", "d"])).toEqual(["a", "b", "c", "d"].map((b) => tips[b]));
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
    // 冲突那层下面的 a、b 这次都挪到了新 main 上：报出它们的新顶端，b 的就是 onto
    expect(r.below.map((t) => t.branch)).toEqual(["a", "b"]);
    expect(r.below.every((t) => t.newTip !== t.oldTip)).toBe(true);
    expect(r.below[1]!.newTip).toBe(r.onto);
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
    expect(revs(repo, ["a", "b", "c", "d", "bystander"])).toEqual(["a", "b", "c", "d", "b"].map((b) => tips[b]));
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

  it("does not reuse a resolution rerere remembers, even one the session gave up on (BTL-278)", async () => {
    const { repo, tips } = fourLayers();
    const trunk = commit(repo, "c.txt", "main's c\n", "main edits c");
    // rr-cache 在共用的 git 目录里，所有 worktree 共用：session 在自己的 worktree 里解过、又放弃的解法也记在这里
    g(repo, "config", "rerere.enabled", "true");
    g(repo, "config", "rerere.autoUpdate", "true");
    g(repo, "checkout", "-q", "-b", "practice", tips.c!);
    try {
      g(repo, "rebase", "-q", trunk);
    } catch {
      // 冲突
    }
    // 「解法」：第二个提交接着它能干净地叠上去（只有第一个提交冲突）
    writeFileSync(join(repo, "c.txt"), "c1\n");
    g(repo, "add", "c.txt");
    execFileSync("git", ["-c", "core.editor=true", "rebase", "--continue"], { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_EDITOR: "true" } });
    g(repo, "checkout", "-q", "main");
    g(repo, "branch", "-D", "practice");
    const r = await runEngine(input(repo, { layers: layers(repo, ["a", "b", "c", "d"]), trunk }));
    expect(r).toMatchObject({ kind: "conflict", branch: "c", files: ["c.txt"] });
    expect(revs(repo, ["a", "b", "c", "d"])).toEqual(["a", "b", "c", "d"].map((b) => tips[b]));
  });

  it("refuses a result that gained conflict markers, but not markers a layer already had (BTL-278)", async () => {
    const { repo, tips } = fourLayers();
    // 一个「解决」冲突时把冲突标记留在文件里还报成功的合并驱动：结果里多出来的标记要拦下来
    const driver = join(tempDir(), "sloppy-merge.sh");
    writeFileSync(driver, `printf '<<<<<<< ours\\nx\\n=======\\ny\\n>>>>>>> theirs\\n' > "$1"\nexit 0\n`);
    g(repo, "config", "merge.sloppy.driver", `sh '${driver.replace(/\\/g, "/")}' %A`);
    writeFileSync(join(g(repo, "rev-parse", "--git-common-dir").replace(/^(?!\/|[A-Za-z]:)/, `${repo}/`), "info", "attributes"), "c.txt merge=sloppy\n");
    const trunk = commit(repo, "c.txt", "main's c\n", "main edits c");
    // 用户开了颜色：git grep 的输出带颜色码也要认得出来
    g(repo, "config", "color.ui", "always");
    const r = await runEngine(input(repo, { layers: layers(repo, ["a", "b", "c", "d"]), trunk }));
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toMatch(/conflict markers.*c\.txt/);
    expect(revs(repo, ["a", "b", "c", "d"])).toEqual(["a", "b", "c", "d"].map((b) => tips[b]));

    // 标记本来就在层里（比如测试夹具）：照常 rebase
    const { repo: repo2 } = fourLayers();
    g(repo2, "checkout", "-q", "b");
    commit(repo2, "fixture.txt", "<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n", "b adds a fixture");
    g(repo2, "checkout", "-q", "main");
    const trunk2 = commit(repo2, "z.txt", "z\n", "main adds z");
    const r2 = await runEngine(input(repo2, { layers: layers(repo2, ["a", "b", "c", "d"]), trunk: trunk2 }));
    expect(r2.kind).toBe("rebased");
  });

  it("markersAdded looks only at the files a layer changes, reads odd file names literally, and throws when git fails", async () => {
    const repo = makeRepo();
    const base = g(repo, "rev-parse", "main");
    // trunk 里本来就有一个带标记的文件、一堆别的文件：层没动它们，不看
    for (let k = 0; k < 150; k++) writeFileSync(join(repo, `f${k}.txt`), `${k}\n`);
    writeFileSync(join(repo, "fixture.txt"), "<<<<<<< ours\nx\n>>>>>>> theirs\n");
    g(repo, "add", ".");
    g(repo, "commit", "-q", "-m", "trunk");
    const newBase = g(repo, "rev-parse", "HEAD");
    g(repo, "checkout", "-q", "-b", "l");
    // 名字像 pathspec 的 magic（:! 是排除）：不按字面读就认不出它自己。Windows 的文件名不能带 :，那里只用普通名字
    const odd = process.platform === "win32" ? "odd.txt" : ":!odd.txt";
    writeFileSync(join(repo, odd), "<<<<<<< ours\nx\n>>>>>>> theirs\n");
    writeFileSync(join(repo, "f3.txt"), "three\n");
    g(repo, "add", ".");
    g(repo, "commit", "-q", "-m", "layer");
    const newTip = g(repo, "rev-parse", "HEAD");
    const t = { branch: "l", oldTip: base, oldBase: base, newBase, newTip };
    expect(await markersAdded(repo, [t])).toEqual([{ branch: "l", files: [odd] }]);
    // 层没改任何文件：不起 git grep
    expect(await markersAdded(repo, [{ ...t, newTip: newBase }])).toEqual([]);
    // 版本不存在：抛出，不当成「没有标记」
    await expect(markersAdded(repo, [{ ...t, newTip: "f".repeat(40) }])).rejects.toThrow();
  });

  it("markersAdded splits git grep by the length of its arguments, not by a count of paths (BTL-278)", async () => {
    // 按总长度分：长路径少放几个，单个就超了的自己一批
    expect(batchByLength(["aaaa", "bbbb", "cccc"], 14)).toEqual([["aaaa", "bbbb"], ["cccc"]]);
    expect(batchByLength(["x".repeat(50), "y"], 14)).toEqual([["x".repeat(50)], ["y"]]);
    expect(batchByLength([], 14)).toEqual([]);
    // 预算很小、版本和路径都要分好几批：每一批里的标记都认得出，计数不串
    const repo = makeRepo();
    const base = g(repo, "rev-parse", "main");
    g(repo, "checkout", "-q", "-b", "l");
    const names = Array.from({ length: 12 }, (_, k) => `dir-${k}/${"n".repeat(20)}-${k}.txt`);
    for (const [k, f] of names.entries()) {
      mkdirSync(join(repo, `dir-${k}`), { recursive: true });
      writeFileSync(join(repo, f), k === 11 ? "<<<<<<< ours\nx\n>>>>>>> theirs\n" : `${k}\n`);
    }
    g(repo, "add", ".");
    g(repo, "commit", "-q", "-m", "layer");
    const newTip = g(repo, "rev-parse", "HEAD");
    const t = { branch: "l", oldTip: base, oldBase: base, newBase: base, newTip };
    expect(await markersAdded(repo, [t], 300)).toEqual([{ branch: "l", files: [names[11]] }]);
  });
});
