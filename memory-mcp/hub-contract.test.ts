// 共享 MCP 的记忆 server 和真的 statecore-mcp 一样吗（WS-M 设计 §8 的契约测试）：
// 同样的 initialize、同样的工具列表，remember / recall / handoff / facts 的结果形状一样。statecore-mcp 升级改了工具层，这里会失败。
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createEmbeddedBackend } from "statecore-mcp/lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../src/main/test-utils";
import { MemoryServer, STATECORE_MCP_VERSION } from "./memory-tools";

type Reply = { id?: number; result?: Record<string, unknown>; error?: unknown };

/** 真的 statecore-mcp（它包里的 bin）经 stdio：一问一答。 */
function realServer(dataDir: string) {
  const main = join(fileURLToPath(new URL("../", import.meta.url)), "node_modules", "statecore-mcp", "dist", "main.js");
  const child = spawn(process.execPath, [main, "--data", dataDir], { env: { ...process.env, STATECORE_SCOPE: "contract", LOG_LEVEL: "warn" }, stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map<number, (r: Reply) => void>();
  createInterface({ input: child.stdout }).on("line", (l) => {
    const m = JSON.parse(l) as Reply;
    if (typeof m.id === "number") waiting.get(m.id)?.(m);
  });
  let next = 0;
  return {
    send: (method: string, params?: object) =>
      new Promise<Reply>((resolve) => {
        const id = ++next;
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params && { params }) })}\n`);
      }),
    notify: (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`),
    close: () => child.kill(),
  };
}

const backend = createEmbeddedBackend({ dataDir: tempDir(), scopeName: "contract", env: { LOG_LEVEL: "warn" } });
const hub = new MemoryServer(async () => backend);
let hubNext = 0;
const hubSend = (method: string, params?: Record<string, unknown>) => hub.handle({ jsonrpc: "2.0", id: ++hubNext, method, ...(params && { params }) }) as Promise<Reply>;

let real: ReturnType<typeof realServer>;

beforeAll(async () => {
  await backend.init();
  real = realServer(tempDir());
});
afterAll(async () => {
  real.close();
  await backend.close();
});

/** 工具结果里的 JSON：id、时间这些每次不一样的值换成它的类型，只比形状和确定的值。 */
function shape(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => shape(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, k)]));
  if (typeof v === "string" && /(id|Id|At|at|time|Time|created|updated|ts|oldest)$/.test(key)) return "<string>";
  if (typeof v === "number" && /(At|at|time|Time|ms|Ms|score|Score|confidence|chars|Chars|used|Used)$/.test(key)) return "<number>";
  return v;
}
const toolJson = (r: Reply) => {
  const res = r.result as { content: { text: string }[]; isError?: boolean };
  return { isError: res.isError ?? false, body: res.isError ? res.content[0].text : shape(JSON.parse(res.content[0].text)) };
};

describe("shared MCP memory server vs statecore-mcp", () => {
  it("answers initialize the same way, for the protocol versions Claude Code asks for", async () => {
    for (const protocolVersion of ["2025-06-18", "2025-03-26", "1999-01-01"]) {
      const params = { protocolVersion, capabilities: {}, clientInfo: { name: "contract", version: "1" } };
      const [a, b] = await Promise.all([real.send("initialize", params), hubSend("initialize", params)]);
      expect(b.result).toEqual(a.result);
    }
    real.notify("notifications/initialized");
    expect(await hub.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("lists the same tools with the same descriptions and schemas", async () => {
    const [a, b] = await Promise.all([real.send("tools/list"), hubSend("tools/list")]);
    expect(b.result).toEqual(a.result);
  });

  it("is the statecore-mcp version it was copied from", async () => {
    const r = await real.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } });
    expect((r.result as { serverInfo: { version: string } }).serverInfo.version).toBe(STATECORE_MCP_VERSION);
  });

  it("gives the same results for remember, recall, facts, handoff, why and forget", async () => {
    const steps: [string, object][] = [
      ["remember", { text: "The build uses pnpm." }],
      ["remember", { text: "x".repeat(600) }],
      ["remember", { text: "A longer conversation to distil later.", consolidate: true }],
      ["handoff", {}],
      ["handoff", { summary: "  Stopped after the contract test.  ", nextSteps: ["ship it"] }],
      ["recall", { query: "build tool" }],
      ["recall", { maxChars: -1 }],
      ["facts", {}],
      ["why", { factId: "no-such-fact" }],
      ["forget", { factKey: "no-such-key" }],
      ["nope", {}],
    ];
    for (const [name, args] of steps) {
      const [a, b] = await Promise.all([real.send("tools/call", { name, arguments: args }), hubSend("tools/call", { name, arguments: args })]);
      expect({ name, ...toolJson(b) }).toEqual({ name, ...toolJson(a) });
    }
  });

  it("returns the same errors for methods it does not have", async () => {
    for (const method of ["resources/list", "prompts/list"]) {
      const [a, b] = await Promise.all([real.send(method), hubSend(method)]);
      expect(b.error).toEqual(a.error);
    }
    const [a, b] = await Promise.all([real.send("ping"), hubSend("ping")]);
    expect(b.result).toEqual(a.result);
  });
});
