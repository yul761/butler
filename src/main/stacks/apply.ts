import type { RunLayerDetail } from "../db/stacks-repo";
import { gitOk, isAncestor, revParse, runGit, trackedDirty, untrackedInTheWay, updateRefCas } from "./git-stack";

/**
 * 把引擎算出来的新顶端落到真分支上（设计 3.4 节）：先全部预检，再写备份引用、逐层 CAS，
 * 中途失败全部改回（备份引用留着）；最后推远端已有的分支（force_push 开关在调用方的 push 里）。
 */

export interface ApplyLayer {
  position: number;
  branch: string;
  oldTip: string;
  newTip: string;
  /** 检出这个分支的目录：managed = Shipherd 管理的 ticket worktree。null = 没检出。 */
  checkout: { path: string; managed: boolean } | null;
  /** 远端分支现在的提交（fetch 之后）；null = 远端没有这个分支。 */
  remoteTip: string | null;
  /** 上次 K 改写之前远端的提交（开关关着没推出去时远端还停在它）。 */
  remoteOkSha: string | null;
}

export interface ApplyInput {
  repo: string;
  stackId: number;
  runId: number;
  layers: ApplyLayer[];
  /** 恢复备份时不再写新的备份。 */
  backup?: boolean;
  /** 那个 worktree 的 session 在忙（活动不是 idle / waiting）。 */
  sessionBusy(path: string): boolean;
  /** 推一个分支（调用方套 ExternalActions.attempt("force_push")）：true = 推了，false = 开关关着。抛错 = 推失败。 */
  push(layer: ApplyLayer): Promise<boolean>;
  log?: (msg: string) => void;
}

export type DeferReason =
  | { code: "checked_out"; branch: string; path: string }
  | { code: "dirty"; branch: string; path: string }
  | { code: "untracked"; branch: string; path: string; files: string[] }
  | { code: "head_moved"; branch: string }
  | { code: "session_busy"; branch: string; path: string }
  | { code: "remote_ahead"; branch: string };

export type ApplyResult =
  | { kind: "deferred"; reason: DeferReason }
  | { kind: "rolled_back"; reason: string; layers: RunLayerDetail[] }
  | { kind: "applied"; layers: RunLayerDetail[]; pushed: string[]; unpushed: string[]; pushFailed: { branch: string; error: string }[] };

export const backupRef = (stackId: number, runId: number, position: number) => `refs/shipherd/stack-backup/${stackId}/${runId}/${position}`;

export function deferText(r: DeferReason): string {
  switch (r.code) {
    case "checked_out":
      return `${r.branch} is checked out in ${r.path}`;
    case "dirty":
      return `${r.branch} has uncommitted changes in ${r.path}`;
    case "untracked":
      return `untracked files in ${r.path} would be overwritten: ${r.files.slice(0, 5).join(", ")}`;
    case "head_moved":
      return `${r.branch} moved during the run`;
    case "session_busy":
      return `the session working on ${r.branch} is busy`;
    case "remote_ahead":
      return `the remote ${r.branch} has commits that are not local`;
  }
}

/** 每层都过了才返回 null。 */
export async function preflight(i: Pick<ApplyInput, "repo" | "layers" | "sessionBusy">): Promise<DeferReason | null> {
  for (const l of i.layers) {
    if (l.oldTip === l.newTip) continue;
    if ((await revParse(i.repo, `refs/heads/${l.branch}`)) !== l.oldTip) return { code: "head_moved", branch: l.branch };
    if (l.checkout) {
      if (!l.checkout.managed) return { code: "checked_out", branch: l.branch, path: l.checkout.path };
      if (i.sessionBusy(l.checkout.path)) return { code: "session_busy", branch: l.branch, path: l.checkout.path };
      if (await trackedDirty(l.checkout.path)) return { code: "dirty", branch: l.branch, path: l.checkout.path };
      const inTheWay = await untrackedInTheWay(l.checkout.path, l.oldTip, l.newTip);
      if (inTheWay.length > 0) return { code: "untracked", branch: l.branch, path: l.checkout.path, files: inTheWay };
      if ((await revParse(l.checkout.path, "HEAD")) !== l.oldTip) return { code: "head_moved", branch: l.branch };
    }
    if (l.remoteTip && l.remoteTip !== l.remoteOkSha && !(await isAncestor(i.repo, l.remoteTip, l.oldTip))) {
      return { code: "remote_ahead", branch: l.branch };
    }
  }
  return null;
}

async function move(repo: string, l: ApplyLayer, from: string, to: string): Promise<void> {
  if (l.checkout) {
    const head = await revParse(l.checkout.path, "HEAD");
    if (head !== from) throw new Error(`${l.branch} moved in ${l.checkout.path}`);
    await gitOk(l.checkout.path, ["reset", "--keep", "--quiet", to]);
  } else {
    await updateRefCas(repo, `refs/heads/${l.branch}`, to, from);
  }
}

export async function applyTips(i: ApplyInput): Promise<ApplyResult> {
  const log = i.log ?? (() => undefined);
  const changed = i.layers.filter((l) => l.oldTip !== l.newTip);
  const defer = await preflight({ repo: i.repo, layers: changed, sessionBusy: i.sessionBusy });
  if (defer) return { kind: "deferred", reason: defer };

  const details: RunLayerDetail[] = [];
  for (const l of changed) {
    let ref: string | null = null;
    if (i.backup !== false) {
      ref = backupRef(i.stackId, i.runId, l.position);
      await updateRefCas(i.repo, ref, l.oldTip, null);
    }
    details.push({ position: l.position, branch: l.branch, oldTip: l.oldTip, newTip: l.newTip, backupRef: ref });
  }

  const moved: ApplyLayer[] = [];
  try {
    for (const l of changed) {
      await move(i.repo, l, l.oldTip, l.newTip);
      moved.push(l);
    }
  } catch (e) {
    const reason = (e as Error).message;
    log(`stack ${i.stackId} run ${i.runId}: rolling back: ${reason}`);
    for (const l of moved.reverse()) {
      try {
        await move(i.repo, l, l.newTip, l.oldTip);
      } catch (e2) {
        // 改不回来：备份引用（refs/shipherd/stack-backup/…）还在，可以照它手动改回。
        log(`stack ${i.stackId} run ${i.runId}: could not restore ${l.branch}: ${(e2 as Error).message}`);
      }
    }
    return { kind: "rolled_back", reason, layers: details };
  }

  const pushed: string[] = [];
  const unpushed: string[] = [];
  const pushFailed: { branch: string; error: string }[] = [];
  // 从下往上推：上面的层要知道下面的推没推上去（BTL-278）
  for (const l of [...changed].sort((a, b) => a.position - b.position)) {
    if (!l.remoteTip) continue;
    try {
      if (await i.push(l)) pushed.push(l.branch);
      else unpushed.push(l.branch);
    } catch (e) {
      pushFailed.push({ branch: l.branch, error: (e as Error).message });
      unpushed.push(l.branch);
    }
  }
  return { kind: "applied", layers: details, pushed, unpushed, pushFailed };
}

/** 每日清理：删掉旧 run 的备份引用。 */
export async function deleteBackups(repo: string, refs: string[]): Promise<void> {
  for (const r of refs) await runGit(repo, ["update-ref", "-d", r]);
}
