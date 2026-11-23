/**
 * 权限档案的安全边界（ws-j 设计 2.2）：确定性地判断一条 Bash 命令或 MCP 工具是不是只读，给出 Claude Code 的允许规则。
 * 不调模型。规则存下、导入、写进 session 的 --settings 之前都再过一遍 isSafeRule：不在这张表里的、会写东西的，一律不放行。
 */

/** shell 元字符、通配、换行：出现任何一个都不收（链、重定向、替换、展开都会绕过精确规则；`*` 会把精确规则变成通配）。 */
const META = /[;&|<>$`(){}\\\n\r*?[\]!#"]/;
/** 只允许单引号成对出现（双引号里还能展开，直接不收）。 */
const QUOTE = "'";

interface Spec {
  /** 任何参数都只读：给前缀规则 Bash(<key>:*)。 */
  prefix?: boolean;
  /** 不许出现的选项（`--x` 也挡 `--x=…`；单字母 `-x` 也挡合写的 `-ax`、`-xfile`）。 */
  forbid?: readonly string[];
  /** 只许出现这些选项（以 * 结尾的是前缀，如 -n*）；给了就是白名单。 */
  allowOnly?: readonly string[];
  /** 有位置参数时必须带其中一个选项（git branch / git tag 只有列表模式是只读的）。 */
  positionalNeeds?: readonly string[];
  /** 必须带其中一个选项（git config 只有读的那几个）。 */
  requireAny?: readonly string[];
  /** 不许有位置参数。 */
  noPositional?: boolean;
  /** Claude Code 本来就不问（内置只读命令）：扫描时不当候选，免得列表里全是没用的规则。 */
  quiet?: boolean;
}

const PREFIX: Spec = { prefix: true };
const QUIET_PREFIX: Spec = { prefix: true, quiet: true };
/** 能写文件或跑外部程序的 git 选项（log / rev-list 一族都认 diff 选项）。 */
const GIT_OUT = ["--output", "--ext-diff", "--textconv"] as const;
const GIT_LOGLIKE: Spec = { forbid: GIT_OUT };
const LIST_MODE = ["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"] as const;

/** 命令（程序 + 子命令）→ 规格。查表按最长的前缀（最多三个词）。 */
const SPECS: Readonly<Record<string, Spec>> = {
  // Claude Code 内置的只读命令：认得，但不当候选。
  ls: QUIET_PREFIX, cat: QUIET_PREFIX, echo: QUIET_PREFIX, pwd: QUIET_PREFIX, head: QUIET_PREFIX, tail: QUIET_PREFIX, wc: QUIET_PREFIX,
  which: { quiet: true, allowOnly: ["-a"] }, stat: QUIET_PREFIX, du: QUIET_PREFIX, diff: QUIET_PREFIX,
  grep: QUIET_PREFIX, find: { quiet: true, forbid: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls", "-files0-from"] },
  // 前缀规则只给「任何参数都只读」的；认 diff / log 选项的（能 --output 写文件）只给精确规则。
  // 不收：git ls-remote（--upload-pack 跑命令）、kubectl（--kubeconfig 能跑 exec 插件）。
  "git status": QUIET_PREFIX, "git rev-parse": PREFIX, "git ls-files": QUIET_PREFIX, "git blame": QUIET_PREFIX, "git merge-base": PREFIX,
  "git cat-file": { forbid: ["--textconv", "--filters"] }, "git ls-tree": PREFIX, "git describe": { forbid: ["--dirty", "--broken"] },
  "git shortlog": GIT_LOGLIKE, "git show-ref": PREFIX, "git rev-list": GIT_LOGLIKE,
  "git stash list": GIT_LOGLIKE, "git stash show": GIT_LOGLIKE, "git worktree list": PREFIX, "git reflog show": GIT_LOGLIKE,
  "git remote get-url": PREFIX,
  "git log": { quiet: true, forbid: GIT_OUT }, "git diff": { quiet: true, forbid: GIT_OUT }, "git show": { quiet: true, forbid: GIT_OUT },
  "git grep": { forbid: ["-O", "--open-files-in-pager"] },
  "git remote": { allowOnly: ["-v", "--verbose"], noPositional: true },
  "git branch": {
    quiet: true,
    allowOnly: ["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "--sort*", "--format*", "--column", "--no-column", "--color*", "--no-color", "-i", "--ignore-case", ...LIST_MODE],
    positionalNeeds: LIST_MODE,
  },
  "git tag": { allowOnly: ["-n*", "--sort*", "--format*", "--column", "--no-column", "-i", "--ignore-case", ...LIST_MODE], positionalNeeds: LIST_MODE },
  "git config": {
    requireAny: ["--get", "--get-all", "--get-regexp", "--list", "-l"],
    allowOnly: ["--get", "--get-all", "--get-regexp", "--list", "-l", "--global", "--local", "--system", "--show-origin", "--show-scope", "--name-only", "-z", "--null", "--type*", "--bool", "--int", "--path", "--default*"],
  },
  "gh pr view": PREFIX, "gh pr list": PREFIX, "gh pr diff": PREFIX, "gh pr checks": PREFIX, "gh pr status": PREFIX,
  "gh issue view": PREFIX, "gh issue list": PREFIX, "gh issue status": PREFIX, "gh run view": PREFIX, "gh run list": PREFIX,
  "gh repo view": PREFIX, "gh release list": PREFIX, "gh release view": PREFIX, "gh workflow list": PREFIX, "gh workflow view": { forbid: ["--yaml"] },
  "gh api": { forbid: ["-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"] },
  jq: PREFIX,
  rg: { forbid: ["--pre", "--pre-glob"] },
  fd: { forbid: ["-x", "-X", "--exec", "--exec-batch"] },
  tree: { forbid: ["-o", "--fromfile"] },
  sort: { allowOnly: ["-r", "-n", "-u", "-f", "-b", "-h", "-V", "-s", "-k*", "-t*", "--reverse", "--numeric-sort", "--unique", "--ignore-case", "--human-numeric-sort", "--version-sort", "--stable"] },
  "pnpm ls": PREFIX, "pnpm list": PREFIX, "pnpm why": PREFIX, "pnpm outdated": PREFIX, "pnpm view": PREFIX,
  "npm ls": PREFIX, "npm list": PREFIX, "npm why": PREFIX, "npm outdated": PREFIX, "npm view": PREFIX,
  "docker ps": { forbid: ["-H", "--host", "--context"] }, "docker images": { forbid: ["-H", "--host", "--context"] },
  "docker logs": { forbid: ["-H", "--host", "--context"] }, "docker inspect": { forbid: ["-H", "--host", "--context"] },
};

interface Parsed {
  key: string;
  spec: Spec;
  /** key 之后的参数（引号已去掉）。 */
  args: string[];
}

/** 按空白切词；单引号成对时去掉引号。不合规（元字符、不成对的引号、连续空白）返回 null。 */
function tokenize(cmd: string): string[] | null {
  if (cmd !== cmd.trim() || cmd.length === 0 || cmd.length > 1000 || META.test(cmd) || /\s{2,}|\t/.test(cmd)) return null;
  const out: string[] = [];
  for (const raw of cmd.split(" ")) {
    const quotes = raw.split(QUOTE).length - 1;
    if (quotes % 2 !== 0) return null;
    if (raw.startsWith("~") || raw.startsWith("=")) return null;
    out.push(raw.replaceAll(QUOTE, ""));
  }
  return out;
}

function parse(cmd: string): Parsed | null {
  const t = tokenize(cmd);
  if (!t || t.length === 0) return null;
  const prog = t[0]!;
  // 变量赋值、带路径的程序、选项打头：不收。
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(prog) || prog.includes("/") || prog.startsWith("-") || prog.startsWith(".")) return null;
  for (let n = Math.min(3, t.length); n >= 1; n--) {
    const words = t.slice(0, n);
    if (words.slice(1).some((w) => w.startsWith("-"))) continue;
    const key = words.join(" ");
    const spec = SPECS[key];
    if (spec) return { key, spec, args: t.slice(n) };
  }
  return null;
}

const isFlag = (a: string): boolean => a.startsWith("-") && a !== "-";

function hitsForbidden(arg: string, f: string): boolean {
  if (f.startsWith("--")) {
    // git 和 getopt_long 都认长选项的唯一前缀（--out 就是 --output）：参数是禁用选项的前缀也挡。
    if (!arg.startsWith("--")) return false;
    const name = arg.slice(2).split("=")[0]!;
    return name.length > 0 && f.slice(2).startsWith(name);
  }
  // 单字母：-x、-xvalue、合写的 -ax 都算（多字母的单横线选项如 find 的 -delete 按整词比）。
  if (f.length === 2) return !arg.startsWith("--") && arg.startsWith("-") && arg.slice(1).includes(f[1]!);
  return arg === f;
}

/** 白名单里的 `-k*` 一类只给单字母选项接值（-k2）；长选项要整词，免得 --sort 的前缀写法冒充别的选项。 */
const allowedFlag = (arg: string, allow: readonly string[]): boolean =>
  allow.some((a) => (a.endsWith("*") ? arg.startsWith(a.slice(0, -1)) : arg === a || (a.startsWith("--") && arg.startsWith(`${a}=`))));

/** 参数满足规格吗。 */
function argsOk(spec: Spec, args: readonly string[]): boolean {
  const flags = args.filter(isFlag);
  const positional = args.filter((a) => !isFlag(a));
  if (spec.forbid && args.some((a) => isFlag(a) && spec.forbid!.some((f) => hitsForbidden(a, f)))) return false;
  if (spec.allowOnly && flags.some((f) => !allowedFlag(f, spec.allowOnly!))) return false;
  if (spec.requireAny && !flags.some((f) => allowedFlag(f, spec.requireAny!))) return false;
  if (spec.noPositional && positional.length > 0) return false;
  if (spec.positionalNeeds && positional.length > 0 && !flags.some((f) => allowedFlag(f, spec.positionalNeeds!))) return false;
  return true;
}

function safeParse(cmd: string): Parsed | null {
  const p = parse(cmd);
  return p && argsOk(p.spec, p.args) ? p : null;
}

/** 一条只读的 Bash 命令该给的规则：前缀规则或精确规则；不是只读返回 null。 */
export function ruleForCommand(cmd: string): string | null {
  const p = safeParse(cmd);
  if (!p) return null;
  return p.spec.prefix ? `Bash(${p.key}:*)` : `Bash(${cmd})`;
}

/** 扫描历史时的候选：同 ruleForCommand，但 Claude Code 本来就不问的不给。 */
export function scanRuleForCommand(cmd: string): string | null {
  const p = safeParse(cmd);
  if (!p || p.spec.quiet) return null;
  return p.spec.prefix ? `Bash(${p.key}:*)` : `Bash(${cmd})`;
}

const READ_VERBS = new Set(["get", "list", "search", "read", "view", "fetch", "describe", "show", "find"]);
const WRITE_VERBS = new Set([
  "create", "update", "delete", "remove", "add", "set", "post", "send", "write", "edit", "move", "merge", "close", "transition", "assign", "comment",
  "upload", "run", "execute", "exec", "trigger", "approve", "reject", "push", "publish", "deploy", "cancel", "archive", "link", "submit", "put", "patch",
  "insert", "modify", "rename", "reply", "resolve", "start", "stop", "restart", "kill", "open", "reopen", "invite", "grant", "revoke", "sync", "import",
  "drop", "truncate", "upsert", "save", "apply", "commit", "mark", "unlink", "attach", "detach", "enable", "disable", "query", "and", "then", "or",
  "replace", "generate", "reset", "clear", "refresh", "install", "uninstall", "access", "invoke", "call", "request", "mint", "token", "dialog",
  "prompt", "notify", "schedule", "book", "pay", "buy", "purchase", "transfer", "sign", "login", "logout", "authenticate", "authorize", "complete",
  "accept", "decline", "lock", "unlock", "pin", "unpin", "star", "fork", "clone", "copy", "duplicate", "restore", "rollback", "promote", "pause",
  "unpause", "resume", "extend", "invalidate", "rerequest", "retry", "record", "fill", "click", "type", "press", "drag", "navigate", "emulate",
  "resize", "select", "hover", "evaluate", "eval", "script", "upgrade", "provision", "register", "unregister", "subscribe", "unsubscribe",
  "share", "rotate", "activate", "deactivate", "verify", "confirm", "cancel", "abort", "flush", "purge", "wipe", "init", "setup", "configure",
  "change", "toggle", "convert", "transform", "render", "build", "compile", "test", "lint", "format", "fix", "ping", "wake", "allow", "deny",
]);
const MCP_NAME = /^mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_-]+)$/;

/** 只读的 MCP 工具：给它的名字（就是规则本身）；不是返回 null。Shipherd 自己的 server 不收（已经单独放行）。 */
export function ruleForTool(name: string): string | null {
  const m = MCP_NAME.exec(name);
  if (!m) return null;
  const [, server, tool] = m;
  if (server!.toLowerCase().startsWith("shipherd") || tool!.includes("__")) return null;
  const words = tool!.split(/[_-]|(?=[A-Z])/).filter(Boolean).map((w) => w.toLowerCase());
  if (words.length === 0 || !READ_VERBS.has(words[0]!) || words.some((w) => WRITE_VERBS.has(w))) return null;
  return name;
}

/** 一条规则字符串安全吗（存、导入、写进 --settings 之前都过这里）。 */
export function isSafeRule(rule: string): boolean {
  if (typeof rule !== "string") return false;
  if (rule.startsWith("mcp__")) return ruleForTool(rule) === rule;
  const m = /^Bash\((.+)\)$/s.exec(rule);
  if (!m) return false;
  const inner = m[1]!;
  const prefix = inner.endsWith(":*") ? inner.slice(0, -2) : inner.endsWith(" *") ? inner.slice(0, -2) : null;
  if (prefix !== null) {
    const spec = SPECS[prefix];
    return spec?.prefix === true && tokenize(prefix)?.join(" ") === prefix;
  }
  return ruleForCommand(inner) !== null;
}

/** 一次工具调用会不会被这条规则放行（算「档案省掉了一次确认」用；和 Claude Code 的前缀 / 精确语义一致）。 */
export function matchesRule(rule: string, call: { tool: string; command?: string }): boolean {
  if (rule.startsWith("mcp__")) return call.tool === rule;
  if (call.tool !== "Bash" || typeof call.command !== "string") return false;
  const m = /^Bash\((.+)\)$/s.exec(rule);
  if (!m) return false;
  const inner = m[1]!;
  const cmd = call.command.trim();
  if (inner.endsWith(":*") || inner.endsWith(" *")) {
    const p = inner.slice(0, -2);
    return !META.test(cmd) && (cmd === p || cmd.startsWith(`${p} `));
  }
  return cmd === inner;
}
