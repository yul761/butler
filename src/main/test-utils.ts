import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Db } from "./db/database";
import type { PtyFactory, PtyProcess } from "./sessions/pty-manager";

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

export class FakePty implements PtyProcess {
  pid = 4242;
  written: string[] = [];
  resized: [number, number][] = [];
  killed = false;
  private dataCbs: ((d: string) => void)[] = [];
  private exitCbs: ((e: { exitCode: number }) => void)[] = [];
  onData(cb: (d: string) => void): void {
    this.dataCbs.push(cb);
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCbs.push(cb);
  }
  write(d: string): void {
    this.written.push(d);
  }
  resize(c: number, r: number): void {
    this.resized.push([c, r]);
  }
  kill(): void {
    this.killed = true;
    this.emitExit(0);
  }
  emit(d: string): void {
    this.dataCbs.forEach((cb) => cb(d));
  }
  emitExit(code: number): void {
    this.exitCbs.forEach((cb) => cb({ exitCode: code }));
  }
}

export function fakePtyFactory() {
  const spawned: { file: string; args: string[]; opts: Parameters<PtyFactory>[2]; pty: FakePty }[] = [];
  const factory: PtyFactory = (file, args, opts) => {
    const pty = new FakePty();
    spawned.push({ file, args, opts, pty });
    return pty;
  };
  return { factory, spawned };
}
