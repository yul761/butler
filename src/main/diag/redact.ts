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
  /** 其他绝对路径（仓库、worktree、epic 目录、Butler / Claude 的数据目录）。 */
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

/** 字母、数字、下划线：词的边界看这些。 */
const WORD = "[\\p{L}\\p{N}_]";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 路径换成三种分隔符的写法：/、\、JSON 里转义过的 \\。 */
function pathVariants(p: string): string[] {
  const parts = p.split(/[\\/]+/);
  if (parts.length < 2) return [p];
  return [...new Set([parts.join("/"), parts.join("\\"), parts.join("\\\\")])];
}

const isPathLike = (cat: keyof RedactTerms, s: string): boolean => cat === "home" || cat === "paths" || /[\\/]/.test(s);

interface Compiled {
  re: RegExp | null;
  map: Map<string, string>;
}

/** 每个词的各种写法（小写）→ 占位符。同一个词在两类里时，类别靠前的（路径、标题）优先。 */
function termMap(t: RedactTerms): Map<string, string> {
  const map = new Map<string, string>();
  for (const cat of ["home", "paths", "titles", "epics", "branches", "tickets", "repos", "users"] as const) {
    for (const raw of t[cat]) {
      const term = raw.trim().replace(/[\\/]+$/, "");
      if (term.length < 2) continue;
      for (const v of isPathLike(cat, term) ? pathVariants(term) : [term]) {
        const k = v.toLowerCase();
        if (!map.has(k)) map.set(k, PLACEHOLDER[cat]);
      }
    }
  }
  return map;
}

const mapCache = new WeakMap<RedactTerms, Map<string, string>>();

/**
 * 只拿真的出现在 haystack 里的写法拼正则：真实的数据库里有上万个词，全塞进一个正则，每个位置都要试一遍，几百 KB 的日志要跑几分钟。
 * includes 先筛一遍，剩下的通常只有几十个。
 */
function compile(t: RedactTerms, haystack: string): Compiled {
  let all = mapCache.get(t);
  if (!all) {
    all = termMap(t);
    mapCache.set(t, all);
  }
  const lower = haystack.toLowerCase();
  const map = new Map<string, string>();
  for (const [k, v] of all) if (lower.includes(k)) map.set(k, v);
  const alts = [...map.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  const re = alts.length === 0 ? null : new RegExp(`(?<!${WORD})(?:${alts.join("|")})(?!${WORD})`, "giu");
  return { re, map };
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]*/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** 一段「像路径」的字符：占位符整块算一段，引号、括号、逗号、分号、等号、竖线把它断开。 */
const TOKEN_RE = /(?:<[a-z]+>|[^\s"'`<>()[\]{},;=|])+/g;
const TICKET_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

function apply(s: string, { re, map }: Compiled): string {
  let out = re ? s.replace(re, (m) => map.get(m.toLowerCase()) ?? "<redacted>") : s;
  out = out.replace(URL_RE, "<url>").replace(EMAIL_RE, "<email>");
  out = out.replace(TOKEN_RE, (tok) => (/[\\/]/.test(tok) && /[A-Za-z]/.test(tok.replace(/<[a-z]+>/g, "x")) ? "<path>" : tok));
  return out.replace(TICKET_RE, "<ticket>");
}

/** 一行文字脱敏：先换已知的词，再换网址、邮箱、任何像路径的片段，最后是像 ticket 号的东西。 */
export function redactText(s: string, t: RedactTerms): string {
  return apply(s, compile(t, s));
}

/** 对象里每个字符串和每个键都脱敏，数字、布尔原样。 */
export function redactDeep<T>(v: T, t: RedactTerms): T {
  const strings: string[] = [];
  const collect = (x: unknown): void => {
    if (typeof x === "string") strings.push(x);
    else if (Array.isArray(x)) x.forEach(collect);
    else if (x && typeof x === "object") {
      for (const [k, val] of Object.entries(x)) {
        strings.push(k);
        collect(val);
      }
    }
  };
  collect(v);
  const c = compile(t, strings.join("\u0000"));
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return apply(x, c);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x)) o[apply(k, c)] = walk(val);
      return o;
    }
    return x;
  };
  return walk(v) as T;
}

export type RedactedDiagnostics = DiagnosticsFile & { redacted: true };

/** 版本号、平台这些不会命中任何规则；时间戳单独保留，免得被误伤。 */
export function redactedDiagnostics(file: DiagnosticsFile, t: RedactTerms): RedactedDiagnostics {
  const out = redactDeep(file, t);
  return { ...out, kind: file.kind, generatedAt: file.generatedAt, redacted: true };
}

/** 哪些列里放的是路径、分支、仓库、ticket 号（每张表都看，以后加的列也算）。 */
const PATH_COLS = new Set(["repo_path", "worktree_path", "workspace_dir", "cwd", "root", "repo_root"]);
const BRANCH_COLS = new Set(["branch", "head_branch", "base_branch"]);
const SLUG_COLS = new Set(["repo_slug", "slug"]);
const TICKET_COLS = new Set(["ticket_key"]);
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
    }
  }
  if (tables.includes("tickets")) {
    t.titles.push(...values("tickets", "title"));
    t.tickets.push(...values("tickets", "key"));
  }
  if (tables.includes("features")) t.epics.push(...values("features", "name"));

  for (const k of Object.keys(t) as (keyof RedactTerms)[]) t[k].push(...(extras[k] ?? []));
  for (const s of slugs) {
    t.repos.push(s);
    t.repos.push(...s.split("/"));
  }
  // 仓库、worktree、epic 目录的最后一段（目录名常常就是仓库名）。
  for (const p of t.paths) t.repos.push(basename(p.replace(/\\/g, "/").replace(/\/+$/, "")));
  for (const h of t.home) t.users.push(basename(h.replace(/\\/g, "/").replace(/\/+$/, "")));

  for (const k of Object.keys(t) as (keyof RedactTerms)[]) {
    t[k] = [...new Set(t[k].map((s) => s.trim()).filter((s) => s.replace(/[\\/]+/g, "").length >= 2))];
  }
  return t;
}
