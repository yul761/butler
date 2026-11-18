// 导出成 lint（设计 §8）：按仓库现状挑接法，算出要写 / 要改的文件。纯函数：读文件经 read()，不碰磁盘、不跑 git。
import type { ExportTarget, RepoBaseline } from "../../../shared/baselines";
import type { ResolvedCheck, RunCommandParams } from "../../../shared/checks";
import { globToRegExp } from "../../../shared/glob";
import { parseJsonc, isRecord } from "../readers/jsonc";
import { checkData, nodeScript, pygrepEntry, pythonScript, runnerScript, shScript, shQuote, type ScriptRuntime } from "./scripts";
import { ensureTrailingEol, eolOf, jsonAddKey, jsonAppend, jsonGet, jsonReplace, makeAddPrereq, makeAddTarget, makeTargets, withEol, yamlAppendToTopList, yamlHasTopKey, yamlQuote } from "./text-edit";

/** 根目录里和导出有关的东西。 */
export interface RepoLayout {
  /** 根目录的文件名（原样大小写）。 */
  files: string[];
  /** 根目录的子目录名。 */
  dirs: string[];
  /** .husky/ 里的文件名。 */
  huskyFiles: string[];
}

export type ExportRefusal =
  | "no_repo"
  | "no_baseline"
  | "no_runtime"
  | "regex"
  | "no_hook_manager"
  | "already_in_ci"
  | "unsupported_type";

export interface ExportFile {
  path: string;
  content: string;
  /** 要可执行位。 */
  exec: boolean;
  created: boolean;
}

/** 接到了哪里（给结果说明用）。 */
export type Wired =
  | { kind: "pre_commit"; id: string; stage: "commit" | "push" }
  | { kind: "lint_staged"; file: string }
  | { kind: "husky"; hook: "pre-commit" | "pre-push" }
  | { kind: "eslint"; file: string }
  | { kind: "pkg_script"; name: string; run: string }
  | { kind: "make_target"; name: string }
  | { kind: "ci_pkg_lint"; script: string }
  | { kind: "ci_make_lint"; target: string };

export interface ExportPlan {
  target: ExportTarget;
  runtime: ScriptRuntime | null;
  /** 脚本的位置（script 目标和逐文件运行脚本）。 */
  script: string | null;
  /** 手动跑一遍全部文件的命令。 */
  runAll: string | null;
  name: string;
  files: ExportFile[];
  wired: Wired[];
  /** 选别的接法的原因（比如 ESLint 已经有 no-restricted-imports）。 */
  notes: string[];
}

export type ExportBuild = { ok: true; plan: ExportPlan } | { ok: false; reason: ExportRefusal; detail?: string };

export interface ExportInput {
  check: ResolvedCheck;
  baseline: RepoBaseline | null;
  layout: RepoLayout;
  /** 读根目录下的文件（仓库相对、用 /），没有返回 null。 */
  read: (path: string) => string | null;
  ticketPattern: string;
}

/** 检查名 → 文件 / 目标名用的短名（ASCII 小写、-）；名字里没有 ASCII 就用 check-<key6>。 */
export function exportName(name: string, key: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[^ -~]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || `check-${key6(key)}`;
}

export function key6(key: string): string {
  return key.replace(/^ck_/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toLowerCase() || "000000";
}

const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());

function findFile(layout: RepoLayout, names: string[]): string | null {
  const want = lower(names);
  for (const n of want) {
    const hit = layout.files.find((f) => f.toLowerCase() === n);
    if (hit) return hit;
  }
  return null;
}

interface Repo {
  preCommit: string | null;
  husky: boolean;
  pkg: { text: string; json: Record<string, unknown> } | null;
  lintStaged: { file: string; key: string[] } | null;
  eslint: { file: string; kind: "flat" | "json" | "yaml" | "package" } | null;
  python: boolean;
  makefile: string | null;
  pm: string;
}

function repoOf(i: ExportInput): Repo {
  const { layout, read } = i;
  const preCommit = findFile(layout, [".pre-commit-config.yaml", ".pre-commit-config.yml"]);
  const pkgText = layout.files.includes("package.json") ? read("package.json") : null;
  let pkgJson: Record<string, unknown> | null;
  try {
    const v = pkgText === null ? null : parseJsonc(pkgText);
    pkgJson = isRecord(v) ? v : null;
  } catch {
    pkgJson = null;
  }
  const pkg = pkgText !== null && pkgJson ? { text: pkgText, json: pkgJson } : null;
  let lintStaged: Repo["lintStaged"] = null;
  if (pkg && isRecord(pkg.json["lint-staged"])) lintStaged = { file: "package.json", key: ["lint-staged"] };
  else {
    const f = findFile(layout, [".lintstagedrc.json", ".lintstagedrc"]);
    if (f) {
      try {
        if (isRecord(parseJsonc(read(f) ?? ""))) lintStaged = { file: f, key: [] };
      } catch {
        // .lintstagedrc 是 YAML 写的：不改它。
      }
    }
  }
  let eslint: Repo["eslint"] = null;
  const flat = findFile(layout, ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts"]);
  if (flat) eslint = { file: flat, kind: "flat" };
  else {
    const json = findFile(layout, [".eslintrc.json"]);
    const yaml = findFile(layout, [".eslintrc.yaml", ".eslintrc.yml"]);
    const bare = findFile(layout, [".eslintrc"]);
    if (json) eslint = { file: json, kind: "json" };
    else if (yaml) eslint = { file: yaml, kind: "yaml" };
    else if (bare) {
      const t = read(bare) ?? "";
      let isJson: boolean;
      try {
        isJson = isRecord(parseJsonc(t));
      } catch {
        isJson = false;
      }
      eslint = { file: bare, kind: isJson ? "json" : "yaml" };
    } else if (pkg && isRecord(pkg.json.eslintConfig)) eslint = { file: "package.json", kind: "package" };
  }
  const python =
    !!findFile(layout, ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "tox.ini"]) ||
    !!i.baseline?.projects.some((p) => p.langs.includes("python"));
  const makefile = findFile(layout, ["GNUmakefile", "Makefile", "makefile"]);
  const rootPm = i.baseline?.projects.find((p) => p.dir === "")?.pm;
  const pm =
    rootPm && ["pnpm", "yarn", "bun", "npm"].includes(rootPm)
      ? rootPm
      : findFile(layout, ["pnpm-lock.yaml"])
        ? "pnpm"
        : findFile(layout, ["yarn.lock"])
          ? "yarn"
          : findFile(layout, ["bun.lockb", "bun.lock"])
            ? "bun"
            : "npm";
  return { preCommit, husky: layout.dirs.includes(".husky"), pkg, lintStaged, eslint, python, makefile, pm };
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** CI 里根目录跑的命令。 */
function ciCommands(b: RepoBaseline | null): string[] {
  return (b?.profile.ci ?? []).filter((c) => c.dir === "").map((c) => squash(c.command));
}

/** CI 跑不跑项目自己的 lint 脚本 / make 目标。 */
function ciRunsPkgLint(b: RepoBaseline | null): boolean {
  return ciCommands(b).some((c) => /(^|[\s;&|])(npm|pnpm|yarn|bun)(\s+run)?\s+lint(\s|$|[;&|])/.test(c));
}
function ciRunsMakeLint(b: RepoBaseline | null): boolean {
  return ciCommands(b).some((c) => /(^|[\s;&|])make(\s+-\S+)*\s+lint(\s|$|[;&|])/.test(c));
}

/** run_command 的命令是不是 CI 已经在跑的（按仓库现状里的 CI 命令比）。 */
function alreadyInCi(command: string, b: RepoBaseline | null): boolean {
  if (!b) return false;
  const cmd = squash(command.split("{file}").join("").replace(/"\$OLDPWD\/\$BUTLER_CHECK_FILE"|"?\$BUTLER_CHECK_FILE"?/g, ""));
  const same = (x: string) => squash(x.split("{file}").join("")) === cmd;
  for (const c of b.checks) {
    if (!c.stages.includes("ci")) continue;
    const prefix = c.dir ? `cd ${shQuote(c.dir)} && ` : "";
    const prefix2 = c.dir ? `cd ${c.dir} && ` : "";
    for (const x of [c.command, c.fileCommand ?? ""].filter(Boolean)) if (same(x) || same(prefix + x) || same(prefix2 + x)) return true;
  }
  return b.profile.ci.some((c) => same(c.command) || (c.dir && (same(`cd ${shQuote(c.dir)} && ${c.command}`) || same(`cd ${c.dir} && ${c.command}`))));
}

/** 检查的 globs → pre-commit 的 files / exclude（Python 正则）。 */
function filesRegex(globs: string[]): string | null {
  const gs = globs.filter((g) => g.trim());
  if (!gs.length) return null;
  const parts = gs.map((g) => globToRegExp(g).source.replace(/\\\//g, "/"));
  return parts.length === 1 ? parts[0] : parts.map((p) => `(?:${p})`).join("|");
}

/** pre-commit 的一个 local hook（YAML 行，不带列表缩进）。 */
function preCommitItem(hook: Record<string, string | boolean | string[] | undefined>): string[] {
  const lines = ["- repo: local", "  hooks:"];
  let first = true;
  for (const [k, v] of Object.entries(hook)) {
    if (v === undefined) continue;
    const val = Array.isArray(v) ? `[${v.map(yamlQuote).join(", ")}]` : typeof v === "boolean" ? String(v) : yamlQuote(v);
    lines.push(`${first ? "    - " : "      "}${k}: ${val}`);
    first = false;
  }
  return lines;
}

interface Builder {
  files: Map<string, ExportFile>;
  read: (p: string) => string | null;
}

function current(b: Builder, path: string): string | null {
  const f = b.files.get(path);
  return f ? f.content : b.read(path);
}

function put(b: Builder, path: string, content: string, exec = false): void {
  const had = b.files.get(path);
  const created = had ? had.created : b.read(path) === null;
  b.files.set(path, { path, content, exec: exec || !!had?.exec, created });
}

function addPreCommit(b: Builder, file: string, item: string[]): boolean {
  const text = current(b, file) ?? "";
  const out = yamlAppendToTopList(text, "repos", item);
  if (out === null) return false;
  put(b, file, out);
  return true;
}

/** .husky/<hook> 末尾加一行；没有这个文件就建（带 sh 开头，可执行）。 */
function addHusky(b: Builder, layout: RepoLayout, hook: "pre-commit" | "pre-push", line: string): void {
  const path = `.husky/${hook}`;
  const exists = layout.huskyFiles.includes(hook);
  const text = exists ? (current(b, path) ?? "") : null;
  if (text === null || (!exists && !b.files.has(path))) {
    put(b, path, `#!/usr/bin/env sh\n${line}\n`, true);
    return;
  }
  put(b, path, `${ensureTrailingEol(text)}${withEol(`${line}\n`, eolOf(text || "\n"))}`, true);
}

function addLintStaged(b: Builder, ls: { file: string; key: string[] }, globs: string[], cmd: string): boolean {
  const keys = globs.length ? globs : ["*"];
  let text = current(b, ls.file);
  if (text === null) return false;
  for (const g of keys) {
    const path = [...ls.key, g];
    const hit = jsonGet(text, path);
    let next: string | null;
    if (!hit) next = jsonAddKey(text, ls.key, g, cmd);
    else if (typeof hit.value === "string") next = jsonReplace(text, path, [hit.value, cmd]);
    else if (Array.isArray(hit.value)) next = jsonAppend(text, path, cmd);
    else next = null;
    if (next === null) return false;
    text = next;
  }
  put(b, ls.file, text);
  return true;
}

function addPkgScript(b: Builder, name: string, cmd: string): boolean {
  const text = current(b, "package.json");
  if (text === null) return false;
  const next = jsonAddKey(text, ["scripts"], name, cmd);
  if (next === null) return false;
  put(b, "package.json", next);
  return true;
}

/** CI 跑的 lint 脚本后面接上新的检查。 */
function appendPkgLint(b: Builder, run: string): boolean {
  const text = current(b, "package.json");
  if (text === null) return false;
  const hit = jsonGet(text, ["scripts", "lint"]);
  if (!hit || typeof hit.value !== "string" || hit.value.includes(run)) return false;
  const next = jsonReplace(text, ["scripts", "lint"], `${hit.value} && ${run}`);
  if (next === null) return false;
  put(b, "package.json", next);
  return true;
}

/**
 * 写了 shell 脚本或 husky hook：在 .gitattributes 里把它们定成 LF。Windows 上 core.autocrlf=true 的人签出来是 CRLF，
 * sh 会在 `set -u\r` 这种地方出错（审查发现）。返回有没有 shell 文件。
 */
function lfForShellFiles(b: Builder): boolean {
  const shell = [...b.files.values()].filter((f) => f.path.endsWith(".sh") || f.path.startsWith(".husky/")).map((f) => f.path);
  if (!shell.length) return false;
  const text = current(b, ".gitattributes") ?? "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = shell.map((p) => `/${p} text eol=lf`).filter((l) => !have.has(l));
  if (missing.length) put(b, ".gitattributes", `${text}${text && !text.endsWith("\n") ? eol : ""}${missing.join(eol)}${eol}`);
  return shell.some((p) => p.endsWith(".sh"));
}

export function buildExport(i: ExportInput): ExportBuild {
  const { check, layout } = i;
  if (!i.baseline) return { ok: false, reason: "no_baseline" };
  const repo = repoOf(i);
  const name = exportName(check.name, check.key);
  const b: Builder = { files: new Map(), read: i.read };
  const wired: Wired[] = [];
  const notes: string[] = [];
  const id = `butler-${name}`;
  const data = checkData(check, i.ticketPattern);
  const done = (target: ExportTarget, runtime: ScriptRuntime | null, script: string | null, runAll: string | null): ExportBuild => {
    if (lfForShellFiles(b)) notes.push("sh_windows");
    return { ok: true, plan: { target, runtime, script, runAll, name, files: [...b.files.values()], wired, notes } };
  };

  if (check.type === "run_command") return runCommandExport(i, repo, b, name, id, wired, notes, done);

  // forbidden_pattern + pre-commit：pygrep，不用额外脚本。
  if (check.type === "forbidden_pattern" && repo.preCommit) {
    const e = pygrepEntry(check.params);
    if (e.ok) {
      const item = preCommitItem({
        id, name: `Butler: ${check.name}`, entry: e.entry, language: "pygrep", args: e.args.length ? e.args : undefined,
        files: filesRegex(check.globs) ?? undefined, exclude: filesRegex(check.excludeGlobs) ?? undefined,
      });
      if (addPreCommit(b, repo.preCommit, item)) {
        wired.push({ kind: "pre_commit", id, stage: "commit" });
        return done("pre_commit", null, null, `pre-commit run ${id} --all-files`);
      }
      notes.push("pre_commit_shape");
    } else notes.push(`pygrep_${e.reason}`);
  }

  // import_boundary + ESLint：只有全是包名时用 no-restricted-imports。
  if (check.type === "import_boundary" && repo.eslint) {
    const r = eslintExport(repo, b, check, layout);
    if (r === true) {
      wired.push({ kind: "eslint", file: repo.eslint.file });
      return done("eslint", null, null, `npx eslint .`);
    }
    notes.push(r);
  }

  // script 目标
  const runtime: ScriptRuntime | null = repo.pkg ? "node" : repo.python ? "python" : check.type === "forbidden_pattern" ? "sh" : null;
  if (!runtime) return { ok: false, reason: "no_runtime" };
  const script = runtime === "node" ? `scripts/butler-checks/${name}.mjs` : runtime === "python" ? `scripts/butler_checks/${name}.py` : `scripts/butler-checks/${name}.sh`;
  const gen = runtime === "node" ? { ok: true as const, content: nodeScript(data, script) } : runtime === "python" ? pythonScript(data, script) : shScript(data, script);
  if (!gen.ok) return { ok: false, reason: "regex", detail: gen.reason };
  if (i.read(script) !== null) notes.push("script_replaced");
  put(b, script, gen.content, runtime === "sh");
  const run = runtime === "node" ? `node ${script}` : runtime === "python" ? `python3 ${script}` : `sh ${script}`;
  wireScript(b, repo, layout, i, name, id, run, runtime, script, check, wired);
  return done("script", runtime, script, `${run} --all`);
}

/** script 目标接到仓库里（设计 §8「Wiring」）：提交时只接一处（免得跑两遍），手动入口和 CI 能接的都接。 */
function wireScript(
  b: Builder, repo: Repo, layout: RepoLayout, i: ExportInput, name: string, id: string, run: string, runtime: ScriptRuntime, script: string, check: ResolvedCheck, wired: Wired[],
): void {
  let commit = false;
  if (repo.preCommit) {
    const item = preCommitItem({
      id, name: `Butler: ${check.name}`, entry: runtime === "python" ? `python ${script}` : run, language: runtime === "python" ? "python" : "system",
      pass_filenames: true, files: filesRegex(check.globs) ?? undefined, exclude: filesRegex(check.excludeGlobs) ?? undefined,
    });
    if (addPreCommit(b, repo.preCommit, item)) {
      wired.push({ kind: "pre_commit", id, stage: "commit" });
      commit = true;
    }
  }
  if (!commit && repo.lintStaged && addLintStaged(b, repo.lintStaged, check.globs, run)) {
    wired.push({ kind: "lint_staged", file: repo.lintStaged.file });
    commit = true;
  }
  if (!commit && repo.husky) {
    addHusky(b, layout, "pre-commit", run);
    wired.push({ kind: "husky", hook: "pre-commit" });
  }
  const scriptName = `butler:${name}`;
  if (repo.pkg && addPkgScript(b, scriptName, `${run} --all`)) {
    wired.push({ kind: "pkg_script", name: scriptName, run: `${repo.pm} run ${scriptName}` });
    if (ciRunsPkgLint(i.baseline) && appendPkgLint(b, `${repo.pm} run ${scriptName}`)) wired.push({ kind: "ci_pkg_lint", script: "lint" });
  }
  if (repo.makefile) {
    const text = current(b, repo.makefile) ?? "";
    const target = `butler-${name}`;
    if (!makeTargets(text).includes(target)) {
      let next = makeAddTarget(text, target, [`${run} --all`]);
      wired.push({ kind: "make_target", name: target });
      if (ciRunsMakeLint(i.baseline) && makeTargets(text).includes("lint")) {
        const withPre = makeAddPrereq(next, "lint", target);
        if (withPre !== null) {
          next = withPre;
          wired.push({ kind: "ci_make_lint", target: "lint" });
        }
      }
      put(b, repo.makefile, next);
    }
  }
}

/** 一条 import 规则是不是包名（不是仓库路径）。 */
function isPackageSpec(p: string, layout: RepoLayout): boolean {
  const s = p.trim();
  if (!s || s.startsWith(".") || s.startsWith("/")) return false;
  if (s.startsWith("@") || s.includes(":")) return true;
  const first = s.split("/")[0];
  if (/[*?[{]/.test(first)) return false;
  return !layout.dirs.some((d) => d.toLowerCase() === first.toLowerCase()) && !layout.files.some((f) => f.toLowerCase() === first.toLowerCase());
}

const ESLINT_BLOCK_KEY = "no-restricted-imports";

function eslintExport(repo: Repo, b: Builder, check: ResolvedCheck, layout: RepoLayout): true | string {
  const e = repo.eslint!;
  const forbid = Array.isArray(check.params.forbid) ? (check.params.forbid as string[]) : [];
  const allow = Array.isArray(check.params.allow) ? (check.params.allow as string[]) : [];
  if (!forbid.length || ![...forbid, ...allow].every((p) => isPackageSpec(p, layout))) return "eslint_repo_paths";
  const text = current(b, e.file);
  if (text === null) return "eslint_unreadable";
  // 已经有这条规则：同一组文件上后写的会整条替换前面的，可能把仓库自己的限制关掉。
  if (text.includes(ESLINT_BLOCK_KEY)) return "eslint_rule_exists";
  const rule = ["error", { patterns: [{ group: [...forbid, ...allow.map((a) => `!${a}`)], message: check.message || check.name }] }];
  const files = check.globs.length ? check.globs.map((g) => (g.includes("/") ? g : `**/${g}`)) : ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"];
  const ignores = check.excludeGlobs.map((g) => (g.includes("/") ? g : `**/${g}`));
  if (e.kind === "flat") {
    const eol = eolOf(text);
    const block: Record<string, unknown> = { files, ...(ignores.length ? { ignores } : {}), rules: { [ESLINT_BLOCK_KEY]: rule } };
    const literal = `// Butler check "${check.name.replace(/[\r\n]+/g, " ")}" as a repo rule.\n${JSON.stringify(block, null, 2)}`;
    const esm = text.match(/^export default\s/gm);
    const cjs = text.match(/^module\.exports\s*=\s*/gm);
    let next: string;
    if (esm?.length === 1 && !cjs) {
      next = text.replace(/^export default\s/m, "const butlerBaseConfig = ");
      next = `${ensureTrailingEol(next)}${withEol(`\n${literal.replace(/^\{/m, "const butlerCheckConfig = {")};\n\nexport default [butlerBaseConfig, butlerCheckConfig];\n`, eol)}`;
    } else if (cjs?.length === 1 && !esm) {
      next = text.replace(/^module\.exports\s*=\s*/m, "const butlerBaseConfig = ");
      next = `${ensureTrailingEol(next)}${withEol(`\n${literal.replace(/^\{/m, "const butlerCheckConfig = {")};\n\nmodule.exports = [butlerBaseConfig, butlerCheckConfig];\n`, eol)}`;
    } else return "eslint_flat_shape";
    put(b, e.file, next);
    return true;
  }
  const override = { files, ...(ignores.length ? { excludedFiles: ignores } : {}), rules: { [ESLINT_BLOCK_KEY]: rule } };
  if (e.kind === "json" || e.kind === "package") {
    const path = e.kind === "package" ? ["eslintConfig", "overrides"] : ["overrides"];
    const next = jsonAppend(text, path, override);
    if (next === null) return "eslint_json_shape";
    put(b, e.file, next);
    return true;
  }
  // YAML eslintrc
  if (yamlHasTopKey(text, "overrides") && !/^overrides\s*:\s*(#.*)?$/m.test(text)) return "eslint_yaml_shape";
  const item = [
    `- files: [${files.map(yamlQuote).join(", ")}]`,
    ...(ignores.length ? [`  excludedFiles: [${ignores.map(yamlQuote).join(", ")}]`] : []),
    "  rules:",
    `    ${ESLINT_BLOCK_KEY}:`,
    "      - error",
    "      - patterns:",
    `          - group: [${[...forbid, ...allow.map((a) => `!${a}`)].map(yamlQuote).join(", ")}]`,
    `            message: ${yamlQuote(check.message || check.name)}`,
  ];
  const next = yamlAppendToTopList(text, "overrides", item);
  if (next === null) return "eslint_yaml_shape";
  put(b, e.file, next);
  return true;
}

const COMPOUND = /[;&|<>`()\n]|\$\(|\$\{?BUTLER_CHECK_FILE|\$OLDPWD/;

/** run_command 检查（设计 §8 表最后一行）。 */
function runCommandExport(
  i: ExportInput, repo: Repo, b: Builder, name: string, id: string, wired: Wired[], notes: string[],
  done: (t: ExportTarget, r: ScriptRuntime | null, s: string | null, a: string | null) => ExportBuild,
): ExportBuild {
  const p = i.check.params as unknown as RunCommandParams;
  const command = String(p.command ?? "").trim();
  if (alreadyInCi(command, i.baseline)) return { ok: false, reason: "already_in_ci" };
  const { layout } = i;
  if (p.stage === "push") {
    const cmd = command.split("{file}").join("").trim();
    if (repo.husky) {
      addHusky(b, layout, "pre-push", cmd);
      wired.push({ kind: "husky", hook: "pre-push" });
      return done("husky", null, null, cmd);
    }
    if (repo.preCommit) {
      const entry = COMPOUND.test(cmd) ? `sh -c ${shQuote(cmd)}` : cmd;
      const item = preCommitItem({ id, name: `Butler: ${i.check.name}`, entry, language: "system", pass_filenames: false, always_run: true, stages: ["pre-push"] });
      if (addPreCommit(b, repo.preCommit, item)) {
        wired.push({ kind: "pre_commit", id, stage: "push" });
        notes.push("pre_push_install");
        return done("pre_commit", null, null, cmd);
      }
    }
    return { ok: false, reason: "no_hook_manager" };
  }
  if (!repo.preCommit && !repo.lintStaged && !repo.husky) return { ok: false, reason: "no_hook_manager" };
  // 简单命令（{file} 在最后或没写）：直接让 pre-commit / lint-staged 把文件接在后面。
  const trimmed = command.replace(/\s*\{file\}\s*$/, "");
  const simple = !COMPOUND.test(command) && !trimmed.includes("{file}");
  if (simple && repo.preCommit) {
    const item = preCommitItem({
      id, name: `Butler: ${i.check.name}`, entry: trimmed, language: "system", pass_filenames: true,
      files: filesRegex(i.check.globs) ?? undefined, exclude: filesRegex(i.check.excludeGlobs) ?? undefined,
    });
    if (addPreCommit(b, repo.preCommit, item)) {
      wired.push({ kind: "pre_commit", id, stage: "commit" });
      return done("pre_commit", null, null, `pre-commit run ${id} --all-files`);
    }
  }
  if (simple && !repo.preCommit && repo.lintStaged && !i.check.excludeGlobs.length && addLintStaged(b, repo.lintStaged, i.check.globs, trimmed)) {
    wired.push({ kind: "lint_staged", file: repo.lintStaged.file });
    return done("lint_staged", null, null, null);
  }
  // 其余：写一个逐文件运行的脚本（和 hook 一样每个文件跑一次），再接到 pre-commit / lint-staged / husky。
  const script = `scripts/butler-checks/${name}.sh`;
  const data = checkData(i.check, i.ticketPattern);
  put(b, script, runnerScript(data, command, script), true);
  const run = `sh ${script}`;
  let target: ExportTarget = "husky";
  if (repo.preCommit) {
    const item = preCommitItem({
      id, name: `Butler: ${i.check.name}`, entry: run, language: "system", pass_filenames: true,
      files: filesRegex(i.check.globs) ?? undefined, exclude: filesRegex(i.check.excludeGlobs) ?? undefined,
    });
    if (addPreCommit(b, repo.preCommit, item)) {
      wired.push({ kind: "pre_commit", id, stage: "commit" });
      target = "pre_commit";
    }
  }
  if (!wired.length && repo.lintStaged && addLintStaged(b, repo.lintStaged, i.check.globs, run)) {
    wired.push({ kind: "lint_staged", file: repo.lintStaged.file });
    target = "lint_staged";
  }
  if (!wired.length && repo.husky) {
    addHusky(b, layout, "pre-commit", run);
    wired.push({ kind: "husky", hook: "pre-commit" });
  }
  if (!wired.length) return { ok: false, reason: "no_hook_manager" };
  return done(target, "sh", script, `${run} --all`);
}
