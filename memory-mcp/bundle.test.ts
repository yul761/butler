import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { startFakeProvider } from "../src/main/gateway/testing";
import { memoryServers } from "../src/main/memory/mcp-config";
import { withScope } from "../src/main/memory/statecore";
import { tempDir } from "../src/main/test-utils";

const root = fileURLToPath(new URL("../", import.meta.url));
let bundle = "";

beforeAll(() => {
  bundle = join(tempDir(), "statecore-mcp.cjs");
  execFileSync(process.execPath, ["scripts/build-memory-mcp.mjs", bundle], { cwd: root, stdio: "pipe" });
}, 120_000);

interface Reply {
  id?: number;
  result?: { content?: { text: string }[]; tools?: { name: string }[] };
}

/** 像 claude 按 --mcp-config 那样启动一个 MCP server：stdio 上的 JSON-RPC，一问一答。 */
async function connect(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (r: Reply) => void>();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c: string) => {
    buf += c;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as Reply;
      if (typeof msg.id === "number") waiting.get(msg.id)?.(msg);
    }
  });
  let nextId = 0;
  const call = (method: string, params?: unknown) =>
    new Promise<Reply>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
      waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "butler-test", version: "0" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const tool = async (name: string, args: Record<string, unknown>) => (await call("tools/call", { name, arguments: args })).result?.content?.[0]?.text ?? "";
  const close = () =>
    new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      child.kill();
    });
  return { call, tool, close };
}

/** 用跑测试的 Node 直接启动 bundle。 */
const open = (env: NodeJS.ProcessEnv, dataDir: string) => connect(process.execPath, [bundle, "--data", dataDir], env);

/** 本仓库装的 Electron 可执行文件（和 `require("electron")` 在 Node 里返回的路径一样）。 */
const electronBinary = (): string => execFileSync(process.execPath, ["-p", 'require("electron")'], { cwd: root, encoding: "utf8" }).trim();

describe("bundled StateCore MCP (design 8.4)", () => {
  it("serves StateCore's tools in the scope from STATECORE_SCOPE, and Butler reads what it wrote", async () => {
    const dataDir = tempDir();
    const s = await open({ ...process.env, STATECORE_SCOPE: "ticket:T-1", LOG_LEVEL: "warn" }, dataDir);
    try {
      const names = ((await s.call("tools/list")).result?.tools ?? []).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["remember", "recall", "facts", "why", "forget", "handoff"]));
      expect(await s.tool("remember", { text: "Claude 记的：这个仓库用 pnpm" })).toContain('"ok": true');
    } finally {
      await s.close();
    }
    const texts = await withScope({ dataDir, scope: "ticket:T-1" }, async (sc) => (await sc.facts()).map((i) => i.text));
    expect(texts).toEqual(["Claude 记的：这个仓库用 pnpm"]);
  }, 60_000);

  it("strips inherited model keys even when the parent passes them (Review Focus 3)", async () => {
    // 万一清理失效，请求也只会打到本机一个关闭的端口，绝不会到真实的服务商。
    const s = await open(
      {
        ...process.env, STATECORE_SCOPE: "ticket:T-2", LOG_LEVEL: "warn",
        FEATURE_LLM: "true", MODEL_API_KEY: "sk-inherited", OPENAI_API_KEY: "sk-inherited-2", MODEL_BASE_URL: "http://127.0.0.1:9/v1", STATECORE_DIGEST_THRESHOLD: "1",
      },
      tempDir(),
    );
    try {
      expect(await s.tool("remember", { text: "一段原始对话", consolidate: true })).toContain("no model configured");
    } finally {
      await s.close();
    }
  }, 60_000);

  it("stays model-free when launched exactly as the --mcp-config entry, under Electron, inside a claude env full of keys (R1)", async () => {
    // claude 启动 MCP server 时：command/args 取自配置文件，环境变量 = claude 自己的环境 + 配置里的 env。
    // 这里 claude 的环境里带着用户 shell 导出的各种 key，base URL 全部指向本机一个记录请求的假服务器：
    // 清理一旦失效，这里就会收到请求（绝不会到真实的服务商）。
    const recorder = await startFakeProvider();
    const statecoreDir = tempDir();
    const spec = memoryServers({ launcher: { command: electronBinary(), script: bundle }, statecoreDir, ticketKey: "T-3" })["butler-memory"];
    const claudeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      FEATURE_LLM: "true", STATECORE_DIGEST_THRESHOLD: "1",
      MODEL_API_KEY: "sk-inherited", OPENAI_API_KEY: "sk-inherited-2", ANTHROPIC_API_KEY: "sk-ant-inherited",
      MODEL_BASE_URL: recorder.baseUrl, OPENAI_BASE_URL: recorder.baseUrl, ANTHROPIC_BASE_URL: recorder.baseUrl,
      MODEL_STRUCTURED_OUTPUT_API_KEY: "sk-inherited-3", MODEL_STRUCTURED_OUTPUT_BASE_URL: recorder.baseUrl,
    };
    try {
      const s = await connect(spec.command, spec.args, { ...claudeEnv, ...spec.env });
      try {
        // 带 consolidate 的 remember 要模型来蒸馏；阈值 1 时普通 remember 也会触发后台摘要。
        expect(await s.tool("remember", { text: "一段原始对话", consolidate: true })).toContain("no model configured");
        for (const text of ["决定：用 pnpm", "约束：不能改公共 API"]) expect(await s.tool("remember", { text })).toContain('"ok": true');
        // 给可能的后台摘要留出时间，再确认没有任何请求发出。
        await new Promise((r) => setTimeout(r, 1500));
      } finally {
        await s.close();
      }
      expect(recorder.requests).toEqual([]);
    } finally {
      await recorder.close();
    }
    const texts = await withScope({ dataDir: statecoreDir, scope: "ticket:T-3" }, async (sc) => (await sc.facts()).map((i) => i.text));
    expect(texts).toEqual(expect.arrayContaining(["决定：用 pnpm", "约束：不能改公共 API"]));
  }, 60_000);
});
