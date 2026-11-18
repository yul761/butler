import { describe, expect, it } from "vitest";
import { parseToml, tomlGet, tomlStrings } from "./toml";
import { parseJsonc } from "./jsonc";
import { joinDir, lines, shellWords, splitCommands } from "./commands";

describe("toml reader", () => {
  it("reads tables, arrays, multi-line arrays and inline tables", () => {
    const t = parseToml(
      [
        "﻿# comment",
        "[project]",
        'name = "demo"',
        "version = '1.0'",
        "",
        "[tool.ruff]",
        "line-length = 100",
        "[tool.ruff.lint]",
        'select = ["E", "F",',
        '  "I", # imports',
        "]",
        "[tool.mypy]",
        "strict = true",
        "[[tool.mypy.overrides]]",
        'module = "a.*"',
        "[[tool.mypy.overrides]]",
        'module = "b.*"',
        "[dependencies]",
        'serde = { version = "1", features = ["derive"] }',
        'x."quoted.key" = 3',
      ].join("\r\n"),
    );
    expect(tomlGet(t, "project.name")).toBe("demo");
    expect(tomlGet(t, "project.version")).toBe("1.0");
    expect(tomlGet(t, "tool.ruff.line-length")).toBe(100);
    expect(tomlStrings(tomlGet(t, "tool.ruff.lint.select"))).toEqual(["E", "F", "I"]);
    expect(tomlGet(t, "tool.mypy.strict")).toBe(true);
    expect((tomlGet(t, "tool.mypy.overrides") as unknown[]).length).toBe(2);
    expect(tomlGet(t, "dependencies.serde.version")).toBe("1");
    expect((tomlGet(t, "dependencies.x") as Record<string, unknown>)["quoted.key"]).toBe(3);
  });

  it("skips what it cannot read instead of throwing", () => {
    const t = parseToml('[broken\nkey = "v"\n???\n[ok]\na = 1\nb = """multi\nline"""\n');
    expect(tomlGet(t, "ok.a")).toBe(1);
    expect(tomlGet(t, "ok.b")).toBe("multi\nline");
  });
});

describe("jsonc reader", () => {
  it("reads comments and trailing commas, keeps // inside strings", () => {
    const v = parseJsonc('{\n // c\n "a": "http://x", /* b */ "b": [1,2,],\n}') as Record<string, unknown>;
    expect(v).toEqual({ a: "http://x", b: [1, 2] });
    expect(parseJsonc("{nope")).toBeNull();
  });
});

describe("command splitting", () => {
  it("splits on separators outside quotes and follows cd", () => {
    expect(splitCommands('pnpm install && pnpm lint; echo "a && b"\ncd packages/web && npx tsc --noEmit || true')).toEqual([
      { text: "pnpm install", cd: "" },
      { text: "pnpm lint", cd: "" },
      { text: "npx tsc --noEmit", cd: "packages/web" },
    ]);
  });

  it("joins continuations and drops env assignments and comments", () => {
    expect(splitCommands("CI=1 FOO='a b' go test \\\n  ./... # all\r\nruff check `\n  .")).toEqual([
      { text: "go test ./...", cd: "" },
      { text: "ruff check .", cd: "" },
    ]);
  });

  it("resolves cd relative to a start dir and stops at paths leaving the repo", () => {
    expect(splitCommands("cd ../api && make test", "services/web")).toEqual([{ text: "make test", cd: "services/api" }]);
    expect(splitCommands("cd /tmp && make test")).toEqual([]);
    expect(joinDir("", "./a\\b")).toBe("a/b");
    expect(joinDir("", "..")).toBeNull();
  });

  it("splits words and lines", () => {
    expect(shellWords(`eslint "src dir" --ext '.ts'`)).toEqual(["eslint", "src dir", "--ext", ".ts"]);
    expect(lines("﻿a\r\nb\nc")).toEqual(["a", "b", "c"]);
  });
});
