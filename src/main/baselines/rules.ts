// 标记文件表（设计 §3.1）：哪个文件说明有哪个工具、命令行里的哪个词是哪类检查。这是数据，三层配置（契约 4.2）可以改、可以加、可以停用。
// 怎么解析某种文件（package.json 的 scripts、Makefile 的 target、workflow 的 run 步骤）是代码，规则里按名字引用（extract）。
import { z } from "zod";
import { BASELINE_CATEGORIES, type BaselineRule, type KeywordRule, type MarkerRule, type ToolSpec } from "../../shared/baselines";

/** 有代码实现的解析器名字；规则里写了别的名字就当无效。 */
export const EXTRACTORS = [
  "package_json", "tsconfig", "eslint", "pyproject", "setup_cfg", "tox", "ruff", "golangci", "cargo", "maven", "gradle", "dotnet", "gemfile", "rubocop",
  "composer", "phpstan", "makefile", "justfile", "pre_commit", "husky", "lefthook", "lint_staged", "github_actions", "gitlab_ci", "azure_pipelines",
  "circleci", "bitbucket", "jenkinsfile",
] as const;
export type ExtractorName = (typeof EXTRACTORS)[number];

const JS_EXTS = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "vue", "svelte"];
const TS_EXTS = ["ts", "tsx", "mts", "cts"];
const CSS_EXTS = ["css", "scss", "sass", "less"];

const toolSchema = z.object({
  tool: z.string().min(1).max(60),
  category: z.enum(BASELINE_CATEGORIES),
  command: z.string().min(1).max(300),
  fileCommand: z.string().min(1).max(300).optional(),
  testOne: z.string().min(1).max(300).optional(),
  exts: z.array(z.string().min(1).max(10)).max(30).optional(),
});

const markerSchema = z.object({
  kind: z.literal("marker"),
  key: z.string().min(1).max(60),
  lang: z.string().min(1).max(30).optional(),
  project: z.boolean().optional(),
  files: z.array(z.string().min(1).max(120)).min(1).max(30),
  requires: z.array(z.object({ file: z.string().max(120).optional(), contains: z.string().max(200).optional(), dep: z.string().max(100).optional() })).max(10).optional(),
  tools: z.array(toolSchema).max(10).optional(),
  extract: z.enum(EXTRACTORS).optional(),
  install: z.string().min(1).max(200).optional(),
  pm: z.string().min(1).max(30).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
});

const keywordSchema = z.object({
  kind: z.literal("keyword"),
  key: z.string().min(1).max(60),
  category: z.enum(BASELINE_CATEGORIES),
  tool: z.string().min(1).max(60),
  match: z.string().min(1).max(300).refine((s) => {
    try {
      new RegExp(s, "i");
      return true;
    } catch {
      return false;
    }
  }, "invalid regex"),
  fileCommand: z.string().min(1).max(300).optional(),
  exts: z.array(z.string().min(1).max(10)).max(30).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
});

export const ruleSchema = z.discriminatedUnion("kind", [markerSchema, keywordSchema]);

const t = (tool: string, category: ToolSpec["category"], command: string, more: Partial<ToolSpec> = {}): ToolSpec => ({ tool, category, command, ...more });
const m = (key: string, files: string[], more: Partial<MarkerRule> = {}): MarkerRule => ({ kind: "marker", key, files, ...more });
const k = (key: string, category: KeywordRule["category"], tool: string, match: string, more: Partial<KeywordRule> = {}): KeywordRule => ({ kind: "keyword", key, category, tool, match, ...more });

const ESLINT = t("eslint", "lint", "{exec} eslint .", { fileCommand: "{exec} eslint {file}", exts: JS_EXTS });
const TSC = t("tsc", "typecheck", "{exec} tsc --noEmit", { exts: TS_EXTS });
const RUFF = t("ruff", "lint", "{py}ruff check .", { fileCommand: "{py}ruff check {file}", exts: ["py", "pyi"] });
const MYPY = t("mypy", "typecheck", "{py}mypy .", { fileCommand: "{py}mypy {file}", exts: ["py", "pyi"] });
const PYTEST = t("pytest", "test", "{py}pytest", { testOne: "{py}pytest {test}", exts: ["py"] });
const FLAKE8 = t("flake8", "lint", "{py}flake8", { fileCommand: "{py}flake8 {file}", exts: ["py"] });
const pyContains = (key: string, section: string, tool: ToolSpec, files: string[] = []): MarkerRule[] => [
  ...(files.length ? [m(key, files, { tools: [tool] })] : []),
  m(`${key}-pyproject`, ["pyproject.toml"], { requires: [{ contains: section }], tools: [tool] }),
];

/** 内置的表。key 唯一；用户的层用同一个 key 覆盖或停用。 */
export const BUILTIN_RULES: BaselineRule[] = [
  // ---- 项目（目录） ----
  m("node", ["package.json"], { project: true, lang: "js", extract: "package_json" }),
  m("typescript", ["tsconfig.json"], { lang: "ts", extract: "tsconfig", tools: [TSC] }),
  m("tsconfig-extra", ["tsconfig.*.json"], { extract: "tsconfig" }),
  m("python", ["pyproject.toml"], { project: true, lang: "python", extract: "pyproject" }),
  m("python-setup", ["setup.py", "setup.cfg", "Pipfile"], { project: true, lang: "python", extract: "setup_cfg" }),
  m("python-requirements", ["requirements.txt", "requirements-dev.txt"], { lang: "python", install: "pip install -r requirements.txt" }),
  m("tox", ["tox.ini"], { lang: "python", extract: "tox" }),
  m("go", ["go.mod"], {
    project: true, lang: "go", pm: "go", install: "go mod download",
    tools: [t("go-test", "test", "go test ./...", { testOne: "go test ./... -run '{name}'", exts: ["go"] }), t("go-build", "build", "go build ./...")],
  }),
  m("rust", ["Cargo.toml"], {
    project: true, lang: "rust", pm: "cargo", install: "cargo fetch", extract: "cargo",
    tools: [t("cargo-test", "test", "cargo test", { testOne: "cargo test {name}", exts: ["rs"] }), t("cargo-build", "build", "cargo build")],
  }),
  m("maven", ["pom.xml"], {
    project: true, lang: "java", pm: "maven", install: "{mvn} -q -DskipTests install", extract: "maven",
    tools: [t("maven-test", "test", "{mvn} test", { testOne: "{mvn} -Dtest='{name}' test", exts: ["java", "kt"] }), t("maven-build", "build", "{mvn} -q -DskipTests package")],
  }),
  m("gradle", ["build.gradle", "build.gradle.kts"], {
    project: true, lang: "java", pm: "gradle", install: "{gradle} assemble", extract: "gradle",
    tools: [t("gradle-test", "test", "{gradle} test", { testOne: "{gradle} test --tests '{name}'", exts: ["java", "kt"] }), t("gradle-build", "build", "{gradle} build -x test")],
  }),
  m("dotnet", ["*.csproj", "*.fsproj", "*.sln"], {
    project: true, lang: "csharp", pm: "dotnet", install: "dotnet restore", extract: "dotnet",
    tools: [t("dotnet-build", "build", "dotnet build"), t("dotnet-test", "test", "dotnet test", { testOne: "dotnet test --filter '{name}'" })],
  }),
  m("ruby", ["Gemfile"], { project: true, lang: "ruby", pm: "bundler", install: "bundle install", extract: "gemfile" }),
  m("php", ["composer.json"], { project: true, lang: "php", pm: "composer", install: "composer install", extract: "composer" }),

  // ---- JS / TS 工具 ----
  m("eslint", ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts", ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml"], { extract: "eslint", tools: [ESLINT] }),
  m("eslint-package", ["package.json"], { requires: [{ contains: '"eslintConfig"' }], tools: [ESLINT] }),
  m("prettier", [".prettierrc", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.toml", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs"], {
    tools: [t("prettier", "format", "{exec} prettier --check .", { fileCommand: "{exec} prettier --check {file}" })],
  }),
  m("biome", ["biome.json", "biome.jsonc"], { tools: [t("biome", "lint", "{exec} biome check .", { fileCommand: "{exec} biome check {file}", exts: JS_EXTS })] }),
  m("oxlint", [".oxlintrc.json", "oxlintrc.json"], { tools: [t("oxlint", "lint", "{exec} oxlint", { fileCommand: "{exec} oxlint {file}", exts: JS_EXTS })] }),
  m("stylelint", [".stylelintrc", ".stylelintrc.json", ".stylelintrc.yml", ".stylelintrc.yaml", ".stylelintrc.js", ".stylelintrc.cjs", "stylelint.config.js", "stylelint.config.cjs", "stylelint.config.mjs"], {
    tools: [t("stylelint", "lint", "{exec} stylelint \"**/*.{css,scss,less}\"", { fileCommand: "{exec} stylelint {file}", exts: CSS_EXTS })],
  }),
  m("vitest", ["vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vitest.config.mjs", "vitest.workspace.ts"], { tools: [t("vitest", "test", "{exec} vitest run", { testOne: "{exec} vitest run {test}" })] }),
  m("vitest-dep", ["package.json"], { requires: [{ dep: "vitest" }], tools: [t("vitest", "test", "{exec} vitest run", { testOne: "{exec} vitest run {test}" })] }),
  m("jest", ["jest.config.js", "jest.config.ts", "jest.config.cjs", "jest.config.mjs", "jest.config.json"], { tools: [t("jest", "test", "{exec} jest", { testOne: "{exec} jest {test}" })] }),
  m("jest-dep", ["package.json"], { requires: [{ dep: "jest" }], tools: [t("jest", "test", "{exec} jest", { testOne: "{exec} jest {test}" })] }),
  m("mocha", [".mocharc.json", ".mocharc.yml", ".mocharc.yaml", ".mocharc.js", ".mocharc.cjs"], { tools: [t("mocha", "test", "{exec} mocha", { testOne: "{exec} mocha {test}" })] }),
  m("playwright", ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"], { tools: [t("playwright", "test", "{exec} playwright test", { testOne: "{exec} playwright test {test}" })] }),

  // ---- Python ----
  ...pyContains("ruff", "[tool.ruff", RUFF, ["ruff.toml", ".ruff.toml"]).map((r) => (r.key === "ruff" ? { ...r, extract: "ruff" as const } : r)),
  m("flake8", [".flake8"], { tools: [FLAKE8] }),
  m("flake8-setup", ["setup.cfg"], { requires: [{ contains: "[flake8]" }], tools: [FLAKE8] }),
  m("flake8-tox", ["tox.ini"], { requires: [{ contains: "[flake8]" }], tools: [FLAKE8] }),
  ...pyContains("pylint", "[tool.pylint", t("pylint", "lint", "{py}pylint .", { fileCommand: "{py}pylint {file}", exts: ["py"] }), [".pylintrc", "pylintrc"]),
  ...pyContains("mypy", "[tool.mypy", MYPY, ["mypy.ini", ".mypy.ini"]),
  m("mypy-setup", ["setup.cfg"], { requires: [{ contains: "[mypy" }], tools: [MYPY] }),
  ...pyContains("pyright", "[tool.pyright", t("pyright", "typecheck", "{py}pyright", { fileCommand: "{py}pyright {file}", exts: ["py"] }), ["pyrightconfig.json"]),
  ...pyContains("black", "[tool.black", t("black", "format", "{py}black --check .", { fileCommand: "{py}black --check {file}", exts: ["py"] })),
  ...pyContains("isort", "[tool.isort", t("isort", "format", "{py}isort --check-only .", { fileCommand: "{py}isort --check-only {file}", exts: ["py"] }), [".isort.cfg"]),
  ...pyContains("pytest", "[tool.pytest", PYTEST, ["pytest.ini", "conftest.py"]),
  m("pytest-setup", ["setup.cfg"], { requires: [{ contains: "[tool:pytest]" }], tools: [PYTEST] }),
  m("pytest-tox", ["tox.ini"], { requires: [{ contains: "[pytest]" }], tools: [PYTEST] }),
  ...pyContains("bandit", "[tool.bandit", t("bandit", "security", "{py}bandit -r ."), [".bandit"]),

  // ---- Go ----
  m("golangci", [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"], { extract: "golangci", tools: [t("golangci-lint", "lint", "golangci-lint run", { exts: ["go"] })] }),
  m("staticcheck", ["staticcheck.conf"], { tools: [t("staticcheck", "lint", "staticcheck ./...", { exts: ["go"] })] }),

  // ---- Rust ----
  m("clippy", ["clippy.toml", ".clippy.toml"], { tools: [t("clippy", "lint", "cargo clippy -- -D warnings", { exts: ["rs"] })] }),
  m("clippy-cargo", ["Cargo.toml"], { requires: [{ contains: "[lints.clippy]" }], tools: [t("clippy", "lint", "cargo clippy -- -D warnings", { exts: ["rs"] })] }),
  m("rustfmt", ["rustfmt.toml", ".rustfmt.toml"], { tools: [t("rustfmt", "format", "cargo fmt --check", { exts: ["rs"] })] }),
  m("cargo-deny", ["deny.toml"], { tools: [t("cargo-deny", "security", "cargo deny check")] }),

  // ---- Java / Kotlin ----
  m("checkstyle-maven", ["pom.xml"], { requires: [{ contains: "maven-checkstyle-plugin" }], tools: [t("checkstyle", "lint", "{mvn} checkstyle:check", { exts: ["java"] })] }),
  m("checkstyle-gradle", ["build.gradle", "build.gradle.kts"], { requires: [{ contains: "checkstyle" }], tools: [t("checkstyle", "lint", "{gradle} checkstyleMain", { exts: ["java"] })] }),
  m("checkstyle-config", ["checkstyle.xml", "config/checkstyle/checkstyle.xml"], { tools: [t("checkstyle", "lint", "{mvn} checkstyle:check", { exts: ["java"] })] }),
  m("spotbugs-maven", ["pom.xml"], { requires: [{ contains: "spotbugs-maven-plugin" }], tools: [t("spotbugs", "lint", "{mvn} spotbugs:check")] }),
  m("spotbugs-gradle", ["build.gradle", "build.gradle.kts"], { requires: [{ contains: "spotbugs" }], tools: [t("spotbugs", "lint", "{gradle} spotbugsMain")] }),
  m("pmd-maven", ["pom.xml"], { requires: [{ contains: "maven-pmd-plugin" }], tools: [t("pmd", "lint", "{mvn} pmd:check")] }),
  m("pmd-gradle", ["build.gradle", "build.gradle.kts"], { requires: [{ contains: "pmd" }], tools: [t("pmd", "lint", "{gradle} pmdMain")] }),
  m("spotless-maven", ["pom.xml"], { requires: [{ contains: "spotless-maven-plugin" }], tools: [t("spotless", "format", "{mvn} spotless:check")] }),
  m("spotless-gradle", ["build.gradle", "build.gradle.kts"], { requires: [{ contains: "spotless" }], tools: [t("spotless", "format", "{gradle} spotlessCheck")] }),
  m("detekt", ["detekt.yml", "config/detekt/detekt.yml"], { tools: [t("detekt", "lint", "{gradle} detekt", { exts: ["kt", "kts"] })] }),
  m("detekt-gradle", ["build.gradle", "build.gradle.kts"], { requires: [{ contains: "detekt" }], tools: [t("detekt", "lint", "{gradle} detekt", { exts: ["kt", "kts"] })] }),
  m("ktlint-gradle", ["build.gradle", "build.gradle.kts"], { requires: [{ contains: "ktlint" }], tools: [t("ktlint", "lint", "{gradle} ktlintCheck", { exts: ["kt", "kts"] })] }),

  // ---- C# / .NET ----
  m("dotnet-editorconfig", [".editorconfig"], { requires: [{ contains: "dotnet_diagnostic" }], tools: [t("dotnet-format", "lint", "dotnet format --verify-no-changes", { fileCommand: "dotnet format --verify-no-changes --include {file}", exts: ["cs"] })] }),
  m("dotnet-editorconfig-style", [".editorconfig"], { requires: [{ contains: "csharp_" }], tools: [t("dotnet-format", "lint", "dotnet format --verify-no-changes", { fileCommand: "dotnet format --verify-no-changes --include {file}", exts: ["cs"] })] }),
  m("dotnet-analyzers", ["Directory.Build.props"], { requires: [{ contains: "TreatWarningsAsErrors" }], tools: [t("dotnet-analyzers", "lint", "dotnet build -warnaserror")] }),
  m("stylecop", ["stylecop.json"], { tools: [t("dotnet-analyzers", "lint", "dotnet build -warnaserror")] }),

  // ---- Ruby ----
  m("rubocop", [".rubocop.yml"], { extract: "rubocop", tools: [t("rubocop", "lint", "bundle exec rubocop", { fileCommand: "bundle exec rubocop {file}", exts: ["rb"] })] }),
  m("standardrb", [".standard.yml"], { tools: [t("standardrb", "lint", "bundle exec standardrb", { fileCommand: "bundle exec standardrb {file}", exts: ["rb"] })] }),
  m("rspec", [".rspec", "spec/spec_helper.rb"], { tools: [t("rspec", "test", "bundle exec rspec", { testOne: "bundle exec rspec {test}" })] }),
  m("sorbet", ["sorbet/config"], { tools: [t("sorbet", "typecheck", "bundle exec srb tc")] }),
  m("brakeman", ["Gemfile"], { requires: [{ contains: "brakeman" }], tools: [t("brakeman", "security", "bundle exec brakeman")] }),

  // ---- PHP ----
  m("phpstan", ["phpstan.neon", "phpstan.neon.dist", "phpstan.dist.neon"], { extract: "phpstan", tools: [t("phpstan", "typecheck", "vendor/bin/phpstan analyse", { fileCommand: "vendor/bin/phpstan analyse {file}", exts: ["php"] })] }),
  m("psalm", ["psalm.xml", "psalm.xml.dist"], { tools: [t("psalm", "typecheck", "vendor/bin/psalm", { fileCommand: "vendor/bin/psalm {file}", exts: ["php"] })] }),
  m("phpcs", ["phpcs.xml", "phpcs.xml.dist", ".phpcs.xml", ".phpcs.xml.dist"], { tools: [t("phpcs", "lint", "vendor/bin/phpcs", { fileCommand: "vendor/bin/phpcs {file}", exts: ["php"] })] }),
  m("php-cs-fixer", [".php-cs-fixer.php", ".php-cs-fixer.dist.php"], { tools: [t("php-cs-fixer", "format", "vendor/bin/php-cs-fixer fix --dry-run --diff", { fileCommand: "vendor/bin/php-cs-fixer fix --dry-run --diff {file}", exts: ["php"] })] }),
  m("phpunit", ["phpunit.xml", "phpunit.xml.dist"], { tools: [t("phpunit", "test", "vendor/bin/phpunit", { testOne: "vendor/bin/phpunit --filter '{name}'" })] }),

  // ---- 通用：任务入口、提交钩子、CI ----
  m("makefile", ["Makefile", "GNUmakefile"], { extract: "makefile" }),
  m("justfile", ["justfile", ".justfile"], { extract: "justfile" }),
  m("pre-commit", [".pre-commit-config.yaml", ".pre-commit-config.yml"], { extract: "pre_commit" }),
  m("husky", [".husky/pre-commit", ".husky/pre-push"], { extract: "husky" }),
  m("lefthook", ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"], { extract: "lefthook" }),
  m("lint-staged", [".lintstagedrc", ".lintstagedrc.json", ".lintstagedrc.yaml", ".lintstagedrc.yml"], { extract: "lint_staged" }),
  m("github-actions", [".github/workflows/*.yml", ".github/workflows/*.yaml"], { extract: "github_actions" }),
  m("gitlab-ci", [".gitlab-ci.yml", ".gitlab-ci.yaml"], { extract: "gitlab_ci" }),
  m("azure-pipelines", ["azure-pipelines.yml", "azure-pipelines.yaml", ".azure-pipelines.yml", ".azure-pipelines/*.yml", ".pipelines/*.yml"], { extract: "azure_pipelines" }),
  m("circleci", [".circleci/config.yml"], { extract: "circleci" }),
  m("bitbucket", ["bitbucket-pipelines.yml"], { extract: "bitbucket" }),
  m("jenkins", ["Jenkinsfile"], { extract: "jenkinsfile" }),

  // ---- 命令关键词（CI 步骤、脚本、钩子里的一条命令是什么） ----
  k("kw-eslint", "lint", "eslint", "\\beslint\\b", { fileCommand: "{exec} eslint {file}", exts: JS_EXTS }),
  k("kw-oxlint", "lint", "oxlint", "\\boxlint\\b", { fileCommand: "{exec} oxlint {file}", exts: JS_EXTS }),
  k("kw-biome-format", "format", "biome-format", "\\bbiome\\s+format\\b", { fileCommand: "{exec} biome format {file}" }),
  k("kw-biome", "lint", "biome", "\\bbiome\\s+(check|lint|ci)\\b", { fileCommand: "{exec} biome check {file}", exts: JS_EXTS }),
  k("kw-prettier", "format", "prettier", "\\bprettier\\b", { fileCommand: "{exec} prettier --check {file}" }),
  k("kw-stylelint", "lint", "stylelint", "\\bstylelint\\b", { fileCommand: "{exec} stylelint {file}", exts: CSS_EXTS }),
  k("kw-tsc", "typecheck", "tsc", "\\b(vue-tsc|tsc|svelte-check)\\b", { exts: TS_EXTS }),
  k("kw-vitest", "test", "vitest", "\\bvitest\\b"),
  k("kw-jest", "test", "jest", "\\bjest\\b"),
  k("kw-mocha", "test", "mocha", "\\bmocha\\b"),
  k("kw-playwright", "test", "playwright", "\\bplaywright\\s+test\\b"),
  k("kw-cypress", "test", "cypress", "\\bcypress\\s+run\\b"),
  k("kw-node-test", "test", "node-test", "\\bnode\\s+(--test|.*\\s--test)\\b"),
  k("kw-npm-audit", "security", "npm-audit", "\\b(npm|pnpm|yarn)\\s+audit\\b"),
  k("kw-ruff-format", "format", "ruff-format", "\\bruff\\s+format\\b", { fileCommand: "{py}ruff format --check {file}", exts: ["py"] }),
  k("kw-ruff", "lint", "ruff", "\\bruff\\b", { fileCommand: "{py}ruff check {file}", exts: ["py", "pyi"] }),
  k("kw-flake8", "lint", "flake8", "\\bflake8\\b", { fileCommand: "{py}flake8 {file}", exts: ["py"] }),
  k("kw-pylint", "lint", "pylint", "\\bpylint\\b", { fileCommand: "{py}pylint {file}", exts: ["py"] }),
  k("kw-mypy", "typecheck", "mypy", "\\bmypy\\b", { fileCommand: "{py}mypy {file}", exts: ["py", "pyi"] }),
  k("kw-pyright", "typecheck", "pyright", "\\b(pyright|basedpyright)\\b", { fileCommand: "{py}pyright {file}", exts: ["py"] }),
  k("kw-black", "format", "black", "\\bblack\\b", { fileCommand: "{py}black --check {file}", exts: ["py"] }),
  k("kw-isort", "format", "isort", "\\bisort\\b", { fileCommand: "{py}isort --check-only {file}", exts: ["py"] }),
  k("kw-pytest", "test", "pytest", "\\b(pytest|py\\.test)\\b"),
  k("kw-unittest", "test", "unittest", "\\bpython[0-9.]*\\s+-m\\s+unittest\\b"),
  k("kw-bandit", "security", "bandit", "\\bbandit\\b"),
  k("kw-pip-audit", "security", "pip-audit", "\\b(pip-audit|safety\\s+check)\\b"),
  k("kw-go-vet", "lint", "go-vet", "\\bgo\\s+vet\\b", { exts: ["go"] }),
  k("kw-golangci", "lint", "golangci-lint", "\\bgolangci-lint\\b", { exts: ["go"] }),
  k("kw-staticcheck", "lint", "staticcheck", "\\bstaticcheck\\b", { exts: ["go"] }),
  k("kw-gofmt", "format", "gofmt", "\\b(gofmt|goimports|gofumpt)\\b", { fileCommand: "test -z \"$(gofmt -l {file})\"", exts: ["go"] }),
  k("kw-go-test", "test", "go-test", "\\bgo\\s+test\\b"),
  k("kw-govulncheck", "security", "govulncheck", "\\bgovulncheck\\b"),
  k("kw-go-build", "build", "go-build", "\\bgo\\s+build\\b"),
  k("kw-clippy", "lint", "clippy", "\\bcargo\\s+clippy\\b|\\bclippy\\b", { exts: ["rs"] }),
  k("kw-cargo-fmt", "format", "rustfmt", "\\bcargo\\s+fmt\\b|\\brustfmt\\b", { fileCommand: "rustfmt --check {file}", exts: ["rs"] }),
  k("kw-cargo-test", "test", "cargo-test", "\\bcargo\\s+(test|nextest)\\b"),
  k("kw-cargo-deny", "security", "cargo-deny", "\\bcargo\\s+(deny|audit)\\b"),
  k("kw-cargo-build", "build", "cargo-build", "\\bcargo\\s+(build|check)\\b"),
  k("kw-checkstyle", "lint", "checkstyle", "\\bcheckstyle"),
  k("kw-spotbugs", "lint", "spotbugs", "\\bspotbugs"),
  k("kw-pmd", "lint", "pmd", "\\bpmd(:check|main)\\b"),
  k("kw-spotless", "format", "spotless", "\\bspotless"),
  k("kw-detekt", "lint", "detekt", "\\bdetekt\\b"),
  k("kw-ktlint", "lint", "ktlint", "\\bktlint"),
  k("kw-maven-test", "test", "maven-test", "\\b(mvn|mvnw)\\b.*\\b(test|verify)\\b"),
  k("kw-maven-build", "build", "maven-build", "\\b(mvn|mvnw)\\b.*\\b(package|install|compile)\\b"),
  k("kw-gradle-test", "test", "gradle-test", "\\b(gradle|gradlew)\\b.*\\b(test|check)\\b"),
  k("kw-gradle-build", "build", "gradle-build", "\\b(gradle|gradlew)\\b.*\\b(build|assemble)\\b"),
  k("kw-dotnet-format", "lint", "dotnet-format", "\\bdotnet\\s+format\\b", { fileCommand: "dotnet format --verify-no-changes --include {file}", exts: ["cs"] }),
  k("kw-dotnet-test", "test", "dotnet-test", "\\bdotnet\\s+test\\b"),
  k("kw-dotnet-build", "build", "dotnet-build", "\\bdotnet\\s+build\\b"),
  k("kw-rubocop", "lint", "rubocop", "\\brubocop\\b", { fileCommand: "bundle exec rubocop {file}", exts: ["rb"] }),
  k("kw-standardrb", "lint", "standardrb", "\\bstandardrb\\b", { fileCommand: "bundle exec standardrb {file}", exts: ["rb"] }),
  k("kw-rspec", "test", "rspec", "\\brspec\\b"),
  k("kw-rake-test", "test", "rake-test", "\\brake\\s+(test|spec)\\b"),
  k("kw-sorbet", "typecheck", "sorbet", "\\bsrb\\s+tc\\b"),
  k("kw-brakeman", "security", "brakeman", "\\bbrakeman\\b"),
  k("kw-bundle-audit", "security", "bundler-audit", "\\bbundle(r)?[- ]audit\\b"),
  k("kw-phpstan", "typecheck", "phpstan", "\\bphpstan\\b", { fileCommand: "vendor/bin/phpstan analyse {file}", exts: ["php"] }),
  k("kw-psalm", "typecheck", "psalm", "\\bpsalm\\b"),
  k("kw-phpcs", "lint", "phpcs", "\\bphpcs\\b", { fileCommand: "vendor/bin/phpcs {file}", exts: ["php"] }),
  k("kw-php-cs-fixer", "format", "php-cs-fixer", "\\bphp-cs-fixer\\b"),
  k("kw-phpunit", "test", "phpunit", "\\b(phpunit|pest)\\b"),
  k("kw-shellcheck", "lint", "shellcheck", "\\bshellcheck\\b", { fileCommand: "shellcheck {file}", exts: ["sh", "bash"] }),
  k("kw-hadolint", "lint", "hadolint", "\\bhadolint\\b"),
  k("kw-markdownlint", "lint", "markdownlint", "\\bmarkdownlint", { fileCommand: "{exec} markdownlint {file}", exts: ["md"] }),
  k("kw-yamllint", "lint", "yamllint", "\\byamllint\\b", { fileCommand: "yamllint {file}", exts: ["yml", "yaml"] }),
  k("kw-actionlint", "lint", "actionlint", "\\bactionlint\\b"),
  k("kw-super-linter", "lint", "super-linter", "super-linter"),
  k("kw-codeql", "security", "codeql", "\\bcodeql"),
  k("kw-semgrep", "security", "semgrep", "\\bsemgrep\\b"),
  k("kw-trivy", "security", "trivy", "\\btrivy\\b"),
  k("kw-gitleaks", "security", "gitleaks", "\\b(gitleaks|trufflehog)\\b"),
  k("kw-snyk", "security", "snyk", "\\bsnyk\\b"),
  k("kw-tox-lint", "lint", "tox-lint", "\\btox\\b.*-e\\s*\\S*(lint|flake8|style)", { priority: 10 }),
  k("kw-tox-type", "typecheck", "tox-type", "\\btox\\b.*-e\\s*\\S*(type|mypy)", { priority: 10 }),
  k("kw-tox", "test", "tox", "\\b(tox|nox)\\b"),
  // 最后才用的通用词：工具名取命令本身。
  k("kw-generic-typecheck", "typecheck", "*", "\\b(type-?check|check-types|types)\\b", { priority: -100 }),
  k("kw-generic-lint", "lint", "*", "\\blint(er|ing)?\\b", { priority: -100 }),
  k("kw-generic-format", "format", "*", "\\b(fmt|format(-check)?)\\b", { priority: -100 }),
  k("kw-generic-security", "security", "*", "\\b(audit|vuln|sast)\\b", { priority: -100 }),
  k("kw-generic-test", "test", "*", "\\b(test|tests|spec|e2e)\\b", { priority: -110 }),
  k("kw-generic-build", "build", "*", "\\b(build|compile)\\b", { priority: -120 }),
];

export interface RuleLayerRow {
  key: string;
  /** 本层存的 JSON：覆盖内置规则时只写要改的字段。 */
  rule: string;
  enabled: boolean;
}

export interface ResolvedRules {
  markers: MarkerRule[];
  keywords: KeywordRule[];
  /** 无效的（按 key）：页面上显示，扫描时忽略。 */
  invalid: Record<string, string>;
  /** 每个 key 最后是哪一层定的。 */
  origin: Record<string, "builtin" | number>;
}

export function parseRuleJson(raw: string): { value: Record<string, unknown> } | { error: string } {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "not an object" };
    return { value: v as Record<string, unknown> };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function validateRule(v: unknown): { rule: BaselineRule } | { error: string } {
  const r = ruleSchema.safeParse(v);
  if (!r.success) return { error: r.error.issues.map((i) => `${i.path.join(".") || "rule"}: ${i.message}`).join("; ") };
  return { rule: r.data as BaselineRule };
}

/**
 * 内置表 + 各层（宽到窄）。同 key 的层逐字段盖掉前面的（只写要改的字段就行）；enabled=false 在这一层停用；新 key 是新规则。
 */
export function resolveRules(layers: RuleLayerRow[][], builtin: BaselineRule[] = BUILTIN_RULES): ResolvedRules {
  const merged = new Map<string, { obj: Record<string, unknown>; enabled: boolean; origin: "builtin" | number }>();
  for (const r of builtin) merged.set(r.key, { obj: { ...r }, enabled: true, origin: "builtin" });
  const invalid: Record<string, string> = {};
  layers.forEach((rows, idx) => {
    for (const row of rows) {
      const p = parseRuleJson(row.rule);
      const prev = merged.get(row.key);
      if ("error" in p) {
        invalid[row.key] = p.error;
        if (prev) merged.set(row.key, { ...prev, enabled: row.enabled && prev.enabled, origin: idx });
        continue;
      }
      merged.set(row.key, { obj: { ...(prev?.obj ?? {}), ...p.value, key: row.key }, enabled: row.enabled, origin: idx });
    }
  });
  const markers: MarkerRule[] = [];
  const keywords: KeywordRule[] = [];
  const origin: Record<string, "builtin" | number> = {};
  for (const [key, m] of merged) {
    origin[key] = m.origin;
    if (!m.enabled) continue;
    const v = validateRule(m.obj);
    if ("error" in v) {
      invalid[key] = v.error;
      continue;
    }
    if (v.rule.kind === "marker") markers.push(v.rule);
    else keywords.push(v.rule);
  }
  keywords.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  markers.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return { markers, keywords, invalid, origin };
}
