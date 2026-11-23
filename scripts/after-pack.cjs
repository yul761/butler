// electron-builder 的 afterPack（计划 5 任务 7），在生成 dmg / 安装程序之前执行：
// 1. 检查 hook 和记忆 MCP 都放进了 resources、node-pty 在 asar 外面；
// 2. macOS：node-pty 的 spawn-helper 和 shipherd-hook 要有执行位（pnpm 装的 prebuilds 里 spawn-helper 没有，计划 1 Task 1）；
// 3. macOS 没有签名证书时（mac-signing.cjs 判断为 ad-hoc）：ad-hoc 签名整个 app——electron-builder 改过 Info.plist，原来的签名失效，
//    arm64 上没有签名的 app 无法启动；再关掉 electron-builder 自己找证书，保证不会被签第二遍。
//    有证书时（builder）这里不签，交给 electron-builder 用 Developer ID 签名（hardened runtime）并公证（BTL-258）。
const { execFileSync } = require("node:child_process");
const { chmodSync, existsSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { macSigningMode } = require("./mac-signing.cjs");

function findAll(dir, name, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) findAll(p, name, out);
    else if (entry === name) out.push(p);
  }
  return out;
}

exports.default = async function afterPack(context) {
  const mac = context.electronPlatformName === "darwin";
  const appPath = mac ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`) : context.appOutDir;
  const resources = mac ? join(appPath, "Contents", "Resources") : join(appPath, "resources");
  const hook = join(resources, "hook", mac ? "shipherd-hook" : "shipherd-hook.exe");
  for (const f of [hook, ...["statecore-mcp.cjs", "shipherd-sessions-mcp.cjs", "mcp-hub.cjs"].map((n) => join(resources, "memory-mcp", n))]) {
    if (!existsSync(f)) throw new Error(`missing ${f}: run pnpm build && pnpm build:hook before packaging`);
  }
  const pty = join(resources, "app.asar.unpacked", "node_modules", "node-pty");
  if (!existsSync(pty)) throw new Error(`node-pty is not unpacked at ${pty}`);
  if (!mac) return;
  const helpers = findAll(pty, "spawn-helper");
  if (helpers.length === 0) throw new Error("no spawn-helper found in node-pty");
  for (const h of helpers) chmodSync(h, 0o755);
  chmodSync(hook, 0o755);
  signMacApp({ appPath, env: process.env, identity: context.packager.platformSpecificBuildOptions.identity, exec: execFileSync });
};

/**
 * 两种签名只走一种：有证书时什么都不做，交给 electron-builder；没有时 ad-hoc 签名，并关掉 electron-builder 自己找证书。
 * @returns {"builder" | "ad-hoc"}
 */
function signMacApp({ appPath, env, identity, exec }) {
  const { mode, problem } = macSigningMode({ env, identity });
  if (problem) throw new Error(problem);
  if (mode === "builder") {
    console.log("  • after-pack: a signing identity is configured; electron-builder signs the app (no ad-hoc signature)");
    return mode;
  }
  exec("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  // electron-builder 签名时按这个变量决定要不要去钥匙串里自动找 Developer ID（本机钥匙串里可能就有一个）：
  // ad-hoc 签过了，就不能再让它找到一个签第二遍。
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  return mode;
}
exports.signMacApp = signMacApp;
