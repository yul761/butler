import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { tempDir } from "../src/main/test-utils";
import { BRIEF_LIMIT, EPIC_PLAN_MAX_CHARS, MAX_RUNNING_FEATURES_PER_EPIC, REASON_LIMIT, START_INSTRUCTIONS_LIMIT } from "../src/shared/control";
import {
  EPIC_CONTEXT_TOOL, EPIC_CONTEXT_TOOL_EN, EPIC_TOOLS, EPIC_TOOLS_EN, FEATURE_TOOLS, FEATURE_TOOLS_EN, INBOX_TOOLS, INBOX_TOOLS_EN, SessionsServer, serveStdio, TOOLS, TOOLS_EN,
} from "./sessions-server";

function setup(timeoutMs = 2000, scope: { ticketKey: string; member?: boolean } | { featureId: number; epic?: boolean } | { epicId: number } = { ticketKey: "P-1" }, lang: "zh" | "en" = "zh") {
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
    expect(list.result.tools.map((t) => t.name)).toEqual(["list_repos", "start_session", "list_sessions", "session_activity", "end_session", "refresh_session", "ask_user", "report"]);
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

  it("sends the model of start_session, and refuses an unknown one without sending anything", async () => {
    const { server, answer } = setup();
    const call = server.handle({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "start_session", arguments: { repo: "api", task: "t", model: "sonnet" } } });
    expect(await answer({ v: 1, ok: true, value: {} })).toMatchObject({ op: "start_session", model: "sonnet" });
    await call;
    const bad = setup(200);
    expect(await bad.server.handle({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "start_session", arguments: { repo: "api", task: "t", model: "gpt-4" } } })).toMatchObject({ result: { isError: true } });
    const badFeature = setup(200, { featureId: 7 });
    expect(await badFeature.server.handle({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "start_session", arguments: { ticket: "A-1", task: "t", model: 3 } } })).toMatchObject({ result: { isError: true } });
    // 没发出任何请求：目录要么没建，要么是空的。
    expect(existsSync(bad.requestsDir) ? readdirSync(bad.requestsDir).filter((n) => n.endsWith(".json")) : []).toHaveLength(0);
  });

  it("start_session descriptions tell the coordinator to put only the task in task, the rest in memory", () => {
    const zh = [TOOLS, FEATURE_TOOLS].map((t) => t.find((x) => x.name === "start_session")!.description);
    const en = [TOOLS_EN, FEATURE_TOOLS_EN].map((t) => t.find((x) => x.name === "start_session")!.description);
    for (const d of zh) expect(d).toContain("task 里只写要做什么，背景、接口约定写进记忆，子 session 会自己读。");
    for (const d of en) expect(d).toContain("Put only what to do in task");
  });

  it("lists model in both start_session schemas, in both languages", () => {
    for (const tools of [TOOLS, TOOLS_EN, FEATURE_TOOLS, FEATURE_TOOLS_EN]) {
      const start = tools.find((t) => t.name === "start_session")!;
      const model = (start.inputSchema.properties as Record<string, { enum?: readonly string[]; description: string }>).model;
      expect(model.enum).toEqual(["opus", "sonnet"]);
      expect(model.description).toMatch(/opus/);
      expect("required" in start.inputSchema && start.inputSchema.required).not.toContain("model");
    }
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
    expect(TOOLS.length).toBe(6);
  });
});

describe("butler-sessions for a feature coordinator (design 2026-10-26)", () => {
  it("lists the feature tools", async () => {
    const { server } = setup(2000, { featureId: 7 });
    const list = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["list_tickets", "list_repos", "create_ticket", "start_session", "list_sessions", "session_activity", "end_session", "refresh_session", "ask_user", "report"]);
    expect(list.result.tools).toEqual([...FEATURE_TOOLS, ...INBOX_TOOLS]);
    // 英文版只换描述：名字、顺序、必填参数一样。
    const shape = (tools: readonly { name: string; inputSchema: object }[]) => tools.map((t) => [t.name, "required" in t.inputSchema ? t.inputSchema.required : []]);
    expect(shape(FEATURE_TOOLS_EN)).toEqual(shape(FEATURE_TOOLS));
    expect(FEATURE_TOOLS.find((t) => t.name === "create_ticket")!.inputSchema.required).toEqual(["ticket"]);
    const start = FEATURE_TOOLS.find((t) => t.name === "start_session")!;
    expect(start.inputSchema.required).toEqual(["ticket", "task"]);
    expect(shape(FEATURE_TOOLS).find(([n]) => n === "session_activity")).toEqual(["session_activity", ["session"]]);
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
    expect(en.result.tools.find((t) => t.name === "session_activity")).toMatchObject({ description: expect.stringMatching(/^[\x20-\x7e]+$/) });
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

const EPIC_NAMES = ["list_features", "list_repos", "create_feature", "start_feature", "list_sessions", "session_activity", "end_session", "set_epic_plan", "refresh_session"];

describe("butler-sessions for an epic session (design 2026-11-01)", () => {
  it("lists the epic tools in order, in both languages", async () => {
    expect((await tools(setup(2000, { epicId: 3 }).server))).toEqual([...EPIC_TOOLS, ...INBOX_TOOLS]);
    expect(EPIC_TOOLS.map((t) => t.name)).toEqual(EPIC_NAMES);
    expect(EPIC_TOOLS_EN.map((t) => [t.name, "required" in t.inputSchema ? t.inputSchema.required : []])).toEqual(EPIC_TOOLS.map((t) => [t.name, "required" in t.inputSchema ? t.inputSchema.required : []]));
    const create = EPIC_TOOLS.find((t) => t.name === "create_feature")!;
    expect(create.inputSchema.required).toEqual(["name", "brief"]);
    for (const t of EPIC_TOOLS) expect(t.description).toMatch(/[\u4e00-\u9fff]/);
    const en = await tools(setup(2000, { epicId: 3 }, "en").server);
    expect(/[\u4e00-\u9fff]/.test(JSON.stringify(en))).toBe(false);
    expect(en.map((t) => t.name)).toEqual([...EPIC_NAMES, "ask_user", "report"]);
  });

  it("tells Claude that tickets belong to the feature's own session, opened by the user or with start_feature", () => {
    const zh = EPIC_TOOLS.find((t) => t.name === "create_feature")!.description;
    const en = EPIC_TOOLS_EN.find((t) => t.name === "create_feature")!.description;
    expect(zh).toContain("ticket");
    expect(zh).toContain("总控");
    expect(zh).toContain("start_feature");
    expect(en).toMatch(/ticket/i);
    expect(en).toMatch(/user opens/i);
    expect(en).toContain("start_feature");
  });

  it("describes start_feature and create_feature's start in both languages (BTL-190 4)", () => {
    for (const list of [EPIC_TOOLS, EPIC_TOOLS_EN]) {
      const start = list.find((t) => t.name === "start_feature")!;
      expect(start.inputSchema.required).toEqual(["feature"]);
      expect(Object.keys(start.inputSchema.properties)).toEqual(["feature", "instructions"]);
      expect(start.description).toContain(String(MAX_RUNNING_FEATURES_PER_EPIC));
      expect(start.description).toContain("list_features");
      const create = list.find((t) => t.name === "create_feature")!;
      expect(create.inputSchema.properties).toHaveProperty("start", expect.objectContaining({ type: "boolean" }));
    }
    expect(EPIC_TOOLS.find((t) => t.name === "start_feature")!.description).toContain("instructions");
    expect(EPIC_TOOLS_EN.find((t) => t.name === "start_feature")!.description).toContain("instructions");
  });

  it("sends start_feature for this epic, taking the feature by name or id, and create_feature with start", async () => {
    const { server, answer } = setup(2000, { epicId: 3 });
    const a = callTool(server, "start_feature", { feature: "checkout" });
    expect(await answer({ v: 1, ok: true, value: { sessionId: "fc" } })).toEqual({ v: 1, epicId: 3, from: "boss", op: "start_feature", feature: "checkout" });
    expect(JSON.stringify(await a)).toContain("fc");
    const b = callTool(server, "start_feature", { feature: 5, instructions: "先做 API" });
    expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ v: 1, epicId: 3, from: "boss", op: "start_feature", feature: "5", instructions: "先做 API" });
    await b;
    const c = callTool(server, "create_feature", { name: "checkout", brief: "做结账", start: true });
    expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ v: 1, epicId: 3, from: "boss", op: "create_feature", name: "checkout", brief: "做结账", start: true });
    await c;
    const d = callTool(server, "create_feature", { name: "checkout", brief: "做结账", start: false });
    expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ v: 1, epicId: 3, from: "boss", op: "create_feature", name: "checkout", brief: "做结账" });
    await d;
  });

  it("rejects bad start_feature arguments without asking Butler, and says what to check when Butler is slow", async () => {
    const { server, requestsDir } = setup(30, { epicId: 3 });
    for (const args of [{}, { feature: "" }, { feature: "  " }, { feature: true }, { feature: 1.5 }, { feature: "c", instructions: 3 }, { feature: "c", instructions: "x".repeat(START_INSTRUCTIONS_LIMIT + 1) }]) {
      expect(await callTool(server, "start_feature", args), JSON.stringify(args).slice(0, 60)).toMatchObject({ result: { isError: true } });
    }
    expect(await callTool(server, "create_feature", { name: "a", brief: "b", start: "yes" })).toMatchObject({ result: { isError: true } });
    expect(existsSync(requestsDir)).toBe(false);
    expect(await callTool(server, "start_feature", { feature: "c" })).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("list_sessions") }] } });
    // 只有 epic session 有这个工具。
    expect(await callTool(setup(30, { featureId: 7, epic: true }).server, "start_feature", { feature: "c" })).toMatchObject({ result: { isError: true } });
    const en = setup(30, { epicId: 3 }, "en");
    expect(JSON.stringify(await callTool(en.server, "start_feature", {}))).not.toMatch(/[\u4e00-\u9fff]/);
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

  it("sends set_epic_plan for this epic, and rejects a missing, empty or too long plan without asking Butler", async () => {
    const { server, answer } = setup(2000, { epicId: 3 });
    const call = callTool(server, "set_epic_plan", { plan: "先做支付" });
    expect(await answer({ v: 1, ok: true, value: { note: "ok" } })).toEqual({ v: 1, epicId: 3, from: "boss", op: "set_epic_plan", plan: "先做支付" });
    expect(await call).toMatchObject({ result: { content: [{ text: expect.stringContaining("ok") }] } });
    const quiet = setup(30, { epicId: 3 });
    for (const args of [{}, { plan: 5 }, { plan: "  " }, { plan: "x".repeat(EPIC_PLAN_MAX_CHARS + 1) }]) {
      expect(await callTool(quiet.server, "set_epic_plan", args), JSON.stringify(args).slice(0, 40)).toMatchObject({ result: { isError: true } });
    }
    expect(existsSync(quiet.requestsDir)).toBe(false);
    // 只有 epic session 有这个工具。
    expect(await callTool(setup(30, { featureId: 7, epic: true }).server, "set_epic_plan", { plan: "p" })).toMatchObject({ result: { isError: true } });
  });

  it("tells the epic session to keep the plan with set_epic_plan and the handoff for progress only", () => {
    const zh = EPIC_TOOLS.find((t) => t.name === "set_epic_plan")!;
    const en = EPIC_TOOLS_EN.find((t) => t.name === "set_epic_plan")!;
    expect(zh.inputSchema.required).toEqual(["plan"]);
    expect(zh.description).toContain("handoff");
    expect(zh.description).toContain("进度");
    expect(en.description).toContain("handoff");
    expect(en.description).toMatch(/progress/i);
    expect(EPIC_TOOLS.find((t) => t.name === "create_feature")!.description).toContain("set_epic_plan");
    expect(EPIC_TOOLS_EN.find((t) => t.name === "create_feature")!.description).toContain("set_epic_plan");
  });
});

describe("epic_context for a feature coordinator in an epic", () => {
  it("appears only when the feature belongs to an epic", async () => {
    expect((await tools(setup(2000, { featureId: 7 }).server)).map((t) => t.name)).not.toContain("epic_context");
    expect(await tools(setup(2000, { featureId: 7, epic: true }).server)).toEqual([...FEATURE_TOOLS, EPIC_CONTEXT_TOOL, ...INBOX_TOOLS]);
    const en = await tools(setup(2000, { featureId: 7, epic: true }, "en").server);
    expect(en.at(-3)).toEqual(EPIC_CONTEXT_TOOL_EN);
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

describe("end_session (task 11)", () => {
  const scopes = [{ ticketKey: "P-1" }, { featureId: 7 }, { epicId: 3 }];
  const lists = [[TOOLS, TOOLS_EN], [FEATURE_TOOLS, FEATURE_TOOLS_EN], [EPIC_TOOLS, EPIC_TOOLS_EN]] as const;

  it("is in all three tool lists in both languages, with session and reason required", () => {
    for (const [zh, en] of lists) {
      for (const list of [zh, en]) {
        const t = (list as readonly { name: string; description: string; inputSchema: object }[]).find((x) => x.name === "end_session")!;
        expect(t.inputSchema).toMatchObject({ required: ["session", "reason"], properties: { session: { type: "string" }, reason: { type: "string" } } });
      }
      const zhEnd = (zh as readonly { name: string; description: string }[]).find((x) => x.name === "end_session")!.description;
      const enEnd = (en as readonly { name: string; description: string }[]).find((x) => x.name === "end_session")!.description;
      expect(zhEnd).toContain("last_reply");
      expect(zhEnd).toContain("拿不准就不关");
      expect(enEnd).toContain("last_reply");
      expect(/[\u4e00-\u9fff]/.test(enEnd)).toBe(false);
    }
  });

  it("gives an epic session list_sessions and session_activity", async () => {
    const { server, answer } = setup(2000, { epicId: 3 });
    const a = callTool(server, "list_sessions");
    expect(await answer({ v: 1, ok: true, value: [] })).toEqual({ v: 1, epicId: 3, from: "boss", op: "list_sessions" });
    await a;
    const b = callTool(server, "session_activity", { session: "fc" });
    expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ v: 1, epicId: 3, from: "boss", op: "session_activity", session: "fc" });
    await b;
    expect(await callTool(server, "session_activity", {})).toMatchObject({ result: { isError: true } });
  });

  it("sends end_session with the session and the reason, in every scope", async () => {
    for (const scope of scopes) {
      const { server, answer } = setup(2000, scope);
      const call = callTool(server, "end_session", { session: "c1", reason: "PR 已合并" });
      expect(await answer({ v: 1, ok: true, value: { ended: true } })).toEqual({ v: 1, ...scope, from: "boss", op: "end_session", session: "c1", reason: "PR 已合并" });
      expect(JSON.stringify(await call)).toContain("ended");
    }
  });

  it("rejects end_session without a session or a reason, or with a reason over the limit, without asking Butler", async () => {
    for (const scope of scopes) {
      const { server, requestsDir } = setup(30, scope);
      for (const args of [{}, { session: "c1" }, { reason: "done" }, { session: "c1", reason: "  " }, { session: 1, reason: "done" }, { session: "c1", reason: "x".repeat(REASON_LIMIT + 1) }]) {
        expect(await callTool(server, "end_session", args), JSON.stringify(args).slice(0, 60)).toMatchObject({ result: { isError: true } });
      }
      expect(existsSync(requestsDir)).toBe(false);
    }
  });
});

describe("refresh_session (plan 16)", () => {
  const scopes = [{ ticketKey: "P-1" }, { featureId: 7 }, { epicId: 3 }];
  const lists = [[TOOLS, TOOLS_EN], [FEATURE_TOOLS, FEATURE_TOOLS_EN], [EPIC_TOOLS, EPIC_TOOLS_EN]] as const;

  it("is in all three tool lists in both languages, with session required", () => {
    for (const [zh, en] of lists) {
      const find = (list: readonly object[]) => (list as readonly { name: string; description: string; inputSchema: object }[]).find((x) => x.name === "refresh_session")!;
      for (const list of [zh, en]) expect(find(list).inputSchema).toMatchObject({ required: ["session"], properties: { session: { type: "string" } } });
      expect(find(zh).description).toBe("让 Butler 给一个停下来的子 session 换新上下文：先写 handoff，再清空，再从记忆里接上。只能对你管的、已经停下来的 session 用。");
      expect(find(en).description).toContain("handoff");
      expect(/[\u4e00-\u9fff]/.test(find(en).description)).toBe(false);
    }
  });

  it("sends refresh_session with the session, in every scope", async () => {
    for (const scope of scopes) {
      const { server, answer } = setup(2000, scope);
      const call = callTool(server, "refresh_session", { session: "c1" });
      expect(await answer({ v: 1, ok: true, value: { started: true } })).toEqual({ v: 1, ...scope, from: "boss", op: "refresh_session", session: "c1" });
      expect(JSON.stringify(await call)).toContain("started");
    }
  });

  it("rejects refresh_session without a session string, without asking Butler", async () => {
    for (const scope of scopes) {
      const { server, requestsDir } = setup(30, scope);
      for (const args of [{}, { session: "" }, { session: 1 }]) {
        expect(await callTool(server, "refresh_session", args), JSON.stringify(args)).toMatchObject({ result: { isError: true } });
      }
      expect(existsSync(requestsDir)).toBe(false);
    }
  });
});

describe("ask_user and report for every Butler session (BTL-190 2+3)", () => {
  it("a member (normal ticket session) only has ask_user and report, in both languages", async () => {
    expect(await tools(setup(2000, { ticketKey: "P-1", member: true }).server)).toEqual([...INBOX_TOOLS]);
    const en = await tools(setup(2000, { ticketKey: "P-1", member: true }, "en").server);
    expect(en).toEqual([...INBOX_TOOLS_EN]);
    expect(/[一-鿿]/.test(JSON.stringify(en))).toBe(false);
    // 英文版名字和必填参数一样；描述告诉模型「要我继续吗」这类不要用 ask_user。
    expect(INBOX_TOOLS_EN.map((t) => [t.name, t.inputSchema.required])).toEqual(INBOX_TOOLS.map((t) => [t.name, t.inputSchema.required]));
    expect(INBOX_TOOLS[0].description).toContain("要我继续吗");
    expect(INBOX_TOOLS_EN[0].description).toContain("shall I continue?");
  });

  it("a member cannot call coordinator tools; nothing is sent", async () => {
    const { server, requestsDir } = setup(200, { ticketKey: "P-1", member: true });
    const r = (await callTool(server, "start_session", { repo: "api", task: "t" })) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("start_session");
    expect(existsSync(requestsDir) ? readdirSync(requestsDir) : []).toEqual([]);
  });

  it("sends ask_user and report in each scope, dropping empty options and blank context, defaulting kind to progress", async () => {
    for (const scope of [{ ticketKey: "P-1", member: true }, { featureId: 7 }, { epicId: 3 }] as const) {
      const { server, answer } = setup(2000, scope);
      const ids = "ticketKey" in scope ? { ticketKey: "P-1" } : scope;
      const ask = callTool(server, "ask_user", { question: "Which?", options: [], context: " " });
      expect(await answer({ v: 1, ok: true, value: { id: 1 } })).toEqual({ v: 1, ...ids, from: "boss", op: "ask_user", question: "Which?" });
      await ask;
      const ask2 = callTool(server, "ask_user", { question: "Which?", options: ["A", "B"], context: "why" });
      expect(await answer({ v: 1, ok: true, value: { id: 2 } })).toEqual({ v: 1, ...ids, from: "boss", op: "ask_user", question: "Which?", options: ["A", "B"], context: "why" });
      await ask2;
      const rep = callTool(server, "report", { text: "half" });
      expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ v: 1, ...ids, from: "boss", op: "report", text: "half", kind: "progress" });
      await rep;
    }
  });

  it("refuses bad ask_user and report arguments without asking Butler", async () => {
    const { server, requestsDir } = setup(200);
    for (const [name, args] of [
      ["ask_user", {}], ["ask_user", { question: " " }], ["ask_user", { question: "q", options: ["1", "2", "3", "4", "5", "6", "7"] }],
      ["ask_user", { question: "q", options: [""] }], ["ask_user", { question: "q", context: 3 }],
      ["report", {}], ["report", { text: "x", kind: "finished" }], ["report", { text: "x".repeat(4001) }],
    ] as const) {
      const r = (await callTool(server, name, args)) as { result: { isError?: boolean } };
      expect(r.result.isError).toBe(true);
    }
    expect(existsSync(requestsDir) ? readdirSync(requestsDir) : []).toEqual([]);
  });
});
