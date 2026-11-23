import { describe, expect, it } from "vitest";
import { jsonAddKey, jsonAppend, jsonGet, jsonReplace, makeAddPrereq, makeAddTarget, makeTargets, yamlAppendToTopList } from "./text-edit";
import { parseJsonc } from "../readers/jsonc";

describe("json edits keep the file as it was", () => {
  const pkg = `{
  // the app
  "name": "x",
  "scripts": {
    "lint": "eslint ." // keep me
  }
}
`;
  it("adds a key to a nested object with the file's indent and keeps comments", () => {
    const out = jsonAddKey(pkg, ["scripts"], "shipherd:x", "node a.mjs --all")!;
    expect(out).toContain("// the app");
    expect(out).toContain("// keep me");
    expect(out).toContain(`    "lint": "eslint .", // keep me\n    "shipherd:x": "node a.mjs --all"\n  }`);
    expect((parseJsonc(out) as { scripts: Record<string, string> }).scripts["shipherd:x"]).toBe("node a.mjs --all");
  });
  it("creates the missing parent object", () => {
    const out = jsonAddKey(`{\n  "name": "x"\n}\n`, ["lint-staged"], "*.ts", "node a.mjs")!;
    expect(parseJsonc(out)).toEqual({ name: "x", "lint-staged": { "*.ts": "node a.mjs" } });
    expect(out).toContain(`  "lint-staged": {\n    "*.ts": "node a.mjs"\n  }`);
  });
  it("keeps CRLF and a trailing comma", () => {
    const crlf = `{\r\n\t"a": 1,\r\n}\r\n`;
    const out = jsonAddKey(crlf, [], "b", [1, 2])!;
    expect(out).not.toMatch(/[^\r]\n/);
    expect(parseJsonc(out)).toEqual({ a: 1, b: [1, 2] });
    expect(out).toContain('\t"b": [\r\n\t\t1,');
  });
  it("refuses an existing key", () => {
    expect(jsonAddKey(pkg, ["scripts"], "lint", "x")).toBeNull();
  });
  it("appends to arrays, empty and not, and replaces values", () => {
    const t = `{\n  "overrides": [\n    { "files": ["a"] }\n  ],\n  "e": []\n}\n`;
    const a = jsonAppend(t, ["overrides"], { files: ["b"] })!;
    expect((parseJsonc(a) as { overrides: unknown[] }).overrides).toEqual([{ files: ["a"] }, { files: ["b"] }]);
    const b = jsonAppend(a, ["e"], 1)!;
    expect((parseJsonc(b) as { e: number[] }).e).toEqual([1]);
    const c = jsonAppend(b, ["new"], "x")!;
    expect((parseJsonc(c) as { new: string[] }).new).toEqual(["x"]);
    const d = jsonReplace(c, ["e"], ["y", "z"])!;
    expect(jsonGet(d, ["e"])!.value).toEqual(["y", "z"]);
    expect(jsonAppend(`{"a": 1}`, ["a"], 2)).toBeNull();
  });
  it("handles a one-line object", () => {
    const out = jsonAddKey(`{"a": 1}`, [], "b", 2)!;
    expect(out).toBe(`{"a": 1, "b": 2}`);
  });
});

describe("yaml list append", () => {
  const cfg = `# hooks\nrepos:\n  - repo: https://example.invalid/hooks\n    rev: v1\n    hooks:\n      - id: a\n\n# end of repos\ndefault_stages: [pre-commit]\n`;
  it("adds an item at the end of the top-level list and keeps the rest", () => {
    const out = yamlAppendToTopList(cfg, "repos", ["- repo: local", "  hooks:", "    - id: b"])!;
    expect(out).toContain("      - id: a\n  - repo: local\n    hooks:\n      - id: b\n\n# end of repos\ndefault_stages");
    expect(out.startsWith("# hooks\n")).toBe(true);
  });
  it("supports unindented list items and CRLF", () => {
    const crlf = "repos:\r\n- repo: x\r\n  hooks: []\r\n";
    const out = yamlAppendToTopList(crlf, "repos", ["- repo: local"])!;
    expect(out).toBe("repos:\r\n- repo: x\r\n  hooks: []\r\n- repo: local\r\n");
  });
  it("creates the key or replaces []", () => {
    expect(yamlAppendToTopList("a: 1\n", "repos", ["- repo: local"])).toBe("a: 1\nrepos:\n  - repo: local\n");
    expect(yamlAppendToTopList("repos: []\n", "repos", ["- repo: local"])).toBe("repos:\n  - repo: local\n");
  });
  it("refuses flow lists and mappings", () => {
    expect(yamlAppendToTopList("repos: [a]\n", "repos", ["- x"])).toBeNull();
    expect(yamlAppendToTopList("repos:\n  a: 1\n", "repos", ["- x"])).toBeNull();
  });
});

describe("makefile", () => {
  const mk = "VAR := 1\n.PHONY: lint\nlint: fmt ## run lint\n\tgo vet ./...\nfmt:\n\tgofmt -l .\n";
  it("lists targets", () => {
    expect(makeTargets(mk)).toEqual(["lint", "fmt"]);
  });
  it("adds a target with a tab recipe and a prerequisite", () => {
    const out = makeAddTarget(mk, "shipherd-x", ["sh scripts/shipherd-checks/x.sh --all"]);
    expect(out.endsWith("\n\n.PHONY: shipherd-x\nshipherd-x:\n\tsh scripts/shipherd-checks/x.sh --all\n")).toBe(true);
    expect(makeAddPrereq(out, "lint", "shipherd-x")).toContain("lint: fmt shipherd-x ## run lint\n");
    expect(makeAddPrereq("lint:\n\tx\n", "lint", "b")).toBe("lint: b\n\tx\n");
    expect(makeAddPrereq("a:\n", "lint", "b")).toBeNull();
    expect(makeAddTarget("a:\r\n\tx\r\n", "b", ["y"])).toBe("a:\r\n\tx\r\n\r\n.PHONY: b\r\nb:\r\n\ty\r\n");
  });
});
