// build-check-runtime.mjs 和它的测试共用：怎么打包、生成的文件长什么样。
import { build } from "esbuild";

export const ENTRY = "src/main/baselines/export/runtime-entry.ts";
export const GENERATED_PATH = "src/main/baselines/export/node-runtime.generated.ts";

export async function bundleCheckRuntime(cwd = process.cwd()) {
  const r = await build({
    absWorkingDir: cwd, entryPoints: [ENTRY], bundle: true, platform: "node", format: "esm", target: "node18", write: false, legalComments: "none", charset: "utf8",
    banner: { js: "" },
  });
  // 去掉 esbuild 标的源文件路径注释（各平台写法不一样，也不需要）。
  return r.outputFiles[0].text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => !/^\/\/ .*\.(ts|mjs|js)$/.test(l))
    .join("\n");
}

export function renderGenerated(code) {
  return [
    "// 生成的文件，不要手改：node scripts/build-check-runtime.mjs（见 scripts/check-runtime-bundle.mjs）。",
    "// 导出成 lint 时写进仓库的 Node 检查脚本的主体；前面加上 `const CHECK = {...};` 就能直接跑。",
    `export const NODE_RUNTIME: string = ${JSON.stringify(code)};`,
    "",
  ].join("\n");
}
