import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Db } from "./db/database";
import type { PtyFactory, PtyProcess } from "./sessions/pty-manager";

/** 有界轮询：等文件出现并返回内容；超时抛错。 */
export async function waitForFile(path: string, ms: number): Promise<string> {
  const end = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`file not written within ${ms} ms: ${path}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return readFileSync(path, "utf8");
}

/** 有界轮询：进程是否在 ms 毫秒内死掉。 */
export async function waitUntilDead(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

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

export interface FakeCall {
  args: string[];
  input: string;
  butlerSession: string | null;
  cwd: string;
}

/**
 * 写一个假的 claude 可执行文件（Node 脚本）。它把参数、stdin、BUTLER_SESSION 和 cwd 记到日志里，然后执行 body。
 * body 里可用：args、input、call（第几次调用，从 1 开始）、emit(obj)（写一行 JSON）、
 * result(structured, extra?)（写一条成功的 --output-format json 结果，session_id 为 "fork-<call>"）。
 * Windows 上额外生成一个 .cmd 包装并返回它的路径，这样测试会经过 cross-spawn 的 cmd.exe 转义。
 */
export function writeFakeClaude(dir: string, body: string): { path: string; calls: () => FakeCall[] } {
  const log = join(dir, "fake-claude-calls.jsonl");
  const script = join(dir, "fake-claude.cjs");
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require("node:fs");
const LOG = ${JSON.stringify(log)};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const call = (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\\n").filter(Boolean).length : 0) + 1;
  fs.appendFileSync(LOG, JSON.stringify({ args, input, butlerSession: process.env.BUTLER_SESSION ?? null, cwd: process.cwd() }) + "\\n");
  const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  const result = (structured, extra) => emit(Object.assign({ type: "result", subtype: "success", is_error: false, session_id: "fork-" + call, result: JSON.stringify(structured), structured_output: structured, permission_denials: [] }, extra || {}));
  ${body}
});
`,
  );
  chmodSync(script, 0o755);
  let path = script;
  if (process.platform === "win32") {
    path = join(dir, "fake-claude.cmd");
    writeFileSync(path, `@echo off\r\nnode "${script}" %*\r\n`);
  }
  const calls = (): FakeCall[] =>
    existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakeCall) : [];
  return { path, calls };
}
