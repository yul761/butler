import { describe, expect, it } from "vitest";
import type { BaselineCheck, RepoBaseline } from "../../../shared/baselines";
import type { ResolvedCheck } from "../../../shared/checks";
import { parseJsonc } from "../readers/jsonc";
import { buildExport, exportName, type ExportPlan, type RepoLayout } from "./targets";

function baseline(over: Partial<RepoBaseline> = {}): RepoBaseline {
  return {
    id: 1, slug: "acme/app", scannedAt: 1, status: "ok", skipReason: null, detail: null, origin: "local", projects: [], checks: [], advice: [],
    profile: { projects: [], dirs: [], ci: [], pitfalls: [] }, inputs: [], listingHash: "", staleAt: null, inferred: "none", inferDetail: null, durationMs: 1, ...over,
  };
}

function check(type: ResolvedCheck["type"], params: Record<string, unknown>, globs: string[] = [], excludeGlobs: string[] = []): ResolvedCheck {
  return { id: 7, key: "ck_a1b2c3d4e5f6", type, name: "No console", params, globs, excludeGlobs, severity: "block", mode: "enforce", message: "Use the logger" };
}

function repo(files: Record<string, string>, husky: string[] = []): { layout: RepoLayout; read: (p: string) => string | null } {
  const top = new Set<string>();
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) {
    const [first, ...rest] = p.split("/");
    if (rest.length) dirs.add(first);
    else top.add(first);
  }
  if (husky.length) dirs.add(".husky");
  return { layout: { files: [...top], dirs: [...dirs], huskyFiles: husky }, read: (p) => files[p] ?? null };
}

function plan(c: ResolvedCheck, files: Record<string, string>, b: RepoBaseline | null = baseline(), husky: string[] = []): ExportPlan {
  const r = buildExport({ check: c, baseline: b, ...repo(files, husky), ticketPattern: "" });
  if (!r.ok) throw new Error(`refused: ${r.reason} ${r.detail ?? ""}`);
  return r.plan;
}

function refusal(c: ResolvedCheck, files: Record<string, string>, b: RepoBaseline | null = baseline(), husky: string[] = []) {
  const r = buildExport({ check: c, baseline: b, ...repo(files, husky), ticketPattern: "" });
  return r.ok ? null : r;
}

const file = (p: ExportPlan, path: string) => p.files.find((f) => f.path === path);
const PRE_COMMIT = "repos:\r\n  - repo: https://example.invalid/hooks\r\n    rev: v1\r\n    hooks:\r\n      - id: trailing-whitespace\r\n";

describe("forbidden_pattern", () => {
  it("goes into pre-commit as a pygrep hook and keeps CRLF", () => {
    const p = plan(check("forbidden_pattern", { pattern: "console\\.(log|debug)\\(" }, ["src/**/*.ts"], ["**/*.test.ts"]), { ".pre-commit-config.yaml": PRE_COMMIT, "go.mod": "module x\n" });
    expect(p.target).toBe("pre_commit");
    expect(p.files.map((f) => f.path)).toEqual([".pre-commit-config.yaml"]);
    const out = file(p, ".pre-commit-config.yaml")!.content;
    expect(out.startsWith(PRE_COMMIT)).toBe(true);
    expect(out).not.toMatch(/[^\r]\n/);
    expect(out).toContain("  - repo: local\r\n    hooks:\r\n      - id: 'butler-no-console'\r\n");
    expect(out).toContain("        entry: 'console\\.(log|debug)\\('\r\n        language: 'pygrep'\r\n");
    expect(out).toContain("        files: '^src/(?:.*/)?[^/]*\\.ts$'");
    expect(out).toContain("        exclude: '^(?:.*/)?[^/]*\\.test\\.ts$'");
    expect(p.runAll).toBe("pre-commit run butler-no-console --all-files");
  });

  it("uses a Node script in a JS repo: lint-staged for commits, a package script, and the CI lint script", () => {
    const pkg = `{\n  "name": "app",\n  "scripts": {\n    "lint": "eslint ."\n  },\n  "lint-staged": {\n    "*.ts": "eslint --fix"\n  }\n}\n`;
    const p = plan(check("forbidden_pattern", { pattern: "console\\.log" }, ["*.ts"]), { "package.json": pkg, "pnpm-lock.yaml": "" }, baseline({ profile: { projects: [], dirs: [], pitfalls: [], ci: [{ category: "lint", command: "pnpm lint", dir: "" }] } }), ["pre-commit"]);
    expect(p.target).toBe("script");
    expect(p.runtime).toBe("node");
    expect(p.script).toBe("scripts/butler-checks/no-console.mjs");
    expect(file(p, p.script!)!.content).toContain("const CHECK = {");
    const json = parseJsonc(file(p, "package.json")!.content) as { scripts: Record<string, string>; "lint-staged": Record<string, unknown> };
    expect(json["lint-staged"]["*.ts"]).toEqual(["eslint --fix", "node scripts/butler-checks/no-console.mjs"]);
    expect(json.scripts["butler:no-console"]).toBe("node scripts/butler-checks/no-console.mjs --all");
    expect(json.scripts.lint).toBe("eslint . && pnpm run butler:no-console");
    // lint-staged 已经接了，husky 不再加一行（免得跑两遍）
    expect(file(p, ".husky/pre-commit")).toBeUndefined();
    expect(p.wired.map((w) => w.kind)).toEqual(["lint_staged", "pkg_script", "ci_pkg_lint"]);
  });

  it("adds a husky line when there is no other commit hook, creating the hook file executable", () => {
    const p = plan(check("forbidden_pattern", { pattern: "x" }), { "package.json": "{}\n" }, baseline(), ["_"]);
    expect(file(p, ".husky/pre-commit")).toMatchObject({ content: "#!/usr/bin/env sh\nnode scripts/butler-checks/no-console.mjs\n", exec: true, created: true });
  });

  it("uses a Python script and the Makefile in a Python repo; CI's make lint runs it", () => {
    const mk = "lint:\r\n\truff check .\r\n";
    const p = plan(check("forbidden_pattern", { pattern: "print\\(" }, ["**/*.py"]), { "pyproject.toml": "[project]\nname='x'\n", Makefile: mk }, baseline({ profile: { projects: [], dirs: [], pitfalls: [], ci: [{ category: "lint", command: "make lint", dir: "" }] } }));
    expect(p.runtime).toBe("python");
    expect(p.script).toBe("scripts/butler_checks/no-console.py");
    expect(file(p, "Makefile")!.content).toBe("lint: butler-no-console\r\n\truff check .\r\n\r\n.PHONY: butler-no-console\r\nbutler-no-console:\r\n\tpython3 scripts/butler_checks/no-console.py --all\r\n");
    expect(p.runAll).toBe("python3 scripts/butler_checks/no-console.py --all");
  });

  it("falls back to a shell script (executable) when the repo has neither Node nor Python", () => {
    const p = plan(check("forbidden_pattern", { pattern: "panic\\(" }), { "go.mod": "module x\n" });
    expect(p.runtime).toBe("sh");
    expect(file(p, "scripts/butler-checks/no-console.sh")).toMatchObject({ exec: true, created: true });
    expect(p.wired).toEqual([]);
  });

  it("pins generated shell files and husky hooks to LF in .gitattributes, keeping the file's own lines and EOL", () => {
    const p = plan(check("forbidden_pattern", { pattern: "x" }), { "go.mod": "", ".gitattributes": "*.png binary\r\n" });
    expect(file(p, ".gitattributes")!.content).toBe("*.png binary\r\n/scripts/butler-checks/no-console.sh text eol=lf\r\n");
    expect(p.notes).toContain("sh_windows");
    const h = plan(check("run_command", { command: "a && b {file}", stage: "edit" }, ["src/**"]), { "package.json": "{}\n" }, baseline(), ["pre-commit"]);
    expect(file(h, ".gitattributes")!.content.split("\n").filter(Boolean).sort()).toEqual(["/.husky/pre-commit text eol=lf", "/scripts/butler-checks/no-console.sh text eol=lf"]);
    // 已经有这一行：不重复
    const again = plan(check("forbidden_pattern", { pattern: "x" }), { "go.mod": "", ".gitattributes": "/scripts/butler-checks/no-console.sh text eol=lf\n" });
    expect(file(again, ".gitattributes")).toBeUndefined();
    // Node 脚本不用
    expect(file(plan(check("forbidden_pattern", { pattern: "x" }), { "package.json": "{}\n" }), ".gitattributes")).toBeUndefined();
  });

  it("refuses a regex Python reads differently in a Python-only repo", () => {
    expect(refusal(check("forbidden_pattern", { pattern: "\\p{L}" }), { "setup.py": "" })).toMatchObject({ reason: "regex", detail: "unicode_property" });
    // pre-commit 接不了时退回脚本：Node 认 JS 正则
    const p = plan(check("forbidden_pattern", { pattern: "\\p{L}" }), { ".pre-commit-config.yaml": PRE_COMMIT, "package.json": "{}" });
    expect(p.target).toBe("script");
    expect(p.notes).toContain("pygrep_unicode_property");
    expect(file(p, ".pre-commit-config.yaml")!.content).toContain("entry: 'node scripts/butler-checks/no-console.mjs'");
  });
});

describe("import_boundary", () => {
  const ib = (forbid: string[], allow: string[] = []) => check("import_boundary", { forbid, allow }, ["src/renderer/**"]);
  const flat = `import js from "@eslint/js";\n\nexport default [\n  js.configs.recommended,\n];\n`;

  it("uses no-restricted-imports in a flat ESLint config when every entry is a package", () => {
    const p = plan(ib(["electron", "node:*"], ["electron/common"]), { "eslint.config.mjs": flat, "package.json": "{}", src: "" });
    expect(p.target).toBe("eslint");
    const out = file(p, "eslint.config.mjs")!.content;
    expect(out).toContain("const butlerBaseConfig = [\n  js.configs.recommended,\n];");
    expect(out).toContain('"group": [\n              "electron",\n              "node:*",\n              "!electron/common"\n            ]');
    expect(out).toContain('"files": [\n    "src/renderer/**"\n  ]');
    expect(out.trimEnd().endsWith("export default [butlerBaseConfig, butlerCheckConfig];")).toBe(true);
  });

  it("uses the script target for repo paths or when the rule is already configured", () => {
    const layoutFiles = { "eslint.config.mjs": flat, "package.json": "{}", "src/x.ts": "" };
    expect(plan(ib(["src/main/**"]), layoutFiles).target).toBe("script");
    const p = plan(ib(["electron"]), { ...layoutFiles, "eslint.config.mjs": `${flat}// no-restricted-imports elsewhere\n` });
    expect(p.target).toBe("script");
    expect(p.notes).toContain("eslint_rule_exists");
  });

  it("adds an override to JSON and YAML eslintrc files", () => {
    const json = plan(ib(["electron"]), { ".eslintrc.json": `{\n  // base\n  "extends": "eslint:recommended"\n}\n`, "package.json": "{}" });
    const parsed = parseJsonc(file(json, ".eslintrc.json")!.content) as { overrides: { files: string[]; rules: Record<string, unknown> }[] };
    expect(parsed.overrides[0].files).toEqual(["src/renderer/**"]);
    expect(file(json, ".eslintrc.json")!.content).toContain("// base");
    const yaml = plan(ib(["electron"]), { ".eslintrc.yml": "extends: eslint:recommended\n", "package.json": "{}" });
    expect(file(yaml, ".eslintrc.yml")!.content).toBe(
      "extends: eslint:recommended\noverrides:\n  - files: ['src/renderer/**']\n    rules:\n      no-restricted-imports:\n        - error\n        - patterns:\n            - group: ['electron']\n              message: 'Use the logger'\n",
    );
  });

  it("is not exportable without Node or Python", () => {
    expect(refusal(ib(["electron"]), { "go.mod": "" })).toMatchObject({ reason: "no_runtime" });
    expect(refusal(check("comment_policy", {}), { "Cargo.toml": "" })).toMatchObject({ reason: "no_runtime" });
  });
});

describe("run_command", () => {
  const rc = (command: string, stage: "edit" | "push" = "edit", excludeGlobs: string[] = []) => check("run_command", { command, stage }, ["**/*.py"], excludeGlobs);

  it("puts a simple command straight into pre-commit with the files passed", () => {
    const p = plan(rc("ruff check {file}"), { ".pre-commit-config.yaml": "repos: []\n" });
    expect(p.target).toBe("pre_commit");
    expect(file(p, ".pre-commit-config.yaml")!.content).toContain("entry: 'ruff check'\n        language: 'system'\n        pass_filenames: true\n        files: '^(?:.*/)?[^/]*\\.py$'");
    expect(p.files).toHaveLength(1);
  });

  it("uses lint-staged for a simple command without pre-commit", () => {
    const p = plan(rc("ruff check"), { ".lintstagedrc.json": "{}\n" });
    expect(p.target).toBe("lint_staged");
    expect(parseJsonc(file(p, ".lintstagedrc.json")!.content)).toEqual({ "**/*.py": "ruff check" });
  });

  it("writes a per-file runner for compound commands and wires it into husky", () => {
    const p = plan(rc('cd api && ruff check "$OLDPWD/$BUTLER_CHECK_FILE"'), { "package.json": "{}" }, baseline(), ["pre-commit"]);
    expect(p.target).toBe("husky");
    expect(file(p, "scripts/butler-checks/no-console.sh")).toMatchObject({ exec: true });
    expect(file(p, ".husky/pre-commit")).toBeDefined();
  });

  it("push-stage commands go into husky pre-push, else pre-commit's pre-push stage", () => {
    expect(file(plan(rc("make test", "push"), {}, baseline(), ["pre-commit"]), ".husky/pre-push")!.content).toBe("#!/usr/bin/env sh\nmake test\n");
    const p = plan(rc("cd api && pytest", "push"), { ".pre-commit-config.yaml": "repos:\n" });
    expect(file(p, ".pre-commit-config.yaml")!.content).toContain("entry: 'sh -c ''cd api && pytest'''\n        language: 'system'\n        pass_filenames: false\n        always_run: true\n        stages: ['pre-push']");
    expect(p.notes).toContain("pre_push_install");
  });

  it("refuses without a hook manager and when CI already runs the command", () => {
    expect(refusal(rc("ruff check"), { "pyproject.toml": "" })).toMatchObject({ reason: "no_hook_manager" });
    const ci: BaselineCheck = {
      id: "|lint|ruff", dir: "", category: "lint", tool: "ruff", command: "ruff check .", fileCommand: "ruff check {file}", stages: ["ci"], changedFiles: true,
      butlerStage: "edit", source: "ci", confidence: "high", evidence: [], facts: [],
    };
    expect(refusal(rc("ruff check {file}"), { ".pre-commit-config.yaml": "repos:\n" }, baseline({ checks: [ci] }))).toMatchObject({ reason: "already_in_ci" });
    expect(refusal(rc("ruff check ."), { ".pre-commit-config.yaml": "repos:\n" }, baseline({ checks: [ci] }))).toMatchObject({ reason: "already_in_ci" });
  });
});

describe("general", () => {
  it("needs a baseline", () => {
    expect(refusal(check("forbidden_pattern", { pattern: "x" }), { "package.json": "{}" }, null)).toMatchObject({ reason: "no_baseline" });
  });
  it("names files from the check name, or from the key when the name has no ASCII", () => {
    expect(exportName("No console.log in src!", "ck_abc")).toBe("no-console-log-in-src");
    expect(exportName("不要用 console", "ck_a1b2c3d4")).toBe("console");
    expect(exportName("禁止调试输出", "ck_a1b2c3d4")).toBe("check-a1b2c3");
    expect(exportName("Café", "ck_1")).toBe("cafe");
  });
});
