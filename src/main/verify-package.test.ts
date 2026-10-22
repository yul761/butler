import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { missingFromPackage } from "../../scripts/verify-package.mjs";
import { afterEach, describe, expect, it } from "vitest";

const WIN_FILES = [
  "win-unpacked/resources/app.asar",
  "win-unpacked/resources/hook/butler-hook.exe",
  "win-unpacked/resources/memory-mcp/statecore-mcp.cjs",
  ...["pty.node", "conpty.node", "conpty_console_list.node", "conpty/conpty.dll", "conpty/OpenConsole.exe", "winpty.dll", "winpty-agent.exe"].map(
    (f) => `win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/${f}`,
  ),
  "Butler Setup 1.0.0.exe",
];

describe("verify-package (Task 7 carry-over: what the NSIS package must contain)", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const make = (files: string[]) => {
    const dist = mkdtempSync(join(tmpdir(), "butler-verify-"));
    dirs.push(dist);
    for (const f of files) {
      mkdirSync(dirname(join(dist, f)), { recursive: true });
      writeFileSync(join(dist, f), "x");
    }
    return dist;
  };

  it("accepts a complete Windows package", () => {
    expect(missingFromPackage("win32", make(WIN_FILES))).toEqual([]);
  });

  it("names the hook, memory MCP and every conpty file that is missing", () => {
    const keep = WIN_FILES.filter((f) => !/butler-hook|OpenConsole|statecore-mcp/.test(f));
    const missing = missingFromPackage("win32", make(keep)).join("\n");
    expect(missing).toContain("butler-hook.exe");
    expect(missing).toContain("OpenConsole.exe");
    expect(missing).toContain("statecore-mcp.cjs");
  });

  it("fails when there is no installer", () => {
    const missing = missingFromPackage("win32", make(WIN_FILES.filter((f) => !f.endsWith("Setup 1.0.0.exe"))));
    expect(missing.join("\n")).toContain("NSIS installer");
  });
});
