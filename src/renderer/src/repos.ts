import type { ScanResult, SessionView, TicketRepo } from "../../shared/types";

/** 路径的最后一段（渲染进程没有 node:path；两种分隔符都认）。 */
export function lastSegment(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 仓库在界面上的名字：仓库目录名。 */
export function repoName(r: TicketRepo): string {
  return lastSegment(r.repoPath);
}

/** 仓库在哪里工作：worktree 目录，或者“仓库 @ 分支”。 */
export function repoWhere(r: TicketRepo): string {
  return r.workMode === "worktree" && r.worktreePath ? r.worktreePath : `${r.repoPath} @ ${r.branch}`;
}

/** session 按钮前面的小标签：总控、仓库名；单仓库 ticket 不显示（和以前一样）。 */
export function sessionPlace(s: SessionView, repos: TicketRepo[], coordinatorLabel: string): string | null {
  if (s.coordinator) return coordinatorLabel;
  if (repos.length <= 1) return null;
  const r = repos.find((x) => x.id === s.repoId);
  return r ? repoName(r) : null;
}

/**
 * 选目录的结果变成要提交的仓库（设计文档 2026-10-26）：仓库 → 它的根目录；上一层目录 → 下一层的仓库全选，给出勾选项；
 * 都不是 → 保留输入的目录，交给主进程报出具体原因。
 */
export function scanToSelection(scan: ScanResult, typed: string): { paths: string[]; options: string[] | null; notFound: boolean } {
  if (scan.kind === "repo") return { paths: [scan.root], options: null, notFound: false };
  if (scan.kind === "parent") return { paths: [...scan.repos], options: scan.repos, notFound: false };
  return { paths: [typed], options: null, notFound: true };
}
