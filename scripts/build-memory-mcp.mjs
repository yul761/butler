// 把 Butler 的记忆 MCP server（memory-mcp/entry.ts：MemoryServer + 嵌入式 StateCore）连同依赖打成一个文件。Butler 用自己的 Electron（ELECTRON_RUN_AS_NODE=1）运行它，挂给 claude。
// 同一个目录里还有总控 session 的 butler-sessions MCP server（butler-sessions-mcp.cjs，设计文档 2026-10-23 第二步）
// 和共享 MCP hub（mcp-hub.cjs，WS-M H）。
// 用法：node scripts/build-memory-mcp.mjs [输出文件]，默认 build/memory-mcp/statecore-mcp.cjs。
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "esbuild";

/**
 * esbuild 按 import 语句选 exports 里的 "import" 条件（ESM 的 lib.mjs，里面用 import.meta.url），打成 CJS 后 import.meta.url 是空的。
 * 这个包改按 require 条件解析，用它自己的 CJS 版本（lib.js）。
 */
const requireCondition = (name) => ({
  name: `require-condition:${name}`,
  setup(b) {
    b.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`) }, (args) =>
      args.pluginData === "inner" ? undefined : b.resolve(args.path, { kind: "require-call", resolveDir: args.resolveDir, pluginData: "inner" }));
  },
});

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
  plugins: [requireCondition("statecore-mcp/lib")],
  logLevel: "warning",
});
console.log(`built ${outfile}`);

const sessionsOut = join(dirname(outfile), "butler-sessions-mcp.cjs");
await build({
  entryPoints: ["memory-mcp/sessions-entry.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: sessionsOut,
  logLevel: "warning",
});
console.log(`built ${sessionsOut}`);

// 共享 MCP hub（WS-M H）：记忆和 butler-sessions 都在里面，经本机回环 HTTP 给所有 session 用。
const hubOut = join(dirname(outfile), "mcp-hub.cjs");
await build({
  entryPoints: ["memory-mcp/hub-entry.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: hubOut,
  external: ["@statecore/db"],
  plugins: [requireCondition("statecore-mcp/lib")],
  logLevel: "warning",
});
console.log(`built ${hubOut}`);
