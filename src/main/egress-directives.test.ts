import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const EGRESS_RULES = ["no-restricted-globals", "no-restricted-imports", "no-restricted-syntax", "no-restricted-properties"];
const GATEWAY = join("src", "main", "gateway") + sep;
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "out" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE.test(entry.name)) out.push(full);
  }
  return out;
}

/** 返回会让出口规则失效的 eslint 注释：没写规则名的（全关），或点名出口规则的。 */
export function silencingDirectives(text: string): string[] {
  const found: string[] = [];
  const re = /eslint-disable(?:-next-line|-line)?(?![\w-])([^\n]*)/g;
  for (const m of text.matchAll(re)) {
    const list = m[1].replace(/\*\/.*$/, "").split(/\s--\s/)[0].trim();
    if (list === "" || EGRESS_RULES.some((rule) => list.split(/[\s,]+/).includes(rule))) found.push(m[0].trim());
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
