import { existsSync, readFileSync } from "node:fs";
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
  files: string[];
  extraResources: { from: string; to: string; filter: string[] }[];
  electronFuses?: Record<string, boolean>;
  mac: { identity: unknown; artifactName: string; target: { target: string; arch: string[] }[] };
  dmg: { artifactName: string };
  win: { target: { target: string; arch: string[] }[] };
  nsis: Record<string, unknown>;
}

describe("packaging config (design 2.1, 12)", () => {
  const cfg = parse(read("electron-builder.yml")) as BuilderConfig;
  const pkg = JSON.parse(read("package.json")) as {
    version: string;
    main: string;
    author: string;
    scripts: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it("uses the same app id as the Windows notification identity", () => {
    expect(cfg.appId).toBe(APP_ID);
    expect(cfg.productName).toBe("Butler");
  });

  it("is unsigned, never publishes, and keeps RunAsNode available for the memory MCP", () => {
    expect(cfg.publish).toBeNull();
    expect(cfg.mac.identity).toBeNull();
    expect(cfg.afterPack).toBe("scripts/after-pack.cjs");
    expect(cfg.electronFuses?.runAsNode).not.toBe(false);
    // 不配置 fuses：记忆 MCP 靠 ELECTRON_RUN_AS_NODE 运行。以后真要加 fuses，改这条断言时 runAsNode 必须保持 true。
    expect(cfg.electronFuses).toBeUndefined();
    expect(existsSync(`${root}${cfg.afterPack}`)).toBe(true);
  });

  it("has no auto-update (Ruling P5-R4): no electron-updater and the dist scripts never publish", () => {
    expect(cfg.publish).toBeNull();
    expect(pkg.dependencies ?? {}).not.toHaveProperty("electron-updater");
    expect(pkg.devDependencies ?? {}).not.toHaveProperty("electron-updater");
    expect(pkg.scripts.dist).toContain("--publish never");
    expect(pkg.scripts["dist:dir"]).toContain("--publish never");
  });

  it("ships the hook, the memory MCP and an unpacked node-pty", () => {
    expect(cfg.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "build/hook", to: "hook" }),
        expect.objectContaining({ from: "build/memory-mcp", to: "memory-mcp", filter: ["statecore-mcp.cjs"] }),
      ]),
    );
    expect(cfg.asarUnpack).toContain("**/node_modules/node-pty/**");
    // 主进程按 process.resourcesPath/hook/butler-hook[.exe] 和 process.resourcesPath/memory-mcp/statecore-mcp.cjs 找（index.ts）。
    const byFrom = (from: string) => cfg.extraResources.find((r) => r.from === from);
    expect(byFrom("build/hook")).toEqual({ from: "build/hook", to: "hook", filter: ["butler-hook", "butler-hook.exe"] });
    expect(byFrom("build/memory-mcp")).toEqual({ from: "build/memory-mcp", to: "memory-mcp", filter: ["statecore-mcp.cjs"] });
  });

  it("ships the built app but not source maps", () => {
    expect(cfg.files).toEqual(expect.arrayContaining(["out/**/*", "package.json", "!**/*.map"]));
  });

  it("builds a dmg and zip for Apple silicon and an NSIS installer for x64 Windows", () => {
    expect(cfg.mac.target).toEqual([{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] }]);
    expect(cfg.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
  });

  it("pins the NSIS install behaviour: per-user, both shortcuts, user data kept on uninstall", () => {
    expect(cfg.nsis).toEqual({
      artifactName: "Butler-Setup-${version}.${ext}",
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
    });
  });

  it("names the installers without spaces, as the README and the CI upload globs expect", () => {
    // GitHub turns spaces in release asset names into dots, so "Butler Setup 1.0.0.exe" would not match the README.
    expect(cfg.nsis.artifactName).toBe("Butler-Setup-${version}.${ext}");
    expect(cfg.dmg.artifactName).toBe("Butler-${version}-${arch}.${ext}");
    expect(cfg.mac.artifactName).toBe("Butler-${version}-${arch}-mac.${ext}");
    const readme = read("README.md");
    for (const name of ["Butler-x.y.z-arm64.dmg", "Butler-x.y.z-arm64-mac.zip", "Butler-Setup-x.y.z.exe"]) expect(readme, name).toContain(name);
    expect(readme).not.toContain("Butler Setup");
  });

  it("has release metadata and scripts", () => {
    // 发布的版本号：普通的 x.y.z（release.yml 要求 tag 和它一致）。
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.main).toBe("out/main/index.js");
    expect(pkg.author).toBe("Yuchen Lin");
    expect(pkg.scripts.dist).toBe("electron-builder --publish never");
    expect(pkg.scripts["dist:dir"]).toBe("electron-builder --dir --publish never");
  });
});
