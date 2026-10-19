import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Db } from "./db/database";

export function memDb(): Db {
  return openDatabase(":memory:");
}

/** realpath：macOS 的 /var 实际是 /private/var，git 返回的是真实路径。 */
export function tempDir(prefix = "butler-test-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** 一个带初始提交、当前分支为 main 的临时 git 仓库。 */
export function makeRepo(): string {
  const dir = tempDir("butler-repo-");
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  g("init", "-b", "main");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "hello\n");
  g("add", ".");
  g("commit", "-m", "init");
  return dir;
}
