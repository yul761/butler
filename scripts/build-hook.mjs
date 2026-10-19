// 把 hook 打成不依赖系统 Node 的单文件可执行程序（Node SEA）。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

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
