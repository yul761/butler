// electron-builder 的 afterPack（计划 5 任务 7），在生成 dmg / 安装程序之前执行：
// 1. 检查 hook 和记忆 MCP 都放进了 resources、node-pty 在 asar 外面；
// 2. macOS：node-pty 的 spawn-helper 和 butler-hook 要有执行位（pnpm 装的 prebuilds 里 spawn-helper 没有，计划 1 Task 1）；
// 3. macOS：ad-hoc 签名整个 app——electron-builder 改过 Info.plist，原来的签名失效，arm64 上没有签名的 app 无法启动。
const { execFileSync } = require("node:child_process");
const { chmodSync, existsSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

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
  const hook = join(resources, "hook", mac ? "butler-hook" : "butler-hook.exe");
  for (const f of [hook, join(resources, "memory-mcp", "statecore-mcp.cjs")]) {
    if (!existsSync(f)) throw new Error(`missing ${f}: run pnpm build && pnpm build:hook before packaging`);
  }
  const pty = join(resources, "app.asar.unpacked", "node_modules", "node-pty");
  if (!existsSync(pty)) throw new Error(`node-pty is not unpacked at ${pty}`);
  if (!mac) return;
  const helpers = findAll(pty, "spawn-helper");
  if (helpers.length === 0) throw new Error("no spawn-helper found in node-pty");
  for (const h of helpers) chmodSync(h, 0o755);
  chmodSync(hook, 0o755);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
