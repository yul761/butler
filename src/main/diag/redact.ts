// 反馈用的脱敏诊断（BTL-254）：宁可多删，不可漏。
// 设置里的「导出诊断」不走这里，那份给用户自己看，原样保留。
import { basename } from "node:path";
import type { Db } from "../db/database";
import type { DiagnosticsFile } from "./diag-export";

/** 已知要删掉的词，按类别给不同的占位符。 */
export interface RedactTerms {
  /** 家目录：换成 ~，后面跟着的路径再整段换成 <path>。 */
  home: string[];
  /** 系统用户名：作为一个词出现时换成 <user>。 */
  users: string[];
  /** 其他绝对路径（仓库、worktree、epic 目录、Shipherd / Claude 的数据目录）。 */
  paths: string[];
  titles: string[];
  epics: string[];
  /** 仓库名、owner、owner/repo、目录名。 */
  repos: string[];
  branches: string[];
  tickets: string[];
}

export type RedactExtras = Partial<RedactTerms> & { slugs?: string[] };

const PLACEHOLDER: Record<keyof RedactTerms, string> = {
  home: "~", users: "<user>", paths: "<path>", titles: "<title>", epics: "<epic>", repos: "<repo>", branches: "<branch>", tickets: "<ticket>",
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 词的边界只看 ASCII 的字母、数字、下划线：中文没有空格分词，中文的词在哪儿都要换掉。 */
const ASCII_WORD = /^[a-z0-9_]$/i;
const NOT_BEFORE = "(?<![A-Za-z0-9_])";
const NOT_AFTER = "(?![A-Za-z0-9_])";

/** 太常见、换掉只会让文件没法读的词（分支名 main、Shipherd 自己的名字……）。 */
const STOP_WORDS = new Set(["main", "master", "develop", "dev", "trunk", "head", "origin", "upstream", "shipherd", "claude", "src", "test", "tests", "docs", "app", "null", "undefined", "true", "false"]);

const isWindowsPath = (p: string): boolean => /^[a-z]:[\\/]/i.test(p) || p.startsWith("\\\\") || p.includes("\\");

/** 路径的几种写法。Windows 的路径：/、\、JSON 里转义过的 \\；POSIX 的路径不会写成反斜杠，只有原样。 */
function pathVariants(p: string): string[] {
  const parts = p.split(/[\\/]+/);
  if (parts.length < 2 || !isWindowsPath(p)) return [p];
  const lead = p.startsWith("\\\\") || p.startsWith("//") ? 2 : 0;
  const head = (sep: string) => (lead ? sep.repeat(2) : "");
  const body = lead ? parts.slice(1) : parts;
  return [...new Set([head("/") + body.join("/"), head("\\") + body.join("\\"), head("\\\\") + body.join("\\\\")])];
}

const isPathLike = (cat: keyof RedactTerms, s: string): boolean => cat === "home" || cat === "paths" || /[\\/]/.test(s);

/**
 * 一个词或一行字的「特征」：每段 ASCII 字母数字（小写），和每两个相邻的非 ASCII 字符（只有一个就那一个）。
 * 词能出现在这一行，它的每个特征就一定也是这一行的特征（ASCII 的词边界保证了那一段在这一行里也是完整的一段）。
 */
function features(lower: string): Set<string> {
  const out = new Set<string>(lower.match(/[a-z0-9_]+/g) ?? []);
  for (const run of lower.match(/\P{ASCII}+/gu) ?? []) {
    const cs = Array.from(run);
    if (cs.length === 1) out.add(cs[0]);
    for (let i = 0; i + 1 < cs.length; i++) out.add(cs[i] + cs[i + 1]);
  }
  return out;
}

/** 已知词的索引：按最少见的那个特征归堆，一行字只看它的特征对上的那几堆。 */
interface TermIndex {
  placeholder: Map<string, string>;
  byFeature: Map<string, string[]>;
  /** 一个特征都没有的（全是标点）：每行都看。 */
  always: string[];
}

/** 每个词的各种写法（小写）→ 占位符。同一个词在两类里时，类别靠前的（路径、标题）优先。 */
function buildIndex(t: RedactTerms): TermIndex {
  const placeholder = new Map<string, string>();
  for (const cat of ["home", "paths", "titles", "epics", "branches", "tickets", "repos", "users"] as const) {
    for (const raw of t[cat]) {
      const term = raw.trim().replace(/[\\/]+$/, "");
      if (term.length < 2 || STOP_WORDS.has(term.toLowerCase())) continue;
      for (const v of isPathLike(cat, term) ? pathVariants(term) : [term]) {
        const k = v.toLowerCase();
        if (!placeholder.has(k)) placeholder.set(k, PLACEHOLDER[cat]);
      }
    }
  }
  const featsOf = new Map<string, Set<string>>();
  const freq = new Map<string, number>();
  for (const k of placeholder.keys()) {
    const f = features(k);
    featsOf.set(k, f);
    for (const x of f) freq.set(x, (freq.get(x) ?? 0) + 1);
  }
  const byFeature = new Map<string, string[]>();
  const always: string[] = [];
  for (const [k, f] of featsOf) {
    let best: string | null = null;
    for (const x of f) if (best === null || freq.get(x)! < freq.get(best)!) best = x;
    if (best === null) always.push(k);
    else {
      const list = byFeature.get(best);
      if (list) list.push(k);
      else byFeature.set(best, [k]);
    }
  }
  return { placeholder, byFeature, always };
}

const indexCache = new WeakMap<RedactTerms, TermIndex>();
const indexOf = (t: RedactTerms): TermIndex => {
  let ix = indexCache.get(t);
  if (!ix) {
    ix = buildIndex(t);
    indexCache.set(t, ix);
  }
  return ix;
};

/** 这一行里真的出现了的写法拼成的正则（长的在前）。没有就是 null。 */
function lineRegex(ix: TermIndex, s: string): RegExp | null {
  const lower = s.toLowerCase();
  const hits: string[] = [];
  for (const k of ix.always) if (lower.includes(k)) hits.push(k);
  for (const f of features(lower)) for (const k of ix.byFeature.get(f) ?? []) if (lower.includes(k)) hits.push(k);
  if (hits.length === 0) return null;
  const alts = [...new Set(hits)]
    .sort((a, b) => b.length - a.length)
    .map((k) => `${ASCII_WORD.test(k[0]) ? NOT_BEFORE : ""}${escapeRe(k)}${ASCII_WORD.test(k.at(-1)!) ? NOT_AFTER : ""}`);
  return new RegExp(`(?:${alts.join("|")})`, "giu");
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]*/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** 不带协议的主机名。只换后缀像域名的（.com、.internal……），文件名（main.log、x.ts）和代码里的 a.b 不动。 */
const HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,24})\b/gi;
const HOST_TLDS = new Set(["com", "net", "org", "io", "ai", "dev", "co", "cn", "jp", "kr", "uk", "de", "fr", "in", "us", "eu", "me", "tv", "xyz", "cloud", "tech", "info", "biz", "internal", "local", "corp", "lan", "intranet", "localdomain", "site", "online", "team", "work", "company", "inc"]);
const PUBLIC_HOSTS = new Set(["github.com", "api.github.com", "raw.githubusercontent.com", "githubusercontent.com", "anthropic.com", "api.anthropic.com", "claude.ai", "claude.com", "nodejs.org", "electronjs.org"]);
/** 一段「像路径」的字符：占位符整块算一段，引号、括号、逗号、分号、等号、竖线把它断开。 */
const TOKEN_RE = /(?:<[a-z]+>|[^\s"'`<>()[\]{},;=|])+/g;
/** 两段路径中间夹着几个词：多半是带空格的目录名（OneDrive - Acme Corp），整段算一个路径。 */
const PATH_GAP_RE = /<path>(?:[ \t]+[^\s"'`<>]+){1,4}?[ \t]+<path>/g;
const TICKET_RE = /\b[A-Z][A-Z0-9_]{1,9}-\d+\b/g;
/** 日志里引号括起来的内容多半是用户写的东西（笔记、标题、提示）。 */
const QUOTED_RE = /"(?:[^"\\\n]|\\.)*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』/g;
/** 带非 ASCII 字母的一段（连着它的 ASCII 字母数字一起）：日志是英文写的，这些都是用户的内容。 */
const NON_ASCII_RE = /\w*\P{ASCII}+(?:\w+\P{ASCII}+)*\w*/gu;
const NON_ASCII_LETTER = /(?=\P{ASCII})\p{L}/u;
const PLACEHOLDER_SPLIT = /(<[a-z]+>)/;

/** 只在占位符以外的地方换：仓库叫 path 也不会把 <path> 弄坏。 */
const outside = (s: string, f: (part: string) => string): string =>
  s.split(PLACEHOLDER_SPLIT).map((part, i) => (i % 2 === 1 ? part : f(part))).join("");

interface ApplyOptions {
  /** 日志：引号里的内容和非 ASCII 的文字也换掉。 */
  freeText?: boolean;
}

function apply(s: string, ix: TermIndex, o: ApplyOptions = {}): string {
  let out = s.replace(URL_RE, "<url>").replace(EMAIL_RE, "<email>");
  out = outside(out, (part) => {
    const re = lineRegex(ix, part);
    return re ? part.replace(re, (m) => ix.placeholder.get(m.toLowerCase()) ?? "<redacted>") : part;
  });
  if (o.freeText) {
    out = outside(out, (part) => part.replace(QUOTED_RE, (m) => `${m[0]}<text>${m.at(-1)}`));
    out = outside(out, (part) => part.replace(NON_ASCII_RE, (m) => (NON_ASCII_LETTER.test(m) ? "<text>" : m)));
  }
  out = outside(out, (part) =>
    part.replace(HOST_RE, (m, tld: string) => (HOST_TLDS.has(tld.toLowerCase()) && !PUBLIC_HOSTS.has(m.toLowerCase()) ? "<host>" : m)),
  );
  out = out.replace(TOKEN_RE, (tok) => (/[\\/]/.test(tok) && /[A-Za-z]/.test(tok.replace(/<[a-z]+>/g, "x")) ? "<path>" : tok));
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(PATH_GAP_RE, "<path>");
  }
  return out.replace(TICKET_RE, "<ticket>");
}

/** 一行文字脱敏：先换网址和邮箱，再换已知的词、主机名、任何像路径的片段，最后是像 ticket 号的东西。 */
export function redactText(s: string, t: RedactTerms, o: ApplyOptions = {}): string {
  return apply(s, indexOf(t), o);
}

function walk(x: unknown, ix: TermIndex): unknown {
  if (typeof x === "string") return apply(x, ix);
  if (Array.isArray(x)) return x.map((y) => walk(y, ix));
  if (x && typeof x === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(x)) o[apply(k, ix)] = walk(val, ix);
    return o;
  }
  return x;
}

/** 对象里每个字符串和每个键都脱敏，数字、布尔原样。 */
export function redactDeep<T>(v: T, t: RedactTerms): T {
  return walk(v, indexOf(t)) as T;
}

export type RedactedDiagnostics = DiagnosticsFile & { redacted: true };

/** 版本号、平台这些不会命中任何规则；时间戳单独保留，免得被误伤。日志另外把引号里的内容和非 ASCII 的文字换掉。 */
export function redactedDiagnostics(file: DiagnosticsFile, t: RedactTerms): RedactedDiagnostics {
  const ix = indexOf(t);
  const out = walk({ ...file, logTail: [] }, ix) as DiagnosticsFile;
  const logTail = file.logTail.map((l) => apply(l, ix, { freeText: true }));
  return { ...out, logTail, kind: file.kind, generatedAt: file.generatedAt, redacted: true };
}

/** 哪些列里放的是路径、分支、仓库、ticket 号（每张表都看，以后加的列也算）。 */
const PATH_COLS = new Set(["repo_path", "worktree_path", "workspace_dir", "cwd", "root", "repo_root", "dir", "local_path", "worktree"]);
const BRANCH_COLS = new Set(["branch", "head_branch", "base_branch", "git_branch", "other_branch", "base"]);
const TITLE_COLS = new Set(["title", "pr_title"]);
const SLUG_COLS = new Set(["repo_slug", "slug"]);
const TICKET_COLS = new Set(["ticket_key", "other_ticket", "jira_epic_key"]);
/** 每一列最多取这么多个不同的值。 */
const MAX_PER_COLUMN = 5000;

/** 从数据库里收集要删的词，再并上 extras（家目录、用户名、数据目录、git remote 认出来的 slug）。读不了的表跳过。 */
export function collectRedactTerms(db: Db, extras: RedactExtras = {}): RedactTerms {
  const t: RedactTerms = { home: [], users: [], paths: [], titles: [], epics: [], repos: [], branches: [], tickets: [] };
  const slugs: string[] = [...(extras.slugs ?? [])];
  const values = (table: string, col: string): string[] => {
    try {
      const rows = db.prepare(`SELECT DISTINCT "${col}" AS v FROM "${table}" WHERE "${col}" IS NOT NULL LIMIT ${MAX_PER_COLUMN}`).all() as { v: unknown }[];
      return rows.map((r) => r.v).filter((v): v is string => typeof v === "string");
    } catch {
      return [];
    }
  };
  let tables: string[];
  try {
    tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  } catch {
    tables = [];
  }
  for (const table of tables) {
    let cols: string[];
    try {
      cols = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
    } catch {
      continue;
    }
    for (const col of cols) {
      if (PATH_COLS.has(col)) t.paths.push(...values(table, col));
      else if (BRANCH_COLS.has(col)) t.branches.push(...values(table, col));
      else if (SLUG_COLS.has(col)) slugs.push(...values(table, col));
      else if (TICKET_COLS.has(col)) t.tickets.push(...values(table, col));
      else if (TITLE_COLS.has(col)) t.titles.push(...values(table, col));
    }
  }
  for (const table of ["tickets", "intake_items"]) if (tables.includes(table)) t.tickets.push(...values(table, "key"));
  for (const table of ["features", "blocks"]) if (tables.includes(table)) t.epics.push(...values(table, "name"));
  if (tables.includes("merge_holds")) t.branches.push(...values("merge_holds", "target"));
  // 仓库、worktree、epic 目录的最后一段（目录名常常就是仓库名）。只看数据库里的：Shipherd 自己的目录、下载目录这些的名字不用删。
  for (const p of t.paths) t.repos.push(basename(p.replace(/\\/g, "/").replace(/\/+$/, "")));

  for (const k of Object.keys(t) as (keyof RedactTerms)[]) t[k].push(...(extras[k] ?? []));
  for (const s of slugs) {
    t.repos.push(s);
    t.repos.push(...s.split("/"));
  }
  for (const h of t.home) t.users.push(basename(h.replace(/\\/g, "/").replace(/\/+$/, "")));

  for (const k of Object.keys(t) as (keyof RedactTerms)[]) {
    t[k] = [...new Set(t[k].map((s) => s.trim()).filter((s) => s.replace(/[\\/]+/g, "").length >= 2))];
  }
  return t;
}
