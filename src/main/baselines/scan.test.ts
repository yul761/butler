import { describe, expect, it } from "vitest";
import { scanFiles } from "./scan";
import { resolveRules } from "./rules";
import { CI_ONLY_REPO, GO_REPO, JS_REPO, MONO_REPO, PY_REPO, type FixtureRepo } from "./__fixtures__/repos";

function scan(repo: FixtureRepo, layers: Parameters<typeof resolveRules>[0] = []) {
  return scanFiles({ files: Object.keys(repo), read: (p) => repo[p] ?? null, rules: resolveRules(layers) });
}
const find = (r: ReturnType<typeof scan>, dir: string, tool: string) => r.checks.find((c) => c.dir === dir && c.tool === tool);

describe("baseline scan: JS / TS repo", () => {
  const r = scan(JS_REPO);
  it("finds the project, its languages and package manager", () => {
    expect(r.projects).toEqual([expect.objectContaining({ dir: "", langs: ["js", "ts"], pm: "pnpm" })]);
  });
  it("merges a script, the CI step and lint-staged into one ESLint check", () => {
    const e = find(r, "", "eslint")!;
    expect(e).toMatchObject({ category: "lint", command: "pnpm lint", fileCommand: "pnpm exec eslint {file}", stages: ["commit", "ci"], changedFiles: true, butlerStage: "edit", source: "ci", confidence: "high" });
    expect(e.facts).toEqual(["no-console", "no-debugger"]);
    expect(e.evidence).toEqual(expect.arrayContaining([expect.stringContaining(".github/workflows/ci.yml"), "package.json: scripts.lint"]));
  });
  it("finds the type check with the tsconfig facts, tests and prettier", () => {
    expect(find(r, "", "tsc")).toMatchObject({ category: "typecheck", command: "pnpm typecheck", stages: ["ci"], confidence: "high" });
    expect(find(r, "", "tsc")!.facts).toEqual(["noUnusedLocals", "strict"]);
    expect(find(r, "", "vitest")).toMatchObject({ category: "test", command: "pnpm test", testOne: "pnpm exec vitest run {test}", stages: ["ci"] });
    expect(find(r, "", "prettier")).toMatchObject({ category: "format", stages: ["commit"], changedFiles: true });
  });
  it("writes the profile and gives no advice", () => {
    expect(r.advice).toEqual([]);
    expect(r.profile.projects[0]).toMatchObject({ install: "pnpm install", testAll: "pnpm test", testOne: "pnpm exec vitest run {test}", lint: "pnpm lint", typecheck: "pnpm typecheck", fastest: "pnpm exec eslint {file}" });
    expect(r.profile.ci.map((c) => c.command)).toEqual(["pnpm lint", "pnpm typecheck", "pnpm test -- --coverage"]);
    expect(r.profile.dirs).toEqual(expect.arrayContaining(["src/", "*.test.ts / *.test.js"]));
    expect(r.inferReasons).toEqual([]);
    expect(r.inputs.map((i) => i.path)).toContain("package.json");
  });
});

describe("baseline scan: Python repo", () => {
  const r = scan(PY_REPO);
  it("reads pre-commit hooks, stages and pyproject facts (CRLF files)", () => {
    expect(r.projects[0]).toMatchObject({ dir: "", langs: ["python"], pm: "uv" });
    expect(find(r, "", "ruff")).toMatchObject({ command: "pre-commit run ruff --all-files", fileCommand: "pre-commit run ruff --files {file}", stages: ["commit", "ci"], butlerStage: "edit", facts: ["E", "F", "I"] });
    expect(find(r, "", "ruff-format")).toMatchObject({ category: "format", stages: ["commit", "ci"] });
    expect(find(r, "", "mypy")).toMatchObject({ category: "typecheck", stages: ["push"], facts: ["strict"] });
    expect(find(r, "", "pytest")).toMatchObject({ command: "uv run pytest -q", testOne: "uv run pytest {test}", stages: ["ci"], confidence: "high" });
  });
  it("profiles uv", () => {
    expect(r.profile.projects[0]).toMatchObject({ install: "uv sync", testAll: "uv run pytest -q" });
    expect(r.advice).toEqual([]);
  });
});

describe("baseline scan: Go repo", () => {
  const r = scan(GO_REPO);
  it("follows make targets from CI and classifies uses: steps", () => {
    expect(find(r, "", "golangci-lint")).toMatchObject({ category: "lint", command: "make lint", stages: ["ci"], confidence: "high", facts: ["errcheck", "govet", "staticcheck"] });
    expect(find(r, "", "go-test")).toMatchObject({ command: "make test", testOne: "go test ./... -run '{name}'", stages: ["ci"] });
    expect(find(r, "", "go-build")).toMatchObject({ confidence: "medium", stages: [] });
    expect(r.profile.projects[0].install).toBe("go mod download");
    expect(r.profile.dirs).toEqual(expect.arrayContaining(["cmd/", "internal/", "*_test.go next to the code"]));
  });
});

describe("baseline scan: CI-only repo in an unknown language", () => {
  const r = scan(CI_ONLY_REPO);
  it("finds nothing deterministic and asks for the model", () => {
    expect(r.projects).toEqual([]);
    expect(r.checks).toEqual([]);
    expect(r.inferReasons).toEqual(expect.arrayContaining(["no_project", "ci_unclassified"]));
    expect(r.unclassified.map((u) => u.command)).toEqual(["./tools/check.sh", "make verify"]);
  });
});

describe("baseline scan: monorepo", () => {
  const r = scan(MONO_REPO);
  it("attributes each check to its project directory", () => {
    expect(r.projects.map((p) => p.dir)).toEqual(["", "packages/web", "services/api", "tools/cli"]);
    expect(find(r, "packages/web", "eslint")).toMatchObject({ command: "pnpm lint", confidence: "high" });
    expect(find(r, "packages/web", "vitest")).toMatchObject({ command: "pnpm test", stages: ["ci"] });
    expect(find(r, "services/api", "ruff")).toMatchObject({ command: "poetry run ruff check .", stages: ["ci"] });
    expect(find(r, "services/api", "pytest")).toMatchObject({ command: "poetry run pytest", stages: ["ci"] });
    expect(find(r, "tools/cli", "go-test")).toMatchObject({ command: "go test ./...", stages: ["ci"] });
    expect(find(r, "tools/cli", "go-vet")).toMatchObject({ category: "lint", stages: ["ci"] });
    expect(r.checks.filter((c) => c.dir === "")).toEqual([]);
  });
  it("advises per project and leaves the workspace root alone", () => {
    expect(r.advice).toEqual([{ dir: "services/api", missing: ["typecheck"] }]);
    const api = r.profile.projects.find((p) => p.dir === "services/api")!;
    expect(api.install).toBe("poetry install");
    expect(r.profile.projects.find((p) => p.dir === "packages/web")!.install).toBeNull();
  });
});

describe("baseline scan: rules and platforms", () => {
  it("advises basic checks for a repo without lint or type check", () => {
    const r = scan({ "package.json": '{"name":"x","scripts":{"test":"jest"}}', "tsconfig.json": "{}", "package-lock.json": "{}" });
    expect(r.advice).toEqual([{ dir: "", missing: ["lint"] }]);
    expect(find(r, "", "jest")!.command).toBe("npm run test");
  });
  it("quotes script names that would split into several arguments, and leaves the usual ones bare", () => {
    const one = (scripts: Record<string, string>) => {
      const pkg = JSON.stringify({ packageManager: "pnpm@9.0.0", scripts, devDependencies: { eslint: "9" } });
      return scan({ "package.json": pkg, "pnpm-lock.yaml": "", "src/a.ts": "" }).checks.find((c) => c.tool === "eslint")?.command;
    };
    expect(one({ "lint fix": "eslint --fix ." })).toBe("pnpm 'lint fix'");
    expect(one({ "lint:all": "eslint ." })).toBe("pnpm lint:all");
  });

  it("accepts Windows separators and marker names in other cases", () => {
    const repo: FixtureRepo = { "go.mod": "module x\n", makefile: "lint:\r\n\tgo vet ./...\r\n", "sub\\x.go": "package x" };
    const r = scanFiles({ files: Object.keys(repo), read: (p) => repo[p] ?? repo[p.replace(/\//g, "\\")] ?? null, rules: resolveRules([]) });
    expect(find(r, "", "go-vet")).toMatchObject({ command: "make lint", confidence: "high" });
  });
  it("uses a user rule from the layered table", () => {
    const repo: FixtureRepo = { "acme.toml": "", ".gitlab-ci.yml": "lint:\n  script: [acme-lint --all]\n" };
    const r = scan(repo, [[
      { key: "acme", rule: JSON.stringify({ kind: "marker", files: ["acme.toml"], tools: [{ tool: "acme-lint", category: "lint", command: "acme-lint --all", fileCommand: "acme-lint {file}" }] }), enabled: true },
      { key: "kw-acme", rule: JSON.stringify({ kind: "keyword", category: "lint", tool: "acme-lint", match: "\\bacme-lint\\b", priority: 100 }), enabled: true },
    ]]);
    expect(find(r, "", "acme-lint")).toMatchObject({ confidence: "high", stages: ["ci"], fileCommand: "acme-lint {file}", butlerStage: "edit" });
  });
});
