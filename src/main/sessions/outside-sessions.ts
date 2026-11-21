/**
 * 「显示 Butler 之外开的 session」（showOutsideSessions，BTL-244）：默认关。
 * 关着时不扫描 ~/.claude/projects 去发现未认领 session，未认领列表也是空的；Butler 自己的 session 不受影响。
 */
export function outsideSessionsOn(settings: { get(key: "showOutsideSessions"): string }): boolean {
  return settings.get("showOutsideSessions") === "1";
}

/**
 * Butler 自己的 session 缺分支时，从它的目录读一次当前分支（BTL-244）。
 * 以前分支只靠扫描 transcript 补；扫描默认关掉以后，CI 结论按分支挑接收者、PR 阶段事件、度量都要靠这里。
 * 每个 session 每次运行最多读一次；游离 HEAD、不是仓库的目录（总控的工作区）不记。
 */
export async function fillBranchFromCwd(
  s: { id: string; cwd: string; gitBranch: string | null; origin: string; dismissed: boolean },
  deps: { tried: Set<string>; currentBranch: (cwd: string) => Promise<string>; fill: (id: string, branch: string) => void },
): Promise<void> {
  if (s.gitBranch || !s.cwd || s.origin !== "butler" || s.dismissed || deps.tried.has(s.id)) return;
  deps.tried.add(s.id);
  let branch: string;
  try {
    branch = (await deps.currentBranch(s.cwd)).trim();
  } catch {
    return;
  }
  if (branch && branch !== "HEAD") deps.fill(s.id, branch);
}
