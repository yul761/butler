// 解析各种文件（设计 §3.1 的 extract）：从 package.json、Makefile、workflow、pre-commit 配置等里读出命令、脚本、依赖和开着的规则。
// 每个解析器只读给它的那个文件的文字，读不懂就返回空的结果，不抛错。纯函数（不碰磁盘），扫描器负责读文件。
import { parse as parseYaml } from "yaml";
import type { RepoStage } from "../../shared/baselines";
import { isRecord, parseJsonc } from "./readers/jsonc";
import { parseToml, tomlGet, tomlStrings, type TomlTable } from "./readers/toml";
import { lines } from "./readers/commands";
import type { ExtractorName } from "./rules";

/** CI 步骤、提交钩子里接上的一条命令。 */
export interface WiredCommand {
  text: string;
  /** 在哪个目录跑（仓库相对，用 /）。 */
  dir: string;
  stage: RepoStage | null;
  evidence: string;
  /** 钩子会把改过的文件传给它（pre-commit、lint-staged）。 */
  passFiles?: boolean;
  /** pre-commit 的 hook id。 */
  hookId?: string;
  /** GitHub Actions 的 uses: 步骤（不是 shell 命令）。 */
  uses?: boolean;
}

export type ScriptKind = "node" | "make" | "just" | "composer" | "tox";

export interface ScriptDef {
  kind: ScriptKind;
  name: string;
  body: string;
  evidence: string;
}

export interface Contribution {
  wired?: WiredCommand[];
  scripts?: ScriptDef[];
  deps?: string[];
  facts?: { tool: string; facts: string[] }[];
  pm?: string;
  pkgName?: string;
  /** package.json 有 workspaces / pnpm-workspace：子目录的包共用根目录的安装。 */
  workspaces?: boolean;
  /** pre-commit 配置里的 hook（CI 里 `pre-commit run` 展开用）。 */
  preCommitHooks?: { id: string; entry?: string; stages: RepoStage[]; evidence: string; passFiles: boolean }[];
  /** lint-staged 的条目（`lint-staged` 展开用）。 */
  lintStaged?: { glob: string; commands: string[]; evidence: string }[];
}

export interface ExtractInput {
  /** 文件的仓库相对路径（用 /）。 */
  path: string;
  /** 文件所在的项目目录（"" 是根）。 */
  dir: string;
  text: string;
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function yaml(text: string): unknown {
  try {
    return parseYaml(text.replace(/^﻿/, ""), { strict: false, uniqueKeys: false, logLevel: "silent" });
  } catch {
    return null;
  }
}

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === "string" ? [x] : Array.isArray(x) ? strings(x) : []));
  return [];
}

function joinRel(dir: string, sub: unknown): string {
  if (typeof sub !== "string" || !sub.trim()) return dir;
  const s = sub.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!s || s === "." || s.includes("$") || s.startsWith("/") || /^[a-zA-Z]:/.test(s)) return dir;
  return dir ? `${dir}/${s}` : s;
}

// ---------------------------------------------------------------- JS / TS

function packageJson({ path, text }: ExtractInput): Contribution {
  const pkg = parseJsonc(text);
  if (!isRecord(pkg)) return {};
  const out: Contribution = {};
  if (isRecord(pkg.scripts)) {
    out.scripts = Object.entries(pkg.scripts)
      .filter((e): e is [string, string] => typeof e[1] === "string")
      .map(([name, body]) => ({ kind: "node", name, body, evidence: `${path}: scripts.${name}` }));
  }
  const deps = new Set<string>();
  for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) if (isRecord(pkg[k])) for (const d of Object.keys(pkg[k] as object)) deps.add(d);
  out.deps = [...deps];
  if (typeof pkg.packageManager === "string") out.pm = pkg.packageManager.split("@")[0].trim() || undefined;
  if (typeof pkg.name === "string") out.pkgName = pkg.name;
  if (pkg.workspaces) out.workspaces = true;
  if (isRecord(pkg["lint-staged"])) out.lintStaged = lintStagedEntries(pkg["lint-staged"], `${path}: lint-staged`);
  if (isRecord(pkg.eslintConfig)) out.facts = [{ tool: "eslint", facts: eslintRuleFacts(pkg.eslintConfig) }];
  return out;
}

function eslintRuleFacts(cfg: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const visit = (c: unknown) => {
    if (!isRecord(c)) return;
    if (isRecord(c.rules)) {
      for (const [name, v] of Object.entries(c.rules)) {
        const level = Array.isArray(v) ? v[0] : v;
        if (level === "error" || level === "warn" || level === 1 || level === 2) out.add(name);
      }
    }
    if (Array.isArray(c.overrides)) c.overrides.forEach(visit);
  };
  if (Array.isArray(cfg)) cfg.forEach(visit);
  else visit(cfg);
  return [...out];
}

function eslint({ path, text }: ExtractInput): Contribution {
  const name = base(path);
  let facts: string[] = [];
  if (name === ".eslintrc" || name.endsWith(".json")) {
    const v = parseJsonc(text);
    facts = isRecord(v) ? eslintRuleFacts(v) : [];
    if (!facts.length && name === ".eslintrc") {
      const y = yaml(text);
      if (isRecord(y)) facts = eslintRuleFacts(y);
    }
  } else if (name.endsWith(".yml") || name.endsWith(".yaml")) {
    const y = yaml(text);
    if (isRecord(y)) facts = eslintRuleFacts(y);
  } else {
    // JS 配置：认引号里的规则名 + 级别。
    const re = /["'`]((?:@[\w.-]+\/)?[\w-]+(?:\/[\w-]+)?)["'`]\s*:\s*\[?\s*["'`]?(error|warn|1|2)\b/g;
    const set = new Set<string>();
    for (const mm of text.matchAll(re)) set.add(mm[1]);
    facts = [...set];
  }
  return facts.length ? { facts: [{ tool: "eslint", facts }] } : {};
}

function tsconfig({ text }: ExtractInput): Contribution {
  const v = parseJsonc(text);
  if (!isRecord(v) || !isRecord(v.compilerOptions)) return {};
  const facts = Object.entries(v.compilerOptions).filter(([, x]) => x === true).map(([k]) => k);
  return facts.length ? { facts: [{ tool: "tsc", facts }] } : {};
}

function lintStagedEntries(obj: Record<string, unknown>, evidence: string): NonNullable<Contribution["lintStaged"]> {
  return Object.entries(obj).map(([glob, v]) => ({ glob, commands: strings(v), evidence })).filter((e) => e.commands.length);
}

function lintStaged({ path, text }: ExtractInput): Contribution {
  const v = parseJsonc(text) ?? yaml(text);
  return isRecord(v) ? { lintStaged: lintStagedEntries(v, path) } : {};
}

// ---------------------------------------------------------------- Python

function ruffFacts(t: TomlTable, prefix: string): string[] {
  return [...tomlStrings(tomlGet(t, `${prefix}select`)), ...tomlStrings(tomlGet(t, `${prefix}extend-select`)), ...tomlStrings(tomlGet(t, `${prefix}lint.select`)), ...tomlStrings(tomlGet(t, `${prefix}lint.extend-select`))];
}

function trueKeys(v: unknown): string[] {
  return isRecord(v) ? Object.entries(v).filter(([, x]) => x === true).map(([k]) => k) : [];
}

function pyproject({ text }: ExtractInput): Contribution {
  const t = parseToml(text);
  const out: Contribution = { facts: [] };
  const name = tomlGet(t, "project.name") ?? tomlGet(t, "tool.poetry.name");
  if (typeof name === "string") out.pkgName = name;
  if (tomlGet(t, "tool.poetry")) out.pm = "poetry";
  else if (tomlGet(t, "tool.uv")) out.pm = "uv";
  else if (tomlGet(t, "tool.pdm")) out.pm = "pdm";
  const ruff = ruffFacts(t, "tool.ruff.");
  if (ruff.length) out.facts!.push({ tool: "ruff", facts: ruff });
  const mypy = trueKeys(tomlGet(t, "tool.mypy"));
  if (mypy.length) out.facts!.push({ tool: "mypy", facts: mypy });
  const pyright = tomlGet(t, "tool.pyright.typeCheckingMode");
  if (typeof pyright === "string") out.facts!.push({ tool: "pyright", facts: [`typeCheckingMode:${pyright}`] });
  const deps = [...tomlStrings(tomlGet(t, "project.dependencies")), ...Object.values((tomlGet(t, "project.optional-dependencies") as TomlTable) ?? {}).flatMap((x) => tomlStrings(x))];
  const groups = tomlGet(t, "dependency-groups");
  if (isRecord(groups)) for (const g of Object.values(groups)) deps.push(...tomlStrings(g as never));
  const poetryDev = tomlGet(t, "tool.poetry.group");
  if (isRecord(poetryDev)) for (const g of Object.values(poetryDev)) if (isRecord(g) && isRecord(g.dependencies)) deps.push(...Object.keys(g.dependencies));
  const poetryDeps = tomlGet(t, "tool.poetry.dependencies");
  if (isRecord(poetryDeps)) deps.push(...Object.keys(poetryDeps));
  out.deps = deps.map((d) => d.split(/[\s<>=!~[;]/)[0].toLowerCase()).filter(Boolean);
  const poe = tomlGet(t, "tool.poe.tasks");
  if (isRecord(poe)) {
    out.scripts = Object.entries(poe).flatMap(([n, v]) => {
      const body = typeof v === "string" ? v : isRecord(v) && typeof v.cmd === "string" ? v.cmd : null;
      return body ? [{ kind: "node" as const, name: `poe:${n}`, body, evidence: `pyproject.toml: tool.poe.tasks.${n}` }] : [];
    });
  }
  return out;
}

/** INI：section → key → value（多行值按缩进续行）。 */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let sec: Record<string, string> | null = null;
  let last: string | null = null;
  for (const raw of lines(text)) {
    if (/^\s*[#;]/.test(raw) || !raw.trim()) continue;
    const s = /^\s*\[([^\]]+)\]\s*$/.exec(raw);
    if (s) {
      sec = out[s[1].trim()] ??= {};
      last = null;
      continue;
    }
    if (!sec) continue;
    if (/^\s+/.test(raw) && last) {
      sec[last] += `\n${raw.trim()}`;
      continue;
    }
    const kv = /^([^=:]+)[=:](.*)$/.exec(raw);
    if (kv) {
      last = kv[1].trim();
      sec[last] = kv[2].trim();
    }
  }
  return out;
}

const iniList = (v: string | undefined) => (v ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

function setupCfg({ path, text }: ExtractInput): Contribution {
  if (base(path) === "Pipfile") return { pm: "pipenv" };
  if (base(path) !== "setup.cfg") return {};
  const ini = parseIni(text);
  const facts: { tool: string; facts: string[] }[] = [];
  const f = [...iniList(ini.flake8?.select), ...iniList(ini.flake8?.["extend-select"])];
  if (f.length) facts.push({ tool: "flake8", facts: f });
  const mypy = Object.entries(ini.mypy ?? {}).filter(([, v]) => /^(true|1|yes)$/i.test(v)).map(([k]) => k);
  if (mypy.length) facts.push({ tool: "mypy", facts: mypy });
  return { facts };
}

function tox({ path, text }: ExtractInput): Contribution {
  const ini = parseIni(text);
  const scripts: ScriptDef[] = [];
  for (const [sec, kv] of Object.entries(ini)) {
    const m = /^testenv(?::(.+))?$/.exec(sec);
    if (!m || !kv.commands) continue;
    for (const env of (m[1] ?? "py").split(/[,\s]+/).filter(Boolean)) scripts.push({ kind: "tox", name: env, body: kv.commands, evidence: `${path}: [${sec}]` });
  }
  const f = [...iniList(ini.flake8?.select), ...iniList(ini.flake8?.["extend-select"])];
  return { scripts, facts: f.length ? [{ tool: "flake8", facts: f }] : [] };
}

function ruff({ text }: ExtractInput): Contribution {
  const f = ruffFacts(parseToml(text), "");
  return f.length ? { facts: [{ tool: "ruff", facts: f }] } : {};
}

// ---------------------------------------------------------------- Go / Rust / JVM / .NET / Ruby / PHP

function golangci({ path, text }: ExtractInput): Contribution {
  const v = path.endsWith(".toml") ? parseToml(text) : path.endsWith(".json") ? parseJsonc(text) : yaml(text);
  if (!isRecord(v) || !isRecord(v.linters)) return {};
  const facts = strings(v.linters.enable);
  if (v.linters["enable-all"] === true || v.linters.default === "all") facts.push("enable-all");
  return facts.length ? { facts: [{ tool: "golangci-lint", facts }] } : {};
}

function cargo({ text }: ExtractInput): Contribution {
  const t = parseToml(text);
  const facts: { tool: string; facts: string[] }[] = [];
  for (const [group, tool] of [["lints.clippy", "clippy"], ["workspace.lints.clippy", "clippy"], ["lints.rust", "cargo-build"], ["workspace.lints.rust", "cargo-build"]] as const) {
    const v = tomlGet(t, group);
    if (isRecord(v)) {
      const names = Object.entries(v).filter(([, x]) => (isRecord(x) ? x.level : x) !== "allow").map(([n]) => (tool === "clippy" ? `clippy::${n}` : n));
      if (names.length) facts.push({ tool, facts: names });
    }
  }
  const name = tomlGet(t, "package.name");
  return { facts, pkgName: typeof name === "string" ? name : undefined, workspaces: !!tomlGet(t, "workspace") };
}

function jvm(): Contribution {
  return {};
}

function dotnet({ text }: ExtractInput): Contribution {
  const facts: string[] = [];
  if (/<TreatWarningsAsErrors>\s*true/i.test(text)) facts.push("TreatWarningsAsErrors");
  if (/<Nullable>\s*enable/i.test(text)) facts.push("nullable");
  const lvl = /<AnalysisLevel>\s*([^<]+)</i.exec(text);
  if (lvl) facts.push(`AnalysisLevel:${lvl[1].trim()}`);
  return facts.length ? { facts: [{ tool: "dotnet-build", facts }] } : {};
}

function gemfile({ text }: ExtractInput): Contribution {
  return { deps: [...text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((m) => m[1]) };
}

function rubocop({ text }: ExtractInput): Contribution {
  const v = yaml(text);
  if (!isRecord(v)) return {};
  const facts = Object.entries(v).filter(([k, x]) => k.includes("/") && isRecord(x) && x.Enabled === true).map(([k]) => k);
  return facts.length ? { facts: [{ tool: "rubocop", facts }] } : {};
}

function composer({ path, text }: ExtractInput): Contribution {
  const v = parseJsonc(text);
  if (!isRecord(v)) return {};
  const out: Contribution = { deps: [...Object.keys(isRecord(v.require) ? v.require : {}), ...Object.keys(isRecord(v["require-dev"]) ? v["require-dev"] : {})] };
  if (isRecord(v.scripts)) {
    out.scripts = Object.entries(v.scripts).flatMap(([name, body]) => {
      const cmds = strings(body);
      return cmds.length ? [{ kind: "composer" as const, name, body: cmds.join("\n").replace(/@php\s+/g, "php ").replace(/^@(\S+)/gm, "composer $1"), evidence: `${path}: scripts.${name}` }] : [];
    });
  }
  if (typeof v.name === "string") out.pkgName = v.name;
  return out;
}

function phpstan({ text }: ExtractInput): Contribution {
  const m = /^\s*level:\s*(\S+)/m.exec(text);
  return m ? { facts: [{ tool: "phpstan", facts: [`level:${m[1]}`] }] } : {};
}

// ---------------------------------------------------------------- 任务入口

function makefile({ path, text }: ExtractInput): Contribution {
  const scripts: ScriptDef[] = [];
  let current: ScriptDef[] = [];
  for (const raw of lines(text)) {
    if (raw.startsWith("\t")) {
      const cmd = raw.slice(1).trim().replace(/^[@\-+]+/, "").replace(/\$\((MAKE)\)|\$\{MAKE\}/g, "make");
      if (cmd) for (const s of current) s.body += (s.body ? "\n" : "") + cmd;
      continue;
    }
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const m = /^([A-Za-z0-9_.\-/ ]+?)\s*:(?![=:])(.*)$/.exec(raw);
    if (m && !/^\s/.test(raw) && !m[1].startsWith(".")) {
      current = m[1].trim().split(/\s+/).map((name) => ({ kind: "make" as const, name, body: "", evidence: `${path}: ${name}` }));
      // 依赖的 target 也算进 body：`check: lint test` → make lint、make test
      const deps = m[2].split(";")[0].trim().split(/\s+/).filter((d) => d && !d.includes("$") && !d.includes("/") && !d.includes("."));
      for (const s of current) s.body = deps.map((d) => `make ${d}`).join("\n");
      const inline = m[2].includes(";") ? m[2].slice(m[2].indexOf(";") + 1).trim() : "";
      if (inline) for (const s of current) s.body += (s.body ? "\n" : "") + inline;
      scripts.push(...current);
    } else if (!raw.startsWith(" ")) current = [];
  }
  return { scripts };
}

function justfile({ path, text }: ExtractInput): Contribution {
  const scripts: ScriptDef[] = [];
  let cur: ScriptDef | null = null;
  for (const raw of lines(text)) {
    if (/^\s+\S/.test(raw) && cur) {
      const cmd = raw.trim().replace(/^[@-]+/, "");
      if (cmd && !cmd.startsWith("#")) cur.body += (cur.body ? "\n" : "") + cmd;
      continue;
    }
    cur = null;
    const m = /^@?([A-Za-z0-9_-]+)(?:\s+[^:=]*)?:(?!=)(.*)$/.exec(raw);
    if (m && !raw.startsWith("set ") && !raw.startsWith("export ")) {
      cur = { kind: "just", name: m[1], body: m[2].trim().split(/\s+/).filter(Boolean).map((d) => `just ${d}`).join("\n"), evidence: `${path}: ${m[1]}` };
      scripts.push(cur);
    }
  }
  return { scripts };
}

// ---------------------------------------------------------------- 提交钩子

function stageOf(name: string): RepoStage | null {
  const n = name.replace(/_/g, "-").toLowerCase();
  if (n === "pre-commit" || n === "commit") return "commit";
  if (n === "pre-push" || n === "push") return "push";
  return null;
}

function preCommit({ path, dir, text }: ExtractInput): Contribution {
  const v = yaml(text);
  if (!isRecord(v) || !Array.isArray(v.repos)) return {};
  const defaults = strings(v.default_stages).map(stageOf).filter((s): s is RepoStage => !!s);
  const hooks: NonNullable<Contribution["preCommitHooks"]> = [];
  for (const repo of v.repos) {
    if (!isRecord(repo) || !Array.isArray(repo.hooks)) continue;
    const local = repo.repo === "local";
    for (const h of repo.hooks) {
      if (!isRecord(h) || typeof h.id !== "string") continue;
      const st = strings(h.stages).map(stageOf).filter((s): s is RepoStage => !!s);
      const stages = st.length ? st : defaults.length ? defaults : (["commit"] as RepoStage[]);
      const entry = local && typeof h.entry === "string" ? h.entry : undefined;
      hooks.push({ id: h.id, entry, stages: [...new Set(stages)], evidence: `${path}: ${h.id}`, passFiles: h.pass_filenames !== false });
    }
  }
  const wired: WiredCommand[] = hooks.flatMap((h) => h.stages.map((stage) => ({ text: h.entry ?? h.id, dir, stage, evidence: h.evidence, passFiles: h.passFiles, hookId: h.id })));
  return { preCommitHooks: hooks, wired };
}

function husky({ path, text }: ExtractInput): Contribution {
  const stage = stageOf(base(path));
  // git 钩子在仓库根目录执行。
  const dir = "";
  const wired = lines(text)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !/husky\.sh|^\.\s|^source\s/.test(l))
    .map((text) => ({ text, dir, stage, evidence: path }));
  return { wired };
}

function lefthook({ path, text }: ExtractInput): Contribution {
  const dir = "";
  const v = yaml(text);
  if (!isRecord(v)) return {};
  const wired: WiredCommand[] = [];
  for (const [hook, cfg] of Object.entries(v)) {
    const stage = stageOf(hook);
    if (!stage || !isRecord(cfg)) continue;
    for (const group of [cfg.commands, cfg.jobs]) {
      const entries = Array.isArray(group) ? group.map((g, i) => [String(i), g] as const) : isRecord(group) ? Object.entries(group) : [];
      for (const [name, c] of entries) {
        if (!isRecord(c) || typeof c.run !== "string") continue;
        const pass = /\{(staged_files|push_files|all_files|files)\}/.test(c.run);
        wired.push({ text: c.run.replace(/\{(staged_files|push_files|all_files|files)\}/g, "").trim(), dir: joinRel(dir, c.root), stage, evidence: `${path}: ${hook}.${name}`, passFiles: pass });
      }
    }
  }
  return { wired };
}

// ---------------------------------------------------------------- CI

function githubActions({ path, text }: ExtractInput): Contribution {
  const v = yaml(text);
  if (!isRecord(v) || !isRecord(v.jobs)) return {};
  const wfDir = isRecord(v.defaults) && isRecord(v.defaults.run) ? v.defaults.run["working-directory"] : undefined;
  const wired: WiredCommand[] = [];
  for (const [jobName, job] of Object.entries(v.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    const jobDir = isRecord(job.defaults) && isRecord(job.defaults.run) ? (job.defaults.run["working-directory"] ?? wfDir) : wfDir;
    job.steps.forEach((step, i) => {
      if (!isRecord(step)) return;
      const label = `${path}: jobs.${jobName}.steps[${i}]${typeof step.name === "string" ? ` (${step.name})` : ""}`;
      if (typeof step.run === "string") wired.push({ text: step.run, dir: joinRel("", step["working-directory"] ?? jobDir), stage: "ci", evidence: label });
      else if (typeof step.uses === "string") {
        const args = isRecord(step.with) ? Object.values(step.with).filter((x) => typeof x === "string").join(" ") : "";
        wired.push({ text: `${step.uses} ${args}`.trim(), dir: joinRel("", isRecord(step.with) ? step.with["working-directory"] : undefined), stage: "ci", evidence: label, uses: true });
      }
    });
  }
  return { wired };
}

function gitlabCi({ path, text }: ExtractInput): Contribution {
  const v = yaml(text);
  if (!isRecord(v)) return {};
  const wired: WiredCommand[] = [];
  const RESERVED = new Set(["stages", "variables", "include", "workflow", "image", "services", "cache", "before_script", "after_script", "default"]);
  for (const [name, job] of Object.entries(v)) {
    if (RESERVED.has(name) || !isRecord(job)) continue;
    for (const key of ["script"]) for (const s of strings(job[key])) wired.push({ text: s, dir: "", stage: "ci", evidence: `${path}: ${name}` });
  }
  return { wired };
}

/** 递归找 script / bash / pwsh / powershell / run 这类键（Azure、Bitbucket、CircleCI 共用）。 */
function walkScripts(v: unknown, keys: Set<string>, path: string, dirKeys: string[], out: WiredCommand[], label: string, dir: string): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => walkScripts(x, keys, path, dirKeys, out, `${label}[${i}]`, dir));
    return;
  }
  if (!isRecord(v)) return;
  let here = dir;
  for (const dk of dirKeys) if (typeof v[dk] === "string") here = joinRel("", v[dk]);
  for (const [k, x] of Object.entries(v)) {
    if (keys.has(k)) {
      if (typeof x === "string") out.push({ text: x, dir: here, stage: "ci", evidence: `${path}: ${label}${label ? "." : ""}${k}` });
      else if (Array.isArray(x)) for (const s of strings(x)) out.push({ text: s, dir: here, stage: "ci", evidence: `${path}: ${label}${label ? "." : ""}${k}` });
      else if (isRecord(x) && typeof x.command === "string") {
        out.push({ text: x.command, dir: joinRel("", x.working_directory ?? here), stage: "ci", evidence: `${path}: ${label}.${k}` });
      }
    } else if (typeof x === "object") walkScripts(x, keys, path, dirKeys, out, label ? `${label}.${k}` : k, here);
  }
}

function azure({ path, text }: ExtractInput): Contribution {
  const v = yaml(text);
  const wired: WiredCommand[] = [];
  walkScripts(v, new Set(["script", "bash", "pwsh", "powershell"]), path, ["workingDirectory"], wired, "", "");
  // DotNetCoreCLI@2 / Npm@1 这类任务：command 输入就是命令
  const tasks = (x: unknown, label: string): void => {
    if (Array.isArray(x)) x.forEach((y, i) => tasks(y, `${label}[${i}]`));
    else if (isRecord(x)) {
      if (typeof x.task === "string" && isRecord(x.inputs) && typeof x.inputs.command === "string") {
        const tool = x.task.toLowerCase().startsWith("dotnet") ? "dotnet" : x.task.toLowerCase().startsWith("npm") ? "npm" : x.task.toLowerCase().startsWith("maven") ? "mvn" : x.task.toLowerCase().startsWith("gradle") ? "gradle" : "";
        if (tool) wired.push({ text: `${tool} ${x.inputs.command} ${typeof x.inputs.arguments === "string" ? x.inputs.arguments : ""}`.trim(), dir: joinRel("", x.inputs.workingDir ?? x.inputs.workingDirectory), stage: "ci", evidence: `${path}: ${label}.task ${x.task}` });
      }
      if (typeof x.task === "string" && isRecord(x.inputs) && typeof x.inputs.goals === "string") wired.push({ text: `mvn ${x.inputs.goals}`, dir: "", stage: "ci", evidence: `${path}: ${label}.task ${x.task}` });
      if (typeof x.task === "string" && isRecord(x.inputs) && typeof x.inputs.tasks === "string") wired.push({ text: `gradle ${x.inputs.tasks}`, dir: "", stage: "ci", evidence: `${path}: ${label}.task ${x.task}` });
      for (const [k, y] of Object.entries(x)) if (typeof y === "object") tasks(y, label ? `${label}.${k}` : k);
    }
  };
  tasks(v, "");
  return { wired };
}

function circleci({ path, text }: ExtractInput): Contribution {
  const v = yaml(text);
  const wired: WiredCommand[] = [];
  if (isRecord(v) && isRecord(v.jobs)) {
    for (const [name, job] of Object.entries(v.jobs)) {
      if (!isRecord(job)) continue;
      walkScripts(job.steps, new Set(["run"]), path, [], wired, `jobs.${name}.steps`, joinRel("", job.working_directory));
    }
  }
  return { wired };
}

function bitbucket({ path, text }: ExtractInput): Contribution {
  const wired: WiredCommand[] = [];
  walkScripts(yaml(text), new Set(["script"]), path, [], wired, "", "");
  return { wired };
}

function jenkinsfile({ path, text }: ExtractInput): Contribution {
  const wired: WiredCommand[] = [];
  const re = /\b(?:sh|bat|pwsh|powershell)\s*\(?\s*(?:script\s*:\s*)?('''|"""|'|")([\s\S]*?)\1/g;
  let dir = "";
  const dirs = [...text.matchAll(/\bdir\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
  if (dirs.length === 1) dir = joinRel("", dirs[0][1]);
  for (const m of text.matchAll(re)) wired.push({ text: m[2], dir, stage: "ci", evidence: path });
  return { wired };
}

const EXTRACT: Record<ExtractorName, (i: ExtractInput) => Contribution> = {
  package_json: packageJson, tsconfig, eslint, pyproject, setup_cfg: setupCfg, tox, ruff, golangci, cargo, maven: jvm, gradle: jvm, dotnet, gemfile, rubocop,
  composer, phpstan, makefile, justfile, pre_commit: preCommit, husky, lefthook, lint_staged: lintStaged, github_actions: githubActions, gitlab_ci: gitlabCi,
  azure_pipelines: azure, circleci, bitbucket, jenkinsfile,
};

export function runExtractor(name: ExtractorName, input: ExtractInput): Contribution {
  try {
    return EXTRACT[name](input);
  } catch {
    return {};
  }
}

export { dirOf };
