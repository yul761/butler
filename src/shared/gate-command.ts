// 识别合并总控要审核的 Bash 命令。纯函数，不引 Node 模块（渲染进程也会打包 shared）。
// 认不准的一律返回 null：宁可漏审，也不误拦普通命令。

export type GateAction =
  | { kind: "pr_merge"; dir: string | null; pr: string | null }
  | { kind: "local_merge"; dir: string | null; source: string }
  | { kind: "push"; dir: string | null; target: string }
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
      else if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
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
    } else if (c === " " || c === "\t") endToken();
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
    const dst = refspec.includes(":") ? refspec.slice(refspec.lastIndexOf(":") + 1) : refspec;
    const target = dst.replace(/^\+/, "").replace(/^refs\/heads\//, "");
    return target ? { kind: "push", dir, target } : null;
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
