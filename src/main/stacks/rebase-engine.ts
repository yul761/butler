import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { StackRunMode } from "../../shared/stacks";
import {
  REBASE_TIMEOUT_MS, deleteRef, gitOk, isAncestor, mergeBase, refsUnder, revParse, runGit, treeOf, unmergedFiles, updateRefCas,
} from "./git-stack";
import { withRepoLock } from "../tickets/repo-lock";
import { sequenceEditorEnv } from "./seq-editor";

/**
 * 整栈 rebase 的引擎（设计 3.1–3.3 节）：只在 Shipherd 自己的临时 detached worktree 里、用指向各层顶端的临时分支做，
 * 真分支一个都不动；成功时返回各层的新顶端，由 apply 去 CAS 更新真分支。
 */

export interface EngineLayer {
  position: number;
  branch: string;
  /** 现在的本地顶端。 */
  tip: string;
  /** 记录的起点（上次同步时父层的顶端）。 */
  base: string | null;
  /**
   * 上次冲突时让 session 叠上去的那个提交（session 照做以后这一层就在它上面）。
   * 也是起点的候选：不然 session 解完冲突后，下一次会从很早的分叉点算起、把别的提交也重放一遍。
   */
  conflictOnto?: string | null;
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
  /** below：冲突那层下面各层这次的新顶端（没动的 newTip 等于 oldTip）。 */
  | { kind: "conflict"; position: number; branch: string; files: string[]; commit: string | null; onto: string; upstream: string; below: NewTip[] }
  | { kind: "failed"; reason: string };

interface Planned {
  layer: EngineLayer;
  upstream: string;
}

type SegResult =
  | { kind: "ok"; tips: NewTip[] }
  | { kind: "conflict"; ownerIdx: number; files: string[]; commit: string | null }
  | { kind: "failed"; reason: string };

/** 本地没有这个提交（比如合并时的 head 没 fetch 到）时当成「不是祖先」，不抛。 */
const ancestor = (repo: string, a: string, b: string): Promise<boolean> => isAncestor(repo, a, b).catch(() => false);

/** 在 candidates 里取是 tip 祖先的、最新的那个（一个是另一个的祖先时取后代）。 */
async function newestAncestor(repo: string, tip: string, candidates: (string | null | undefined)[]): Promise<string | null> {
  const ok: string[] = [];
  for (const c of candidates) if (c && !ok.includes(c) && (await ancestor(repo, c, tip))) ok.push(c);
  let best: string | null = null;
  for (const c of ok) {
    if (best === null || (await ancestor(repo, best, c))) best = c;
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
        // 已经叠在 trunk 上（比如 session 照冲突提示做过了）时 trunk 本身就是起点
        up = (await newestAncestor(i.repo, l.tip, [i.bottomOldParent, l.base, l.conflictOnto, i.trunk]))
          ?? (await mergeBase(i.repo, l.tip, i.bottomOldParent)) ?? (await mergeBase(i.repo, l.tip, i.trunk));
      } else {
        up = await mergeBase(i.repo, l.tip, i.trunk);
      }
    } else {
      const parentOld = i.layers[k - 1]!.tip;
      up = (await newestAncestor(i.repo, l.tip, [parentOld, l.base, l.conflictOnto])) ?? (await mergeBase(i.repo, l.tip, parentOld));
    }
    if (!up) return `no base for ${l.branch}`;
    out.push({ layer: l, upstream: up });
  }
  return out;
}

const tmpPrefix = (runId: number) => `refs/heads/shipherd-stack/${runId}/`;
const tmpRef = (runId: number, pos: number) => `${tmpPrefix(runId)}${pos}`;
const tmpName = (runId: number, pos: number) => `shipherd-stack/${runId}/${pos}`;

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
    if (!(await ancestor(i.repo, parent, p.layer.tip)) || (k === 0 && i.bottomOldParent !== null)) {
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
  // abbreviateCommands 关掉：sequence editor 认的是完整的 update-ref 行（它也认缩写，双保险）。
  // rerere 关掉（BTL-278）：rr-cache 在共用的 git 目录里，所有 worktree 共用一份，session 解过又放弃的解法也在里面；
  // 自动 rebase 套用它、再强推，等于把没人核对过的解法推上去。冲突一律交给那一层的 session。
  const pre = [
    "-c", `core.hooksPath=${hooks.replace(/\\/g, "/")}`, "-c", "rerere.enabled=false", "-c", "rebase.abbreviateCommands=false",
  ];
  const env = sequenceEditorEnv(work, i.execPath, tmpPrefix(i.runId));
  try {
    // 仓库锁（BTL-264）只包这一条：和建 ticket 的 worktree add 抢 .git/worktrees。rebase 本身在临时 worktree 里，不锁。
    await withRepoLock(i.repo, () => gitOk(i.repo, ["worktree", "add", "--detach", "--force", wt, i.trunk], { pre }), `add stack run ${i.runId}'s temporary worktree`);
    for (const p of planned) await updateRefCas(i.repo, tmpRef(i.runId, p.layer.position), p.layer.tip, null);

    // autosquash 不挪栈底：第一段叠回它自己原来的起点。
    let newParent = i.autosquash ? planned[0]!.upstream : parent;
    const rebaseSeg = async (seg: Planned[], onto: string): Promise<SegResult> => {
      const top = seg[seg.length - 1]!;
      const first = seg[0]!;
      // 总是 -i：sequence editor 才会跑（rebase.updateRefs 配置下也挡得住真分支），老 git 上 --autosquash 也才生效
      const args = ["rebase", "-i"];
      if (i.mode === "update_refs" && seg.length > 1) args.push("--update-refs");
      args.push(i.autosquash ? "--autosquash" : "--no-autosquash", "--empty=drop", "--onto", onto, first.upstream, tmpName(i.runId, top.layer.position));
      log(`stack run ${i.runId}: git ${args.join(" ")}`);
      const conflict = await rebaseOnce(wt, args, pre, env);
      if (conflict) {
        let ownerIdx = seg.length - 1;
        if (conflict.commit) {
          for (let k = 0; k < seg.length; k++) {
            if (await ancestor(i.repo, conflict.commit, seg[k]!.layer.tip)) {
              ownerIdx = k;
              break;
            }
          }
        }
        return { kind: "conflict", ownerIdx, files: conflict.files, commit: conflict.commit };
      }
      const out: NewTip[] = [];
      let below = onto;
      for (const p of seg) {
        const t = await revParse(i.repo, tmpRef(i.runId, p.layer.position));
        if (!t) return { kind: "failed", reason: `lost ${p.layer.branch}` };
        out.push({ position: p.layer.position, branch: p.layer.branch, oldTip: p.layer.tip, newTip: t, newBase: below });
        below = t;
      }
      return { kind: "ok", tips: out };
    };
    let doneInSeg: NewTip[] = [];
    for (const seg0 of segments(planned, start, i.mode)) {
      doneInSeg = [];
      let r = await rebaseSeg(seg0, newParent);
      let seg = seg0;
      if (r.kind === "conflict" && r.ownerIdx > 0) {
        // 一段里不是第一层冲突：--update-refs 只在整段做完时才写临时分支，冲突那层下面的新顶端拿不到。
        // 改成一层一层地重做这一段，冲突那条命令的 onto 就是它下面那层真正的新顶端。
        for (const p of seg0) await gitOk(i.repo, ["update-ref", tmpRef(i.runId, p.layer.position), p.layer.tip]);
        const acc: NewTip[] = [];
        doneInSeg = acc;
        let onto = newParent;
        r = { kind: "ok", tips: acc };
        for (const p of seg0) {
          const one = await rebaseSeg([p], onto);
          if (one.kind !== "ok") {
            r = one;
            seg = [p];
            newParent = onto;
            break;
          }
          acc.push(...one.tips);
          onto = one.tips[0]!.newTip;
        }
      }
      if (r.kind === "failed") return { kind: "failed", reason: r.reason };
      if (r.kind === "conflict") {
        // owner 那一层要在自己的 worktree 里做的那一条：它的新父是 owner 下面那层的新顶端（段首就是这段的 onto）。
        const owner = seg[r.ownerIdx]!;
        return {
          kind: "conflict", position: owner.layer.position, branch: owner.layer.branch, files: r.files, commit: r.commit, onto: newParent, upstream: owner.upstream,
          below: [...tips, ...doneInSeg],
        };
      }
      tips.push(...r.tips);
      newParent = r.tips[r.tips.length - 1]!.newTip;
    }

    if (i.autosquash) {
      for (const t of tips) {
        if ((await treeOf(i.repo, t.oldTip)) !== (await treeOf(i.repo, t.newTip))) {
          return { kind: "failed", reason: `autosquash changed the content of ${t.branch}` };
        }
      }
    }
    const changed = tips.some((t) => t.newTip !== t.oldTip);
    if (changed && !i.autosquash) {
      // 强推前的护栏（BTL-278）：结果里比应有的多出冲突标记（合并驱动、hook 之类把没解完的冲突当成解完了）就不落地。
      const bases = new Map(planned.map((p) => [p.layer.branch, p.upstream]));
      const bad = await markersAdded(i.repo, tips.filter((t) => t.newTip !== t.oldTip).map((t) => ({ ...t, oldBase: bases.get(t.branch)! })));
      if (bad.length > 0) return { kind: "failed", reason: `conflict markers left in ${bad.map((b) => `${b.branch}: ${b.files.join(", ")}`).join("; ")}` };
    }
    return { kind: changed ? "rebased" : "noop", tips };
  } catch (e) {
    return { kind: "failed", reason: (e as Error).message };
  } finally {
    await cleanup(i.repo, wt, work, i.runId, log);
  }
}

/**
 * 跑一次 rebase。停下来有没解的冲突：abort 并返回冲突信息。停下来却没有冲突（不该发生：rerere 关着、
 * sequence editor 只写 pick 和 update-ref）：abort 并抛出，不自己 --continue（BTL-278）。别的失败也抛出。
 */
async function rebaseOnce(
  wt: string, args: string[], pre: string[], env: Record<string, string>,
): Promise<{ files: string[]; commit: string | null } | null> {
  const r = await runGit(wt, args, { pre, env, timeoutMs: REBASE_TIMEOUT_MS });
  if (!(await inRebase(wt))) {
    if (r.code === 0) return null;
    throw new Error(`git rebase failed: ${(r.stderr || r.stdout).trim()}`);
  }
  const files = await unmergedFiles(wt);
  const at = await revParse(wt, "REBASE_HEAD");
  await runGit(wt, ["rebase", "--abort"], { pre, env });
  if (files.length > 0) return { files, commit: at };
  throw new Error(`git rebase stopped without a conflict: ${(r.stderr || r.stdout).trim()}`);
}

const MARKER = "^(<<<<<<<|>>>>>>>)( |$)";

/**
 * 一次 git grep 的参数最多多长（BTL-278）：Windows 的整条命令行最长 32767 个字符，git 的路径、引号、转义还要占一些；
 * 原来按 100 个路径一批，路径一长（monorepo 里 200 多字的很常见）就超了。
 */
const GREP_ARGS_BUDGET = 24_000;

/** 按总长度分批（每个参数另算 3 个字符：空格和可能加的一对引号）；单个就超了的自己一批。 */
export function batchByLength(items: string[], budget: number): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const it of items) {
    const n = it.length + 3;
    if (cur.length > 0 && len + n > budget) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(it);
    len += n;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * 每层新顶端里比「应有的」多出冲突标记的文件。应有的 = 新起点里的 + 这一层自己那段提交带进来的（旧顶端减旧起点），
 * 这样层里、trunk 里本来就有的标记（测试夹具之类）不算。只看这一层（新起点..新顶端）改到的文件（BTL-278：原来每个
 * 版本的整棵树都 grep 一遍，大仓库里会超时）：没改到的文件新顶端和新起点一样，不会多出标记。git 出错、超时都抛出。
 */
export async function markersAdded(
  repo: string, tips: { branch: string; oldTip: string; newTip: string; oldBase: string; newBase: string }[], budget = GREP_ARGS_BUDGET,
): Promise<{ branch: string; files: string[] }[]> {
  if (tips.length === 0) return [];
  const touched = new Set<string>();
  for (const t of tips) {
    const d = await runGit(repo, ["diff", "--name-only", "--no-renames", "-z", t.newBase, t.newTip]);
    if (d.code !== 0) throw new Error(`git diff failed: ${d.stderr.trim()}`);
    for (const f of d.stdout.split("\0")) if (f) touched.add(f);
  }
  if (touched.size === 0) return [];
  const revs = [...new Set(tips.flatMap((t) => [t.oldTip, t.newTip, t.oldBase, t.newBase]))];
  const counts = new Map<string, Map<string, number>>();
  // 用户配了 color.ui=always 时输出带颜色码，下面就一行都认不出来：关掉颜色。路径按字面认（文件名开头的 :! 之类不当 pathspec 的 magic）。
  const fixed = ["--literal-pathspecs", "-c", "color.grep=false", "grep", "--no-color", "-I", "-c", "-E", MARKER, "--"];
  const room = budget - fixed.reduce((a, x) => a + x.length + 3, 0);
  // 版本和路径都按长度分：版本最多占一半
  const batches: [string[], string[]][] = [];
  for (const rs of batchByLength(revs, Math.floor(room / 2))) {
    const left = room - rs.reduce((a, x) => a + x.length + 3, 0);
    for (const ps of batchByLength([...touched], left)) batches.push([rs, ps]);
  }
  for (const [rs, ps] of batches) {
    const r = await runGit(repo, [...fixed.slice(0, -1), ...rs, "--", ...ps]);
    // 1 = 一处都没有
    if (r.code !== 0 && r.code !== 1) throw new Error(`git grep failed: ${r.stderr.trim()}`);
    let seen = 0;
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^([0-9a-f]{7,64}):(.*):(\d+)$/.exec(line);
      if (!m) continue;
      seen++;
      const per = counts.get(m[1]!) ?? new Map<string, number>();
      per.set(m[2]!, Number(m[3]));
      counts.set(m[1]!, per);
    }
    // 有匹配却一行都没认出来：输出格式不对，不能当成「没有标记」放过去
    if (r.code === 0 && seen === 0) throw new Error(`git grep: unexpected output: ${r.stdout.slice(0, 200)}`);
  }
  const n = (rev: string, f: string) => counts.get(rev)?.get(f) ?? 0;
  const out: { branch: string; files: string[] }[] = [];
  for (const t of tips) {
    const files = [...(counts.get(t.newTip)?.keys() ?? [])].filter((f) => n(t.newTip, f) > n(t.newBase, f) + Math.max(0, n(t.oldTip, f) - n(t.oldBase, f)));
    if (files.length > 0) out.push({ branch: t.branch, files });
  }
  return out;
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
      await withRepoLock(repo, () => runGit(repo, ["worktree", "remove", "--force", wt]), `remove stack run ${runId}'s temporary worktree`);
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
  await withRepoLock(repo, () => runGit(repo, ["worktree", "prune"]), `prune worktrees after stack run ${runId}`).catch(() => undefined);
}
