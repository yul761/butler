import { createHash } from "node:crypto";
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
  mac: {
    identity?: unknown;
    hardenedRuntime?: boolean;
    entitlements?: string;
    entitlementsInherit?: string;
    files?: string[];
    artifactName: string;
    icon?: string;
    target: { target: string; arch: string[] }[];
  };
  dmg: { artifactName: string; sign?: boolean };
  win: { icon?: string; target: { target: string; arch: string[] }[] };
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
    expect(cfg.productName).toBe("Shipherd");
  });

  it("never publishes, signs macOS in after-pack or electron-builder, and keeps RunAsNode available for the memory MCP", () => {
    expect(cfg.publish).toBeNull();
    // BTL-258：以前是 identity: null（永远不让 electron-builder 签名）。现在不写 identity：有 CSC_LINK 时 electron-builder 用
    // Developer ID 签名，没有时 after-pack.cjs 做 ad-hoc 签名（scripts/mac-signing.cjs 判断，见 mac-signing.test.ts）。
    expect(cfg.mac).not.toHaveProperty("identity");
    expect(cfg.afterPack).toBe("scripts/after-pack.cjs");
    expect(cfg.electronFuses?.runAsNode).not.toBe(false);
    // 不配置 fuses：记忆 MCP 靠 ELECTRON_RUN_AS_NODE 运行。以后真要加 fuses，改这条断言时 runAsNode 必须保持 true。
    expect(cfg.electronFuses).toBeUndefined();
    expect(existsSync(`${root}${cfg.afterPack}`)).toBe(true);
  });

  it("signs the Developer ID build with the hardened runtime and only the entitlements it needs (BTL-258)", () => {
    expect(cfg.mac.hardenedRuntime).toBe(true);
    expect(cfg.mac.entitlements).toBe("build-resources/entitlements.mac.plist");
    // 包里的 helper、node-pty、shipherd-hook 和主程序用同一份：它们都跑 V8 或 Node。
    expect(cfg.mac.entitlementsInherit).toBe(cfg.mac.entitlements);
    expect(cfg.dmg.sign).toBe(true);
    const plist = read(String(cfg.mac.entitlements));
    const keys = [...plist.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1]);
    expect(keys).toEqual(["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory"]);
    // 每个 Mach-O 都是同一个 Team ID 签的，不需要关库验证；也不需要调试、注入环境变量、摄像头之类。
    expect(plist.replace(/<!--[\s\S]*?-->/g, "")).not.toMatch(/disable-library-validation|allow-dyld-environment-variables|get-task-allow|<false\/>/);
  });

  it("leaves other platforms' node-pty prebuilds out of the Apple silicon app (they would have to be signed and notarized)", () => {
    expect(cfg.mac.files).toEqual(["!**/node_modules/node-pty/prebuilds/win32-*/**", "!**/node_modules/node-pty/prebuilds/darwin-x64/**"]);
  });

  it("uses the Shipherd icon (direction E1) on both platforms, not the default Electron one", () => {
    expect(cfg.mac.icon).toBe("build-resources/icon.png");
    expect(cfg.win.icon).toBe("build-resources/icon.ico");
    for (const f of [cfg.mac.icon, cfg.win.icon]) expect(existsSync(`${root}${String(f)}`), f).toBe(true);
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
        expect.objectContaining({ from: "build/memory-mcp", to: "memory-mcp", filter: ["statecore-mcp.cjs", "shipherd-sessions-mcp.cjs", "mcp-hub.cjs"] }),
      ]),
    );
    expect(cfg.asarUnpack).toContain("**/node_modules/node-pty/**");
    // 主进程按 process.resourcesPath/hook/shipherd-hook[.exe] 和 process.resourcesPath/memory-mcp/statecore-mcp.cjs 找（index.ts）。
    const byFrom = (from: string) => cfg.extraResources.find((r) => r.from === from);
    expect(byFrom("build/hook")).toEqual({ from: "build/hook", to: "hook", filter: ["shipherd-hook", "shipherd-hook.exe"] });
    expect(byFrom("build/memory-mcp")).toEqual({ from: "build/memory-mcp", to: "memory-mcp", filter: ["statecore-mcp.cjs", "shipherd-sessions-mcp.cjs", "mcp-hub.cjs"] });
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
      artifactName: "Shipherd-Setup-${version}.${ext}",
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      include: "build-resources/installer.nsh",
    });
  });

  // BTL-260：appId 改了，NSIS 的卸载注册表项 GUID 也跟着变；installer.nsh 要按旧 appId 的 GUID 找旧 Butler。
  it("detects the pre-rename Butler install by the uninstall key electron-builder derived from the old appId", () => {
    const uuidV5 = (name: string, ns: string): string => {
      const h = createHash("sha1").update(Buffer.concat([Buffer.from(ns.replace(/-/g, ""), "hex"), Buffer.from(name)])).digest();
      h[6] = (h[6] & 0x0f) | 0x50;
      h[8] = (h[8] & 0x3f) | 0x80;
      const x = h.subarray(0, 16).toString("hex");
      return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
    };
    // electron-builder（app-builder-lib NsisTarget）的命名空间。
    const NS = "50e065bc-3134-11e6-9bab-38c9862bdaf3";
    const nsh = read("build-resources/installer.nsh");
    expect(nsh).toContain(`!define LEGACY_BUTLER_GUID "${uuidV5("io.statecore.butler", NS)}"`);
    expect(uuidV5("io.statecore.butler", NS)).not.toBe(uuidV5(cfg.appId, NS));
    expect(nsh).toMatch(/!macro customInit[\s\S]*MessageBox MB_YESNO[^\n]*\/SD IDNO[\s\S]*!macroend/);
    expect(existsSync(`${root}${cfg.nsis.include as string}`)).toBe(true);
  });

  it("names the installers without spaces, as the README and the CI upload globs expect", () => {
    // GitHub turns spaces in release asset names into dots, so "Shipherd Setup 1.0.0.exe" would not match the README.
    expect(cfg.nsis.artifactName).toBe("Shipherd-Setup-${version}.${ext}");
    expect(cfg.dmg.artifactName).toBe("Shipherd-${version}-${arch}.${ext}");
    expect(cfg.mac.artifactName).toBe("Shipherd-${version}-${arch}-mac.${ext}");
    const readme = read("README.md");
    for (const name of ["Shipherd-x.y.z-arm64.dmg", "Shipherd-x.y.z-arm64-mac.zip", "Shipherd-Setup-x.y.z.exe"]) expect(readme, name).toContain(name);
    expect(readme).not.toContain("Shipherd Setup");
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
