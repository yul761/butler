import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyCsp, CSP_PLACEHOLDER, DEV_CSP, PROD_CSP } from "./csp";

const directives = (csp: string): Record<string, string[]> =>
  Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

describe("renderer CSP (Review Focus 4)", () => {
  it("lets the packaged renderer load only its own files", () => {
    const d = directives(PROD_CSP);
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["script-src"]).toEqual(["'self'"]);
    expect(d["connect-src"]).toEqual(["'self'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'none'"]);
    // xterm 会插入 <style>。
    expect(d["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(PROD_CSP).not.toMatch(/https?:|ws:|unsafe-eval/);
  });

  it("relaxes only what Vite's dev server needs", () => {
    const d = directives(DEV_CSP);
    expect(d["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(d["connect-src"]).toEqual(["'self'", "ws://localhost:*", "http://localhost:*"]);
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(DEV_CSP).not.toMatch(/unsafe-eval/);
  });

  it("is filled into index.html exactly once", () => {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    expect(html.split(CSP_PLACEHOLDER)).toHaveLength(2);
    expect(applyCsp(html, false)).toContain(`content="${PROD_CSP}"`);
    expect(applyCsp(html, true)).toContain(`content="${DEV_CSP}"`);
    expect(() => applyCsp("<html></html>", false)).toThrow();
  });
});
