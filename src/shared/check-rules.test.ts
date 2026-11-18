import { describe, expect, it } from "vitest";
import {
  commentPolicy, commentsOf, editedLines, evaluateBuiltin, fingerprints, forbiddenPattern, importBoundary, importsOfLine, importTargets, newViolations, reconstructBefore,
} from "./check-rules";

const ctx = (path: string) => ({ path, ticketPattern: "[A-Z][A-Z0-9]+-\\d+" });

describe("forbidden_pattern", () => {
  it("reports each matching line with its number", () => {
    const v = forbiddenPattern({ pattern: "useEffect\\(" }, "a\nuseEffect(() => {})\nb\n  useEffect(x)");
    expect(v.map((x) => x.line)).toEqual([2, 4]);
    expect(v[1].text).toBe("useEffect(x)");
  });
  it("supports literal and case-insensitive", () => {
    expect(forbiddenPattern({ pattern: "a.b", literal: true }, "axb\na.b")).toHaveLength(1);
    expect(forbiddenPattern({ pattern: "console", flags: "i" }, "CONSOLE.log(1)")).toHaveLength(1);
  });
  it("ignores a broken regex instead of throwing", () => {
    expect(forbiddenPattern({ pattern: "(" }, "(")).toEqual([]);
  });
});

describe("import_boundary", () => {
  it("parses JS/TS import forms", () => {
    expect(importsOfLine(`import { a } from "../main/x";`, false)).toEqual(["../main/x"]);
    expect(importsOfLine(`import "./side";`, false)).toEqual(["./side"]);
    expect(importsOfLine(`export * from './y'`, false)).toEqual(["./y"]);
    expect(importsOfLine(`const m = await import("electron")`, false)).toEqual(["electron"]);
    expect(importsOfLine(`const fs = require('node:fs')`, false)).toEqual(["node:fs"]);
    expect(importsOfLine(`} from "lodash";`, false)).toEqual(["lodash"]);
  });
  it("parses Python imports", () => {
    expect(importsOfLine("from app.db import models", true)).toEqual(["app.db"]);
    expect(importsOfLine("import os, app.web as w", true)).toEqual(["os", "app.web"]);
    expect(importsOfLine("from ..core import x", true)).toEqual(["..core"]);
  });
  it("resolves relative specifiers against the file", () => {
    expect(importTargets("../main/x", "src/renderer/a.ts", false)).toEqual(["../main/x", "src/main/x"]);
    expect(importTargets("..core", "pkg/sub/mod.py", true)).toEqual(["..core", "pkg/core"]);
    expect(importTargets("app.db", "x.py", true)).toEqual(["app.db", "app/db"]);
  });
  it("forbids by repo path or package name, with allow exceptions", () => {
    const content = [`import { x } from "../main/db";`, `import { y } from "../shared/z";`, `import { ipcMain } from "electron";`, `import { ok } from "../main/api";`].join("\n");
    const v = importBoundary({ forbid: ["src/main/**", "electron"], allow: ["src/main/api"] }, content, ctx("src/renderer/view.ts"));
    expect(v.map((x) => [x.line, x.detail])).toEqual([[1, "../main/db"], [3, "electron"]]);
  });
  it("works with Windows-style paths", () => {
    const v = importBoundary({ forbid: ["src\\main\\**"] }, `import a from "../main/db"`, ctx("src\\renderer\\view.ts"));
    expect(v).toHaveLength(1);
  });
  it("checks Python boundaries", () => {
    const v = importBoundary({ forbid: ["app/db/**", "app/db"] }, "from app.db import models\nfrom app.web import v", ctx("app/api/x.py"));
    expect(v.map((x) => x.line)).toEqual([1]);
  });
});

describe("comment_policy", () => {
  it("finds line and block comments, not strings or URLs", () => {
    const c = commentsOf(`const u = "http://x"; // real one\nconst s = "// not a comment";\n/* block\n still */ code`, "a.ts");
    expect(c).toEqual([{ line: 1, text: "real one" }, { line: 3, text: "block" }, { line: 4, text: "still" }]);
  });
  it("uses # for Python and shell", () => {
    expect(commentsOf("x = 1  # temporary hack", "a.py")).toEqual([{ line: 1, text: "temporary hack" }]);
  });
  it("requires a ticket on temporary-style comments, English and Chinese", () => {
    const content = [
      "// temporary fix until upstream lands",
      "// temporary fix, see ABC-123",
      "// 暂时这样写，以后再改",
      "// 临时方案 #42",
      "// a normal comment",
      "// TODO https://example.com/issues/7",
      "// this is not optimal",
    ].join("\n");
    expect(commentPolicy({}, content, ctx("a.ts")).map((v) => v.line)).toEqual([1, 3, 7]);
  });
  it("matches English keywords on word boundaries only", () => {
    expect(commentPolicy({}, "// hackathon notes", ctx("a.ts"))).toEqual([]);
    expect(commentPolicy({}, "// Hack: skip", ctx("a.ts"))).toHaveLength(1);
  });
  it("accepts custom keywords and ticket pattern", () => {
    const p = { keywords: ["kludge"], ticketPattern: "T\\d+" };
    expect(commentPolicy(p, "// kludge\n// kludge T12\n// temporary", ctx("a.ts")).map((v) => v.line)).toEqual([1]);
  });
});

describe("new violations and edits", () => {
  it("only reports what the edit added", () => {
    const before = forbiddenPattern({ pattern: "bad" }, "bad\nok");
    const after = forbiddenPattern({ pattern: "bad" }, "bad\nok\nbad");
    expect(newViolations(before, after, null).map((v) => v.line)).toEqual([3]);
    expect(newViolations(after, before, null)).toEqual([]);
  });
  it("falls back to edited lines when the old content is unknown", () => {
    const after = forbiddenPattern({ pattern: "bad" }, "bad\nok\nbad");
    expect(newViolations(null, after, new Set([3])).map((v) => v.line)).toEqual([3]);
  });
  it("fingerprints identical lines separately", () => {
    expect(fingerprints([{ line: 1, text: "x", detail: "" }, { line: 2, text: "x", detail: "" }])).toEqual(["x#0", "x#1"]);
  });
  it("reconstructs the old content", () => {
    expect(reconstructBefore("Write", {}, { originalFile: "old" }, "new")).toBe("old");
    expect(reconstructBefore("Write", {}, { type: "create" }, "new")).toBe("");
    expect(reconstructBefore("Write", {}, { type: "update" }, "new")).toBeNull();
    expect(reconstructBefore("Edit", { old_string: "a", new_string: "b" }, {}, "x b y b")).toBe("x a y b");
    expect(reconstructBefore("Edit", { old_string: "a", new_string: "b", replace_all: true }, {}, "x b y b")).toBe("x a y a");
    expect(reconstructBefore("MultiEdit", { edits: [{ old_string: "1", new_string: "2" }, { old_string: "2", new_string: "3" }] }, {}, "3")).toBe("1");
    expect(reconstructBefore("Edit", { old_string: "a", new_string: "zz" }, {}, "nothing")).toBeNull();
  });
  it("finds edited lines", () => {
    expect([...(editedLines("Edit", { old_string: "a", new_string: "b\nc" }, "x\nb\nc\ny") ?? [])]).toEqual([2, 3]);
    expect(editedLines("Write", {}, "x")).toBeNull();
  });
  it("dispatches by type", () => {
    expect(evaluateBuiltin({ type: "forbidden_pattern", params: { pattern: "x" } }, "x", ctx("a.ts"))).toHaveLength(1);
    expect(evaluateBuiltin({ type: "run_command", params: {} }, "x", ctx("a.ts"))).toEqual([]);
  });
});
