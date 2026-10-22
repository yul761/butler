import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EDITABLE_SETTINGS } from "../shared/settings";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (f: string) => readFileSync(`${root}${f}`, "utf8");

describe("open-source docs (design 12)", () => {
  it("documents every setting a user can change", () => {
    const doc = read("docs/configuration.md");
    for (const key of EDITABLE_SETTINGS) expect(doc, key).toContain(`\`${key}\``);
  });

  it("explains how to open the unsigned build and what not to install alongside", () => {
    const readme = read("README.md");
    for (const s of ["Gatekeeper", "SmartScreen", "xattr -dr com.apple.quarantine", "~/.butler", "StateCore", "docs/configuration.md", "CONTRIBUTING.md"]) {
      expect(readme, s).toContain(s);
    }
  });

  it("is MIT licensed", () => {
    const license = read("LICENSE");
    expect(license.startsWith("MIT License")).toBe(true);
    expect(license).toContain("Copyright (c) 2026 Yuchen Lin");
  });

  it("tells contributors which toolchain to install", () => {
    const c = read("CONTRIBUTING.md");
    for (const s of [".node-version", "pnpm", "Xcode Command Line Tools", "Desktop development with C++", "Git Bash", "pnpm e2e", "PrivacyGateway"]) expect(c, s).toContain(s);
  });

  it("only links to files that exist in the repository", () => {
    for (const doc of ["README.md", "CONTRIBUTING.md", "docs/configuration.md"]) {
      const text = read(doc);
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
        const path = join(root, dirname(doc), target.split("#")[0]);
        expect(existsSync(path), `${doc} → ${target}`).toBe(true);
      }
    }
  });
});
