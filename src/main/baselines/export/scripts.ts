// 导出成 lint 时写进仓库的检查脚本（设计 §8 的 script 目标）：Node（和 hook 同一份规则代码）、Python（规则的 Python 版）、
// shell（只做 forbidden_pattern，用 git grep），以及 run_command 的逐文件运行脚本。用法都一样：
//   没有参数 = 暂存的文件；--all = 所有跟踪的文件；或者列出文件。打印 file:line: message，有违规退出 1。
import { commandScript } from "../../../../hook/check-run";
import type { ResolvedCheck } from "../../../shared/checks";
import { NODE_RUNTIME } from "./node-runtime.generated";
import { PY_RUNTIME } from "./py-runtime";
import { escapeRegex, jsRegexToPcre, jsRegexToPython, replaceEndAnchors } from "./regex";

export type ScriptRuntime = "node" | "python" | "sh";

export interface ExportedCheckData {
  name: string;
  type: string;
  params: Record<string, unknown>;
  globs: string[];
  excludeGlobs: string[];
  message: string;
  ticketPattern: string;
}

export type ScriptResult = { ok: true; content: string } | { ok: false; reason: string };

export function checkData(c: ResolvedCheck, ticketPattern: string): ExportedCheckData {
  return { name: c.name, type: c.type, params: c.params, globs: c.globs, excludeGlobs: c.excludeGlobs, message: c.message, ticketPattern };
}

function header(comment: string, data: ExportedCheckData, usage: string): string[] {
  return [
    `${comment} Butler check "${data.name.replace(/[\r\n]+/g, " ")}" (${data.type}), written by Butler as a repo rule.`,
    `${comment} Usage: ${usage} [--all | files...]   (no arguments = staged files)`,
    `${comment} Prints file:line: message for each violation and exits 1 when there is any.`,
  ];
}

export function nodeScript(data: ExportedCheckData, path: string): string {
  return [
    "#!/usr/bin/env node",
    ...header("//", data, `node ${path}`),
    `const CHECK = ${JSON.stringify(data, null, 2)};`,
    NODE_RUNTIME.trimEnd(),
    "",
  ].join("\n");
}

/** 用户的正则换成 Python 写法；换不了给出原因。 */
export function pythonData(data: ExportedCheckData): { ok: true; data: ExportedCheckData } | { ok: false; reason: string } {
  const params = { ...data.params };
  if (data.type === "forbidden_pattern" && !params.literal) {
    const t = jsRegexToPython(String(params.pattern ?? ""));
    if (!t.ok) return { ok: false, reason: t.reason };
    params.pattern = t.source;
  }
  let ticketPattern = data.ticketPattern;
  if (data.type === "comment_policy") {
    for (const key of ["ticketPattern"] as const) {
      const v = params[key];
      if (typeof v === "string" && v) {
        const t = jsRegexToPython(v);
        if (!t.ok) return { ok: false, reason: t.reason };
        params[key] = t.source;
      }
    }
    if (ticketPattern) {
      const t = jsRegexToPython(ticketPattern);
      if (!t.ok) return { ok: false, reason: t.reason };
      ticketPattern = t.source;
    }
  }
  return { ok: true, data: { ...data, params, ticketPattern } };
}

export function pythonScript(data: ExportedCheckData, path: string): ScriptResult {
  const t = pythonData(data);
  if (!t.ok) return t;
  return {
    ok: true,
    content: [
      "#!/usr/bin/env python3",
      ...header("#", data, `python3 ${path}`),
      "import json",
      `CHECK = json.loads(${JSON.stringify(JSON.stringify(t.data))})`,
      PY_RUNTIME.trim(),
      "",
    ].join("\n"),
  };
}

/** sh 单引号字符串。 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** {a,b} 展开（git 的 glob pathspec 不认花括号）。 */
export function expandBraces(g: string): string[] {
  const open = g.indexOf("{");
  if (open < 0) return [g];
  let depth = 0;
  const parts: string[] = [];
  let last = open + 1;
  for (let i = open; i < g.length; i++) {
    if (g[i] === "{") depth++;
    else if (g[i] === "}") {
      depth--;
      if (depth === 0) {
        parts.push(g.slice(last, i));
        const pre = g.slice(0, open);
        const post = g.slice(i + 1);
        return parts.flatMap((p) => expandBraces(pre + p + post));
      }
    } else if (g[i] === "," && depth === 1) {
      parts.push(g.slice(last, i));
      last = i + 1;
    }
  }
  return [g];
}

/** 检查的 globs → git pathspec（和 shared/glob.ts 的规则一样：没有 / 的匹配任意目录下的文件名，以 / 结尾的是整个目录）。 */
export function pathspecs(globs: string[], exclude: string[]): string[] {
  const one = (g: string, magic: string) =>
    expandBraces(g.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "")).map((x) => {
      let s = x.endsWith("/") ? `${x}**` : x;
      if (!s.includes("/")) s = `**/${s}`;
      return `:(${magic})${s}`;
    });
  return [...globs.filter((g) => g.trim()).flatMap((g) => one(g, "glob")), ...exclude.filter((g) => g.trim()).flatMap((g) => one(g, "glob,exclude"))];
}

/** 列出要查的文件（shell 片段）：$files 是一行一个、仓库相对的路径。暂存模式时 $staged=1。 */
function listFilesSh(specs: string[]): string[] {
  const spec = specs.map(shQuote).join(" ");
  return [
    'here=$(pwd)',
    'root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not in a git repository" >&2; exit 2; }',
    "staged=0",
    'if [ "${1:-}" = "--all" ]; then',
    '  picked=""',
    'elif [ $# -gt 0 ]; then',
    '  picked=$(cd "$here" && git -c core.quotepath=off ls-files --full-name -- "$@")',
    "else",
    "  staged=1",
    '  picked=$(cd "$root" && git -c core.quotepath=off diff --cached --name-only --diff-filter=ACMR)',
    "fi",
    'cd "$root" || exit 2',
    `scope=$(git -c core.quotepath=off ls-files${spec ? ` -- ${spec}` : ""})`,
    'if [ "${1:-}" = "--all" ]; then',
    '  files=$scope',
    'elif [ -n "$picked" ] && [ -n "$scope" ]; then',
    '  files=$(printf \'%s\\n\' "$picked" | grep -Fx -e "$scope")',
    "else",
    '  files=""',
    "fi",
    '[ -n "$files" ] || exit 0',
  ];
}

export function shScript(data: ExportedCheckData, path: string): ScriptResult {
  if (data.type !== "forbidden_pattern") return { ok: false, reason: "sh_type" };
  const literal = !!data.params.literal;
  const raw = String(data.params.pattern ?? "");
  let pattern = raw;
  if (!literal) {
    const t = jsRegexToPcre(raw);
    if (!t.ok) return { ok: false, reason: t.reason };
    pattern = t.source;
  }
  const modeFlag = literal ? "-F" : "-P";
  const caseFlag = data.params.flags === "i" ? " -i" : "";
  return {
    ok: true,
    content: [
      "#!/bin/sh",
      ...header("#", data, `sh ${path}`),
      "set -u",
      `PATTERN=${shQuote(pattern)}`,
      `MSG=${shQuote(data.message || data.name)}`,
      `NAME=${shQuote(data.name)}`,
      ...listFilesSh(pathspecs(data.globs, data.excludeGlobs)),
      'cached=""',
      '[ "$staged" = 1 ] && cached="--cached"',
      // 先拿这个正则空跑一次：git 没带 PCRE、或者正则编译不了，git grep 都退出 128，下面的管道却只会得到空输出，
      // 把「出错」当成「没有违规」放过去（审查发现）。
      `git grep -q ${modeFlag}${caseFlag} -e "$PATTERN" -- ":(literal)butler-no-such-file" >/dev/null 2>&1; [ $? -le 1 ] || { echo "$NAME: git grep cannot run this pattern (it does not compile, or this git was built without PCRE)" >&2; exit 2; }`,
      // 输出里的 NUL 存不进 shell 变量：先换成 \\001 再存。
      `out=$(printf '%s\\n' "$files" | tr '\\n' '\\000' | xargs -0 git -c core.quotepath=off grep -z -n -I $cached ${modeFlag}${caseFlag} -e "$PATTERN" -- | tr '\\000' '\\001')`,
      '[ -n "$out" ] || exit 0',
      `printf '%s\\n' "$out" | MSG="$MSG" awk -F "$(printf '\\001')" '{ c = $3; for (i = 4; i <= NF; i++) c = c "\\001" $i; gsub(/[ \\t]+/, " ", c); sub(/^ /, "", c); sub(/ $/, "", c); print $1 ":" $2 ": " ENVIRON["MSG"] (c == "" ? "" : " (" substr(c, 1, 200) ")") }'`,
      `n=$(printf '%s\\n' "$out" | grep -c .)`,
      'echo "$NAME: $n violation(s)" >&2',
      "exit 1",
      "",
    ].join("\n"),
  };
}

/** run_command 检查的逐文件运行脚本：和 Butler 编辑时的 hook 一样，每个文件跑一次，{file} 换成 "$1"，文件名也在 BUTLER_CHECK_FILE 里。 */
export function runnerScript(data: ExportedCheckData, command: string, path: string): string {
  return [
    "#!/bin/sh",
    ...header("#", data, `sh ${path}`),
    "set -u",
    `NAME=${shQuote(data.name)}`,
    `SCRIPT=${shQuote(commandScript(command, "file"))}`,
    ...listFilesSh(pathspecs(data.globs, data.excludeGlobs)),
    "status=0",
    "while IFS= read -r f; do",
    '  [ -n "$f" ] || continue',
    '  if ! BUTLER_CHECK_FILE="$f" sh -c "$SCRIPT" sh "$f" </dev/null; then',
    '    echo "$f: $NAME failed" >&2',
    "    status=1",
    "  fi",
    "done <<EOF",
    "$files",
    "EOF",
    "exit $status",
    "",
  ].join("\n");
}

/** 字面文字或 JS 正则 → pre-commit pygrep 的 entry（Python 正则）。 */
export function pygrepEntry(params: Record<string, unknown>): { ok: true; entry: string; args: string[] } | { ok: false; reason: string } {
  const raw = String(params.pattern ?? "");
  const args = params.flags === "i" ? ["--ignore-case"] : [];
  // pygrep 按字节编译、按字节匹配：非 ASCII 的字符（尤其在字符类里）会按单个字节去比，意思就变了。这种导出成 Python 脚本。
  if ([...raw].some((c) => c.charCodeAt(0) > 0x7f)) return { ok: false, reason: "non_ascii" };
  if (params.literal) return { ok: true, entry: escapeRegex(raw), args };
  const t = jsRegexToPython(raw);
  if (!t.ok) return t;
  // JS 不带 u 时 \d \w \s \b 只认 ASCII；pygrep 的 Python 正则默认认 Unicode，加 (?a) 对齐。
  const ascii = /\\[dDwWsSbB]/.test(t.source) ? "(?a)" : "";
  // pygrep 读到的行带着 Windows 换行的 \r：$ 前面允许一个 \r，和 Butler 按 \r?\n 分行一样。
  return { ok: true, entry: ascii + replaceEndAnchors(t.source, "(?=\\r?$)"), args };
}
