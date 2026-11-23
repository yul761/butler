import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EDITABLE_SETTINGS } from "../shared/settings";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (f: string) => readFileSync(`${root}${f}`, "utf8");

/** GitHub 的标题锚点：小写，去掉标点和符号（保留字母、数字、CJK、空格、_ 和 -），空格换成 -，重名的依次加 -1、-2。代码块里的行不算标题。 */
function headingAnchors(markdown: string): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = fenced ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = m[1].trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "").replace(/ /g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** 每一行的标题层级（# 的个数），代码块里的不算：中英两份文档的标题要一一对应。 */
function headingLevels(markdown: string): number[] {
  const out: number[] = [];
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = fenced ? null : /^(#{1,6})\s+\S/.exec(line);
    if (m) out.push(m[1].length);
  }
  return out;
}

/** 面向用户的文档都是英文一份、中文一份（.zh-CN.md）。 */
const DOC_PAIRS = [
  ["README.md", "README.zh-CN.md"],
  ["CONTRIBUTING.md", "CONTRIBUTING.zh-CN.md"],
  ["docs/configuration.md", "docs/configuration.zh-CN.md"],
  ["docs/demo-media.md", "docs/demo-media.zh-CN.md"],
  ["docs/how-it-works.md", "docs/how-it-works.zh-CN.md"],
  ["docs/compare.md", "docs/compare.zh-CN.md"],
  ["docs/upgrading-from-butler.md", "docs/upgrading-from-butler.zh-CN.md"],
] as const;

describe("open-source docs (design 12)", () => {
  it("documents every setting a user can change, in both languages", () => {
    for (const doc of ["docs/configuration.md", "docs/configuration.zh-CN.md"]) {
      const text = read(doc);
      for (const key of EDITABLE_SETTINGS) expect(text, `${doc}: ${key}`).toContain(`\`${key}\``);
    }
  });

  it("explains how to open the unsigned Windows build, in both READMEs", () => {
    const required = (zh: boolean) => [
      "SmartScreen",
      zh ? "macOS 版用 Developer ID 签名并通过 Apple 公证，双击即可打开" : "The macOS build is signed with Developer ID and notarized by Apple, so it opens with a double-click",
      "~/.shipherd",
      zh ? "docs/configuration.zh-CN.md" : "docs/configuration.md",
      zh ? "CONTRIBUTING.zh-CN.md" : "CONTRIBUTING.md",
    ];
    for (const [doc, zh] of [["README.md", false], ["README.zh-CN.md", true]] as const) {
      const readme = read(doc);
      for (const s of required(zh)) expect(readme, `${doc}: ${s}`).toContain(s);
      // BTL-259: since 4.1.2 the macOS build is signed and notarized, so the READMEs no longer teach getting past Gatekeeper.
      for (const s of ["Gatekeeper", "xattr", "com.apple.quarantine"]) expect(readme, `${doc}: ${s}`).not.toContain(s);
    }
  });

  it("warns against StateCore's own capture plugin in How it works, not in the READMEs", () => {
    for (const [doc, s] of [["docs/how-it-works.md", "Do not also install StateCore's own Claude Code capture plugin"], ["docs/how-it-works.zh-CN.md", "不要再另外安装 StateCore 自己的 Claude Code 采集插件"]] as const) {
      expect(read(doc), doc).toContain(s);
    }
    for (const doc of ["README.md", "README.zh-CN.md"]) expect(read(doc), doc).not.toMatch(/capture plugin|采集插件/);
  });

  it("keeps the Butler upgrade steps in their own doc, linked from both READMEs", () => {
    expect(read("README.md")).toContain("](docs/upgrading-from-butler.md)");
    expect(read("README.zh-CN.md")).toContain("](docs/upgrading-from-butler.zh-CN.md)");
    for (const doc of ["README.md", "README.zh-CN.md"]) expect(read(doc), doc).not.toContain("BUTLER_HOME");
  });

  it("says what Shipherd is on the README's first screen, above everything but the quick start", () => {
    const cases = [
      { doc: "README.md", line: "Talk to one coordinator. It runs your Claude Code sessions and only pings you when it's your turn.", gif: "docs/media/demo.gif", docs: ["docs/how-it-works.md", "docs/compare.md", "docs/configuration.md"] },
      { doc: "README.zh-CN.md", line: "和一个总控对话。它替你管好各个 Claude Code session，只在轮到你的时候叫你。", gif: "docs/media/demo.zh-CN.gif", docs: ["docs/how-it-works.zh-CN.md", "docs/compare.zh-CN.md", "docs/configuration.zh-CN.md"] },
    ];
    for (const c of cases) {
      const text = read(c.doc);
      // 首屏：第一个不是「快速开始」的二级标题之前。
      const firstScreen = text.slice(0, text.search(/^## (?!Quick start|快速开始)/m));
      for (const s of [c.line, `](${c.gif})`, "https://github.com/yul761/shipherd/releases/latest", "MIT", ...c.docs.map((d) => `](${d})`)]) {
        expect(firstScreen, `${c.doc}: ${s}`).toContain(s);
      }
      expect(text, c.doc).not.toMatch(/^## (New in|.*新增)/m);
    }
  });

  it("keeps each English doc and its Chinese twin one click apart, with the same heading outline", () => {
    for (const [en, zh] of DOC_PAIRS) {
      const name = (f: string) => f.slice(f.lastIndexOf("/") + 1);
      expect(read(en), en).toContain(`](${name(zh)})`);
      expect(read(zh), zh).toContain(`](${name(en)})`);
      expect(headingLevels(read(zh)), `${zh} vs ${en}`).toEqual(headingLevels(read(en)));
    }
  });

  it("is MIT licensed", () => {
    const license = read("LICENSE");
    expect(license.startsWith("MIT License")).toBe(true);
    expect(license).toContain("Copyright (c) 2026 Yuchen Lin");
  });

  it("tells contributors which toolchain to install, in both languages", () => {
    for (const doc of ["CONTRIBUTING.md", "CONTRIBUTING.zh-CN.md"]) {
      const c = read(doc);
      for (const s of [".node-version", "pnpm", "Xcode Command Line Tools", "Desktop development with C++", "Git Bash", "pnpm e2e", "loopback-recorder", "egress-lint.test.ts"]) expect(c, `${doc}: ${s}`).toContain(s);
    }
  });

  it("slugs headings the way GitHub does", () => {
    const md = ["# Shipherd", "## Privacy model", "## 记忆（StateCore）(Memory)", "## `code` & more!", "```sh", "# not a heading", "```", "## Privacy model"].join("\n");
    expect(headingAnchors(md)).toEqual(["shipherd", "privacy-model", "记忆statecorememory", "code--more", "privacy-model-1"]);
  });

  it("only links to files and headings that exist", () => {
    for (const doc of DOC_PAIRS.flat()) {
      for (const [, target] of read(doc).matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/i.test(target)) continue;
        const [file, anchor] = target.split("#");
        const linked = file ? join(dirname(doc), file) : doc;
        expect(existsSync(join(root, linked)), `${doc} → ${target}`).toBe(true);
        if (anchor !== undefined && linked.endsWith(".md")) {
          expect(headingAnchors(read(linked)), `${doc} → ${target}`).toContain(decodeURIComponent(anchor));
        }
      }
    }
  });
});
