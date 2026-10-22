// 把 statecore-mcp 的 MCP server 连同依赖打成一个文件。Butler 用自己的 Electron（ELECTRON_RUN_AS_NODE=1）运行它，挂给 claude。
// 用法：node scripts/build-memory-mcp.mjs [输出文件]，默认 build/memory-mcp/statecore-mcp.cjs。
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { build } from "esbuild";

const outfile = process.argv[2] ?? "build/memory-mcp/statecore-mcp.cjs";
mkdirSync(dirname(outfile), { recursive: true });
await build({
  entryPoints: ["memory-mcp/entry.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile,
  // statecore-mcp 自己打包时也把它留在外面：@statecore/core 里一个嵌入式后端永远走不到的懒加载 import。
  external: ["@statecore/db"],
  logLevel: "warning",
});
console.log(`built ${outfile}`);
