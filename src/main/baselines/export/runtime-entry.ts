// 导出成 lint 时写进仓库的 Node 检查脚本（设计 §8 的 script 目标）。scripts/build-check-runtime.mjs 用 esbuild 把它和 check-rules 打成一个文件，
// 生成的文件里前面是 `const CHECK = {...}`。和 hook 用的是同一份规则代码，所以「编辑时」和「仓库 lint」结果一样。
// 用法：没有参数 = 暂存的文件；--all = 所有跟踪的文件；或者列出文件。打印 file:line: message，有违规退出 1。
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { evaluateBuiltin } from "../../../shared/check-rules";
import { inScope, normalizePath } from "../../../shared/glob";

interface ExportedCheck {
  name: string;
  type: string;
  params: Record<string, unknown>;
  globs: string[];
  excludeGlobs: string[];
  message: string;
  ticketPattern: string;
}
declare const CHECK: ExportedCheck;

const MAX_BYTES = 1024 * 1024;

function git(args: string[], cwd: string): Buffer {
  return execFileSync("git", ["-c", "core.quotepath=off", ...args], { cwd, maxBuffer: 256 * 1024 * 1024 });
}

function main(argv: string[]): number {
  const cwd = process.cwd();
  let root = cwd;
  try {
    root = git(["rev-parse", "--show-toplevel"], cwd).toString("utf8").trim() || cwd;
  } catch {
    // 不在 git 仓库里：按当前目录算。
  }
  const all = argv.includes("--all");
  const listed = argv.filter((a) => a !== "--all" && a !== "--");
  let files: string[];
  let staged = false;
  if (listed.length) files = listed.map((f) => normalizePath(relative(root, isAbsolute(f) ? f : resolve(cwd, f))));
  else if (all) files = git(["ls-files", "-z"], root).toString("utf8").split("\0").filter(Boolean);
  else {
    staged = true;
    files = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], root).toString("utf8").split("\0").filter(Boolean);
  }
  let count = 0;
  for (const file of files) {
    if (!inScope(file, CHECK.globs, CHECK.excludeGlobs)) continue;
    let buf: Buffer;
    try {
      if (staged) buf = git(["show", `:${file}`], root);
      else {
        const abs = resolve(root, file);
        if (statSync(abs).size > MAX_BYTES) continue;
        buf = readFileSync(abs);
      }
    } catch {
      continue;
    }
    if (buf.length > MAX_BYTES || buf.subarray(0, 8192).includes(0)) continue;
    let text = buf.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    for (const v of evaluateBuiltin(CHECK, text, { path: file, ticketPattern: CHECK.ticketPattern })) {
      count++;
      process.stdout.write(`${file}:${v.line}: ${CHECK.message || CHECK.name}${v.detail ? ` (${v.detail.replace(/\s+/g, " ").slice(0, 200)})` : ""}\n`);
    }
  }
  if (count) process.stderr.write(`${CHECK.name}: ${count} violation${count === 1 ? "" : "s"}\n`);
  return count ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
