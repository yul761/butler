// 仓库的文件列表（设计 §3.2、§9）：git ls-files（跟踪的 + 没被忽略的新文件），路径用 /，非 ASCII 不转义。
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { GIT_SAFE_ARGS, gitBinary } from "../util/git-path";
import { gitEnv } from "../tickets/git";
import type { BaselineSkipReason } from "../../shared/baselines";

export const LISTING_MAX_FILES = 200_000;
const MAX_BUFFER = 256 * 1024 * 1024;

export type Listing = { ok: true; files: string[]; truncated: boolean } | { ok: false; reason: BaselineSkipReason; detail: string };

function run(cwd: string, args: string[]): Promise<{ ok: true; out: string } | { ok: false; err: string }> {
  return new Promise((resolve) => {
    let bin: string;
    try {
      bin = gitBinary();
    } catch (e) {
      resolve({ ok: false, err: (e as Error).message });
      return;
    }
    execFile(bin, [...GIT_SAFE_ARGS, "-c", "core.quotepath=off", ...args], { cwd, env: gitEnv(process.env), windowsHide: true, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, err: String(stderr).trim() || err.message });
      else resolve({ ok: true, out: String(stdout) });
    });
  });
}

/** 本地路径能不能扫：不存在（没 clone）、不是目录 / 读不了、不是 git 仓库。 */
export function checkRoot(root: string | null): { ok: true } | { ok: false; reason: BaselineSkipReason; detail: string } {
  if (!root) return { ok: false, reason: "not_cloned", detail: "" };
  if (!existsSync(root)) return { ok: false, reason: "not_cloned", detail: root };
  try {
    if (!statSync(root).isDirectory()) return { ok: false, reason: "unreadable", detail: root };
  } catch (e) {
    return { ok: false, reason: "unreadable", detail: (e as Error).message };
  }
  if (!existsSync(join(root, ".git"))) return { ok: false, reason: "not_git", detail: root };
  return { ok: true };
}

export async function listRepoFiles(root: string, max = LISTING_MAX_FILES): Promise<Listing> {
  const c = checkRoot(root);
  if (!c.ok) return c;
  const r = await run(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (!r.ok) {
    const notGit = /not a git repository/i.test(r.err);
    return { ok: false, reason: notGit ? "not_git" : "unreadable", detail: r.err.slice(0, 500) };
  }
  const seen = new Set<string>();
  const files: string[] = [];
  for (const raw of r.out.split("\0")) {
    if (!raw) continue;
    const f = raw.replace(/\\/g, "/");
    if (seen.has(f)) continue;
    seen.add(f);
    files.push(f);
  }
  files.sort();
  const truncated = files.length > max;
  return { ok: true, files: truncated ? files.slice(0, max) : files, truncated };
}
