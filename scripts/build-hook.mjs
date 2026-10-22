// 把 hook 打成不依赖系统 Node 的单文件可执行程序（Node SEA）。需要支持 --build-sea 的 Node（见 .node-version）。
// 用法：node scripts/build-hook.mjs [--check-only]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const help = execFileSync(process.execPath, ["--help"], { encoding: "utf8" });
if (!help.includes("--build-sea")) {
  console.error(`build:hook 需要支持 --build-sea 的 Node（当前 ${process.version}）。请换成 .node-version 里写的版本，例如 nvm install && nvm use。`);
  process.exit(1);
}
if (process.argv.includes("--check-only")) process.exit(0);

const outDir = "build/hook";
const bundle = `${outDir}/butler-hook.cjs`;
const exe = process.platform === "win32" ? `${outDir}/butler-hook.exe` : `${outDir}/butler-hook`;
mkdirSync(outDir, { recursive: true });

await build({ entryPoints: ["hook/entry.ts"], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: bundle });

const config = `${outDir}/sea-config.json`;
writeFileSync(config, JSON.stringify({ main: bundle, output: exe, disableExperimentalSEAWarning: true, useCodeCache: false }));
execFileSync(process.execPath, ["--build-sea", config], { stdio: "inherit" });

if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", "--force", exe], { stdio: "inherit" });
console.log(`built ${exe}`);
