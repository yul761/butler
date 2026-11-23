// 第一阶段扫描的核心（设计 §3.2–3.4）：给定文件列表和读文件的函数，认项目、跑解析器、给 CI / 钩子 / 脚本里的命令归类、合并成检查、写仓库档案。
// 不调模型、不跑命令、不写文件。纯同步，worker 里跑。
import { createHash } from "node:crypto";
import { globToRegExp } from "../../shared/glob";
import {
  baselineCheckId, type BaselineAdvice, type BaselineCategory, type BaselineCheck, type BaselineConfidence, type BaselineProject, type KeywordRule,
  type MarkerRule, type ProfileProject, type RepoProfile, type RepoStage, type ToolSpec,
} from "../../shared/baselines";
import { runExtractor, type Contribution, type ScriptDef, type ScriptKind, type WiredCommand } from "./extract";
import { shellWords, splitCommands } from "./readers/commands";
import type { ExtractorName, ResolvedRules } from "./rules";

export interface ScanInput {
  /** 仓库相对路径，用 /。 */
  files: string[];
  /** 读一个文件（仓库相对）；读不了 / 太大返回 null。 */
  read: (path: string) => string | null;
  rules: ResolvedRules;
  /** 文件列表被截断了。 */
  truncated?: boolean;
}

export interface ScanOutput {
  projects: BaselineProject[];
  checks: BaselineCheck[];
  advice: BaselineAdvice[];
  profile: RepoProfile;
  inputs: { path: string; hash: string }[];
  listingHash: string;
  /** 为什么要模型补（空 = 不用）。 */
  inferReasons: string[];
  /** CI 里认不出来的命令（给模型看）。 */
  unclassified: { command: string; dir: string; evidence: string }[];
  truncated: boolean;
}

const SKIP_SEGMENTS = /(^|\/)(node_modules|vendor|third_party|testdata|__fixtures__|fixtures|examples?|\.git|\.venv|venv|dist|build|target|out|coverage|\.next)(\/|$)/;
const MAX_DEPTH = 6;

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const depth = (d: string) => (d ? d.split("/").length : 0);
const join = (d: string, rel: string) => (d ? (rel ? `${d}/${rel}` : d) : rel);
const under = (path: string, dir: string) => !dir || path === dir || path.startsWith(`${dir}/`);
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** 从 from 目录到 to 目录的相对路径（都是仓库相对）。 */
function relPath(from: string, to: string): string {
  const a = from ? from.split("/") : [];
  const b = to ? to.split("/") : [];
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/") || ".";
}

// ---------------------------------------------------------------- 规则匹配

interface CompiledMarker {
  rule: MarkerRule;
  /** 不带 / 的：只匹配目录里直接的文件名；带 / 的：匹配相对路径。 */
  flat: RegExp[];
  nested: RegExp[];
}

function compile(rule: MarkerRule): CompiledMarker {
  const flat: RegExp[] = [];
  const nested: RegExp[] = [];
  for (const g of rule.files) {
    const re = globToRegExp(g);
    const ci = new RegExp(re.source, "i");
    (g.includes("/") ? nested : flat).push(ci);
  }
  return { rule, flat, nested };
}

function matches(c: CompiledMarker, rel: string): boolean {
  if (!rel.includes("/")) return c.flat.some((re) => re.test(rel));
  return c.nested.some((re) => re.test(rel));
}

// ---------------------------------------------------------------- 每个目录的信息

interface DirInfo {
  dir: string;
  project: boolean;
  langs: Set<string>;
  markers: Set<string>;
  deps: Set<string>;
  facts: Map<string, Set<string>>;
  pm?: string;
  pkgName?: string;
  workspaces: boolean;
  install?: string;
  installRule?: string;
  templates: { spec: ToolSpec; evidence: string; rule: string }[];
}

interface Ctx {
  files: Set<string>;
  lower: Map<string, string>;
  read: (p: string) => string | null;
  readLog: Map<string, string>;
  rules: ResolvedRules;
  dirs: Map<string, DirInfo>;
  projects: string[];
  /** 脚本按文件所在目录存：kind → dir → name → def。 */
  scripts: Map<ScriptKind, Map<string, Map<string, ScriptDef>>>;
  preCommit: Map<string, NonNullable<Contribution["preCommitHooks"]>>;
  lintStaged: Map<string, NonNullable<Contribution["lintStaged"]>>;
  wired: WiredCommand[];
  toolSpecs: Map<string, ToolSpec>;
}

function info(ctx: Ctx, dir: string): DirInfo {
  let d = ctx.dirs.get(dir);
  if (!d) {
    d = { dir, project: false, langs: new Set(), markers: new Set(), deps: new Set(), facts: new Map(), workspaces: false, templates: [] };
    ctx.dirs.set(dir, d);
  }
  return d;
}

function readFile(ctx: Ctx, p: string): string | null {
  if (ctx.readLog.has(p)) return ctx.readLog.get(p)!;
  const t = ctx.read(p);
  if (t !== null) ctx.readLog.set(p, t);
  return t;
}

/** 目录 dir 所属的项目（最深的、是 dir 前缀的项目目录）；没有就是根。 */
function ownerOf(ctx: Ctx, dir: string): string {
  let best = "";
  for (const p of ctx.projects) if (under(dir, p) && p.length > best.length) best = p;
  return best;
}

function exists(ctx: Ctx, p: string): boolean {
  return ctx.files.has(p) || ctx.lower.has(p.toLowerCase());
}

// ---------------------------------------------------------------- 占位符

const NODE_PMS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PY_PMS = new Set(["uv", "poetry", "pipenv", "pdm", "pip"]);

function lockPm(ctx: Ctx, dir: string): { node?: string; py?: string } {
  const has = (f: string) => exists(ctx, join(dir, f));
  const node = has("pnpm-lock.yaml") || has("pnpm-workspace.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : has("package-lock.json") ? "npm" : undefined;
  const py = has("uv.lock") ? "uv" : has("poetry.lock") ? "poetry" : has("Pipfile.lock") || has("Pipfile") ? "pipenv" : has("pdm.lock") ? "pdm" : undefined;
  return { node, py };
}

function ancestors(dir: string): string[] {
  const out = [dir];
  let d = dir;
  while (d) {
    d = dirOf(d);
    out.push(d);
  }
  return out;
}

/** 包管理器：自己的 packageManager / 锁文件，否则往上找（monorepo 的子包用根目录的）。 */
function nodePm(ctx: Ctx, dir: string): { pm: string; root: string } {
  for (const d of ancestors(dir)) {
    const own = ctx.dirs.get(d)?.pm;
    if (own && NODE_PMS.has(own)) return { pm: own, root: d };
    const l = lockPm(ctx, d).node;
    if (l) return { pm: l, root: d };
  }
  return { pm: "npm", root: dir };
}

function pyPm(ctx: Ctx, dir: string): { pm: string; root: string } {
  for (const d of ancestors(dir)) {
    const own = ctx.dirs.get(d)?.pm;
    if (own && PY_PMS.has(own)) return { pm: own, root: d };
    const l = lockPm(ctx, d).py;
    if (l) return { pm: l, root: d };
  }
  return { pm: "pip", root: dir };
}

function wrapper(ctx: Ctx, dir: string, name: string, fallback: string): string {
  for (const d of ancestors(dir)) if (exists(ctx, join(d, name))) return d === dir ? `./${name}` : `${relPath(dir, d)}/${name}`;
  return fallback;
}

const RUN: Record<string, string> = { npm: "npm run", pnpm: "pnpm", yarn: "yarn", bun: "bun run" };
const EXEC: Record<string, string> = { npm: "npx", pnpm: "pnpm exec", yarn: "yarn", bun: "bunx" };
const PY: Record<string, string> = { uv: "uv run ", poetry: "poetry run ", pipenv: "pipenv run ", pdm: "pdm run ", pip: "" };

function fill(ctx: Ctx, dir: string, tpl: string): string {
  return tpl
    .replace(/\{exec\}/g, () => EXEC[nodePm(ctx, dir).pm])
    .replace(/\{run\}/g, () => RUN[nodePm(ctx, dir).pm])
    .replace(/\{pm\}/g, () => nodePm(ctx, dir).pm)
    .replace(/\{py\}/g, () => PY[pyPm(ctx, dir).pm])
    .replace(/\{mvn\}/g, () => wrapper(ctx, dir, "mvnw", "mvn"))
    .replace(/\{gradle\}/g, () => wrapper(ctx, dir, "gradlew", "gradle"));
}

// ---------------------------------------------------------------- 命令归类

interface Found {
  /** 命令在哪个目录跑。 */
  cwd: string;
  category: BaselineCategory;
  tool: string;
  command: string;
  /** 命令的来源有多「直接」：4 脚本入口，3 原样的命令，2 pre-commit hook，1 模板。 */
  rank: number;
  fileCommand?: string;
  passFiles?: boolean;
  exts?: string[];
  evidence: string[];
}

interface Origin {
  stage: RepoStage | null;
  evidence: string;
  passFiles?: boolean;
  ci: boolean;
}

const SETUP = /^(?:(?:sudo\s+)?(?:apt(?:-get)?|brew|choco|yum|apk|dnf|corepack|curl|wget|tar|unzip|chmod|ln|touch|git|docker|gh|nvm|fnm|asdf|rustup|pyenv|conda)\b|(?:npm|pnpm|yarn|bun)\s+(?:install|ci|i|add|config|set|cache|store|rebuild|link)\b|(?:pip3?|python3?\s+-m\s+pip|pipx|uv\s+(?:pip|sync|venv|tool\s+install)|poetry\s+(?:install|config)|pipenv\s+install|pdm\s+install|gem|bundle\s+(?:install|config)|composer\s+(?:install|update|config)|go\s+(?:mod|get|install|env)|cargo\s+(?:install|fetch)|dotnet\s+(?:restore|tool)|mvn\s+.*dependency:|npx\s+playwright\s+install)\b)/i;
const NODE_BUILTIN = new Set(["install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "outdated", "link", "unlink", "publish", "pack", "version", "init", "create", "config", "set", "cache", "store", "rebuild", "prune", "dedupe", "why", "list", "ls", "help", "login", "logout", "whoami", "import", "fetch", "audit", "env", "setup", "patch", "info", "view"]);
const LAUNCHER = /^(npm|pnpm|yarn|bun|bunx|npx|pnpx|node|deno|sh|bash|zsh|pwsh|powershell|cmd|python3?|py|uv|poetry|pipenv|pdm|go|cargo|make|just|mvn|gradle|dotnet|bundle|ruby|rake|composer|php|\.{0,2}\/.*)$/;

/** 剥掉 time / env / sudo 这类前缀。 */
function stripWrappers(words: string[]): string[] {
  let w = words;
  for (;;) {
    if (w[0] === "time" || w[0] === "sudo" || w[0] === "nice" || w[0] === "xvfb-run") w = w.slice(1);
    else if (w[0] === "env") w = w.slice(1).filter((x, i, a) => !(i < a.findIndex((y) => !y.includes("=")) && x.includes("=")));
    else if (w[0] === "timeout" && w[1]) w = w.slice(2);
    else return w;
  }
}

function genericTool(words: string[]): string {
  const first = baseOf(words[0] ?? "cmd");
  if (/^(make|gmake|just|npm|pnpm|yarn|bun|composer|rake|tox|nox|cargo|go|dotnet|mvn|gradle|gradlew|mvnw)$/.test(first) && words[1] && !words[1].startsWith("-")) return `${first} ${words[1]}`;
  return first || "cmd";
}

function keyword(ctx: Ctx, text: string): KeywordRule | null {
  for (const r of ctx.rules.keywords) {
    try {
      if (new RegExp(r.match, "i").test(text)) return r;
    } catch {
      // 规则表里的正则已经校验过
    }
  }
  return null;
}

/** 名字本身说明了是哪类（lint、test、typecheck…）。 */
function categoryOfName(ctx: Ctx, name: string): BaselineCategory | null {
  const n = name.toLowerCase().replace(/^poe:/, "");
  if (/^(check|verify|validate|ci|precommit|pre-commit|qa|all)$/.test(n)) return null;
  for (const r of ctx.rules.keywords) {
    if (r.tool !== "*") continue;
    if (new RegExp(r.match, "i").test(n.replace(/[:_]/g, " "))) return r.category;
  }
  return null;
}

function scriptsIn(ctx: Ctx, kind: ScriptKind, dir: string): Map<string, ScriptDef> | undefined {
  return ctx.scripts.get(kind)?.get(dir);
}

/** 节点脚本里的命令在 npm 外面跑要加 exec 前缀（node_modules/.bin 不在 PATH 上）。 */
function nodeBin(ctx: Ctx, dir: string, text: string): string {
  const w = shellWords(text);
  return w[0] && !LAUNCHER.test(w[0]) ? `${fill(ctx, dir, "{exec}")} ${text}` : text;
}

interface ClassifyOpts {
  depth: number;
  seen: Set<string>;
  /** 命令来自 package.json 的脚本（裸的 bin 名）。 */
  nodeScript?: boolean;
  passFiles?: boolean;
}

function classify(ctx: Ctx, text: string, cwd: string, o: ClassifyOpts): { found: Found[]; unclassified: boolean; setup: boolean } {
  const words = stripWrappers(shellWords(text));
  if (!words.length) return { found: [], unclassified: false, setup: true };
  const plain = words.join(" ");
  if (SETUP.test(plain)) return { found: [], unclassified: false, setup: true };
  if (o.depth > 4) return { found: [], unclassified: true, setup: false };

  const expanded = expand(ctx, words, cwd, o);
  if (expanded) return { found: expanded, unclassified: expanded.length === 0, setup: false };

  const kw = keyword(ctx, plain);
  if (!kw) return { found: [], unclassified: true, setup: false };
  const tool = kw.tool === "*" ? genericTool(words) : kw.tool;
  const command = o.nodeScript ? nodeBin(ctx, cwd, text.trim()) : text.trim();
  return {
    found: [{ cwd, category: kw.category, tool, command, rank: 3, fileCommand: kw.fileCommand ?? ctx.toolSpecs.get(tool)?.fileCommand, passFiles: o.passFiles, exts: kw.exts ?? ctx.toolSpecs.get(tool)?.exts, evidence: [] }],
    unclassified: false, setup: false,
  };
}

/** 跑脚本 name（package.json / Makefile / justfile / composer / tox）：展开它的内容。 */
function runScript(ctx: Ctx, def: ScriptDef, dir: string, invocation: string, o: ClassifyOpts): Found[] {
  const key = `${def.kind}:${dir}:${def.name}`;
  if (o.seen.has(key)) return [];
  const seen = new Set(o.seen).add(key);
  const nameCat = categoryOfName(ctx, def.name);
  const out: Found[] = [];
  let anyUnclassified = false;
  for (const seg of splitCommands(def.body)) {
    const sub = classify(ctx, seg.text, join(dir, seg.cd), { depth: o.depth + 1, seen, nodeScript: def.kind === "node", passFiles: o.passFiles });
    if (sub.unclassified) anyUnclassified = true;
    out.push(...sub.found);
  }
  // 名字说明了类别、里面又认不出来（./tools/acme-lint）：整条脚本就是这一类。
  if (nameCat && !out.some((f) => f.category === nameCat)) {
    if (anyUnclassified || out.length === 0) out.push({ cwd: dir, category: nameCat, tool: genericTool(shellWords(invocation)), command: invocation, rank: 4, evidence: [] });
  }
  for (const f of out) {
    f.evidence.push(def.evidence);
    // 脚本名就是这一类、这一类只有这一个工具：用脚本入口（仓库自己的叫法）。
    if (nameCat && f.category === nameCat && ownerOf(ctx, f.cwd) === ownerOf(ctx, dir) && out.filter((x) => x.category === nameCat).length === 1) {
      f.command = invocation;
      f.cwd = dir;
      f.rank = 4;
    }
  }
  return out;
}

function nodeProjects(ctx: Ctx): string[] {
  return [...ctx.dirs.values()].filter((d) => d.project && d.markers.has("node")).map((d) => d.dir);
}

/** 认得的「跑别的东西」的命令：包管理器的脚本、make、just、composer、tox、pre-commit、lint-staged、仓库里的 shell 脚本。null = 不是。 */
function expand(ctx: Ctx, words: string[], cwd: string, o: ClassifyOpts): Found[] | null {
  const w0 = baseOf(words[0]).toLowerCase();

  if (w0 === "npx" || w0 === "pnpx" || w0 === "bunx" || (w0 === "yarn" && words[1] === "dlx") || (w0 === "pnpm" && (words[1] === "dlx" || words[1] === "exec")) || (w0 === "npm" && (words[1] === "exec" || words[1] === "x"))) {
    const rest = words.slice(w0 === "npx" || w0 === "pnpx" || w0 === "bunx" ? 1 : 2).filter((x, i) => !(i === 0 && x === "--"));
    const r = rest[0] === "--" ? rest.slice(1) : rest;
    if (!r.length) return [];
    const sub = classify(ctx, r.join(" "), cwd, { ...o, depth: o.depth + 1 });
    return sub.found.map((f) => (f.rank === 3 ? { ...f, command: words.join(" ") } : f));
  }

  if (w0 === "turbo" || w0 === "nx" || w0 === "lerna") {
    const names = words.slice(1).filter((x) => !x.startsWith("-") && !["run", "run-many", "affected", "exec"].includes(x));
    const tIdx = words.findIndex((x) => x === "-t" || x === "--target" || x === "--targets");
    const targets = tIdx >= 0 ? (words[tIdx + 1] ?? "").split(",") : names.map((n) => (n.includes(":") ? n.split(":")[1] : n));
    const out: Found[] = [];
    for (const dir of nodeProjects(ctx)) {
      const s = scriptsIn(ctx, "node", dir);
      for (const t of targets) {
        const def = s?.get(t);
        if (def) out.push(...runScript(ctx, def, dir, `${fill(ctx, dir, "{run}")} ${t}`, o));
      }
    }
    return out;
  }

  if (NODE_PMS.has(w0)) {
    let i = 1;
    let target: string | null = null;
    let all = false;
    let filter: string | null = null;
    while (i < words.length && words[i].startsWith("-")) {
      const f = words[i];
      if (f === "-C" || f === "--dir" || f === "--prefix" || f === "--cwd") {
        target = words[i + 1] ?? null;
        i += 2;
      } else if (f === "--filter" || f === "-F" || f === "--workspace" || f === "-w") {
        filter = words[i + 1] ?? null;
        i += 2;
      } else if (f.startsWith("--filter=") || f.startsWith("--workspace=")) {
        filter = f.slice(f.indexOf("=") + 1);
        i++;
      } else if (f === "-r" || f === "--recursive" || f === "-ws" || f === "--workspaces" || f === "-W" || f === "--if-present" || f === "--silent" || f === "-s") {
        if (f !== "--if-present" && f !== "--silent" && f !== "-s" && f !== "-W") all = true;
        i++;
      } else i++;
    }
    if (w0 === "yarn" && words[i] === "workspaces" && words[i + 1] === "foreach") {
      all = true;
      i += 2;
      while (i < words.length && words[i].startsWith("-")) i++;
    }
    if (w0 === "yarn" && words[i] === "workspace" && words[i + 1]) {
      filter = words[i + 1];
      i += 2;
    }
    let sub = words[i];
    if (!sub) return null;
    if (sub === "run" || sub === "run-script") sub = words[++i];
    else if (sub === "t" || sub === "tst") sub = "test";
    if (!sub) return null;
    if (NODE_BUILTIN.has(sub) && words[i - 1] !== "run" && words[i - 1] !== "run-script") return sub === "audit" ? null : [];
    const baseDir = target ? (join(cwd, target.replace(/^\.\/?/, "").replace(/\/$/, "")) || cwd) : cwd;
    const dirs = all || filter
      ? nodeProjects(ctx).filter((d) => {
          if (!filter) return d !== "" || nodeProjects(ctx).length === 1;
          const nm = ctx.dirs.get(d)?.pkgName ?? "";
          const re = new RegExp(`^${filter.replace(/^\.\//, "").replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
          return re.test(nm) || re.test(d) || re.test(baseOf(d));
        })
      : [ownerOf(ctx, baseDir)];
    const out: Found[] = [];
    let found = false;
    for (const dir of dirs) {
      const def = scriptsIn(ctx, "node", dir)?.get(sub);
      if (!def) continue;
      found = true;
      out.push(...runScript(ctx, def, dir, `${fill(ctx, dir, "{run}")} ${sub}`, o));
    }
    if (found) return out;
    // 没有这个脚本：pnpm / yarn / bun 会去跑同名的 bin（pnpm eslint .）。
    if (w0 !== "npm") {
      const rest = words.slice(i).join(" ");
      const r = classify(ctx, rest, cwd, { ...o, depth: o.depth + 1 });
      return r.found.map((f) => (f.rank === 3 ? { ...f, command: words.join(" ") } : f));
    }
    return null;
  }

  if (w0 === "make" || w0 === "gmake" || w0 === "just" || w0 === "composer" || w0 === "tox") {
    const kind: ScriptKind = w0 === "just" ? "just" : w0 === "composer" ? "composer" : w0 === "tox" ? "tox" : "make";
    let dir = cwd;
    const names: string[] = [];
    for (let i = 1; i < words.length; i++) {
      const x = words[i];
      if ((x === "-C" || x === "--directory" || x === "-c" || x === "--working-directory") && words[i + 1]) {
        dir = join(cwd, words[++i].replace(/^\.\/?/, "").replace(/\/$/, ""));
      } else if (kind === "tox" && (x === "-e" || x.startsWith("-e"))) {
        const v = x === "-e" ? words[++i] : x.slice(2);
        names.push(...(v ?? "").split(",").filter(Boolean));
      } else if (x.startsWith("-") || x.includes("=")) continue;
      else if (kind !== "tox" && !(kind === "composer" && (x === "run-script" || x === "run"))) names.push(x);
    }
    const s = scriptsIn(ctx, kind, dir);
    if (!s || !names.length) return null;
    const out: Found[] = [];
    let any = false;
    for (const n of names) {
      const def = s.get(n);
      if (!def) continue;
      any = true;
      const inv = kind === "make" ? `make ${arg(n)}` : kind === "just" ? `just ${arg(n)}` : kind === "composer" ? `composer ${arg(n)}` : `tox -e ${arg(n)}`;
      out.push(...runScript(ctx, def, dir, inv, o));
    }
    return any ? out : null;
  }

  if (w0 === "pre-commit" || w0 === "prek") {
    if (words[1] !== "run" && words[1] !== undefined) return words[1] === "install" ? [] : null;
    const id = words.slice(2).find((x) => !x.startsWith("-") && !/^(manual|pre-commit|pre-push|commit|push)$/.test(x));
    const stageIdx = words.indexOf("--hook-stage");
    const stage = stageIdx >= 0 ? words[stageIdx + 1] : null;
    let hooks: NonNullable<Contribution["preCommitHooks"]> = [];
    for (const d of ancestors(cwd)) {
      const h = ctx.preCommit.get(d);
      if (h) {
        hooks = h;
        break;
      }
    }
    const pick = hooks.filter((h) => (id ? h.id === id : stage ? h.stages.includes(stage === "pre-push" || stage === "push" ? "push" : "commit") : h.stages.includes("commit")));
    return pick.flatMap((h) => preCommitHook(ctx, h, cwd, o));
  }

  if (w0 === "lint-staged") {
    let entries: NonNullable<Contribution["lintStaged"]> = [];
    for (const d of ancestors(cwd)) {
      const e = ctx.lintStaged.get(d);
      if (e) {
        entries = e;
        break;
      }
    }
    return entries.flatMap((e) =>
      e.commands.flatMap((c) => {
        const r = classify(ctx, c.replace(/\s--fix\b|\s--write\b/g, "").trim(), cwd, { ...o, depth: o.depth + 1, nodeScript: true, passFiles: true });
        return r.found.map((f) => ({ ...f, passFiles: true, evidence: [...f.evidence, e.evidence] }));
      }),
    );
  }

  // 仓库里的脚本文件：./scripts/lint.sh、bash tools/check.sh
  let script = words[0];
  if (/^(bash|sh|zsh)$/.test(w0) && words[1] && !words[1].startsWith("-")) script = words[1];
  const rel = join(cwd, script.replace(/^\.\//, ""));
  if (/\.(sh|bash)$|^\.\//.test(script) && exists(ctx, rel)) {
    const text = readFile(ctx, rel);
    if (text !== null && !text.includes("\0")) {
      const name = baseOf(rel).replace(/\.[^.]+$/, "");
      const def: ScriptDef = { kind: "make", name, body: text, evidence: rel };
      const key = `file:${rel}`;
      if (o.seen.has(key)) return [];
      const found = runScript(ctx, def, cwd, words.join(" "), { ...o, seen: new Set(o.seen).add(key) });
      return found.length ? found : null;
    }
  }
  return null;
}

function preCommitHook(ctx: Ctx, h: NonNullable<Contribution["preCommitHooks"]>[number], cwd: string, o: ClassifyOpts): Found[] {
  const r = h.entry ? classify(ctx, h.entry, cwd, { ...o, depth: o.depth + 1 }) : { found: [] as Found[] };
  let found = r.found;
  if (!found.length) {
    // hook id：ruff-format 要按「ruff format」认，golangci-lint 要按原样认；专门的规则优先于通用词。
    const spaced = keyword(ctx, h.id.replace(/[-_]/g, " "));
    const raw = keyword(ctx, h.id);
    const kw = [spaced, raw].find((x) => x && x.tool !== "*") ?? spaced ?? raw;
    if (!kw) return [];
    found = [{ cwd, category: kw.category, tool: kw.tool === "*" ? h.id : kw.tool, command: "", rank: 2, exts: kw.exts, evidence: [] }];
  }
  return found.map((f) => ({
    ...f,
    cwd,
    command: `pre-commit run ${arg(h.id)} --all-files`,
    fileCommand: h.passFiles ? `pre-commit run ${arg(h.id)} --files {file}` : f.fileCommand,
    passFiles: h.passFiles,
    rank: 2,
    evidence: [...f.evidence, h.evidence],
  }));
}

// ---------------------------------------------------------------- 主流程

export function scanFiles(input: ScanInput): ScanOutput {
  const files = input.files.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "")).filter(Boolean);
  const ctx: Ctx = {
    files: new Set(files), lower: new Map(files.map((f) => [f.toLowerCase(), f])), read: input.read, readLog: new Map(), rules: input.rules, dirs: new Map(), projects: [],
    scripts: new Map(), preCommit: new Map(), lintStaged: new Map(), wired: [], toolSpecs: new Map(),
  };
  for (const r of input.rules.markers) for (const t of r.tools ?? []) if (!ctx.toolSpecs.has(t.tool)) ctx.toolSpecs.set(t.tool, t);
  const compiled = input.rules.markers.map(compile);
  const projectRules = compiled.filter((c) => c.rule.project);

  // 1. 项目目录
  const candidates = files.filter((f) => !SKIP_SEGMENTS.test(dirOf(f)) && depth(dirOf(f)) <= MAX_DEPTH + 2);
  const projects = new Set<string>();
  for (const f of candidates) {
    const d = dirOf(f);
    if (depth(d) > MAX_DEPTH) continue;
    if (projectRules.some((c) => matches(c, baseOf(f)))) projects.add(d);
  }
  ctx.projects = [...projects].sort();
  for (const p of ctx.projects) info(ctx, p).project = true;
  info(ctx, "");

  // 2. 规则命中：(规则, 文件)
  const hits: { c: CompiledMarker; file: string; dir: string; fileDir: string }[] = [];
  for (const f of candidates) {
    const fileDir = dirOf(f);
    const owner = ownerOf(ctx, fileDir);
    const rel = owner ? f.slice(owner.length + 1) : f;
    for (const c of compiled) if (matches(c, rel)) hits.push({ c, file: f, dir: owner, fileDir });
  }
  const listingHash = sha1(hits.map((h) => `${h.c.rule.key}:${h.file}`).sort().join("\n") + `\n${ctx.projects.join(",")}`);

  // 3. 解析器（先跑：requires 里的 dep 要用 package.json 的依赖）
  const extracted = new Set<string>();
  for (const h of hits) {
    const ex = h.c.rule.extract;
    if (!ex) continue;
    const key = `${ex}:${h.file}`;
    if (extracted.has(key)) continue;
    extracted.add(key);
    const text = readFile(ctx, h.file);
    if (text === null) continue;
    const contrib = runExtractor(ex as ExtractorName, { path: h.file, dir: h.dir, text });
    absorb(ctx, h.dir, h.fileDir, contrib);
  }

  // 4. 规则的其他部分：语言、安装、工具模板
  for (const h of hits) {
    const r = h.c.rule;
    if (r.requires?.length) {
      const ok = r.requires.every((q) => {
        if (q.dep && !info(ctx, h.dir).deps.has(q.dep) && !info(ctx, h.dir).deps.has(q.dep.toLowerCase())) return false;
        if (q.contains) {
          const target = q.file ? join(h.dir, q.file) : h.file;
          const text = readFile(ctx, target);
          if (text === null || !text.includes(q.contains)) return false;
        }
        return true;
      });
      if (!ok) continue;
    }
    const d = info(ctx, h.dir);
    d.markers.add(r.key);
    if (r.lang && (d.project || h.dir === "")) d.langs.add(r.lang);
    if (r.pm && !d.pm) d.pm = r.pm;
    if (r.install && (!d.install || r.project)) {
      d.install = r.install;
      d.installRule = r.key;
    }
    for (const spec of r.tools ?? []) d.templates.push({ spec, evidence: h.file, rule: r.key });
  }
  // TypeScript：有 tsconfig 就是 ts；Kotlin：gradle 项目里有 .kt 文件
  for (const d of ctx.dirs.values()) {
    if (d.markers.has("typescript") || d.deps.has("typescript")) d.langs.add("ts");
    if (d.langs.has("java") && files.some((f) => under(f, d.dir) && f.endsWith(".kt"))) d.langs.add("kotlin");
  }

  // 5. 接上的命令（CI、钩子）和名字像检查的脚本
  const found: { f: Found; origin: Origin }[] = [];
  const unclassified: ScanOutput["unclassified"] = [];
  const ciList: RepoProfile["ci"] = [];
  let ciClassified = 0;
  let ciTotal = 0;
  for (const w of ctx.wired) {
    const origin: Origin = { stage: w.stage, evidence: w.evidence, passFiles: w.passFiles, ci: w.stage === "ci" };
    if (w.uses) {
      const kw = keyword(ctx, w.text);
      if (!kw) continue;
      ciTotal++;
      ciClassified++;
      const tool = kw.tool === "*" ? w.text.split(/[@\s]/)[0] : kw.tool;
      ciList.push({ category: kw.category, command: `uses: ${w.text.split(" ")[0]}`, dir: w.dir });
      const spec = ctx.toolSpecs.get(tool);
      if (spec) found.push({ f: { cwd: w.dir, category: kw.category, tool, command: fill(ctx, w.dir, spec.command), rank: 1, fileCommand: spec.fileCommand, exts: spec.exts, evidence: [] }, origin });
      continue;
    }
    if (w.hookId) {
      const hooks = ctx.preCommit.get(w.dir) ?? [];
      const h = hooks.find((x) => x.id === w.hookId);
      if (h) for (const f of preCommitHook(ctx, h, w.dir, { depth: 0, seen: new Set() })) found.push({ f, origin });
      continue;
    }
    for (const seg of splitCommands(w.text, w.dir)) {
      const r = classify(ctx, seg.text, seg.cd, { depth: 0, seen: new Set(), passFiles: w.passFiles, nodeScript: false });
      if (origin.ci && !r.setup) {
        ciTotal++;
        if (r.found.length) ciClassified++;
        else unclassified.push({ command: seg.text, dir: seg.cd, evidence: w.evidence });
        const cats = [...new Set(r.found.map((x) => x.category))];
        ciList.push({ category: cats.length === 1 ? cats[0] : "other", command: seg.text, dir: seg.cd });
      }
      for (const f of r.found) found.push({ f, origin });
    }
  }
  for (const [kind, byDir] of ctx.scripts) {
    if (kind === "tox") continue;
    for (const [dir, defs] of byDir) {
      for (const def of defs.values()) {
        if (!categoryOfName(ctx, def.name)) continue;
        const inv = kind === "node" ? `${fill(ctx, dir, "{run}")} ${arg(def.name)}` : kind === "make" ? `make ${arg(def.name)}` : kind === "just" ? `just ${arg(def.name)}` : `composer ${arg(def.name)}`;
        for (const f of runScript(ctx, def, dir, inv, { depth: 0, seen: new Set() })) found.push({ f, origin: { stage: null, evidence: def.evidence, ci: false } });
      }
    }
  }

  // 6. 合并成检查
  const byId = new Map<string, BaselineCheck & { rank: number; fileRank: number }>();
  const add = (dir: string, f: Found, stage: RepoStage | null, confidence: BaselineConfidence, ci: boolean, evidence: string[]) => {
    const id = baselineCheckId(dir, f.category, f.tool);
    // 命令要能在项目目录里跑：cwd 在项目下面就 cd 过去
    const command = f.cwd === dir ? f.command : under(f.cwd, dir) ? `cd ${quote(relPath(dir, f.cwd))} && ${f.command}` : f.command;
    const spec = ctx.toolSpecs.get(f.tool);
    const fileTpl = f.fileCommand;
    const fileRank = f.rank === 2 ? 3 : fileTpl ? 2 : 0;
    const cur = byId.get(id);
    if (!cur) {
      byId.set(id, {
        id, dir, category: f.category, tool: f.tool, command, fileCommand: fileTpl ? fill(ctx, dir, fileTpl) : undefined,
        testOne: spec?.testOne ? fill(ctx, dir, spec.testOne) : undefined, stages: stage ? [stage] : [], changedFiles: !!(f.passFiles || fileTpl), shipherdStage: "push",
        source: ci ? "ci" : "marker", confidence, evidence: [...new Set(evidence)], facts: [], exts: f.exts ?? spec?.exts, rank: f.rank, fileRank,
      });
      return;
    }
    if (f.rank > cur.rank) {
      cur.command = command;
      cur.rank = f.rank;
    }
    if (fileTpl && fileRank > cur.fileRank) {
      cur.fileCommand = fill(ctx, dir, fileTpl);
      cur.fileRank = fileRank;
    }
    if (stage && !cur.stages.includes(stage)) cur.stages.push(stage);
    if (f.passFiles || fileTpl) cur.changedFiles = true;
    if (rankConf(confidence) > rankConf(cur.confidence)) cur.confidence = confidence;
    if (ci) cur.source = "ci";
    for (const e of evidence) if (!cur.evidence.includes(e)) cur.evidence.push(e);
    if (!cur.exts) cur.exts = f.exts;
  };
  for (const { f, origin } of found) {
    const dir = ownerOf(ctx, f.cwd);
    add(dir, f, origin.stage, "high", origin.ci, [origin.evidence, ...f.evidence]);
  }
  for (const d of ctx.dirs.values()) {
    for (const t of d.templates) {
      add(d.dir, { cwd: d.dir, category: t.spec.category, tool: t.spec.tool, command: fill(ctx, d.dir, t.spec.command), rank: 1, fileCommand: t.spec.fileCommand, exts: t.spec.exts, evidence: [] }, null, "medium", false, [t.evidence]);
    }
  }
  const checks: BaselineCheck[] = [];
  for (const c of byId.values()) {
    const { rank: _r, fileRank: _f, ...rest } = c;
    void _r;
    void _f;
    const facts = new Set<string>();
    for (const [tool, fs] of info(ctx, c.dir).facts) if (tool === c.tool) for (const x of fs) facts.add(x);
    rest.facts = [...facts].sort();
    rest.stages.sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b));
    rest.shipherdStage = rest.fileCommand && (rest.category === "lint" || rest.category === "format" || rest.category === "typecheck") ? "edit" : "push";
    rest.evidence = rest.evidence.slice(0, 8);
    checks.push(rest);
  }
  checks.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category) || (a.tool < b.tool ? -1 : 1)));

  // 7. 项目、建议、要不要模型补
  const projectsOut: BaselineProject[] = [...ctx.dirs.values()]
    .filter((d) => d.project)
    .map((d) => ({ dir: d.dir, langs: [...d.langs].sort(), markers: [...d.markers].sort(), pm: projectPm(ctx, d) }));
  const advice: BaselineAdvice[] = [];
  const inferReasons: string[] = [];
  for (const p of projectsOut) {
    if (!p.langs.length) continue;
    // 工作区的根（下面还有同语言的项目、自己没有检查）：检查都在子项目里，不算缺。
    const children = projectsOut.filter((q) => q.dir !== p.dir && under(q.dir, p.dir));
    if (children.length && !checks.some((c) => c.dir === p.dir) && p.langs.every((l) => children.some((q) => q.langs.includes(l)))) continue;
    const mine = checks.filter((c) => c.dir === p.dir);
    const missing: BaselineCategory[] = [];
    if (!mine.some((c) => c.category === "lint")) missing.push("lint");
    if ((p.langs.includes("ts") || p.langs.includes("python")) && !mine.some((c) => c.category === "typecheck")) missing.push("typecheck");
    if (missing.length) advice.push({ dir: p.dir, missing });
    if (!mine.some((c) => c.category === "test") && !mine.some((c) => c.category === "lint")) inferReasons.push(`project_without_checks:${p.dir || "."}`);
  }
  if (!projectsOut.length && !checks.length) inferReasons.push("no_project");
  if (ciTotal > 0 && ciClassified === 0) inferReasons.push("ci_unclassified");

  const profile = buildProfile(ctx, projectsOut, checks, ciList, files);
  const inputs = [...ctx.readLog.entries()].map(([path, text]) => ({ path, hash: sha1(text) })).sort((a, b) => (a.path < b.path ? -1 : 1));
  return { projects: projectsOut, checks, advice, profile, inputs, listingHash, inferReasons, unclassified: unclassified.slice(0, 40), truncated: !!input.truncated };
}

const STAGE_ORDER: RepoStage[] = ["commit", "push", "ci"];
const CAT_ORDER: BaselineCategory[] = ["lint", "format", "typecheck", "test", "build", "security"];
const rankConf = (c: BaselineConfidence) => (c === "high" ? 3 : c === "medium" ? 2 : 1);

function quote(s: string): string {
  return /^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 命令里的一个参数（脚本名、make / just 目标、pre-commit 的 hook id）：常见的 lint:fix、@scope/x 这类不加引号，
 * 带空格或 shell 字符的才加（不然 "lint fix" 会变成两个参数）。
 */
function arg(s: string): string {
  return /^[\w./:@+=,%-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

function absorb(ctx: Ctx, owner: string, fileDir: string, c: Contribution): void {
  const d = info(ctx, owner);
  for (const x of c.deps ?? []) d.deps.add(x);
  for (const f of c.facts ?? []) {
    const set = d.facts.get(f.tool) ?? new Set<string>();
    for (const x of f.facts) set.add(x);
    d.facts.set(f.tool, set);
  }
  if (c.pm && !d.pm) d.pm = c.pm;
  if (c.pkgName && !d.pkgName) d.pkgName = c.pkgName;
  if (c.workspaces) d.workspaces = true;
  for (const s of c.scripts ?? []) {
    const byDir = ctx.scripts.get(s.kind) ?? new Map<string, Map<string, ScriptDef>>();
    ctx.scripts.set(s.kind, byDir);
    const m = byDir.get(fileDir) ?? new Map<string, ScriptDef>();
    byDir.set(fileDir, m);
    if (!m.has(s.name)) m.set(s.name, s);
  }
  if (c.preCommitHooks) ctx.preCommit.set(fileDir, c.preCommitHooks);
  if (c.lintStaged) ctx.lintStaged.set(fileDir, [...(ctx.lintStaged.get(fileDir) ?? []), ...c.lintStaged]);
  for (const w of c.wired ?? []) ctx.wired.push(w.hookId ? { ...w, dir: fileDir } : w);
}

function projectPm(ctx: Ctx, d: DirInfo): string | undefined {
  if (d.markers.has("node")) return nodePm(ctx, d.dir).pm;
  if (d.langs.has("python")) return pyPm(ctx, d.dir).pm;
  return d.pm;
}

// ---------------------------------------------------------------- 档案

function pick(checks: BaselineCheck[], cat: BaselineCategory, avoid: RegExp = /^$/): BaselineCheck | null {
  const c = checks.filter((x) => x.category === cat).sort((a, b) => rankConf(b.confidence) - rankConf(a.confidence) || Number(avoid.test(a.tool)) - Number(avoid.test(b.tool)) || b.stages.length - a.stages.length);
  return c[0] ?? null;
}

function installFor(ctx: Ctx, p: BaselineProject): string | null {
  const d = info(ctx, p.dir);
  if (d.markers.has("node")) {
    const { pm, root } = nodePm(ctx, p.dir);
    if (root !== p.dir && ctx.dirs.get(root)?.markers.has("node")) return null; // 根目录装
    if (pm === "npm") return exists(ctx, join(p.dir, "package-lock.json")) ? "npm ci" : "npm install";
    return `${pm} install`;
  }
  if (d.langs.has("python")) {
    const { pm } = pyPm(ctx, p.dir);
    if (pm === "uv") return "uv sync";
    if (pm === "poetry") return "poetry install";
    if (pm === "pipenv") return "pipenv install --dev";
    if (pm === "pdm") return "pdm install";
    if (exists(ctx, join(p.dir, "requirements-dev.txt"))) return "pip install -r requirements-dev.txt";
    if (exists(ctx, join(p.dir, "requirements.txt"))) return "pip install -r requirements.txt";
    return exists(ctx, join(p.dir, "pyproject.toml")) || exists(ctx, join(p.dir, "setup.py")) ? "pip install -e ." : null;
  }
  return d.install ? fill(ctx, p.dir, d.install) : null;
}

function conventions(files: string[], projects: BaselineProject[]): string[] {
  const out: string[] = [];
  const count = (re: RegExp) => files.reduce((n, f) => n + (re.test(f) ? 1 : 0), 0);
  const parents = new Map<string, number>();
  for (const p of projects) if (p.dir) parents.set(dirOf(p.dir), (parents.get(dirOf(p.dir)) ?? 0) + 1);
  for (const [parent, n] of parents) if (n >= 2 && parent) out.push(`${parent}/* (${n} projects)`);
  const topDirs = new Set(files.map((f) => f.split("/")[0]).filter((x) => x && !x.startsWith(".")));
  for (const d of ["src", "lib", "app", "cmd", "internal", "pkg", "tests", "test", "spec", "e2e", "docs", "scripts"]) if (topDirs.has(d) && files.some((f) => f.startsWith(`${d}/`))) out.push(`${d}/`);
  const patterns: [RegExp, string][] = [
    [/\.test\.[cm]?[jt]sx?$/, "*.test.ts / *.test.js"],
    [/\.spec\.[cm]?[jt]sx?$/, "*.spec.ts / *.spec.js"],
    [/(^|\/)test_[^/]+\.py$/, "test_*.py"],
    [/_test\.py$/, "*_test.py"],
    [/_test\.go$/, "*_test.go next to the code"],
    [/_spec\.rb$/, "*_spec.rb"],
    [/Test\.java$/, "*Test.java"],
    [/Tests?\.cs$/, "*Tests.cs"],
  ];
  for (const [re, label] of patterns) if (count(re) > 0) out.push(label);
  return out.slice(0, 12);
}

function buildProfile(ctx: Ctx, projects: BaselineProject[], checks: BaselineCheck[], ci: RepoProfile["ci"], files: string[]): RepoProfile {
  const list = projects.length ? projects : checks.length ? [{ dir: "", langs: [], markers: [] } as BaselineProject] : [];
  const out: ProfileProject[] = list.map((p) => {
    const mine = checks.filter((c) => c.dir === p.dir);
    const test = pick(mine, "test", /^(playwright|cypress)$/);
    const lint = pick(mine, "lint");
    const type = pick(mine, "typecheck");
    const build = pick(mine, "build");
    const perFile = mine.filter((c) => c.fileCommand && (c.category === "lint" || c.category === "typecheck")).sort((a, b) => rankConf(b.confidence) - rankConf(a.confidence))[0];
    return {
      dir: p.dir, langs: p.langs, install: installFor(ctx, p), build: build?.command ?? null, testAll: test?.command ?? null, testOne: test?.testOne ?? null,
      fastest: perFile?.fileCommand ?? type?.command ?? lint?.command ?? null, lint: lint?.command ?? null, typecheck: type?.command ?? null, inferred: [],
    };
  });
  const seen = new Set<string>();
  const ciOut = ci.filter((c) => {
    const k = `${c.dir}|${c.command}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { projects: out, dirs: conventions(files, projects), ci: ciOut.slice(0, 20), pitfalls: [] };
}
