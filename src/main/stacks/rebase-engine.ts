import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { StackRunMode } from "../../shared/stacks";
import {
  REBASE_TIMEOUT_MS, deleteRef, gitOk, isAncestor, mergeBase, refsUnder, revParse, runGit, treeOf, unmergedFiles, updateRefCas,
} from "./git-stack";
import { sequenceEditorEnv } from "./seq-editor";

/**
 * 整栈 rebase 的引擎（设计 3.1–3.3 节）：只在 Butler 自己的临时 detached worktree 里、用指向各层顶端的临时分支做，
 * 真分支一个都不动；成功时返回各层的新顶端，由 apply 去 CAS 更新真分支。
 */

export interface EngineLayer {
  position: number;
  branch: string;
  /** 现在的本地顶端。 */
  tip: string;
  /** 记录的起点（上次同步时父层的顶端）。 */
  base: string | null;
}

export interface EngineInput {
  /** 主仓库（或任何一个同仓库的 worktree）。 */
  repo: string;
  /** 放临时 worktree 的目录。 */
  workRoot: string;
  runId: number;
  /** 新的 trunk 提交（远端 trunk 的 sha）。 */
  trunk: string;
  /** 还没合并的层，从下到上。 */
  layers: EngineLayer[];
  /**
   * 栈底的旧父层顶端：squash / rebase merge 后是合并掉的那层的 head（`--onto trunk <它>`）。
   * null：栈底的起点按 merge-base(trunk, 栈底) 算（普通 rebase；main 更新、merge commit 合并都这样）。
   */
  bottomOldParent: string | null;
  mode: StackRunMode;
  /** autosquash：不移动任何层，只把 fixup 提交合进去，并核对每层的 tree 不变。 */
  autosquash?: boolean;
  /** 跑 sequence editor 的 node（Electron 里是 process.execPath）。 */
  execPath: string;
  log?: (msg: string) => void;
}

export interface NewTip {
  position: number;
  branch: string;
  oldTip: string;
  newTip: string;
  /** 新的起点（父层的新顶端，栈底是 trunk）。 */
  newBase: string;
}

export type EngineResult =
  | { kind: "noop"; tips: NewTip[] }
  | { kind: "rebased"; tips: NewTip[] }
  | { kind: "conflict"; position: number; branch: string; files: string[]; commit: string | null; onto: string; upstream: string }
  | { kind: "failed"; reason: string };

interface Planned {
  layer: EngineLayer;
  upstream: string;
}

/** 在 candidates 里取是 tip 祖先的、最新的那个（一个是另一个的祖先时取后代）。 */
async function newestAncestor(repo: string, tip: string, candidates: (string | null)[]): Promise<string | null> {
  const ok: string[] = [];
  for (const c of candidates) if (c && !ok.includes(c) && (await isAncestor(repo, c, tip))) ok.push(c);
  let best: string | null = null;
  for (const c of ok) {
    if (best === null || (await isAncestor(repo, best, c))) best = c;
  }
  return best;
}

/** 每层那段提交的起点（设计 3.1 节）。 */
async function upstreams(i: EngineInput): Promise<Planned[] | string> {
  const out: Planned[] = [];
  for (let k = 0; k < i.layers.length; k++) {
    const l = i.layers[k]!;
    let up: string | null;
    if (k === 0) {
      if (i.bottomOldParent) {
        up = (await newestAncestor(i.repo, l.tip, [i.bottomOldParent, l.base])) ?? (await mergeBase(i.repo, l.tip, i.bottomOldParent));
      } else {
        up = await mergeBase(i.repo, l.tip, i.trunk);
      }
    } else {
      const parentOld = i.layers[k - 1]!.tip;
      up = (await newestAncestor(i.repo, l.tip, [parentOld, l.base])) ?? (await mergeBase(i.repo, l.tip, parentOld));
    }
    if (!up) return `no base for ${l.branch}`;
    out.push({ layer: l, upstream: up });
  }
  return out;
}

const tmpPrefix = (runId: number) => `refs/heads/butler-stack/${runId}/`;
const tmpRef = (runId: number, pos: number) => `${tmpPrefix(runId)}${pos}`;
const tmpName = (runId: number, pos: number) => `butler-stack/${runId}/${pos}`;

/** 分段：同一段里每层都正好叠在下一层现在的顶端上（下一层后来没再加提交、也没被改写），一条 --update-refs 命令搬完。 */
function segments(plan: Planned[], from: number, mode: StackRunMode): Planned[][] {
  const segs: Planned[][] = [];
  let cur: Planned[] = [];
  for (let k = from; k < plan.length; k++) {
    const p = plan[k]!;
    if (cur.length > 0 && (mode === "per_layer" || p.upstream !== cur[cur.length - 1]!.layer.tip)) {
      segs.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length > 0) segs.push(cur);
  return segs;
}

export async function runEngine(i: EngineInput): Promise<EngineResult> {
  const log = i.log ?? (() => undefined);
  if (i.layers.length === 0) return { kind: "noop", tips: [] };
  const planned = await upstreams(i);
  if (typeof planned === "string") return { kind: "failed", reason: planned };

  // 从下往上找第一层要动的；它下面的层不变。
  const tips: NewTip[] = [];
  let start = -1;
  let parent = i.trunk;
  for (let k = 0; k < planned.length; k++) {
    const p = planned[k]!;
    if (i.autosquash) {
      // autosquash 从最低的含 fixup 的那层开始；调用方保证栈本来就是最新的。
      start = 0;
      break;
    }
    if (!(await isAncestor(i.repo, parent, p.layer.tip)) || (k === 0 && i.bottomOldParent !== null)) {
      start = k;
      break;
    }
    tips.push({ position: p.layer.position, branch: p.layer.branch, oldTip: p.layer.tip, newTip: p.layer.tip, newBase: parent });
    parent = p.layer.tip;
  }
  if (start === -1) return { kind: "noop", tips };
  // 栈底合并后（bottomOldParent）新栈底已经在 trunk 上（比如 merge commit 合并时它本来就是 trunk 的后代）也照样算一次：
  // 起点会是 trunk 本身，rebase 什么都不做，新顶端等于旧顶端。

  const work = join(i.workRoot, `run-${i.runId}`);
  const wt = join(work, "wt");
  const hooks = join(work, "hooks");
  mkdirSync(hooks, { recursive: true });
  const pre = ["-c", `core.hooksPath=${hooks.replace(/\\/g, "/")}`, "-c", "rerere.enabled=true", "-c", "rerere.autoUpdate=true"];
  const env = sequenceEditorEnv(work, i.execPath, tmpPrefix(i.runId));
  try {
    await gitOk(i.repo, ["worktree", "add", "--detach", "--force", wt, i.trunk], { pre });
    for (const p of planned) await updateRefCas(i.repo, tmpRef(i.runId, p.layer.position), p.layer.tip, null);

    // autosquash 不挪栈底：第一段叠回它自己原来的起点。
    let newParent = i.autosquash ? planned[0]!.upstream : parent;
    for (const seg of segments(planned, start, i.mode)) {
      const top = seg[seg.length - 1]!;
      const first = seg[0]!;
      const onto = newParent;
      const args = ["rebase"];
      if (i.mode === "update_refs") args.push("-i", "--update-refs");
      args.push(i.autosquash ? "--autosquash" : "--no-autosquash", "--empty=drop", "--onto", onto, first.upstream, tmpName(i.runId, top.layer.position));
      log(`stack run ${i.runId}: git ${args.join(" ")}`);
      const conflict = await rebaseWithRerere(wt, args, pre, env);
      if (conflict) {
        const files = conflict.files;
        const commit = conflict.commit;
        let owner = top;
        if (commit) {
          for (const p of seg) {
            if (await isAncestor(i.repo, commit, p.layer.tip)) {
              owner = p;
              break;
            }
          }
        }
        // owner 那一层要在自己的 worktree 里做的那一条：它的新父是 owner 下面那层的新顶端。
        const ownerIdx = seg.indexOf(owner);
        const ownerOnto = ownerIdx === 0 ? onto : (await revParse(i.repo, tmpRef(i.runId, seg[ownerIdx - 1]!.layer.position))) ?? onto;
        return { kind: "conflict", position: owner.layer.position, branch: owner.layer.branch, files, commit, onto: ownerOnto, upstream: owner.upstream };
      }
      let below = onto;
      for (const p of seg) {
        const t = await revParse(i.repo, tmpRef(i.runId, p.layer.position));
        if (!t) return { kind: "failed", reason: `lost ${p.layer.branch}` };
        tips.push({ position: p.layer.position, branch: p.layer.branch, oldTip: p.layer.tip, newTip: t, newBase: below });
        below = t;
      }
      newParent = below;
    }

    if (i.autosquash) {
      for (const t of tips) {
        if ((await treeOf(i.repo, t.oldTip)) !== (await treeOf(i.repo, t.newTip))) {
          return { kind: "failed", reason: `autosquash changed the content of ${t.branch}` };
        }
      }
    }
    const changed = tips.some((t) => t.newTip !== t.oldTip);
    return { kind: changed ? "rebased" : "noop", tips };
  } catch (e) {
    return { kind: "failed", reason: (e as Error).message };
  } finally {
    await cleanup(i.repo, wt, work, i.runId, log);
  }
}

/** 跑 rebase；rerere 解完的冲突自动 --continue。还有没解的冲突时 abort 并返回冲突信息；别的失败抛出。 */
async function rebaseWithRerere(
  wt: string, args: string[], pre: string[], env: Record<string, string>,
): Promise<{ files: string[]; commit: string | null } | null> {
  let r = await runGit(wt, args, { pre, env, timeoutMs: REBASE_TIMEOUT_MS });
  for (let n = 0; n < 50; n++) {
    if (r.code === 0 && !(await inRebase(wt))) return null;
    if (!(await inRebase(wt))) throw new Error(`git rebase failed: ${(r.stderr || r.stdout).trim()}`);
    const files = await unmergedFiles(wt);
    if (files.length > 0) {
      const commit = await revParse(wt, "REBASE_HEAD");
      await runGit(wt, ["rebase", "--abort"], { pre, env });
      return { files, commit };
    }
    // rerere 已经解完并 add 了（rerere.autoUpdate）：接着走。
    r = await runGit(wt, ["rebase", "--continue"], { pre, env, timeoutMs: REBASE_TIMEOUT_MS });
  }
  await runGit(wt, ["rebase", "--abort"], { pre, env });
  throw new Error("git rebase did not finish");
}

async function inRebase(wt: string): Promise<boolean> {
  for (const d of ["rebase-merge", "rebase-apply"]) {
    const r = await runGit(wt, ["rev-parse", "--git-path", d]);
    if (r.code === 0) {
      const p = r.stdout.trim();
      if (existsSync(p) || existsSync(join(wt, p))) return true;
    }
  }
  return false;
}

async function cleanup(repo: string, wt: string, work: string, runId: number, log: (m: string) => void): Promise<void> {
  try {
    if (existsSync(wt)) {
      if (await inRebase(wt)) await runGit(wt, ["rebase", "--abort"]);
      await runGit(repo, ["worktree", "remove", "--force", wt]);
    }
    for (const r of await refsUnder(repo, tmpPrefix(runId).replace(/\/$/, ""))) await deleteRef(repo, r.ref);
  } catch (e) {
    log(`stack run ${runId}: cleanup: ${(e as Error).message}`);
  }
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // Windows 上文件被占用：下次清
  }
  await runGit(repo, ["worktree", "prune"]).catch(() => undefined);
}
