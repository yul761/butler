import { git as realGit } from "../tickets/git";
import { matchAny, normalizePath } from "../../shared/glob";
import type { DiffFile } from "../../shared/prereview";

/** 给预审模型的 patch 正文总量上限（设计 §4.3）。 */
export const PRE_REVIEW_DIFF_CHARS = 150_000;

export interface PrDiff {
  /** 和哪个提交比的（merge-base）。 */
  base: string | null;
  files: DiffFile[];
  /** 路径 → patch 正文（不含文件头）。 */
  patches: Map<string, string>;
  source: "git" | "github";
}

export type GitRun = (cwd: string, args: string[]) => Promise<string>;

/** `git diff --numstat -z` 的输出：`added\tdeleted\tpath\0`，改名时 `added\tdeleted\t\0old\0new\0`；二进制文件两个数是 `-`。 */
export function parseNumstatZ(out: string): DiffFile[] {
  const parts = out.split("\0");
  const files: DiffFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i]!.replace(/^\n+/, "");
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    let path = m[3]!;
    if (path === "") {
      // 改名：后面两段是旧路径和新路径，取新的。
      i += 2;
      path = parts[i] ?? "";
    }
    if (!path) continue;
    const binary = m[1] === "-" && m[2] === "-";
    files.push({ path: normalizePath(path), added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary });
  }
  return files;
}

/** 整份 unified diff 按文件拆开：`diff --git a/x b/y` 开始一个文件，取 `+++ b/` 的路径（删除的文件取 `--- a/`）。 */
export function splitPatch(out: string): Map<string, string> {
  const map = new Map<string, string>();
  const chunks = out.split(/^diff --git /m).slice(1);
  for (const c of chunks) {
    const lines = c.split("\n");
    let path: string | null = null;
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.startsWith("+++ ")) {
        const p = l.slice(4).trim();
        if (p !== "/dev/null") path = p.replace(/^b\//, "");
        start = i + 1;
        break;
      }
      if (l.startsWith("--- ")) {
        const p = l.slice(4).trim();
        if (p !== "/dev/null") path = p.replace(/^a\//, "");
      }
    }
    if (!path) {
      // 二进制或只改了权限：从 `a/x b/x` 取。
      const m = /^a\/(.+?) b\/(.+)$/.exec(lines[0] ?? "");
      path = m ? m[2]! : null;
      start = lines.length;
    }
    if (path) map.set(normalizePath(path), lines.slice(start).join("\n"));
  }
  return map;
}

/**
 * 这次 PR 的改动：在 worktree 里 `git merge-base <sha> origin/<base>`（没有远端分支时用本地 `<base>`），再 numstat 和 patch。
 * 取不到返回 null（调用方退回 GitHub 的 compare）。
 */
export async function prDiff(cwd: string, sha: string, base: string, run: GitRun = realGit): Promise<PrDiff | null> {
  let mb: string | null = null;
  for (const ref of [`origin/${base}`, base]) {
    try {
      mb = (await run(cwd, ["merge-base", sha, ref])).trim();
      if (mb) break;
    } catch {
      // 换下一个。
    }
  }
  if (!mb) return null;
  try {
    const numstat = await run(cwd, ["diff", "--numstat", "-z", "--no-color", "-M", mb, sha]);
    const patch = await run(cwd, ["diff", "--no-color", "--unified=3", "-M", "--no-ext-diff", mb, sha]);
    return { base: mb, files: parseNumstatZ(numstat), patches: splitPatch(patch), source: "git" };
  } catch {
    return null;
  }
}

/** GitHub compare 的结果（`compareFiles`）转成同样的形状：行数从 patch 里数。 */
export function fromCompare(rows: { filename: string; patch: string }[]): PrDiff {
  const files: DiffFile[] = [];
  const patches = new Map<string, string>();
  for (const r of rows) {
    let added = 0;
    let deleted = 0;
    for (const l of r.patch.split("\n")) {
      if (l.startsWith("+") && !l.startsWith("+++")) added++;
      else if (l.startsWith("-") && !l.startsWith("---")) deleted++;
    }
    const path = normalizePath(r.filename);
    files.push({ path, added, deleted, binary: r.patch === "" });
    if (r.patch) patches.set(path, r.patch);
  }
  return { base: null, files, patches, source: "github" };
}

/**
 * 给模型的 diff 正文：生成文件只给统计；其余按改动行数从多到少放，总量到上限为止，超出的文件注明「正文没给」。
 */
export function diffForModel(d: PrDiff, generated: readonly string[], limit = PRE_REVIEW_DIFF_CHARS): { text: string; omitted: string[] } {
  const omitted: string[] = [];
  const parts: string[] = [];
  let used = 0;
  const order = [...d.files].sort((a, b) => b.added + b.deleted - (a.added + a.deleted) || (a.path < b.path ? -1 : 1));
  for (const f of order) {
    const head = `### ${f.path} (+${f.added} -${f.deleted}${f.binary ? ", binary" : ""})`;
    const body = d.patches.get(f.path);
    if (f.binary || !body || matchAny(f.path, generated)) {
      parts.push(`${head}\n(stats only)`);
      continue;
    }
    if (used + body.length > limit) {
      omitted.push(f.path);
      parts.push(`${head}\n(patch omitted: size limit)`);
      continue;
    }
    used += body.length;
    parts.push(`${head}\n\`\`\`diff\n${body}\n\`\`\``);
  }
  return { text: parts.join("\n\n"), omitted };
}
