// 测试用：把 fixture 写进临时目录并 git init（不进生产代码）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function writeRepo(files: Record<string, string>, opts: { git?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "shipherd-baseline-"));
  for (const [p, text] of Object.entries(files)) {
    const abs = join(root, ...p.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  if (opts.git !== false) {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env });
    execFileSync("git", ["-c", "core.autocrlf=false", "add", "-A"], { cwd: root, env });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: root, env });
  }
  return root;
}
