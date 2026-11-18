import { describe, expect, it } from "vitest";
import { scanFiles } from "./scan";
import { resolveRules } from "./rules";
import { parseIni, runExtractor } from "./extract";

function scan(repo: Record<string, string>) {
  return scanFiles({ files: Object.keys(repo), read: (p) => repo[p] ?? null, rules: resolveRules([]) });
}
const tools = (r: ReturnType<typeof scan>) => r.checks.map((c) => `${c.dir}|${c.category}|${c.tool}|${c.stages.join("+")}|${c.command}`);

describe("extractors through the scanner", () => {
  it("Azure Pipelines: scripts with workingDirectory and CLI tasks", () => {
    const r = scan({
      "app/App.csproj": "<Project><PropertyGroup><TreatWarningsAsErrors>true</TreatWarningsAsErrors><Nullable>enable</Nullable></PropertyGroup></Project>",
      "azure-pipelines.yml": [
        "steps:",
        "  - script: dotnet format --verify-no-changes",
        "    workingDirectory: app",
        "  - task: DotNetCoreCLI@2",
        "    inputs:",
        "      command: test",
        "      workingDir: app",
        "  - pwsh: |",
        "      Set-Location app",
        "      dotnet build -c Release",
      ].join("\r\n"),
    });
    expect(tools(r)).toEqual(expect.arrayContaining([
      "app|lint|dotnet-format|ci|dotnet format --verify-no-changes",
      "app|test|dotnet-test|ci|dotnet test",
      "app|build|dotnet-build|ci|dotnet build -c Release",
    ]));
    expect(r.checks.find((c) => c.tool === "dotnet-build")!.facts).toEqual(["TreatWarningsAsErrors", "nullable"]);
  });

  it("CircleCI, Bitbucket and Jenkins", () => {
    const r = scan({
      "Gemfile": "gem 'rubocop'\ngem 'rspec'\n",
      ".rubocop.yml": "Style/StringLiterals:\n  Enabled: true\nLayout/LineLength:\n  Enabled: false\n",
      ".circleci/config.yml": "jobs:\n  test:\n    steps:\n      - checkout\n      - run: bundle exec rspec\n      - run:\n          command: bundle exec rubocop\n",
      "bitbucket-pipelines.yml": "pipelines:\n  default:\n    - step:\n        script:\n          - bundle exec brakeman -q\n",
      Jenkinsfile: "pipeline { stages { stage('t') { steps { sh 'bundle exec rake test' } } } }\n",
    });
    expect(tools(r)).toEqual(expect.arrayContaining([
      "|lint|rubocop|ci|bundle exec rubocop",
      "|test|rspec|ci|bundle exec rspec",
      "|security|brakeman|ci|bundle exec brakeman -q",
      "|test|rake-test|ci|bundle exec rake test",
    ]));
    expect(r.checks.find((c) => c.tool === "rubocop")!.facts).toEqual(["Style/StringLiterals"]);
    expect(r.profile.projects[0].install).toBe("bundle install");
  });

  it("GitLab, lefthook, justfile, tox and composer", () => {
    const r = scan({
      "composer.json": JSON.stringify({ name: "acme/site", scripts: { lint: "phpcs --standard=PSR12 src", test: ["@php vendor/bin/phpunit"] }, "require-dev": { "phpunit/phpunit": "11" } }),
      "phpstan.neon": "parameters:\n  level: 8\n",
      "lefthook.yml": "pre-push:\n  commands:\n    stan:\n      run: vendor/bin/phpstan analyse\npre-commit:\n  commands:\n    cs:\n      run: vendor/bin/phpcs {staged_files}\n",
      ".gitlab-ci.yml": "test:\n  script:\n    - composer install\n    - composer test\n",
    });
    expect(tools(r)).toEqual(expect.arrayContaining([
      "|lint|phpcs|commit|composer lint",
      "|typecheck|phpstan|push|vendor/bin/phpstan analyse",
      "|test|phpunit|ci|composer test",
    ]));
    expect(r.checks.find((c) => c.tool === "phpstan")!.facts).toEqual(["level:8"]);

    const p = scan({
      "pyproject.toml": "[project]\nname='x'\n",
      "tox.ini": "[tox]\nenvlist = py, lint\n[testenv]\ncommands = pytest {posargs}\n[testenv:lint]\ncommands =\n    flake8 src\n    mypy src\n[flake8]\nselect = E,W\n",
      justfile: "default: test\n\ntest:\n    tox -e py\n\nlint:\n    tox -e lint\n",
    });
    expect(tools(p)).toEqual(expect.arrayContaining(["|lint|flake8||just lint", "|test|pytest||just test", "|typecheck|mypy||mypy src"]));
    expect(p.checks.find((c) => c.tool === "flake8")!.facts).toEqual(["E", "W"]);
  });

  it("Cargo lints, golangci TOML, Gradle wrapper and Maven plugins", () => {
    const r = scan({
      "Cargo.toml": "[package]\nname = 'x'\n[lints.clippy]\nunwrap_used = 'deny'\npedantic = { level = 'warn', priority = -1 }\nexpect_used = 'allow'\n",
      "svc/go.mod": "module y\n",
      "svc/.golangci.toml": "[linters]\nenable = ['errcheck']\n",
      "jvm/build.gradle.kts": "plugins { checkstyle; id(\"io.gitlab.arturbosch.detekt\") }\n",
      "jvm/gradlew": "#!/bin/sh\n",
      "jvm/src/A.kt": "",
      "mvn/pom.xml": "<project><build><plugins><plugin><artifactId>maven-checkstyle-plugin</artifactId></plugin></plugins></build></project>",
    });
    expect(r.checks.find((c) => c.tool === "clippy")!.facts).toEqual(["clippy::pedantic", "clippy::unwrap_used"]);
    expect(r.checks.find((c) => c.tool === "golangci-lint")).toMatchObject({ dir: "svc", facts: ["errcheck"] });
    expect(r.checks.find((c) => c.dir === "jvm" && c.tool === "detekt")!.command).toBe("./gradlew detekt");
    expect(r.checks.find((c) => c.dir === "jvm" && c.tool === "checkstyle")!.command).toBe("./gradlew checkstyleMain");
    expect(r.checks.find((c) => c.dir === "mvn" && c.tool === "checkstyle")!.command).toBe("mvn checkstyle:check");
    expect(r.projects.find((p) => p.dir === "jvm")!.langs).toEqual(["java", "kotlin"]);
  });

  it("ESLint YAML, JSON eslintrc and package.json eslintConfig", () => {
    expect(runExtractor("eslint", { path: ".eslintrc.yml", dir: "", text: "rules:\n  no-alert: error\n  semi: [2, always]\n  quotes: 0\n" }).facts).toEqual([{ tool: "eslint", facts: ["no-alert", "semi"] }]);
    expect(runExtractor("eslint", { path: ".eslintrc.json", dir: "", text: '{"overrides":[{"rules":{"no-var":"warn"}}]}' }).facts).toEqual([{ tool: "eslint", facts: ["no-var"] }]);
    expect(runExtractor("package_json", { path: "package.json", dir: "", text: '{"eslintConfig":{"rules":{"no-eval":"error"}}}' }).facts).toEqual([{ tool: "eslint", facts: ["no-eval"] }]);
  });

  it("tolerates broken files", () => {
    for (const name of ["github_actions", "pre_commit", "package_json", "pyproject", "gitlab_ci", "azure_pipelines"] as const) {
      expect(runExtractor(name, { path: "x", dir: "", text: "{{{: [\n\t- ][" })).toBeTypeOf("object");
    }
    expect(parseIni("[a]\nk = v\n  more\n; c\n")).toEqual({ a: { k: "v\nmore" } });
  });
});
