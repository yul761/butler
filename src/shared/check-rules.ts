// 内置检查类型的求值（契约 4.5）：禁用模式、import 边界、注释策略。纯函数，hook 在进程内逐行跑，毫秒级。
// 也给 Butler 页面和测试用。只看文字，不执行任何东西。
import { matchAny, normalizePath } from "./glob";
import type { CommentPolicyParams, ForbiddenPatternParams, ImportBoundaryParams } from "./checks";

export interface Violation {
  /** 从 1 开始的行号。 */
  line: number;
  /** 指纹用的文字（这一行或这条注释，去掉首尾空白、压缩空白）。 */
  text: string;
  /** 给 agent 看的细节（import 的目标、注释原文）。 */
  detail: string;
}

export interface RuleContext {
  /** 仓库内路径，/ 分隔。 */
  path: string;
  /** 注释规则默认的 ticket 号正则。 */
  ticketPattern: string;
}

const squash = (s: string): string => s.trim().replace(/\s+/g, " ");
const lines = (content: string): string[] => content.split(/\r?\n/);

// ---------------------------------------------------------------- forbidden_pattern

export function forbiddenPattern(p: ForbiddenPatternParams, content: string): Violation[] {
  let test: (line: string) => boolean;
  if (p.literal) {
    const needle = p.flags === "i" ? p.pattern.toLowerCase() : p.pattern;
    test = (l) => (p.flags === "i" ? l.toLowerCase() : l).includes(needle);
  } else {
    let re: RegExp;
    try {
      re = new RegExp(p.pattern, p.flags === "i" ? "i" : "");
    } catch {
      return [];
    }
    test = (l) => re.test(l);
  }
  const out: Violation[] = [];
  lines(content).forEach((l, i) => {
    if (test(l)) out.push({ line: i + 1, text: squash(l), detail: l.trim().slice(0, 300) });
  });
  return out;
}

// ---------------------------------------------------------------- import_boundary

const PY_EXT = /\.(py|pyi)$/i;

/** 一行里的 import 目标（JS/TS：import/export from、副作用 import、import()、require()；Python：import / from … import）。 */
export function importsOfLine(line: string, python: boolean): string[] {
  const out: string[] = [];
  if (python) {
    const from = /^\s*from\s+(\.*[\w.]*)\s+import\b/.exec(line);
    if (from) out.push(from[1]);
    const imp = /^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/.exec(line);
    if (imp) for (const part of imp[1].split(",")) out.push(part.trim().split(/\s+/)[0]);
    return out.filter(Boolean);
  }
  const res = [
    /\bfrom\s*["']([^"'\n]+)["']/g,
    /^\s*import\s*["']([^"'\n]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  ];
  for (const re of res) for (const m of line.matchAll(re)) out.push(m[1]);
  return [...new Set(out)];
}

function joinPosix(dir: string, rel: string): string {
  const parts = dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** import 目标的几种写法：原样、仓库内路径（相对 import 解析后）、Python 模块的路径写法。 */
export function importTargets(spec: string, filePath: string, python: boolean): string[] {
  const path = normalizePath(filePath);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (python) {
    const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
    const rest = spec.slice(dots).replace(/\./g, "/");
    if (dots > 0) {
      let base = dir;
      for (let i = 1; i < dots; i++) base = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
      return [spec, joinPosix(base, rest)];
    }
    return [spec, rest];
  }
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") return [spec, joinPosix(dir, spec)];
  if (spec.startsWith("/")) return [spec, normalizePath(spec)];
  return [spec];
}

export function importBoundary(p: ImportBoundaryParams, content: string, ctx: RuleContext): Violation[] {
  const python = PY_EXT.test(ctx.path);
  const out: Violation[] = [];
  lines(content).forEach((l, i) => {
    for (const spec of importsOfLine(l, python)) {
      const targets = importTargets(spec, ctx.path, python);
      const forbidden = targets.some((t) => matchAny(t, p.forbid));
      const allowed = (p.allow?.length ?? 0) > 0 && targets.some((t) => matchAny(t, p.allow ?? []));
      if (forbidden && !allowed) out.push({ line: i + 1, text: `${squash(l)} ${spec}`, detail: spec });
    }
  });
  return out;
}

// ---------------------------------------------------------------- comment_policy

/** 默认关键词：英文按词边界、不分大小写；中文按子串。 */
export const DEFAULT_COMMENT_KEYWORDS: readonly string[] = [
  "temporary", "temporarily", "for now", "not optimal", "suboptimal", "workaround", "hack", "hacky", "quick fix", "TODO", "FIXME", "XXX",
  "暂时", "临时", "先这样", "权宜", "不是最优", "以后再", "待优化", "凑合",
];

type CommentSyntax = { line: string[]; block: [string, string][] };
const C_LIKE: CommentSyntax = { line: ["//"], block: [["/*", "*/"]] };
const HASH: CommentSyntax = { line: ["#"], block: [] };
const SYNTAX: [RegExp, CommentSyntax][] = [
  [/\.(py|pyi|sh|bash|zsh|rb|ya?ml|toml|pl|r|ps1|cfg|conf|mk|cmake|tf|nix)$|(^|\/)(Dockerfile|Makefile|Gemfile|Rakefile)$/i, HASH],
  [/\.(sql|lua|hs)$/i, { line: ["--"], block: [["/*", "*/"]] }],
  [/\.(html?|xml|svg|md|vue|svelte)$/i, { line: ["//"], block: [["<!--", "-->"], ["/*", "*/"]] }],
  [/\.(css|scss|less)$/i, { line: ["//"], block: [["/*", "*/"]] }],
];

function syntaxFor(path: string): CommentSyntax {
  for (const [re, s] of SYNTAX) if (re.test(path)) return s;
  return C_LIKE;
}

/** 每行里的注释文字（跨行的块注释每行一段）。引号里的不算；`://` 不当成行注释。 */
export function commentsOf(content: string, path: string): { line: number; text: string }[] {
  const syn = syntaxFor(path);
  const out: { line: number; text: string }[] = [];
  let inBlock: string | null = null; // 块注释的结束符
  lines(content).forEach((l, idx) => {
    let i = 0;
    let quote: string | null = null;
    let buf = "";
    const flush = () => {
      if (buf.trim()) out.push({ line: idx + 1, text: buf.trim() });
      buf = "";
    };
    while (i < l.length) {
      if (inBlock) {
        const end = l.indexOf(inBlock, i);
        if (end < 0) {
          buf += l.slice(i);
          i = l.length;
        } else {
          buf += l.slice(i, end);
          i = end + inBlock.length;
          inBlock = null;
          flush();
        }
        continue;
      }
      const c = l[i];
      if (quote) {
        if (c === "\\") i += 2;
        else {
          if (c === quote) quote = null;
          i++;
        }
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        i++;
        continue;
      }
      const block = syn.block.find(([s]) => l.startsWith(s, i));
      if (block) {
        inBlock = block[1];
        i += block[0].length;
        continue;
      }
      const lc = syn.line.find((s) => l.startsWith(s, i) && !(s === "//" && l[i - 1] === ":"));
      if (lc) {
        buf += l.slice(i + lc.length);
        i = l.length;
        continue;
      }
      i++;
    }
    flush();
  });
  return out;
}

const CJK = /[　-鿿豈-﫿]/;

function keywordMatcher(keywords: readonly string[]): (text: string) => string | null {
  const en = keywords.filter((k) => !CJK.test(k));
  const zh = keywords.filter((k) => CJK.test(k));
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const re = en.length ? new RegExp(`(?<![\\w])(?:${en.map(esc).join("|")})(?![\\w])`, "i") : null;
  return (text) => {
    const m = re?.exec(text);
    if (m) return m[0];
    return zh.find((k) => text.includes(k)) ?? null;
  };
}

function ticketMatcher(pattern: string): (text: string) => boolean {
  let custom: RegExp | null = null;
  try {
    custom = pattern ? new RegExp(pattern) : null;
  } catch {
    custom = null;
  }
  const extra = /(^|[^\w&])#\d+\b|https?:\/\/\S+/;
  return (text) => (custom?.test(text) ?? false) || extra.test(text);
}

export function commentPolicy(p: CommentPolicyParams, content: string, ctx: RuleContext): Violation[] {
  const has = keywordMatcher(p.keywords?.length ? p.keywords : DEFAULT_COMMENT_KEYWORDS);
  const ticket = ticketMatcher(p.ticketPattern || ctx.ticketPattern);
  const out: Violation[] = [];
  for (const c of commentsOf(content, ctx.path)) {
    const kw = has(c.text);
    if (kw && !ticket(c.text)) out.push({ line: c.line, text: squash(c.text), detail: c.text.slice(0, 300) });
  }
  return out;
}

// ---------------------------------------------------------------- 只报新增

/** 编辑前后对比：编辑前就有的（同样文字、按次数算）不算这次引入的。before 为 null 时只看改过的行。 */
export function newViolations(before: Violation[] | null, after: Violation[], edited: Set<number> | null): Violation[] {
  if (before === null) return edited ? after.filter((v) => edited.has(v.line)) : after;
  const left = new Map<string, number>();
  for (const v of before) left.set(v.text, (left.get(v.text) ?? 0) + 1);
  return after.filter((v) => {
    const n = left.get(v.text) ?? 0;
    if (n > 0) {
      left.set(v.text, n - 1);
      return false;
    }
    return true;
  });
}

/** 去抖用的指纹：文字加它在同样文字里的序号（两行一样的违规各算一个）。 */
export function fingerprints(vs: Violation[]): string[] {
  const seen = new Map<string, number>();
  return vs.map((v) => {
    const n = seen.get(v.text) ?? 0;
    seen.set(v.text, n + 1);
    return `${v.text}#${n}`;
  });
}

// ---------------------------------------------------------------- 编辑前的内容

interface EditOp {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

const isEdit = (v: unknown): v is EditOp =>
  typeof v === "object" && v !== null && typeof (v as EditOp).old_string === "string" && typeof (v as EditOp).new_string === "string";

function editsOf(tool: string, input: Record<string, unknown>): EditOp[] | null {
  if (tool === "Edit") return isEdit(input) ? [input] : null;
  if (tool === "MultiEdit") return Array.isArray(input.edits) && input.edits.every(isEdit) ? (input.edits as EditOp[]) : null;
  return null;
}

function undo(text: string, e: EditOp): string | null {
  if (e.new_string === "") return null; // 删掉的文字放回哪儿不知道
  if (e.replace_all) return text.includes(e.new_string) ? text.split(e.new_string).join(e.old_string) : null;
  const at = text.indexOf(e.new_string);
  return at < 0 ? null : text.slice(0, at) + e.old_string + text.slice(at + e.new_string.length);
}

/**
 * 编辑前的文件内容：tool_response.originalFile 优先；Write 新建 = 空；Edit / MultiEdit 把改动倒着撤回去。还原不出来返回 null。
 */
export function reconstructBefore(tool: string, input: Record<string, unknown>, response: unknown, after: string): string | null {
  const r = typeof response === "object" && response !== null ? (response as Record<string, unknown>) : {};
  if (typeof r.originalFile === "string") return r.originalFile;
  if (tool === "Write") return r.type === "create" ? "" : null;
  const edits = editsOf(tool, input);
  if (!edits) return null;
  let text: string | null = after;
  for (const e of [...edits].reverse()) {
    text = text === null ? null : undo(text, e);
    if (text === null) return null;
  }
  return text;
}

/** 改过的行（编辑后文件里的行号）：Write = 全部；Edit / MultiEdit = new_string 所在的行。认不出返回 null（当成全部）。 */
export function editedLines(tool: string, input: Record<string, unknown>, after: string): Set<number> | null {
  const edits = editsOf(tool, input);
  if (!edits) return null;
  const set = new Set<number>();
  for (const e of edits) {
    if (!e.new_string) continue;
    let from = 0;
    for (;;) {
      const at = after.indexOf(e.new_string, from);
      if (at < 0) break;
      const start = after.slice(0, at).split("\n").length;
      const n = e.new_string.split("\n").length;
      for (let k = 0; k < n; k++) set.add(start + k);
      from = at + Math.max(1, e.new_string.length);
      if (!e.replace_all) break;
    }
  }
  return set;
}

/** 一条内置检查对一份内容的违规；run_command 不在这里（要执行命令，只在 hook 里跑）。 */
export function evaluateBuiltin(check: { type: string; params: Record<string, unknown> }, content: string, ctx: RuleContext): Violation[] {
  switch (check.type) {
    case "forbidden_pattern":
      return forbiddenPattern(check.params as unknown as ForbiddenPatternParams, content);
    case "import_boundary":
      return importBoundary(check.params as unknown as ImportBoundaryParams, content, ctx);
    case "comment_policy":
      return commentPolicy(check.params as unknown as CommentPolicyParams, content, ctx);
    default:
      return [];
  }
}
