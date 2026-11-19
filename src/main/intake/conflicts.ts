// 同仓库冲突预判（设计补充 ws-n 第 5.1 节）：只读，不写合并闸门的表。
import { normalizePath } from "../../shared/glob";
import { defaultBase, type GitRun } from "../prereview/diff";

const norm = (p: string, ci: boolean): string => {
  const s = normalizePath(p.trim());
  return ci ? s.toLowerCase() : s;
};

/** 两条路径重叠：同一个文件，或一个是另一个的目录前缀（`src/` 和 `src/a.ts`）。Windows 上不分大小写。 */
export function pathsOverlap(a: string, b: string, caseInsensitive = process.platform === "win32"): boolean {
  const x = norm(a, caseInsensitive).replace(/\/+$/, "");
  const y = norm(b, caseInsensitive).replace(/\/+$/, "");
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export interface RunningWork {
  key: string;
  paths: string[];
}

/** 预计要改的路径和在跑的哪些 ticket 重叠：返回重叠的 ticket 和前几条重叠的路径。没有预计路径时判断不了，当作不冲突。 */
export function predictConflicts(expected: readonly string[], running: readonly RunningWork[], caseInsensitive?: boolean): { key: string; paths: string[] }[] {
  if (expected.length === 0) return [];
  const out: { key: string; paths: string[] }[] = [];
  for (const r of running) {
    const hit = expected.filter((e) => r.paths.some((p) => pathsOverlap(e, p, caseInsensitive)));
    if (hit.length) out.push({ key: r.key, paths: hit.slice(0, 5) });
  }
  return out;
}

/** 一个 worktree 相对主干改过的文件（已提交 + 没提交的 + 没跟踪的）。拿不到为 []。 */
export async function changedPaths(cwd: string, run: GitRun): Promise<string[]> {
  try {
    const name = await defaultBase(cwd, run);
    if (!name) return [];
    let base: string | null = null;
    for (const ref of [`origin/${name}`, name]) {
      try {
        base = (await run(cwd, ["merge-base", "HEAD", ref])).trim();
        if (base) break;
      } catch {
        // 换下一个
      }
    }
    if (!base) return [];
    const tracked = (await run(cwd, ["diff", "--name-only", "-z", base])).split("\0");
    const untracked = (await run(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0");
    return [...new Set([...tracked, ...untracked].map((p) => normalizePath(p)).filter(Boolean))].slice(0, 2000);
  } catch {
    return [];
  }
}
