// 给 claude 挂载的记忆 MCP server（设计文档 8.4），经 stdio。用法：statecore-mcp.cjs --data <StateCore 数据目录>，作用域在 STATECORE_SCOPE。
// BTL-243 起不再加载 statecore-mcp 的 bin（它的说明许诺后台蒸馏）：和共享 MCP 的 hub 一样用 Butler 自己的 MemoryServer，
// 后端是嵌入式 StateCore，backgroundDigest: false。
// 顺序就是执行顺序（ES 模块按 import 的先后求值，esbuild 打包后保持不变）：先清掉环境变量里的模型 key（R1），再加载 StateCore。
import "./clean-env";
import { createEmbeddedBackend } from "statecore-mcp/lib";
import { MemoryServer } from "./memory-tools";
import { serveStdio } from "./stdio";

const i = process.argv.indexOf("--data");
const dataDir = i >= 0 ? process.argv[i + 1] : undefined;
const scope = process.env.STATECORE_SCOPE?.trim();
if (!dataDir || !scope) {
  process.stderr.write("butler-memory: --data <dir> and STATECORE_SCOPE are required\n");
  process.exit(2);
}

const backend = createEmbeddedBackend({ dataDir, scopeName: scope, env: process.env, backgroundDigest: false });
// 第一次调用工具时才打开数据库：握手和列工具不碰它（和 hub 一样）。
// 打开失败的不留着（比如主进程同时在写，等过了 busy_timeout）：下次调用工具时重新开，和 hub 一样。
let ready: Promise<typeof backend> | null = null;
const open = () => {
  if (!ready) {
    const p = backend.init().then(() => backend);
    ready = p;
    p.catch((e: unknown) => {
      process.stderr.write(`butler-memory: memory did not open: ${e instanceof Error ? e.message : String(e)}\n`);
      if (ready === p) ready = null;
    });
  }
  return ready;
};
serveStdio(new MemoryServer(open), process.stdin, process.stdout);
// claude 退出时关掉 stdin：关数据库，跟着退出，不留下孤儿进程。
process.stdin.on("end", () => {
  void (ready ?? Promise.resolve(null))
    .then((b) => b?.close())
    .catch(() => undefined)
    .finally(() => process.exit(0));
});
