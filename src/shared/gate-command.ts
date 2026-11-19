// 识别合并总控要审核的 Bash 命令。纯函数，不引 Node 模块（渲染进程也会打包 shared）。
// 认不准的一律返回 null：宁可漏审，也不误拦普通命令。
import type { BypassHow } from "./backtest";

export type GateAction =
  | { kind: "pr_merge"; dir: string | null; pr: string | null }
  | { kind: "local_merge"; dir: string | null; source: string }
  /** source：推的是哪个本地分支（可能是 HEAD，即当前分支）。没写 `src:` 时和 target 同名。 */
  | { kind: "push"; dir: string | null; target: string; source?: string }
  | { kind: "switch"; dir: string | null; branch: string; create: boolean };

/** 分词并按 && || ; | & 换行切段。引号里的内容留在同一个词里，不当分隔符。 */
function splitSegments(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let cur = "";
  let has = false; // 当前词是否存在（空引号 '' 也算）
  let quote: "'" | '"' | null = null;
  const endToken = (): void => {
    if (has) tokens.push(cur);
    cur = "";
    has = false;
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      // 双引号里的反斜杠只转义 $ ` " \ 和换行，别的照原样留着（bash 的规则）：`cd "C:\Users\me"` 的路径不能被吃掉。
      else if (c === "\\" && quote === '"' && i + 1 < command.length && '$`"\\\n'.includes(command[i + 1])) cur += command[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && command[i + 1] === "\n") {
      i++; // 续行符：当空白处理，不是词
      endToken();
    } else if (c === "\\" && i + 1 < command.length) {
      cur += command[++i];
      has = true;
    } else if (c === " " || c === "\t" || c === "\r") endToken(); // \r：Windows 换行留下的
    else if (c === "\n" || c === ";" || c === "|" || c === "&") endSegment();
    else {
      cur += c;
      has = true;
    }
  }
  endSegment();
  return segments;
}

const isOption = (t: string): boolean => t.startsWith("-") && t !== "-";

/** 取出非选项参数；valueOpts 里的选项会吃掉下一个词。 */
function positionals(args: string[], valueOpts: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueOpts.includes(a)) i++;
    else if (!isOption(a)) out.push(a);
  }
  return out;
}

function classifySegment(tokens: string[], dir: string | null): GateAction | null {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  const cmd = tokens[i];
  if (cmd === "gh") {
    if (tokens[i + 1] !== "pr" || tokens[i + 2] !== "merge") return null;
    const pr = positionals(tokens.slice(i + 3), ["-b", "--body", "-F", "--body-file", "-t", "--subject", "-A", "--author-email", "--match-head-commit", "-R", "--repo"])[0];
    return { kind: "pr_merge", dir, pr: pr ?? null };
  }
  if (cmd !== "git") return null;
  i++;
  // git 的全局选项：-C <dir>、-c k=v
  while (i < tokens.length && isOption(tokens[i])) {
    if (tokens[i] === "-C" && i + 1 < tokens.length) {
      dir = tokens[i + 1];
      i += 2;
    } else if (tokens[i] === "-c") i += 2;
    else i++;
  }
  const sub = tokens[i];
  const args = tokens.slice(i + 1);
  if (sub === "merge") {
    if (args.some((a) => a === "--abort" || a === "--continue" || a === "--quit")) return null;
    const source = positionals(args, ["-m", "--message", "-F", "--file", "-s", "--strategy", "-X", "--strategy-option"])[0];
    return source ? { kind: "local_merge", dir, source } : null;
  }
  if (sub === "push") {
    const pos = positionals(args, ["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);
    const refspec = pos[1]; // pos[0] 是 remote；没写远端分支就是推自己的 branch
    if (!refspec) return null;
    const colon = refspec.lastIndexOf(":");
    const dst = colon >= 0 ? refspec.slice(colon + 1) : refspec;
    const branchName = (r: string) => r.replace(/^\+/, "").replace(/^refs\/heads\//, "");
    const target = branchName(dst);
    if (!target) return null;
    // 没写 `src:` 时推的是同名的本地分支（在 dms-2 上 git push origin main 推的是本地 main），不是当前分支。
    const source = colon >= 0 ? branchName(refspec.slice(0, colon)) : target;
    // `:main` 是删除远端分支，不是合并。
    return source ? { kind: "push", dir, target, source } : null;
  }
  if (sub === "checkout" || sub === "switch") {
    if (args.includes("--")) return null; // 还原文件，不是切分支
    const createOpts = sub === "checkout" ? ["-b", "-B"] : ["-c", "-C", "--create", "--force-create"];
    const ci = args.findIndex((a) => createOpts.includes(a));
    if (ci >= 0) {
      const branch = args[ci + 1];
      return branch && !isOption(branch) ? { kind: "switch", dir, branch, create: true } : null;
    }
    const branch = positionals(args, [])[0];
    if (!branch || branch === ".") return null;
    return { kind: "switch", dir, branch, create: false };
  }
  return null;
}

export function classifyGateCommand(command: string): GateAction | null {
  let dir: string | null = null;
  for (const tokens of splitSegments(command)) {
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    if (tokens[i] === "cd") {
      if (tokens[i + 1]) dir = tokens[i + 1]; // cd 的目录作用到后面的段
      continue;
    }
    const action = classifySegment(tokens, dir);
    if (action) return action;
  }
  return null;
}

/**
 * push 前的重检查（契约 4.5）用：认出任何真正会推送的 `git push`（不要求写 refspec，和合并总控的 classifyGateCommand 分开，
 * 那边的行为不变）。--dry-run / -n、只删除远端分支（--delete、-d、`:branch`）不算。dir 是 `git -C` 或前面 `cd` 的目录。
 */
export function classifyPush(command: string): { dir: string | null } | null {
  if (!/\bpush\b/.test(command)) return null;
  let dir: string | null = null;
  for (const tokens of splitSegments(command)) {
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    if (tokens[i] === "cd") {
      if (tokens[i + 1]) dir = dir && !/^([/\\]|[A-Za-z]:)/.test(tokens[i + 1]) ? `${dir}/${tokens[i + 1]}` : tokens[i + 1];
      continue;
    }
    if (tokens[i] !== "git") continue;
    i++;
    let segDir = dir;
    while (i < tokens.length && isOption(tokens[i])) {
      if (tokens[i] === "-C" && i + 1 < tokens.length) {
        segDir = segDir && !/^([/\\]|[A-Za-z]:)/.test(tokens[i + 1]) ? `${segDir}/${tokens[i + 1]}` : tokens[i + 1];
        i += 2;
      } else if (tokens[i] === "-c") i += 2;
      else i++;
    }
    if (tokens[i] !== "push") continue;
    const args = tokens.slice(i + 1);
    if (args.some((a) => a === "--dry-run" || a === "-n" || a === "--delete" || a === "-d" || /^-[a-zA-Z]*[nd][a-zA-Z]*$/.test(a))) continue;
    const pos = positionals(args, ["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);
    const refspecs = pos.slice(1);
    if (refspecs.length > 0 && refspecs.every((r) => r.startsWith(":"))) continue;
    return { dir: segDir };
  }
  return null;
}

/** 一条推送或开 PR 的命令（工作流 W：记下分支是谁的）。dir 是 `git -C` 或前面 `cd` 的目录，相对 hook 的 cwd。 */
export type ShipCommand =
  /** branch：推到远端的哪个分支；HEAD 或没写 refspec 时是当前分支（null，由调用方在 dir 里查）。 */
  | { kind: "push"; dir: string | null; branch: string | null }
  /** head：--head 写的分支（去掉 `owner:`）；没写是当前分支（null）。 */
  | { kind: "pr_create"; dir: string | null; head: string | null };

const isAbsDir = (d: string): boolean => /^([/\\]|[A-Za-z]:)/.test(d);
const joinDir = (base: string | null, next: string): string => (base && !isAbsDir(next) ? `${base}/${next}` : next);
const remoteBranch = (r: string): string => r.replace(/^\+/, "").replace(/^refs\/heads\//, "");

/**
 * 命令里所有真正推送分支的 `git push` 和 `gh pr create`，按出现的顺序。--dry-run、只删除远端分支、只推 tag 的不算。
 * 认不准的不返回（最多是少记一次分支是谁的）。
 */
export function classifyShip(command: string): ShipCommand[] {
  if (!/\bpush\b|\bpr\b/.test(command)) return [];
  const out: ShipCommand[] = [];
  let dir: string | null = null;
  for (const raw of splitSegments(command)) {
    const tokens = shipTokens(raw);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    if (tokens[i] === "cd") {
      if (tokens[i + 1]) dir = joinDir(dir, tokens[i + 1]);
      continue;
    }
    if (tokens[i] === "gh" && tokens[i + 1] === "pr" && tokens[i + 2] === "create") {
      const args = tokens.slice(i + 3);
      const h = args.findIndex((a) => a === "--head" || a === "-H");
      const eq = args.find((a) => a.startsWith("--head="));
      const raw = h >= 0 ? (args[h + 1] ?? null) : eq ? eq.slice("--head=".length) : null;
      const head = raw ? raw.slice(raw.indexOf(":") + 1) || null : null;
      out.push({ kind: "pr_create", dir, head });
      continue;
    }
    if (tokens[i] !== "git") continue;
    i++;
    let segDir = dir;
    while (i < tokens.length && isOption(tokens[i])) {
      if (tokens[i] === "-C" && i + 1 < tokens.length) {
        segDir = joinDir(segDir, tokens[i + 1]);
        i += 2;
      } else if (tokens[i] === "-c") i += 2;
      else i++;
    }
    if (tokens[i] !== "push") continue;
    const args = tokens.slice(i + 1);
    if (args.some((a) => a === "--dry-run" || a === "-n" || a === "--delete" || a === "-d" || /^-[a-zA-Z]*[nd][a-zA-Z]*$/.test(a))) continue;
    if (args.some((a) => a === "--tags" || a === "--mirror" || a === "--all" || a === "--branches")) continue;
    const pos = positionals(args, ["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);
    const refspecs = pos.slice(1).filter((r) => !r.startsWith(":"));
    if (pos.length > 1 && refspecs.length === 0) continue;
    if (refspecs.length === 0) out.push({ kind: "push", dir: segDir, branch: null });
    for (const r of refspecs) {
      const dst = remoteBranch(r.slice(r.lastIndexOf(":") + 1));
      // 推 tag（refs/tags/…）不是分支。
      if (/^refs\/(?!heads\/)/.test(dst)) continue;
      out.push({ kind: "push", dir: segDir, branch: dst && dst !== "HEAD" ? dst : null });
    }
  }
  return out;
}

/**
 * classifyShip 用的一段词：去掉重定向（`2>&1` 被 & 切开后剩下的 `2>`、`>/dev/null`、`> out.log`），
 * 把命令替换和子 shell 的开头剥掉（`PR=$(gh pr create …)`、`(cd /wt && git push)`），结尾的 `)` 也去掉。
 */
function shipTokens(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i];
    const redirect = /^\d*(?:>>?|<)(.*)$/.exec(t);
    if (redirect) {
      // 只写了符号（`>` `2>`）：下一个词是目标，一起去掉；`>&` 被切开了，后面没有词。
      if (redirect[1] === "" && i + 1 < tokens.length) i++;
      continue;
    }
    if (out.length === 0) {
      const sub = /^(?:[A-Za-z_][A-Za-z0-9_]*=)?(?:\$\(|`|\()+(.*)$/.exec(t);
      if (sub) {
        t = sub[1];
        if (t === "") continue;
      }
    }
    t = t.replace(/[)`]+$/, "");
    if (t !== "") out.push(t);
  }
  return out;
}

/** Bash 里绕过检查的手法（工作流 F 第 7.1 节；suppress 是编辑里加的压制注释，由 hook 的编辑检查认）。 */
export type BashBypass = Exclude<BypassHow, "suppress">;

/** 动 Butler 的检查文件或 Claude Code 的 hook 设置。 */
const TAMPER_TARGET = /[\\/]\.butler[\\/]checks\b|[\\/]\.claude[\\/]settings(\.local)?\.json\b/;
/** 会写东西的命令或重定向（只读的 cat / grep 不算）。 */
const WRITES = /(^|[\s;&|(])(rm|mv|cp|sed\s+-i|perl\s+-[a-z]*i|tee|truncate|chmod|ln|dd)\b|[^<>&0-9]>{1,2}\s*\S/;

/**
 * 一条 Bash 命令里绕过检查的写法：`git commit/push/merge … --no-verify`（commit 的 `-n`）、关掉 git hook
 * （`-c core.hooksPath=`、`git config core.hooksPath …`、HUSKY=0、SKIP=…）、改 Butler 的检查文件或 Claude 的 hook 设置、
 * 把 BUTLER_HOME 指到别处。只认出手法；算到哪条检查头上由调用方看这个 session 最近被拦过什么。纯字符串，不跑 shell。
 */
export function classifyBypass(command: string): { how: BashBypass; detail: string }[] {
  const out: { how: BashBypass; detail: string }[] = [];
  const add = (how: BashBypass, detail: string) => {
    if (!out.some((o) => o.how === how)) out.push({ how, detail: detail.slice(0, 200) });
  };
  if (TAMPER_TARGET.test(command) && WRITES.test(command)) add("tamper", command);
  for (const tokens of splitSegments(command)) {
    let i = 0;
    for (; i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]); i++) {
      const t = tokens[i];
      if (/^(HUSKY=0|HUSKY_SKIP_HOOKS=1|LEFTHOOK=0|SKIP=.+)$/.test(t)) add("hooks_off", t);
      else if (/^BUTLER_HOME=/.test(t)) add("tamper", t);
    }
    if (tokens[i] === "export" || tokens[i] === "unset") {
      for (const t of tokens.slice(i + 1)) {
        if (/^(HUSKY=0|HUSKY_SKIP_HOOKS=1|LEFTHOOK=0|SKIP=.+)$/.test(t)) add("hooks_off", `${tokens[i]} ${t}`);
        else if (/^BUTLER_(HOME=.*|SESSION)$/.test(t)) add("tamper", `${tokens[i]} ${t}`);
      }
      continue;
    }
    if (tokens[i] !== "git") continue;
    i++;
    while (i < tokens.length && isOption(tokens[i])) {
      if (tokens[i] === "-c" && i + 1 < tokens.length) {
        if (/^core\.hooksPath=/i.test(tokens[i + 1])) add("hooks_off", `git -c ${tokens[i + 1]}`);
        i += 2;
      } else if (tokens[i] === "-C") i += 2;
      else i++;
    }
    const sub = tokens[i];
    const args = tokens.slice(i + 1);
    if (sub === "config" && args.some((a) => /^core\.hooksPath$/i.test(a)) && !args.some((a) => a === "--get" || a === "--get-all" || a === "--unset" || a === "--list" || a === "-l")) {
      // 只读（--get、只写键名）不算：至少要有一个值。
      const pos = args.filter((a) => !a.startsWith("-"));
      if (pos.length >= 2) add("hooks_off", `git config ${args.join(" ")}`);
    }
    if ((sub === "commit" || sub === "push" || sub === "merge" || sub === "rebase" || sub === "am" || sub === "cherry-pick") && args.includes("--no-verify")) add("no_verify", `git ${sub} --no-verify`);
    else if (sub === "commit" && args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))) add("no_verify", "git commit -n");
  }
  return out;
}
