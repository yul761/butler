// 共享 MCP hub（WS-M H，设计文档 2026-11-17 §8）：一个进程经本机回环 HTTP 给所有 session 提供 Shipherd 的记忆和 shipherd-sessions。
// 用法：mcp-hub.cjs --data <StateCore 数据目录> [--port <想要的端口>]。Shipherd 用自己的 Electron（ELECTRON_RUN_AS_NODE=1）运行它。
// 启动好了在 stdout 打一行 {"ready":true,"port":N}；之后 stdin 上每行一条路由（见 hub.ts）；stdin 关了（Shipherd 退出）就跟着退出。
// 顺序就是执行顺序：先清掉环境变量里的模型 key（R1），再加载 StateCore。
import "./clean-env";
import { createEmbeddedBackend } from "statecore-mcp/lib";
import { startLoopbackMcp } from "./loopback-http";
import { Hub, parseHubCommand } from "./hub";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dataDir = arg("--data");
const wanted = Number(arg("--port") ?? "0");
const log = (msg: string, e?: unknown) => process.stderr.write(`[shipherd-mcp-hub] ${msg}${e === undefined ? "" : `: ${e instanceof Error ? e.message : String(e)}`}\n`);

if (!dataDir || !Number.isInteger(wanted) || wanted < 0 || wanted > 65535) {
  log("usage: mcp-hub.cjs --data <dir> [--port <n>]");
  process.exit(2);
}

// backgroundDigest: false：Shipherd 不蒸馏（BTL-243），consolidate 的内容作为事件留着。
const hub = new Hub({ backend: (scope) => createEmbeddedBackend({ dataDir, scopeName: scope, env: process.env, backgroundDigest: false }), log });

async function listen() {
  try {
    return await startLoopbackMcp({ port: wanted, route: (t) => hub.handler(t), log });
  } catch (e) {
    // 上次的端口被别的程序占了：换一个。之前开的 session 的配置里还是旧端口，连不上，Shipherd 会记日志。
    if (wanted === 0 || (e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    log(`port ${wanted} is taken; listening on another one`);
    return startLoopbackMcp({ port: 0, route: (t) => hub.handler(t), log });
  }
}

void listen().then(
  (server) => {
    process.stdout.write(`${JSON.stringify({ ready: true, port: server.port })}\n`);
    const sweep = setInterval(() => void hub.sweep(), 60_000);
    sweep.unref();
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const cmd = parseHubCommand(line);
        if (cmd) hub.apply(cmd);
        else log("ignored a malformed route line");
      }
    });
    process.stdin.on("end", () => {
      clearInterval(sweep);
      void Promise.allSettled([hub.closeAll(), server.close()]).then(() => process.exit(0));
    });
  },
  (e: unknown) => {
    log("could not listen", e);
    process.exit(1);
  },
);
