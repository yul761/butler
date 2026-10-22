import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const EGRESS_RULES = ["no-restricted-globals", "no-restricted-imports", "no-restricted-syntax", "no-restricted-properties"];
const GATEWAY = join("src", "main", "gateway") + sep;
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "out" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * 返回会让出口规则失效的 eslint 注释：没写规则名的 eslint-disable（全关）、点名出口规则的 eslint-disable，
 * 以及点名出口规则的 `eslint rule: off` 行内配置。块注释按整段（含多行）读取。
 */
export function silencingDirectives(text: string): string[] {
  const found: string[] = [];
  const comments = [...text.matchAll(/\/\*([\s\S]*?)\*\//g)].map((m) => ({ body: m[1], block: true }));
  for (const m of text.matchAll(/\/\/([^\n]*)/g)) comments.push({ body: m[1], block: false });
  for (const { body, block } of comments) {
    const trimmed = body.trim();
    const disable = /^eslint-disable(?:-next-line|-line)?(?![\w-])([\s\S]*)$/.exec(trimmed);
    if (disable) {
      const list = disable[1].split(/\s--\s/)[0].trim();
      if (list === "" || EGRESS_RULES.some((rule) => list.split(/[\s,]+/).includes(rule))) found.push(trimmed);
    } else if (block && /^eslint\s/.test(trimmed) && EGRESS_RULES.some((rule) => trimmed.includes(rule))) {
      found.push(trimmed);
    }
  }
  return found;
}

describe("egress lint rule cannot be silenced by comments", () => {
  it("detects bare and egress-rule disables", () => {
    expect(silencingDirectives("// eslint-disable-next-line no-restricted-globals\nfetch(1)")).toHaveLength(1);
    expect(silencingDirectives("/* eslint-disable */")).toHaveLength(1);
    expect(silencingDirectives("// eslint-disable-line")).toHaveLength(1);
    expect(silencingDirectives("// eslint-disable-next-line no-control-regex, no-restricted-imports")).toHaveLength(1);
    expect(silencingDirectives("// eslint-disable-next-line no-control-regex")).toHaveLength(0);
    expect(silencingDirectives("/* eslint no-restricted-globals: off */")).toHaveLength(1);
    expect(silencingDirectives("/* eslint no-restricted-globals: 0 */")).toHaveLength(1);
    expect(silencingDirectives('/* eslint "no-restricted-syntax": "off" */')).toHaveLength(1);
    expect(silencingDirectives("/* eslint-disable no-control-regex,\n   no-restricted-imports */")).toHaveLength(1);
    expect(silencingDirectives("/* eslint-disable\n   no-restricted-properties */")).toHaveLength(1);
    expect(silencingDirectives("/* eslint eqeqeq: off */")).toHaveLength(0);
  });

  it("no file outside src/main/gateway disables it", () => {
    const offenders: string[] = [];
    for (const dir of ["src", "hook", "scripts"]) {
      for (const file of walk(join(root, dir))) {
        const rel = relative(root, file);
        if (rel.startsWith(GATEWAY) || rel.endsWith("egress-directives.test.ts")) continue;
        for (const d of silencingDirectives(readFileSync(file, "utf8"))) offenders.push(`${rel}: ${d}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
