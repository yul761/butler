// Shipherd 的记忆 server 和真的 statecore-mcp 比（WS-M 设计 §8 的契约测试，BTL-243 改过）：
// Shipherd 留的上游原文和真的一字不差；Shipherd 的 server 和真的之间，差别只有 SHIPHERD_OVERRIDES 这份清单（和 overrideResult 对结果的改动）。
// statecore-mcp 升级改了工具层，这里会失败。
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createEmbeddedBackend } from "statecore-mcp/lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../src/main/test-utils";
import { applyOverrides, SHIPHERD_OVERRIDES, MemoryServer, overrideResult, STATECORE_MCP_VERSION, UPSTREAM_INSTRUCTIONS, UPSTREAM_TOOLS } from "./memory-tools";

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

const backend = createEmbeddedBackend({ dataDir: tempDir(), scopeName: "contract", env: { LOG_LEVEL: "warn" }, backgroundDigest: false });
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
const toolJson = (r: Reply, fix: (body: unknown) => unknown = (b) => b) => {
  const res = r.result as { content: { text: string }[]; isError?: boolean };
  return { isError: res.isError ?? false, body: res.isError ? res.content[0].text : shape(fix(JSON.parse(res.content[0].text))) };
};
/** 真的 statecore-mcp 的结果在 Shipherd 这边应该变成什么：remember 走 overrideResult，facts 去掉等待蒸馏的 pending。 */
const shipherdSide = (name: string) => (body: unknown) => {
  if (name === "facts" && body && typeof body === "object") {
    const rest = { ...(body as Record<string, unknown>) };
    delete rest.pending;
    return rest;
  }
  return overrideResult(name, body);
};

describe("shared MCP memory server vs statecore-mcp", () => {
  it("answers initialize the same way, for the protocol versions Claude Code asks for, apart from the overridden instructions", async () => {
    for (const protocolVersion of ["2025-06-18", "2025-03-26", "1999-01-01"]) {
      const params = { protocolVersion, capabilities: {}, clientInfo: { name: "contract", version: "1" } };
      const [a, b] = await Promise.all([real.send("initialize", params), hubSend("initialize", params)]);
      const upstream = (a.result as { instructions: string }).instructions;
      expect(upstream).toBe(UPSTREAM_INSTRUCTIONS);
      expect(b.result).toEqual({ ...a.result, instructions: applyOverrides(upstream, [], SHIPHERD_OVERRIDES.filter((o) => o.where === "instructions")).instructions });
    }
    real.notify("notifications/initialized");
    expect(await hub.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("keeps a word-for-word copy of the real tool list, and differs from it only by the named overrides", async () => {
    const [a, b] = await Promise.all([real.send("tools/list"), hubSend("tools/list")]);
    const upstream = (a.result as { tools: unknown[] }).tools;
    expect(upstream).toEqual(UPSTREAM_TOOLS);
    expect(b.result).toEqual({ tools: applyOverrides("", upstream, SHIPHERD_OVERRIDES.filter((o) => o.where !== "instructions")).tools });
    // 说明里不再许诺蒸馏。
    expect(JSON.stringify(b.result)).not.toMatch(/distil/i);
  });

  it("fails loudly when an override no longer matches the upstream text", () => {
    expect(() => applyOverrides(UPSTREAM_INSTRUCTIONS, UPSTREAM_TOOLS, [{ where: "instructions", from: "no such words", to: "x" }])).toThrow(/no longer matches/);
    expect(() => applyOverrides(UPSTREAM_INSTRUCTIONS, UPSTREAM_TOOLS, [{ where: "remember.nope", from: "a", to: "b" }])).toThrow(/no parameter/);
    for (const o of SHIPHERD_OVERRIDES) expect(o.to, o.where).not.toBe(o.from);
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
      expect({ name, ...toolJson(b) }).toEqual({ name, ...toolJson(a, shipherdSide(name)) });
    }
  });

  it("rejects bad arguments with the same words as statecore-mcp (zod 4 since BTL-262)", async () => {
    const cases: [string, object][] = [
      ["remember", {}], ["remember", { text: 1 }], ["remember", { text: null }], ["remember", { text: "" }], ["remember", { text: "x".repeat(2001) }],
      ["remember", { text: "x", consolidate: "y" }], ["remember", { text: 1, consolidate: "y" }],
      ["recall", { query: 1 }], ["recall", { maxChars: 1.5 }], ["recall", { maxChars: "1" }], ["recall", { maxChars: null }], ["recall", { maxChars: 0 }],
      ["recall", { maxChars: 32001 }], ["recall", { maxChars: -1.5 }],
      ["why", {}], ["why", { factId: "" }], ["forget", { factKey: 3 }],
      ["handoff", { summary: "x".repeat(2001) }], ["handoff", { openQuestions: "a" }], ["handoff", { nextSteps: Array(11).fill("a") }],
      ["handoff", { nextSteps: [1, ...Array(10).fill("a")] }], ["handoff", { nextSteps: [1, "  ", "x".repeat(501)], openQuestions: 2 }], ["handoff", { clear: 1 }],
    ];
    for (const [name, args] of cases) {
      const [a, b] = await Promise.all([real.send("tools/call", { name, arguments: args }), hubSend("tools/call", { name, arguments: args })]);
      const label = `${name} ${JSON.stringify(args).slice(0, 60)}`;
      expect(toolJson(a).isError, label).toBe(true);
      expect(toolJson(b), label).toEqual(toolJson(a));
    }
  });

  it("answers remember(consolidate) as an event and returns a long entry whole in recall (BTL-243)", async () => {
    const long = `Why we picked WAL over a rollback journal: ${"readers never block the writer, and recovery after a crash is a replay. ".repeat(24)}`;
    expect(long.length).toBeGreaterThan(1500);
    const r = toolJson(await hubSend("tools/call", { name: "remember", arguments: { text: long, consolidate: true } }));
    expect(r).toEqual({ isError: false, body: { ok: true, mode: "event" } });
    for (const args of [{}, { query: "rollback journal" }]) {
      const res = (await hubSend("tools/call", { name: "recall", arguments: args })).result as { content: { text: string }[] };
      const body = JSON.parse(res.content[0].text) as { events: { content: string }[] };
      expect(body.events.map((e) => e.content)).toContain(long);
    }
    const facts = (await hubSend("tools/call", { name: "facts", arguments: {} })).result as { content: { text: string }[] };
    expect(Object.keys(JSON.parse(facts.content[0].text) as object)).toEqual(["groups"]);
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
