// 检查 pnpm dist 的产物真的带上了该带的东西（计划 5 任务 10，承接任务 7 的遗留项）。
// 用法：node scripts/verify-package.mjs [dist 目录]，按当前平台检查 win-unpacked 或 mac-arm64/Butler.app 和安装包。
// 缺任何一项就列出来并以非零退出码结束；CI 在 pnpm dist 之后运行它。
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function expectedFiles(platform, resources) {
  const unpacked = join(resources, "app.asar.unpacked", "node_modules", "node-pty");
  const common = [join(resources, "memory-mcp", "statecore-mcp.cjs"), join(resources, "app.asar")];
  if (platform === "win32") {
    const pre = join(unpacked, "prebuilds", "win32-x64");
    return [
      ...common,
      join(resources, "hook", "butler-hook.exe"),
      // conpty 后端：原生模块、控制台列表模块、以及 conpty/ 里的 conpty.dll 和 OpenConsole.exe；winpty 是旧系统的回退。
      join(pre, "pty.node"),
      join(pre, "conpty.node"),
      join(pre, "conpty_console_list.node"),
      join(pre, "conpty", "conpty.dll"),
      join(pre, "conpty", "OpenConsole.exe"),
      join(pre, "winpty.dll"),
      join(pre, "winpty-agent.exe"),
    ];
  }
  const pre = join(unpacked, "prebuilds", "darwin-arm64");
  return [...common, join(resources, "hook", "butler-hook"), join(pre, "pty.node"), join(pre, "spawn-helper")];
}

/** 返回缺失项（字符串数组）；空数组表示齐全。 */
export function missingFromPackage(platform, distDir) {
  const mac = platform !== "win32";
  const appDir = mac ? join(distDir, "mac-arm64", "Butler.app") : join(distDir, "win-unpacked");
  const resources = mac ? join(appDir, "Contents", "Resources") : join(appDir, "resources");
  const missing = expectedFiles(platform, resources).filter((f) => !existsSync(f));
  const installers = existsSync(distDir) ? readdirSync(distDir).filter((f) => (mac ? /\.(dmg|zip)$/ : /\.exe$/).test(f) && statSync(join(distDir, f)).size > 0) : [];
  if (installers.length === 0) missing.push(join(distDir, mac ? "*.dmg / *.zip" : "*.exe (NSIS installer)"));
  return missing;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = process.argv[2] ?? "dist";
  const missing = missingFromPackage(process.platform, dist);
  if (missing.length > 0) {
    console.error(`package is missing ${missing.length} expected item(s):\n${missing.map((m) => `  ${m}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`package contents ok (${process.platform}, ${dist})`);
}
