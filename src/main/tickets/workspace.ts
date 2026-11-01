import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { featureDirName } from "../util/ticket-file";
import { repoRoot } from "./git";
import { samePath, TicketError } from "./ticket-service";
import { M } from "../strings";

/** feature 和 epic 共用的工作区路径、名字、仓库校验。 */

/** 默认放在仓库上一层的旁边：~/Code/shop/frontend → ~/Code/shop-<suffix>/<名字>（suffix 是 features 或 epics）。 */
export function defaultWorkspaceDir(repoPaths: string[], name: string, suffix: "features" | "epics"): string {
  const parent = dirname(repoPaths[0]);
  return join(dirname(parent), `${basename(parent)}-${suffix}`, featureDirName(name));
}

/**
 * 工作区目录：展开 ~，必须是绝对路径；建好之后存真实路径（claude 和 hook 报上来的 cwd 是真实路径，经过 symlink 的写法对不上）。
 */
export function resolveWorkspaceDir(dir: string, homeDir?: string): string {
  const expanded = dir === "~" || dir.startsWith("~/") || dir.startsWith("~\\") ? join(homeDir ?? homedir(), dir.slice(1)) : dir;
  if (!isAbsolute(expanded)) throw new TicketError("invalid_workspace", M().workspaceNotAbsolute(dir));
  const abs = resolve(expanded);
  try {
    mkdirSync(abs, { recursive: true });
    return realpathSync.native(abs);
  } catch (e) {
    throw new TicketError("invalid_workspace", M().workspaceCannotCreate(abs, (e as Error).message));
  }
}

/** 名字去掉首尾空白，不能为空、不能超过上限；不合格时抛 invalid_name，提示文字由调用方给。 */
export function checkNameLimit(name: string, limit: number, invalidMessage: string): string {
  const n = name.trim();
  if (!n || n.length > limit) throw new TicketError("invalid_name", invalidMessage);
  return n;
}

export async function gitRootOf(path: string): Promise<string> {
  try {
    return await repoRoot(path);
  } catch {
    throw new TicketError("not_git_repo", M().notGitRepo(path));
  }
}

/** 校验并去重一组仓库路径，返回各自的仓库根。 */
export async function uniqueRoots(repoPaths: string[]): Promise<string[]> {
  if (repoPaths.length === 0) throw new TicketError("not_git_repo", M().pickAtLeastOneRepo);
  const roots: string[] = [];
  for (const p of repoPaths) {
    const root = await gitRootOf(p);
    if (!roots.some((r) => samePath(r, root))) roots.push(root);
  }
  return roots;
}
