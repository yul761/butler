import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathKey } from "../src/main/util/env";
import { resolveGit } from "../src/main/util/git-path";

/** 命令输出最多留这么多（保留末尾：错误一般在最后）。 */
export const OUTPUT_CAP = 64 * 1024;

export type CommandResult =
  | { kind: "pass" }
  | { kind: "fail"; code: number | null; output: string }
  | { kind: "timeout"; output: string }
  | { kind: "unavailable"; reason: string };

export interface ShellChoice {
  shell: string;
}

/**
 * 跑检查命令用的 shell（addendum 5.6）：macOS / Linux 用 /bin/sh；Windows 用 Git Bash，
 * 顺序是 CLAUDE_CODE_GIT_BASH_PATH、PATH 上 git.exe 旁边的 bash.exe、%ProgramFiles%\Git\bin\bash.exe。找不到返回 null。
 */
export function findShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (p: string) => boolean = existsSync): string | null {
  if (platform !== "win32") return "/bin/sh";
  const w = path.win32;
  const fromEnv = env.CLAUDE_CODE_GIT_BASH_PATH?.trim();
  if (fromEnv && w.isAbsolute(fromEnv) && exists(fromEnv)) return fromEnv;
  const git = resolveGit(env[pathKey(env)] ?? "", platform, exists);
  if (git) {
    const dir = w.dirname(git);
    // …\Git\cmd\git.exe、…\Git\bin\git.exe、…\Git\mingw64\bin\git.exe → …\Git\bin\bash.exe
    for (const c of [w.join(dir, "bash.exe"), w.join(dir, "..", "bin", "bash.exe"), w.join(dir, "..", "..", "bin", "bash.exe")]) if (exists(c)) return w.normalize(c);
  }
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432]) {
    if (!root) continue;
    const c = w.join(root, "Git", "bin", "bash.exe");
    if (exists(c)) return c;
  }
  return null;
}

/**
 * 命令文字里的 {file} 换成 "$1"，文件名作为参数传进去，绝不拼进 shell 文字里。
 * 编辑时的命令没写 {file} 就把文件接在最后；push 时（file 为 null）只把 {file} 去掉。
 */
export function commandScript(command: string, file: string | null): string {
  if (file === null) return command.split("{file}").join("");
  return command.includes("{file}") ? command.split("{file}").join('"$1"') : `${command} "$1"`;
}

const keepTail = (s: string): string => (s.length > OUTPUT_CAP ? s.slice(s.length - OUTPUT_CAP) : s);

/** 杀掉自己刚起的整棵进程树：POSIX 杀进程组，Windows 用 taskkill /T（是我们自己的子进程，不是孤儿扫描）。 */
export function killTree(pid: number, platform: NodeJS.Platform): void {
  try {
    if (platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
    else process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已经退出了。
    }
  }
}

/** 跑一条检查命令；超时就杀掉整棵树。永不 reject。 */
export function runCommand(o: {
  command: string;
  file: string | null;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  shell?: string | null;
}): Promise<CommandResult> {
  const platform = o.platform ?? process.platform;
  const shell = o.shell === undefined ? findShell(o.env, platform) : o.shell;
  if (!shell) return Promise.resolve({ kind: "unavailable", reason: platform === "win32" ? "Git Bash not found" : "/bin/sh not found" });
  if (o.timeoutMs <= 0) return Promise.resolve({ kind: "timeout", output: "" });
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let timedOut = false;
    const finish = (r: CommandResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ["-c", commandScript(o.command, o.file), "butler-check", ...(o.file === null ? [] : [o.file])], {
        cwd: o.cwd,
        env: o.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: platform !== "win32",
        windowsHide: true,
      });
    } catch (e) {
      resolve({ kind: "unavailable", reason: e instanceof Error ? e.message : String(e) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid, platform);
      // 有的子孙进程攥着输出管道不放：杀完再等一小会儿，到点就算超时。
      setTimeout(() => finish({ kind: "timeout", output: keepTail(out) }), 500).unref?.();
    }, o.timeoutMs);
    const add = (b: Buffer) => {
      out = keepTail(out + b.toString("utf8"));
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    child.on("error", (e) => finish({ kind: "unavailable", reason: e.message }));
    child.on("close", (code) => {
      if (timedOut) return finish({ kind: "timeout", output: keepTail(out) });
      if (code === 0) return finish({ kind: "pass" });
      // 127：找不到命令；126：不能执行。都是「检查跑不起来」，不是代码有问题。
      if (code === 127 || code === 126) return finish({ kind: "unavailable", reason: keepTail(out).trim().slice(-500) || `exit ${code}` });
      finish({ kind: "fail", code, output: keepTail(out) });
    });
  });
}
