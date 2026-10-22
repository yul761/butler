import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { APP_ID } from "./app-id";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (f: string) => readFileSync(`${root}${f}`, "utf8");

interface BuilderConfig {
  appId: string;
  productName: string;
  publish: unknown;
  afterPack: string;
  asarUnpack: string[];
  extraResources: { from: string; to: string; filter: string[] }[];
  electronFuses?: Record<string, boolean>;
  mac: { identity: unknown; target: { target: string; arch: string[] }[] };
  win: { target: { target: string; arch: string[] }[] };
}

describe("packaging config (design 2.1, 12)", () => {
  const cfg = parse(read("electron-builder.yml")) as BuilderConfig;
  const pkg = JSON.parse(read("package.json")) as { version: string; main: string; author: string; scripts: Record<string, string> };

  it("uses the same app id as the Windows notification identity", () => {
    expect(cfg.appId).toBe(APP_ID);
    expect(cfg.productName).toBe("Butler");
  });

  it("is unsigned, never publishes, and keeps RunAsNode available for the memory MCP", () => {
    expect(cfg.publish).toBeNull();
    expect(cfg.mac.identity).toBeNull();
    expect(cfg.afterPack).toBe("scripts/after-pack.cjs");
    expect(cfg.electronFuses?.runAsNode).not.toBe(false);
  });

  it("ships the hook, the memory MCP and an unpacked node-pty", () => {
    expect(cfg.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "build/hook", to: "hook" }),
        expect.objectContaining({ from: "build/memory-mcp", to: "memory-mcp", filter: ["statecore-mcp.cjs"] }),
      ]),
    );
    expect(cfg.asarUnpack).toContain("**/node_modules/node-pty/**");
  });

  it("builds a dmg and zip for Apple silicon and an NSIS installer for x64 Windows", () => {
    expect(cfg.mac.target).toEqual([{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] }]);
    expect(cfg.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
  });

  it("has release metadata and scripts", () => {
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.main).toBe("out/main/index.js");
    expect(pkg.author).toBe("Yuchen Lin");
    expect(pkg.scripts.dist).toBe("electron-builder --publish never");
    expect(pkg.scripts["dist:dir"]).toBe("electron-builder --dir --publish never");
  });
});
