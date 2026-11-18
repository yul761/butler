// 导出的检查脚本和 hook 的规则结果一致（设计 §8 决定 7）：同一批样例，Node / Python / shell 三种脚本对照 evaluateBuiltin。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateBuiltin } from "../../../shared/check-rules";
import { inScope } from "../../../shared/glob";
import type { ResolvedCheck } from "../../../shared/checks";
import { writeRepo } from "../test-repo";
import { checkData, expandBraces, nodeScript, pathspecs, pygrepEntry, pythonScript, runnerScript, shScript, type ExportedCheckData } from "./scripts";
import { jsRegexToPcre, jsRegexToPython } from "./regex";
// @ts-expect-error 纯 JS 的构建脚本
import { bundleCheckRuntime, GENERATED_PATH, renderGenerated } from "../../../../scripts/check-runtime-bundle.mjs";

const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
const HAS_PY = has("python3", ["--version"]);
const HAS_SH = process.platform !== "win32" || has("sh", ["-c", "exit 0"]);

const FILES: Record<string, string> = {
  "src/a.ts": [
    'import { app } from "electron";',
    'import x from "../main/db";',
    'import y from "./main/shared/util";',
    "// TODO: fix later",
    "// TODO ABC-12 tracked",
    'const s = "http://example.invalid // not a comment";',
    "console.log(s); // temporary",
    "const t = `",
    "// inside a template",
    "`;",
    "/* workaround for",
    "   the bug */",
    "let w = 12px; foofoo",
  ].join("\n"),
  "src/main/db.ts": "export const db = 1;\r\nconsole.log('db')\r\n// 暂时这样\r\n",
  "src/main/shared/util.ts": "﻿import { db } from '../db';\nexport const u = db;\n",
  "src/b c/ü.ts": "console.log('ü');\n",
  "app/views.py": [
    "from app.db import session",
    "import os, app.db.models as m",
    "from . import local",
    "# TODO: later",
    "# hack, see #123",
    's = "# not a comment"',
    "print('x')  # for now",
  ].join("\n"),
  "app/db/__init__.py": "x = 1\n",
  "db/schema.sql": "-- TODO temporary\nSELECT 1; -- ok\n",
  "web/index.html": "<!-- FIXME later -->\n<p>TODO in text</p>\n",
  "bin/blob.bin": "\u0000\u0001TODO console.log(",
};

function check(type: ResolvedCheck["type"], params: Record<string, unknown>, globs: string[] = [], excludeGlobs: string[] = []): ResolvedCheck {
  return { id: 1, key: "ck_abcdef123456", type, name: `${type} check`, params, globs, excludeGlobs, severity: "block", mode: "enforce", message: "do not" };
}

const CASES: { label: string; check: ResolvedCheck; ticket?: string }[] = [
  { label: "regex", check: check("forbidden_pattern", { pattern: "console\\.log\\(" }, ["src/**/*.ts"]) },
  { label: "literal-ci", check: check("forbidden_pattern", { pattern: "todo", literal: true, flags: "i" }, [], ["**/*.html"]) },
  { label: "named-group", check: check("forbidden_pattern", { pattern: "(?<w>foo)\\k<w>|\\d+px" }, ["*.ts"]) },
  { label: "imports", check: check("import_boundary", { forbid: ["electron", "src/main/**", "app/db", "app/db/**"], allow: ["src/main/shared/**"] }) },
  { label: "comments", check: check("comment_policy", {}), ticket: "[A-Z]+-\\d+" },
  { label: "keywords", check: check("comment_policy", { keywords: ["later", "暂时"] }, ["src/**", "app/**"]) },
];

/** evaluateBuiltin 的结果：file:line 排好序。 */
function expected(c: ResolvedCheck, ticket: string, files: string[] = Object.keys(FILES)): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (!inScope(f, c.globs, c.excludeGlobs)) continue;
    let text = FILES[f];
    if (text.slice(0, 8192).includes("\u0000")) continue;
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    for (const v of evaluateBuiltin(c, text, { path: f, ticketPattern: ticket })) out.push(`${f}:${v.line}`);
  }
  return out.sort();
}

function got(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => /^(.*?):(\d+): /.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => `${m[1]}:${m[2]}`)
    .sort();
}

const repos: string[] = [];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});

function repo(): string {
  const r = writeRepo(FILES);
  repos.push(r);
  return r;
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function run(root: string, cmd: string, args: string[], cwd = root) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("generated node runtime", () => {
  it("is up to date with check-rules (run node scripts/build-check-runtime.mjs)", async () => {
    const code = (await bundleCheckRuntime()) as string;
    expect(readFileSync(GENERATED_PATH, "utf8")).toBe(renderGenerated(code));
  }, 30_000);
});

describe("node script agrees with evaluateBuiltin", () => {
  const root = repo();
  for (const c of CASES) {
    it(c.label, () => {
      const data = checkData(c.check, c.ticket ?? "");
      write(root, `scripts/${c.label}.mjs`, nodeScript(data, `scripts/${c.label}.mjs`));
      const r = run(root, process.execPath, [`scripts/${c.label}.mjs`, "--all"]);
      const want = expected(c.check, c.ticket ?? "");
      expect(got(r.stdout)).toEqual(want);
      expect(r.status).toBe(want.length ? 1 : 0);
    });
  }
  it("checks staged files only by default and listed files relative to the cwd", () => {
    const c = CASES[0];
    write(root, "scripts/staged.mjs", nodeScript(checkData(c.check, ""), "scripts/staged.mjs"));
    expect(run(root, process.execPath, ["scripts/staged.mjs"]).status).toBe(0);
    write(root, "src/new.ts", "console.log(1)\n");
    execFileSync("git", ["add", "src/new.ts"], { cwd: root });
    write(root, "src/new.ts", "clean\n"); // 暂存区里的内容才算
    const r = run(root, process.execPath, ["scripts/staged.mjs"]);
    expect(got(r.stdout)).toEqual(["src/new.ts:1"]);
    const listed = run(root, process.execPath, ["../scripts/staged.mjs", "a.ts", "main/db.ts"], join(root, "src"));
    expect(got(listed.stdout)).toEqual(expected(c.check, "", ["src/a.ts", "src/main/db.ts"]));
    const absolute = run(root, process.execPath, ["../scripts/staged.mjs", join(root, "src", "a.ts")], join(root, "src"));
    expect(got(absolute.stdout)).toEqual(expected(c.check, "", ["src/a.ts"]));
    execFileSync("git", ["reset", "-q", "--", "src/new.ts"], { cwd: root });
    rmSync(join(root, "src/new.ts"));
  });
});

describe.runIf(HAS_PY)("python script agrees with evaluateBuiltin", () => {
  const root = repo();
  for (const c of CASES) {
    it(c.label, () => {
      const s = pythonScript(checkData(c.check, c.ticket ?? ""), `scripts/${c.label}.py`);
      if (!s.ok) throw new Error(s.reason);
      write(root, `scripts/${c.label}.py`, s.content);
      const r = run(root, "python3", [`scripts/${c.label}.py`, "--all"]);
      expect(r.stderr).not.toMatch(/Traceback/);
      const want = expected(c.check, c.ticket ?? "");
      expect(got(r.stdout)).toEqual(want);
      expect(r.status).toBe(want.length ? 1 : 0);
    });
  }
  it("fails with exit 2 instead of passing when Python cannot compile the pattern", () => {
    const s = pythonScript(checkData(check("forbidden_pattern", { pattern: "a\\8" }, ["src/**"]), ""), "scripts/bad.py");
    if (!s.ok) throw new Error(s.reason);
    write(root, "scripts/bad.py", s.content);
    const r = run(root, "python3", ["scripts/bad.py", "--all"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("invalid pattern");
  });
  it("takes listed files relative to the cwd, or absolute", () => {
    const s = pythonScript(checkData(CASES[0].check, ""), "scripts/listed.py");
    if (!s.ok) throw new Error(s.reason);
    write(root, "scripts/listed.py", s.content);
    const sub = join(root, "src");
    expect(got(run(root, "python3", ["../scripts/listed.py", "a.ts", "main/db.ts"], sub).stdout)).toEqual(expected(CASES[0].check, "", ["src/a.ts", "src/main/db.ts"]));
    expect(got(run(root, "python3", ["../scripts/listed.py", join(sub, "a.ts")], sub).stdout)).toEqual(expected(CASES[0].check, "", ["src/a.ts"]));
  });
  it("staged mode reads the index", () => {
    const s = pythonScript(checkData(CASES[0].check, ""), "scripts/staged.py");
    if (!s.ok) throw new Error(s.reason);
    write(root, "scripts/staged.py", s.content);
    write(root, "src/new2.ts", "console.log(2)\n");
    execFileSync("git", ["add", "src/new2.ts"], { cwd: root });
    expect(got(run(root, "python3", ["scripts/staged.py"]).stdout)).toEqual(["src/new2.ts:1"]);
    execFileSync("git", ["reset", "-q", "--", "src/new2.ts"], { cwd: root });
    rmSync(join(root, "src/new2.ts"));
  });
});

describe.runIf(HAS_SH)("shell script agrees with evaluateBuiltin for forbidden patterns", () => {
  const root = repo();
  for (const c of CASES.filter((x) => x.check.type === "forbidden_pattern")) {
    it(c.label, () => {
      const s = shScript(checkData(c.check, ""), `scripts/${c.label}.sh`);
      if (!s.ok) throw new Error(s.reason);
      write(root, `scripts/${c.label}.sh`, s.content);
      const r = run(root, "sh", [`scripts/${c.label}.sh`, "--all"]);
      const want = expected(c.check, "");
      expect(got(r.stdout)).toEqual(want);
      expect(r.status).toBe(want.length ? 1 : 0);
    });
  }
  it("staged mode and listed files", () => {
    const s = shScript(checkData(CASES[0].check, ""), "scripts/staged.sh");
    if (!s.ok) throw new Error(s.reason);
    write(root, "scripts/staged.sh", s.content);
    expect(run(root, "sh", ["scripts/staged.sh"]).status).toBe(0);
    write(root, "src/new3.ts", "console.log(3)\n");
    execFileSync("git", ["add", "src/new3.ts"], { cwd: root });
    expect(got(run(root, "sh", ["scripts/staged.sh"]).stdout)).toEqual(["src/new3.ts:1"]);
    expect(got(run(root, "sh", ["../scripts/staged.sh", "a.ts"], join(root, "src")).stdout)).toEqual(expected(CASES[0].check, "", ["src/a.ts"]));
    execFileSync("git", ["reset", "-q", "--", "src/new3.ts"], { cwd: root });
    rmSync(join(root, "src/new3.ts"));
  });
  it("refuses other check types", () => {
    expect(shScript(checkData(CASES[3].check, ""), "x.sh").ok).toBe(false);
  });
  it("fails with exit 2 instead of passing when git grep cannot compile the pattern", () => {
    // JS 收的（\8 在不带 u 时是字面的 8），PCRE 不收
    const s = shScript(checkData(check("forbidden_pattern", { pattern: "a\\8" }, ["src/**"]), ""), "scripts/bad.sh");
    if (!s.ok) throw new Error(s.reason);
    write(root, "scripts/bad.sh", s.content);
    const r = run(root, "sh", ["scripts/bad.sh", "--all"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("cannot run this pattern");
  });
});

describe.runIf(HAS_SH)("run_command runner", () => {
  it("runs the command once per file in scope with $1 and BUTLER_CHECK_FILE", () => {
    const root = repo();
    const data: ExportedCheckData = { ...checkData(check("run_command", {}, ["src/**/*.ts"], ["src/main/**"]), ""), name: "runner" };
    write(root, "scripts/r.sh", runnerScript(data, 'grep -q console "$BUTLER_CHECK_FILE" && echo "bad {file}" && exit 1; exit 0', "scripts/r.sh"));
    const r = run(root, "sh", ["scripts/r.sh", "--all"]);
    expect(r.status).toBe(1);
    expect(r.stdout.split("\n").filter(Boolean).sort()).toEqual(["bad src/a.ts", "bad src/b c/ü.ts"]);
    expect(r.stderr).toContain("src/a.ts: runner failed");
  });
});

describe("regex translation", () => {
  it("translates named groups and back references for Python", () => {
    expect(jsRegexToPython("(?<n>a)\\k<n>\\/x")).toEqual({ ok: true, source: "(?P<n>a)(?P=n)/x" });
    expect(jsRegexToPython("(?<=ab)c(?<!x)")).toEqual({ ok: true, source: "(?<=ab)c(?<!x)" });
    expect(jsRegexToPython("[\\d-]\\v")).toEqual({ ok: true, source: "[\\d-]\\x0b" });
  });
  it("refuses what Python reads differently", () => {
    expect(jsRegexToPython("\\p{L}")).toEqual({ ok: false, reason: "unicode_property" });
    expect(jsRegexToPython("\\u{1F600}")).toEqual({ ok: false, reason: "unicode_codepoint" });
    expect(jsRegexToPython("(?<=a+)b")).toEqual({ ok: false, reason: "lookbehind" });
    expect(jsRegexToPython("[^]")).toEqual({ ok: false, reason: "empty_class" });
    expect(jsRegexToPython("\\cA")).toEqual({ ok: false, reason: "control_escape" });
    expect(jsRegexToPython("\\q")).toEqual({ ok: false, reason: "escape" });
  });
  it("PCRE keeps the source and rewrites \\u", () => {
    expect(jsRegexToPcre("a\\u00e9(?<n>b)")).toEqual({ ok: true, source: "a\\x{00e9}(?<n>b)" });
    expect(jsRegexToPcre("\\\\u0041")).toEqual({ ok: true, source: "\\\\u0041" });
  });
  it("keeps braces that are not a JS quantifier literal, for Python and PCRE", () => {
    expect(jsRegexToPython("x{,3}")).toEqual({ ok: true, source: "x\\{,3}" });
    expect(jsRegexToPython("a{2,}b{1}c{1,3}[{]")).toEqual({ ok: true, source: "a{2,}b{1}c{1,3}[{]" });
    expect(jsRegexToPython("{a}\\{")).toEqual({ ok: true, source: "\\{a}\\{" });
    expect(jsRegexToPcre("x{,3}")).toEqual({ ok: true, source: "x\\{,3}" });
  });
  it("pygrep entry refuses non-ASCII patterns and lets $ skip a trailing CR", () => {
    expect(pygrepEntry({ pattern: "[é]" })).toEqual({ ok: false, reason: "non_ascii" });
    expect(pygrepEntry({ pattern: "café", literal: true })).toEqual({ ok: false, reason: "non_ascii" });
    expect(pygrepEntry({ pattern: "foo$|[$]\\$" })).toEqual({ ok: true, entry: "foo(?=\\r?$)|[$]\\$", args: [] });
  });
  it("pygrep entry escapes literals, adds ASCII mode and the case flag", () => {
    expect(pygrepEntry({ pattern: "a.b(", literal: true, flags: "i" })).toEqual({ ok: true, entry: "a\\.b\\(", args: ["--ignore-case"] });
    expect(pygrepEntry({ pattern: "\\d+" })).toEqual({ ok: true, entry: "(?a)\\d+", args: [] });
    expect(pygrepEntry({ pattern: "\\p{L}" }).ok).toBe(false);
  });
});

describe("pathspecs", () => {
  it("follow the glob rules of the checks", () => {
    expect(expandBraces("a/*.{ts,tsx}")).toEqual(["a/*.ts", "a/*.tsx"]);
    expect(expandBraces("{a,b{c,d}}/x")).toEqual(["a/x", "bc/x", "bd/x"]);
    expect(pathspecs(["*.ts", "src/", "./lib/**/*.js"], ["gen\\**"])).toEqual([":(glob)**/*.ts", ":(glob)src/**", ":(glob)lib/**/*.js", ":(glob,exclude)gen/**"]);
  });
});
