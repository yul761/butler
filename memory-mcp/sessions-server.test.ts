import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { tempDir } from "../src/main/test-utils";
import { BRIEF_LIMIT } from "../src/shared/control";
import { EPIC_CONTEXT_TOOL, EPIC_CONTEXT_TOOL_EN, EPIC_TOOLS, EPIC_TOOLS_EN, FEATURE_TOOLS, FEATURE_TOOLS_EN, SessionsServer, serveStdio, TOOLS } from "./sessions-server";

function setup(timeoutMs = 2000, scope: { ticketKey: string } | { featureId: number; epic?: boolean } | { epicId: number } = { ticketKey: "P-1" }, lang: "zh" | "en" = "zh") {
  const dir = tempDir("butler-control-");
  const requestsDir = join(dir, "requests");
  const resultsDir = join(dir, "results");
  mkdirSync(resultsDir, { recursive: true });
  const server = new SessionsServer({ scope, lang, from: "boss", requestsDir, resultsDir, timeoutMs, pollMs: 10 });
  /** 扮演 Butler：等一个请求出现，读出来，写回结果。 */
  const answer = async (result: object) => {
    for (;;) {
      const names = readdirSync(requestsDir, { withFileTypes: true }).filter((e) => e.name.endsWith(".json")).map((e) => e.name);
      if (names.length > 0) {
        const req = JSON.parse(readFileSync(join(requestsDir, names[0]), "utf8")) as object;
        // 和 Butler 一样拿走请求，下一次 answer 不会再读到它。
        unlinkSync(join(requestsDir, names[0]));
        writeFileSync(join(resultsDir, names[0]), JSON.stringify(result));
        return req;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { server, answer, requestsDir };
}

describe("butler-sessions MCP server", () => {
  it("answers initialize, ping and tools/list, and ignores notifications", async () => {
    const { server } = setup();
    expect(await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).toMatchObject({
      id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "butler-sessions" } },
    });
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await server.handle({ jsonrpc: "2.0", id: 2, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    const list = (await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["list_repos", "start_session", "list_sessions", "session_activity"]);
    expect(await server.handle({ jsonrpc: "2.0", id: 4, method: "resources/list" })).toMatchObject({ id: 4, error: { code: -32601 } });
  });

  it("turns start_session into a request for this ticket and returns Butler's result", async () => {
    const { server, answer } = setup();
    const call = server.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "start_session", arguments: { repo: "api", task: "写接口\n加测试" } } });
    const req = await answer({ v: 1, ok: true, value: { sessionId: "child-1", repo: "api" } });
    expect(req).toEqual({ v: 1, ticketKey: "P-1", from: "boss", op: "start_session", repo: "api", task: "写接口\n加测试" });
    const r = (await call) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(r.result.isError).toBeUndefined();
    expect(JSON.parse(r.result.content[0].text)).toEqual({ sessionId: "child-1", repo: "api" });
  });

  it("reports Butler's errors, bad arguments and a silent Butler as tool errors", async () => {
    const { server, answer } = setup(200);
    const failing = server.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_repos" } });
    await answer({ v: 1, ok: false, error: "找不到 ticket" });
    expect(await failing).toMatchObject({ result: { isError: true, content: [{ text: "找不到 ticket" }] } });
    expect(await server.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "start_session", arguments: { repo: "api" } } })).toMatchObject({ result: { isError: true } });
    expect(await server.handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "rm_rf" } })).toMatchObject({ result: { isError: true } });
    expect(await server.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_sessions" } })).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining("没有回应") }] },
    });
    expect(await server.handle({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "start_session", arguments: { repo: "api", task: "t" } } })).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining("list_sessions") }] },
    });
  });

  it("withdraws pending requests when it shuts down", async () => {
    const { server, requestsDir } = setup(5000);
    void server.handle({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "start_session", arguments: { repo: "api", task: "t" } } });
    await new Promise((r) => setTimeout(r, 20));
    expect(readdirSync(requestsDir).filter((n) => n.endsWith(".json"))).toHaveLength(1);
    server.withdrawAll();
    expect(readdirSync(requestsDir)).toEqual([]);
  });

  it("withdraws a request nobody picked up", async () => {
    const { server, requestsDir } = setup(50);
    await server.handle({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "list_repos" } });
    expect(readdirSync(requestsDir)).toEqual([]);
  });

  it("speaks newline-delimited JSON over stdio", async () => {
    const { server } = setup();
    const input = new PassThrough();
    const output = new PassThrough();
    serveStdio(server, input, output);
    const lines: string[] = [];
    output.on("data", (c: Buffer) => lines.push(...c.toString("utf8").split("\n").filter(Boolean)));
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\nnot json\n`);
    await new Promise((r) => setTimeout(r, 20));
    const msgs = lines.map((l) => JSON.parse(l) as object);
    expect(msgs).toHaveLength(2);
    expect(msgs).toContainEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(msgs).toContainEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    expect(TOOLS.length).toBe(4);
  });
});

describe("butler-sessions for a feature coordinator (design 2026-10-26)", () => {
  it("lists the feature tools", async () => {
    const { server } = setup(2000, { featureId: 7 });
    const list = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["list_tickets", "list_repos", "create_ticket", "start_session", "list_sessions", "session_activity"]);
    expect(list.result.tools).toEqual(FEATURE_TOOLS);
    // 英文版只换描述：名字、顺序、必填参数一样。
    const shape = (tools: readonly { name: string; inputSchema: object }[]) => tools.map((t) => [t.name, "required" in t.inputSchema ? t.inputSchema.required : []]);
    expect(shape(FEATURE_TOOLS_EN)).toEqual(shape(FEATURE_TOOLS));
    expect(FEATURE_TOOLS.find((t) => t.name === "create_ticket")!.inputSchema.required).toEqual(["ticket"]);
    const start = FEATURE_TOOLS.find((t) => t.name === "start_session")!;
    expect(start.inputSchema.required).toEqual(["ticket", "task"]);
    expect(shape(FEATURE_TOOLS).at(-1)).toEqual(["session_activity", ["session"]]);
    expect(FEATURE_TOOLS.at(-1)!.description).not.toBe(FEATURE_TOOLS_EN.at(-1)!.description);
  });

  it("sends session_activity with the session id, for a feature and for a ticket", async () => {
    for (const scope of [{ featureId: 7 }, { ticketKey: "P-1" }]) {
      const { server, answer } = setup(2000, scope);
      const call = server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "session_activity", arguments: { session: "c1" } } });
      expect(await answer({ v: 1, ok: true, value: { kind: "test" } })).toEqual({ v: 1, ...scope, from: "boss", op: "session_activity", session: "c1" });
      expect(JSON.stringify(await call)).toContain("test");
      const bad = (await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "session_activity", arguments: {} } })) as { result: { isError?: boolean } };
      expect(bad.result.isError).toBe(true);
    }
    const en = (await setup(2000, { ticketKey: "P-1" }, "en").server.handle({ jsonrpc: "2.0", id: 4, method: "tools/list" })) as { result: { tools: { name: string; description: string }[] } };
    expect(en.result.tools.at(-1)).toMatchObject({ name: "session_activity", description: expect.stringMatching(/^[\x20-\x7e]+$/) });
  });

  it("sends start_session for a ticket of this feature, with or without a repo", async () => {
    const { server, answer } = setup(2000, { featureId: 7 });
    const call = server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "start_session", arguments: { ticket: "DMS-1", task: "做购物车" } } });
    const req = await answer({ v: 1, ok: true, value: { sessionId: "c1" } });
    expect(req).toEqual({ v: 1, featureId: 7, from: "boss", op: "start_session", ticket: "DMS-1", task: "做购物车" });
    expect(JSON.stringify(await call)).toContain("c1");

    const withRepo = server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "start_session", arguments: { ticket: "DMS-1", repo: "frontend", task: "x" } } });
    expect(await answer({ v: 1, ok: true, value: {} })).toMatchObject({ ticket: "DMS-1", repo: "frontend" });
    await withRepo;
  });

  it("rejects start_session without a ticket", async () => {
    const { server } = setup(2000, { featureId: 7 });
    const noTicket = (await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "start_session", arguments: { task: "x" } } })) as { result: { isError?: boolean } };
    expect(noTicket.result.isError).toBe(true);
  });

  it("sends list_repos and create_ticket for this feature", async () => {
    const { server, answer } = setup(2000, { featureId: 7 });
    const repos = server.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_repos", arguments: {} } });
    expect(await answer({ v: 1, ok: true, value: [] })).toEqual({ v: 1, featureId: 7, from: "boss", op: "list_repos" });
    await repos;

    const create = server.handle({
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "create_ticket", arguments: { ticket: "DMS-9", title: "购物车", repos: ["frontend", "backend"], branch: "  " } },
    });
    // 空白分支名等于没给（用分支模板）。
    expect(await answer({ v: 1, ok: true, value: { key: "DMS-9" } })).toEqual({
      v: 1, featureId: 7, from: "boss", op: "create_ticket", ticket: "DMS-9", title: "购物车", repos: ["frontend", "backend"],
    });
    expect(JSON.stringify(await create)).toContain("DMS-9");
  });

  it("rejects bad create_ticket arguments without asking Butler, and says what to check when Butler is slow", async () => {
    const { server, requestsDir } = setup(30, { featureId: 7 });
    const call = (id: number, args: object) => server.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "create_ticket", arguments: args } });
    for (const [n, args] of [[1, {}], [2, { ticket: "A-1", repos: "fe" }], [3, { ticket: "A-1", repos: [1] }], [4, { ticket: "A-1", title: 3 }]] as const) {
      expect(await call(n, args), String(n)).toMatchObject({ result: { isError: true } });
    }
    expect(existsSync(requestsDir)).toBe(false);
    expect(await call(5, { ticket: "A-1" })).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("list_tickets") }] } });
  });
});

describe("butler-sessions in English (design 2026-10-26 i18n)", () => {
  it("describes its tools and errors in English", async () => {
    for (const scope of [{ ticketKey: "P-1" }, { featureId: 7 }]) {
      const { server } = setup(2000, scope, "en");
      const list = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: unknown[] } };
      expect(/[\u4e00-\u9fff]/.test(JSON.stringify(list.result.tools))).toBe(false);
      const bad = (await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nope", arguments: {} } })) as { result: { content: { text: string }[] } };
      expect(bad.result.content[0].text).toBe("No such tool: nope");
    }
  });
});

const tools = async (server: SessionsServer) => ((await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string; description: string }[] } }).result.tools;
const callTool = (server: SessionsServer, name: string, args: object = {}) => server.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });

describe("butler-sessions for an epic session (design 2026-11-01)", () => {
  it("lists the epic tools in order, in both languages", async () => {
    expect((await tools(setup(2000, { epicId: 3 }).server))).toEqual(EPIC_TOOLS);
    expect(EPIC_TOOLS.map((t) => t.name)).toEqual(["list_features", "list_repos", "create_feature"]);
    expect(EPIC_TOOLS_EN.map((t) => [t.name, "required" in t.inputSchema ? t.inputSchema.required : []])).toEqual(EPIC_TOOLS.map((t) => [t.name, "required" in t.inputSchema ? t.inputSchema.required : []]));
    const create = EPIC_TOOLS.find((t) => t.name === "create_feature")!;
    expect(create.inputSchema.required).toEqual(["name", "brief"]);
    for (const t of EPIC_TOOLS) expect(t.description).toMatch(/[\u4e00-\u9fff]/);
    const en = await tools(setup(2000, { epicId: 3 }, "en").server);
    expect(/[\u4e00-\u9fff]/.test(JSON.stringify(en))).toBe(false);
    expect(en.map((t) => t.name)).toEqual(["list_features", "list_repos", "create_feature"]);
  });

  it("tells Claude that tickets belong to the feature's own session and the user opens it", () => {
    const zh = EPIC_TOOLS.find((t) => t.name === "create_feature")!.description;
    const en = EPIC_TOOLS_EN.find((t) => t.name === "create_feature")!.description;
    expect(zh).toContain("ticket");
    expect(zh).toContain("总控");
    expect(en).toMatch(/ticket/i);
    expect(en).toMatch(/user opens/i);
  });

  it("sends list_features, list_repos and create_feature for this epic", async () => {
    const { server, answer } = setup(2000, { epicId: 3 });
    const a = callTool(server, "list_features");
    expect(await answer({ v: 1, ok: true, value: [] })).toEqual({ v: 1, epicId: 3, from: "boss", op: "list_features" });
    await a;
    const b = callTool(server, "list_repos");
    expect(await answer({ v: 1, ok: true, value: [] })).toEqual({ v: 1, epicId: 3, from: "boss", op: "list_repos" });
    await b;
    const c = callTool(server, "create_feature", { name: "checkout", repos: ["fe"], brief: "做结账" });
    expect(await answer({ v: 1, ok: true, value: { id: 5, name: "checkout" } })).toEqual({ v: 1, epicId: 3, from: "boss", op: "create_feature", name: "checkout", repos: ["fe"], brief: "做结账" });
    expect(JSON.stringify(await c)).toContain("checkout");
  });

  it("rejects bad create_feature arguments without asking Butler, and says what to check when Butler is slow", async () => {
    const { server, requestsDir } = setup(30, { epicId: 3 });
    for (const args of [{}, { name: "a" }, { brief: "b" }, { name: "a", brief: "b", repos: "x" }, { name: "a", brief: "b", repos: [1] }, { name: 1, brief: "b" }, { name: "a", brief: "x".repeat(BRIEF_LIMIT + 1) }]) {
      expect(await callTool(server, "create_feature", args), JSON.stringify(args).slice(0, 60)).toMatchObject({ result: { isError: true } });
    }
    expect(existsSync(requestsDir)).toBe(false);
    expect(await callTool(server, "create_feature", { name: "a", brief: "b" })).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("list_features") }] } });
    expect(await callTool(server, "start_session", {})).toMatchObject({ result: { isError: true } });
  });
});

describe("epic_context for a feature coordinator in an epic", () => {
  it("appears only when the feature belongs to an epic", async () => {
    expect((await tools(setup(2000, { featureId: 7 }).server)).map((t) => t.name)).not.toContain("epic_context");
    expect(await tools(setup(2000, { featureId: 7, epic: true }).server)).toEqual([...FEATURE_TOOLS, EPIC_CONTEXT_TOOL]);
    const en = await tools(setup(2000, { featureId: 7, epic: true }, "en").server);
    expect(en.at(-1)).toEqual(EPIC_CONTEXT_TOOL_EN);
    expect(EPIC_CONTEXT_TOOL_EN.description).not.toBe(EPIC_CONTEXT_TOOL.description);
    expect(/[\u4e00-\u9fff]/.test(JSON.stringify(en))).toBe(false);
  });

  it("sends epic_context, and refuses it without asking Butler when the feature has no epic", async () => {
    const { server, answer } = setup(2000, { featureId: 7, epic: true });
    const call = callTool(server, "epic_context");
    expect(await answer({ v: 1, ok: true, value: { epic: "shop", features: [] } })).toEqual({ v: 1, featureId: 7, from: "boss", op: "epic_context" });
    expect(JSON.stringify(await call)).toContain("shop");
    const plain = setup(2000, { featureId: 7 });
    expect(await callTool(plain.server, "epic_context")).toMatchObject({ result: { isError: true } });
    expect(existsSync(plain.requestsDir)).toBe(false);
  });
});
