import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { tempDir } from "../src/main/test-utils";
import { MESSAGE_LIMIT, REASON_LIMIT } from "../src/shared/control";
import {
  SHIPHERD_TOOLS, SHIPHERD_TOOLS_EN, FEATURE_SEND_TOOL, FEATURE_SEND_TOOL_EN, FEATURE_TOOLS, FEATURE_TOOLS_EN, INBOX_TOOLS, INBOX_TOOLS_EN, MEMBER_TOOLS, MEMBER_TOOLS_EN, STACK_TOOLS, SessionsServer,
  type SessionsServerOptions,
} from "./sessions-server";
import { serveStdio } from "./stdio";
import { sessionsOptionsFromEnv } from "./sessions-options";

function setup(timeoutMs = 2000, scope: SessionsServerOptions["scope"] = { featureId: 7 }, lang: "zh" | "en" = "zh") {
  const dir = tempDir("shipherd-control-");
  const requestsDir = join(dir, "requests");
  const resultsDir = join(dir, "results");
  mkdirSync(resultsDir, { recursive: true });
  const server = new SessionsServer({ scope, lang, from: "boss", requestsDir, resultsDir, timeoutMs, pollMs: 10 });
  /** 扮演 Shipherd：等一个请求出现，读出来，写回结果。 */
  const answer = async (result: object) => {
    for (;;) {
      const names = readdirSync(requestsDir, { withFileTypes: true }).filter((e) => e.name.endsWith(".json")).map((e) => e.name);
      if (names.length > 0) {
        const req = JSON.parse(readFileSync(join(requestsDir, names[0]), "utf8")) as object;
        // 和 Shipherd 一样拿走请求，下一次 answer 不会再读到它。
        unlinkSync(join(requestsDir, names[0]));
        writeFileSync(join(resultsDir, names[0]), JSON.stringify(result));
        return req;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { server, answer, requestsDir };
}

describe("shipherd-sessions MCP server", () => {
  it("answers initialize, ping and tools/list, and ignores notifications", async () => {
    const { server } = setup();
    expect(await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).toMatchObject({
      id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "shipherd-sessions" } },
    });
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await server.handle({ jsonrpc: "2.0", id: 2, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    const list = (await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools).toEqual([...FEATURE_TOOLS, FEATURE_SEND_TOOL, ...STACK_TOOLS, ...INBOX_TOOLS]);
    expect(await server.handle({ jsonrpc: "2.0", id: 4, method: "resources/list" })).toMatchObject({ id: 4, error: { code: -32601 } });
  });

  it("sends the model of start_session, and refuses an unknown one without sending anything", async () => {
    const { server, answer } = setup();
    const call = server.handle({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "start_session", arguments: { ticket: "A-1", task: "t", model: "sonnet" } } });
    expect(await answer({ v: 1, ok: true, value: {} })).toMatchObject({ op: "start_session", model: "sonnet" });
    await call;
    const tier = setup();
    const tierCall = tier.server.handle({ jsonrpc: "2.0", id: 24, method: "tools/call", params: { name: "start_session", arguments: { ticket: "A-1", task: "t", model: "mid" } } });
    expect(await tier.answer({ v: 1, ok: true, value: {} })).toMatchObject({ op: "start_session", model: "mid" });
    await tierCall;
    const bad = setup(200);
    expect(await bad.server.handle({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "start_session", arguments: { ticket: "A-1", task: "t", model: "bad name!" } } })).toMatchObject({ result: { isError: true } });
    const badFeature = setup(200, { featureId: 7 });
    expect(await badFeature.server.handle({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "start_session", arguments: { ticket: "A-1", task: "t", model: 3 } } })).toMatchObject({ result: { isError: true } });
    // 没发出任何请求：目录要么没建，要么是空的。
    expect(existsSync(bad.requestsDir) ? readdirSync(bad.requestsDir).filter((n) => n.endsWith(".json")) : []).toHaveLength(0);
  });

  it("start_session descriptions tell the coordinator to put only the task in task, the rest in memory", () => {
    const zh = [FEATURE_TOOLS].map((t) => t.find((x) => x.name === "start_session")!.description);
    const en = [FEATURE_TOOLS_EN].map((t) => t.find((x) => x.name === "start_session")!.description);
    for (const d of zh) expect(d).toContain("task 里只写要做什么，背景、接口约定写进记忆，子 session 会自己读。");
    for (const d of en) expect(d).toContain("Put only what to do in task");
  });

  it("lists model in the start_session schema, in both languages", () => {
    for (const tools of [FEATURE_TOOLS, FEATURE_TOOLS_EN]) {
      const start = tools.find((t) => t.name === "start_session")!;
      const model = (start.inputSchema.properties as Record<string, { enum?: readonly string[]; description: string }>).model;
      expect(model.enum).toBeUndefined();
      expect(model.description).toMatch(/high \/ mid \/ low/);
      expect(model.description).toMatch(/opus/);
      expect("required" in start.inputSchema && start.inputSchema.required).not.toContain("model");
    }
  });

  it("reports Shipherd's errors, bad arguments and a silent Shipherd as tool errors", async () => {
    // 有回答的那次用正常的超时（慢的 CI 机器上 200ms 可能来不及），只有「Shipherd 不回应」才用短超时。
    const answered = setup();
    const failing = answered.server.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_repos" } });
    await answered.answer({ v: 1, ok: false, error: "找不到 ticket" });
    expect(await failing).toMatchObject({ result: { isError: true, content: [{ text: "找不到 ticket" }] } });
    const { server } = setup(200);
    expect(await server.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "start_session", arguments: { ticket: "A-1" } } })).toMatchObject({ result: { isError: true } });
    expect(await server.handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "rm_rf" } })).toMatchObject({ result: { isError: true } });
    expect(await server.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_sessions" } })).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining("没有回应") }] },
    });
    expect(await server.handle({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "start_session", arguments: { ticket: "A-1", task: "t" } } })).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining("list_sessions") }] },
    });
  });

  it("withdraws pending requests when it shuts down", async () => {
    const { server, requestsDir } = setup(5000);
    void server.handle({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "start_session", arguments: { ticket: "A-1", task: "t" } } });
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
  });
});

describe("shipherd-sessions for a feature coordinator (design 2026-10-26)", () => {
  it("lists the feature tools", async () => {
    const { server } = setup(2000, { featureId: 7 });
    const list = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual([
      "list_tickets", "list_repos", "create_ticket", "start_session", "list_sessions", "session_activity", "end_session", "refresh_session",
      "list_features", "create_feature", "reorder_features", "set_ticket_feature", "get_workflow", "set_workflow", "list_workflow_presets", "send_message",
      "list_stacks", "stack_define", "stack_rebase", "stack_layer_mode", "ask_user", "report",
    ]);
    expect(list.result.tools).toEqual([...FEATURE_TOOLS, FEATURE_SEND_TOOL, ...STACK_TOOLS, ...INBOX_TOOLS]);
    expect(FEATURE_TOOLS_EN.find((t) => t.name === "set_ticket_feature")!.inputSchema.properties.feature.type).toEqual(["string", "null"]);
    expect(FEATURE_SEND_TOOL_EN.inputSchema.required).toEqual(["session", "text"]);
    expect(/[\u4e00-\u9fff]/.test(JSON.stringify(FEATURE_SEND_TOOL_EN))).toBe(false);
    // 英文版只换描述：名字、顺序、必填参数一样。
    const shape = (tools: readonly { name: string; inputSchema: object }[]) => tools.map((t) => [t.name, "required" in t.inputSchema ? t.inputSchema.required : []]);
    expect(shape(FEATURE_TOOLS_EN)).toEqual(shape(FEATURE_TOOLS));
    expect(FEATURE_TOOLS.find((t) => t.name === "create_ticket")!.inputSchema.required).toEqual(["ticket"]);
    const start = FEATURE_TOOLS.find((t) => t.name === "start_session")!;
    expect(start.inputSchema.required).toEqual(["ticket", "task"]);
    expect(shape(FEATURE_TOOLS).find(([n]) => n === "session_activity")).toEqual(["session_activity", ["session"]]);
    expect(FEATURE_TOOLS.at(-1)!.description).not.toBe(FEATURE_TOOLS_EN.at(-1)!.description);
  });

  it("sends send_message with the session, text and interrupt; rejects bad arguments (BTL-245)", async () => {
    const { server, answer } = setup(2000, { featureId: 7 });
    const call = server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_message", arguments: { session: "c1", text: "停一下", interrupt: true } } });
    expect(await answer({ v: 1, ok: true, value: { queued: true } })).toEqual({ v: 1, featureId: 7, from: "boss", op: "send_message", session: "c1", text: "停一下", interrupt: true });
    await call;
    for (const args of [{ session: "c1" }, { text: "x" }, { session: "c1", text: "x", interrupt: "yes" }]) {
      const bad = (await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send_message", arguments: args } })) as { result: { isError?: boolean } };
      expect(bad.result.isError).toBe(true);
    }
  });

  it("sends the block tools (features inside an epic, BTL-246), checking their arguments first", async () => {
    const send = async (name: string, args: object) => {
      const { server, answer } = setup(2000, { featureId: 7 });
      const call = server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
      const req = await answer({ v: 1, ok: true, value: {} });
      await call;
      return req;
    };
    expect(await send("list_features", {})).toEqual({ v: 1, featureId: 7, from: "boss", op: "list_features" });
    expect(await send("create_feature", { name: " Payment ", before: "Refunds" })).toEqual({ v: 1, featureId: 7, from: "boss", op: "create_feature", name: "Payment", before: "Refunds" });
    expect(await send("reorder_features", { order: ["B", "A"] })).toEqual({ v: 1, featureId: 7, from: "boss", op: "reorder_features", order: ["B", "A"] });
    expect(await send("set_ticket_feature", { ticket: "DMS-1", feature: null })).toEqual({ v: 1, featureId: 7, from: "boss", op: "set_ticket_feature", ticket: "DMS-1", feature: null });
    expect(await send("create_ticket", { ticket: "DMS-2", feature: "Payment" })).toMatchObject({ op: "create_ticket", feature: "Payment" });
    for (const [name, args] of [["create_feature", {}], ["reorder_features", { order: [] }], ["set_ticket_feature", { ticket: "DMS-1" }]] as const) {
      const { server } = setup(2000, { featureId: 7 });
      const r = (await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } })) as { result: { isError?: boolean; content: { text: string }[] } };
      expect(r.result.isError, name).toBe(true);
      expect(r.result.content[0].text, name).toContain(name);
    }
  });

  it("sends session_activity with the session id", async () => {
    for (const scope of [{ featureId: 7 }]) {
      const { server, answer } = setup(2000, scope);
      const call = server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "session_activity", arguments: { session: "c1" } } });
      expect(await answer({ v: 1, ok: true, value: { kind: "test" } })).toEqual({ v: 1, ...scope, from: "boss", op: "session_activity", session: "c1" });
      expect(JSON.stringify(await call)).toContain("test");
      const bad = (await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "session_activity", arguments: {} } })) as { result: { isError?: boolean } };
      expect(bad.result.isError).toBe(true);
    }
    const en = (await setup(2000, { featureId: 7 }, "en").server.handle({ jsonrpc: "2.0", id: 4, method: "tools/list" })) as { result: { tools: { name: string; description: string }[] } };
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

  it("rejects bad create_ticket arguments without asking Shipherd, and says what to check when Shipherd is slow", async () => {
    const { server, requestsDir } = setup(30, { featureId: 7 });
    const call = (id: number, args: object) => server.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "create_ticket", arguments: args } });
    for (const [n, args] of [[1, {}], [2, { ticket: "A-1", repos: "fe" }], [3, { ticket: "A-1", repos: [1] }], [4, { ticket: "A-1", title: 3 }]] as const) {
      expect(await call(n, args), String(n)).toMatchObject({ result: { isError: true } });
    }
    expect(existsSync(requestsDir)).toBe(false);
    expect(await call(5, { ticket: "A-1" })).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("list_tickets") }] } });
  });
});

describe("shipherd-sessions in English (design 2026-10-26 i18n)", () => {
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

describe("stack tools (workstream K)", () => {
  it("sends the stack tools and create_ticket's stack_on as requests, checking arguments first", async () => {
    for (const scope of [{ featureId: 7 }, { shipherd: true as const }]) {
      const { server, answer } = setup(2000, scope);
      const base = { v: 1, ...scope, from: "boss" };
      const cases: [string, object, object][] = [
        ["list_stacks", {}, { op: "list_stacks" }],
        ["stack_define", { branches: [" a ", "B-2"], repo: " shop ", name: "n", stack: 2 }, { op: "stack_define", branches: ["a", "B-2"], repo: "shop", name: "n", stack: 2 }],
        ["stack_define", { branches: ["a", "b"], name: "  " }, { op: "stack_define", branches: ["a", "b"] }],
        ["stack_rebase", { stack: 3 }, { op: "stack_rebase", stack: 3 }],
        ["stack_layer_mode", { stack: 3, branch: " b ", mode: "branch" }, { op: "stack_layer_mode", stack: 3, branch: "b", mode: "branch" }],
      ];
      for (const [tool, args, req] of cases) {
        const call = callTool(server, tool, args);
        expect(await answer({ v: 1, ok: true, value: [] })).toEqual({ ...base, ...req });
        await call;
      }
      for (const [tool, args] of [
        ["stack_define", { branches: ["a"] }], ["stack_define", { branches: ["a", ""] }], ["stack_define", { branches: ["a", "b"], stack: -1 }],
        ["stack_rebase", {}], ["stack_layer_mode", { stack: 1, branch: "b", mode: "ready" }],
      ] as [string, object][]) {
        const bad = (await callTool(server, tool, args)) as { result: { isError?: boolean } };
        expect(bad.result.isError).toBe(true);
      }
    }
    const { server, answer } = setup(2000, { featureId: 7 });
    const call = callTool(server, "create_ticket", { ticket: "P-2", stack_on: " P-1 " });
    expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ v: 1, featureId: 7, from: "boss", op: "create_ticket", ticket: "P-2", stack_on: "P-1" });
    await call;
    expect(((await callTool(server, "create_ticket", { ticket: "P-2", stack_on: 1 })) as { result: { isError?: boolean } }).result.isError).toBe(true);
  });
});

describe("end_session (task 11)", () => {
  const scopes = [{ featureId: 7 }];
  const lists = [[FEATURE_TOOLS, FEATURE_TOOLS_EN]] as const;

  it("is in both tool lists in both languages, with session and reason required", () => {
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

  it("adds a line saying how many more sessions fit when the result carries capacity (workstream W), in both languages", async () => {
    const capacity = { canStart: 3, availableMb: 9216, sessionMb: 1024, estimate: "measured" as const, reserveMb: 2048, pending: 1, running: 4, maxRunning: null, pressure: "normal" as const, source: "vm_stat" as const };
    for (const [lang, want] of [["zh", "现在还能再开 3 个 session"], ["en", "You can start 3 more sessions now"]] as const) {
      const { server, answer } = setup(2000, { featureId: 7 }, lang);
      const call = callTool(server, "list_sessions");
      await answer({ v: 1, ok: true, value: [], capacity });
      const r = (await call) as { result: { content: { text: string }[] } };
      expect(r.result.content).toHaveLength(2);
      expect(r.result.content[1].text).toContain(want);
      expect(r.result.content[1].text).toContain("9.0 GB");
    }
    const { server, answer } = setup();
    const plain = callTool(server, "list_sessions");
    await answer({ v: 1, ok: true, value: [] });
    expect(((await plain) as { result: { content: unknown[] } }).result.content).toHaveLength(1);
  });

  it("sends end_session with the session and the reason, in every scope", async () => {
    for (const scope of scopes) {
      const { server, answer } = setup(2000, scope);
      const call = callTool(server, "end_session", { session: "c1", reason: "PR 已合并" });
      expect(await answer({ v: 1, ok: true, value: { ended: true } })).toEqual({ v: 1, ...scope, from: "boss", op: "end_session", session: "c1", reason: "PR 已合并" });
      expect(JSON.stringify(await call)).toContain("ended");
    }
  });

  it("rejects end_session without a session or a reason, or with a reason over the limit, without asking Shipherd", async () => {
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
  const scopes = [{ featureId: 7 }];
  const lists = [[FEATURE_TOOLS, FEATURE_TOOLS_EN]] as const;

  it("is in both tool lists in both languages, with session required", () => {
    for (const [zh, en] of lists) {
      const find = (list: readonly object[]) => (list as readonly { name: string; description: string; inputSchema: object }[]).find((x) => x.name === "refresh_session")!;
      for (const list of [zh, en]) expect(find(list).inputSchema).toMatchObject({ required: ["session"], properties: { session: { type: "string" } } });
      expect(find(zh).description).toBe("让 Shipherd 给一个停下来的子 session 换新上下文：先写 handoff，再清空，再从记忆里接上。只能对你管的、已经停下来的 session 用。");
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

  it("rejects refresh_session without a session string, without asking Shipherd", async () => {
    for (const scope of scopes) {
      const { server, requestsDir } = setup(30, scope);
      for (const args of [{}, { session: "" }, { session: 1 }]) {
        expect(await callTool(server, "refresh_session", args), JSON.stringify(args)).toMatchObject({ result: { isError: true } });
      }
      expect(existsSync(requestsDir)).toBe(false);
    }
  });
});

describe("ask_user and report for every Shipherd session (BTL-190 2+3)", () => {
  it("a member (normal ticket session) has submit_evidence, pre_review_result, ask_user and report, in both languages", async () => {
    expect(await tools(setup(2000, { ticketKey: "P-1" }).server)).toEqual([...MEMBER_TOOLS, ...INBOX_TOOLS]);
    const en = await tools(setup(2000, { ticketKey: "P-1" }, "en").server);
    expect(en).toEqual([...MEMBER_TOOLS_EN, ...INBOX_TOOLS_EN]);
    expect(MEMBER_TOOLS_EN.map((t) => [t.name, "required" in t.inputSchema ? t.inputSchema.required : []]))
      .toEqual(MEMBER_TOOLS.map((t) => [t.name, "required" in t.inputSchema ? t.inputSchema.required : []]));
    for (const t of MEMBER_TOOLS) expect(t.description).toMatch(/[\u4e00-\u9fff]/);
    expect(/[一-鿿]/.test(JSON.stringify(en))).toBe(false);
    // 英文版名字和必填参数一样；描述告诉模型「要我继续吗」这类不要用 ask_user。
    expect(INBOX_TOOLS_EN.map((t) => [t.name, t.inputSchema.required])).toEqual(INBOX_TOOLS.map((t) => [t.name, t.inputSchema.required]));
    expect(INBOX_TOOLS[0].description).toContain("要我继续吗");
    expect(INBOX_TOOLS_EN[0].description).toContain("shall I continue?");
  });

  it("a member sends submit_evidence cleaned up, and pre_review_result (ws-g)", async () => {
    const { server, answer, requestsDir } = setup(2000, { ticketKey: "P-1" });
    const base = { v: 1, ticketKey: "P-1", from: "boss" };
    const sub = callTool(server, "submit_evidence", {
      checks: [{ name: "unit", category: "test", command: "pnpm test", result: "pass", output: "12 passed" }, { name: "junk" }],
      acceptance: [{ criterion: "AC1", how: "added a branch" }],
    });
    expect(await answer({ v: 1, ok: true, value: { note: "queued" } })).toEqual({
      ...base, op: "submit_evidence",
      evidence: { checks: [{ name: "unit", category: "test", command: "pnpm test", result: "pass", output: "12 passed" }], acceptance: [{ criterion: "AC1", how: "added a branch" }] },
    });
    await sub;
    const res = callTool(server, "pre_review_result");
    expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ ...base, op: "pre_review_result" });
    await res;
    // 什么成形的都没有：不发。
    const bad = (await callTool(server, "submit_evidence", { checks: [{ name: "x" }], acceptance: [] })) as { result: { isError?: boolean } };
    expect(bad.result.isError).toBe(true);
    expect(existsSync(requestsDir) ? readdirSync(requestsDir) : []).toEqual([]);
  });

  it("a ticket session cannot call session-management tools; nothing is sent", async () => {
    const { server, requestsDir } = setup(200, { ticketKey: "P-1" });
    const r = (await callTool(server, "start_session", { repo: "api", task: "t" })) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("start_session");
    for (const name of ["list_sessions", "list_repos", "session_activity", "end_session", "refresh_session"]) {
      expect(await callTool(server, name, { session: "s", reason: "r" }), name).toMatchObject({ result: { isError: true } });
    }
    // ticket 的 session 只有这五个工具：没有总控的那一套（BTL-273 加了 workflow_step_done）。
    expect((await tools(server)).map((t) => t.name)).toEqual(["submit_evidence", "pre_review_result", "workflow_step_done", "ask_user", "report"]);
    expect(existsSync(requestsDir) ? readdirSync(requestsDir) : []).toEqual([]);
  });

  it("sends ask_user and report in each scope, dropping empty options and blank context, defaulting kind to progress", async () => {
    for (const scope of [{ ticketKey: "P-1" }, { featureId: 7 }] as const) {
      const { server, answer } = setup(2000, scope);
      const ids = scope;
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

  it("passes a valid recommended option and choice reports, and drops an out-of-range recommendation (ws-j)", async () => {
    const { server, answer } = setup(2000, { ticketKey: "P-1" });
    const ask = callTool(server, "ask_user", { question: "Which?", options: ["A", "B"], recommended: 1 });
    expect(await answer({ v: 1, ok: true, value: { id: 1 } })).toEqual({ v: 1, ticketKey: "P-1", from: "boss", op: "ask_user", question: "Which?", options: ["A", "B"], recommended: 1 });
    await ask;
    const bad = callTool(server, "ask_user", { question: "Which?", options: ["A", "B"], recommended: 2 });
    expect(await answer({ v: 1, ok: true, value: { id: 2 } })).toEqual({ v: 1, ticketKey: "P-1", from: "boss", op: "ask_user", question: "Which?", options: ["A", "B"] });
    await bad;
    const rep = callTool(server, "report", { text: "picked A", kind: "choice" });
    expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ v: 1, ticketKey: "P-1", from: "boss", op: "report", text: "picked A", kind: "choice" });
    await rep;
  });

  it("refuses bad ask_user and report arguments without asking Shipherd", async () => {
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

describe("shipherd-sessions for the Shipherd 总控 (BTL-190 5)", () => {
  const NAMES = ["list_epics", "list_tickets", "list_prs", "list_sessions", "session_activity", "list_inbox", "send_message", "refresh_session", "progress_overview", "refresh_epic_summary", "metrics_overview", "pr_assessment", "list_features", "get_workflow", "set_workflow", "list_workflow_presets"];

  it("lists only read tools, send_message and refresh_session, plus ask_user and report, in both languages", async () => {
    expect(await tools(setup(2000, { shipherd: true }).server)).toEqual([...SHIPHERD_TOOLS, ...STACK_TOOLS, ...INBOX_TOOLS]);
    expect(SHIPHERD_TOOLS.map((t) => t.name)).toEqual(NAMES);
    // 不建、不删、不结束；没有开 session 的工具（send_message 会接着关掉的终端）。
    for (const t of ["create_ticket", "start_session", "end_session"]) expect(NAMES).not.toContain(t);
    for (const t of SHIPHERD_TOOLS) expect(t.description).toMatch(/[\u4e00-\u9fff]/);
    expect(SHIPHERD_TOOLS_EN.map((t) => [t.name, "required" in t.inputSchema ? t.inputSchema.required : []]))
      .toEqual(SHIPHERD_TOOLS.map((t) => [t.name, "required" in t.inputSchema ? t.inputSchema.required : []]));
    const en = await tools(setup(2000, { shipherd: true }, "en").server);
    expect(/[\u4e00-\u9fff]/.test(JSON.stringify(en))).toBe(false);
    expect(en.map((t) => t.name)).toEqual([...NAMES, ...STACK_TOOLS.map((t) => t.name), "ask_user", "report"]);
    // send_message 说清楚只能发给 epic 总控（BTL-246）。
    const send = SHIPHERD_TOOLS.find((t) => t.name === "send_message")!;
    expect(send.description).toContain("epic 总控");
    expect(send.inputSchema).toMatchObject({ required: ["text"] });
    expect(Object.keys(send.inputSchema.properties)).toEqual(["session", "epic", "text", "interrupt"]);
    // 中英文的参数一样。
    for (const [i, t] of SHIPHERD_TOOLS.entries()) expect(Object.keys(SHIPHERD_TOOLS_EN[i].inputSchema.properties ?? {}), t.name).toEqual(Object.keys(t.inputSchema.properties ?? {}));
  });

  it("sends each tool as a shipherd request, turning epic ids into strings", async () => {
    const { server, answer } = setup(2000, { shipherd: true });
    const base = { v: 1, shipherd: true, from: "boss" };
    for (const op of ["list_epics", "list_features", "list_prs", "list_sessions", "list_inbox"]) {
      const call = callTool(server, op);
      expect(await answer({ v: 1, ok: true, value: [] })).toEqual({ ...base, op });
      await call;
    }
    const a = callTool(server, "list_tickets", { epic: 5 });
    expect(await answer({ v: 1, ok: true, value: [] })).toEqual({ ...base, op: "list_tickets", epic: "5" });
    await a;
    const a2 = callTool(server, "list_features", { epic: "shop" });
    expect(await answer({ v: 1, ok: true, value: [] })).toEqual({ ...base, op: "list_features", epic: "shop" });
    await a2;
    const b = callTool(server, "list_tickets");
    expect(await answer({ v: 1, ok: true, value: [] })).toEqual({ ...base, op: "list_tickets" });
    await b;
    const pa = callTool(server, "pr_assessment", { pr: 12 });
    expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ ...base, op: "pr_assessment", pr: "12" });
    await pa;
    const c = callTool(server, "session_activity", { session: "e1" });
    expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ ...base, op: "session_activity", session: "e1" });
    await c;
    const d = callTool(server, "send_message", { session: "e1", text: "先合 checkout" });
    expect(await answer({ v: 1, ok: true, value: { sent: true } })).toEqual({ ...base, op: "send_message", session: "e1", text: "先合 checkout" });
    expect(JSON.stringify(await d)).toContain("sent");
    // epic 的 id 是数字：转成字符串。
    const d2 = callTool(server, "send_message", { epic: 4, text: "看 PR" });
    expect(await answer({ v: 1, ok: true, value: { sent: true } })).toEqual({ ...base, op: "send_message", epic: "4", text: "看 PR" });
    await d2;
    const e = callTool(server, "refresh_session", { session: "e1" });
    expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ ...base, op: "refresh_session", session: "e1" });
    await e;
    const g = callTool(server, "progress_overview", { epic: 3 });
    expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ ...base, op: "progress_overview", epic: "3" });
    await g;
    const g2 = callTool(server, "progress_overview");
    expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ ...base, op: "progress_overview" });
    await g2;
    const m = callTool(server, "metrics_overview", { days: 90 });
    expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ ...base, op: "metrics_overview", days: 90 });
    await m;
    const m2 = callTool(server, "metrics_overview");
    expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ ...base, op: "metrics_overview" });
    await m2;
    const h = callTool(server, "refresh_epic_summary", { epic: 4 });
    expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ ...base, op: "refresh_epic_summary", epic: "4" });
    await h;
    const f = callTool(server, "report", { text: "巡检完了", kind: "done" });
    expect(await answer({ v: 1, ok: true, value: {} })).toEqual({ ...base, op: "report", text: "巡检完了", kind: "done" });
    await f;
  });

  it("refuses bad arguments and tools it does not have without asking Shipherd", async () => {
    const { server, requestsDir } = setup(30, { shipherd: true });
    // { feature } 是 BTL-246 以前的目标（现在叫 epic）：只给它等于没给目标。
    for (const [name, args] of [
      ["send_message", {}], ["send_message", { session: "e1" }], ["send_message", { session: "e1", text: " " }], ["send_message", { text: "t" }],
      ["send_message", { session: "e1", text: "x".repeat(MESSAGE_LIMIT + 1) }], ["send_message", { session: "e1", epic: "f", text: "t" }],
      ["send_message", { epic: "", text: "t" }], ["send_message", { feature: "shop", text: "t" }], ["session_activity", {}], ["refresh_session", { session: "" }],
      ["list_tickets", { epic: true }], ["list_tickets", { epic: 1.5 }], ["list_features", { epic: "" }],
      ["progress_overview", { epic: "" }], ["refresh_epic_summary", {}], ["refresh_epic_summary", { epic: " " }], ["refresh_feature_summary", { feature: "4" }],
      ["metrics_overview", { days: 0 }], ["metrics_overview", { days: 366 }], ["metrics_overview", { days: 1.5 }], ["metrics_overview", { days: "30" }],
      ["start_session", { repo: "r", task: "t" }], ["create_feature", { name: "a", brief: "b" }], ["end_session", { session: "s", reason: "r" }],
    ] as const) {
      expect(await callTool(server, name, args), `${name} ${JSON.stringify(args).slice(0, 40)}`).toMatchObject({ result: { isError: true } });
    }
    expect(existsSync(requestsDir) ? readdirSync(requestsDir) : []).toEqual([]);
    const en = setup(30, { shipherd: true }, "en");
    expect(JSON.stringify(await callTool(en.server, "send_message", {}))).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it("other scopes do not have the Shipherd 总控 tools", async () => {
    for (const scope of [{ featureId: 7 }, { ticketKey: "P-1" }]) {
      expect(await callTool(setup(30, scope).server, "send_message", { session: "s", text: "t" })).toMatchObject({ result: { isError: true } });
      expect(await callTool(setup(30, scope).server, "list_prs")).toMatchObject({ result: { isError: true } });
    }
  });
});

describe("sessionsOptionsFromEnv", () => {
  const dirs = { SHIPHERD_CONTROL_REQUESTS: "/req", SHIPHERD_CONTROL_RESULTS: "/res" };

  it("reads the ticket, feature or Shipherd scope", () => {
    expect(sessionsOptionsFromEnv({ ...dirs, SHIPHERD_TICKET: "P-1" }, "s1")?.scope).toEqual({ ticketKey: "P-1" });
    expect(sessionsOptionsFromEnv({ ...dirs, SHIPHERD_FEATURE: "7" }, "s1")?.scope).toEqual({ featureId: 7 });
    expect(sessionsOptionsFromEnv({ ...dirs, SHIPHERD_SCOPE: "shipherd" }, "s1")?.scope).toEqual({ shipherd: true });
  });

  it("has no scope for the removed epic session's variables (BTL-246)", () => {
    // 升级前写下的配置里可能还有这两个变量：SHIPHERD_EPIC 不再是作用域，SHIPHERD_FEATURE_EPIC 不再加工具。
    expect(sessionsOptionsFromEnv({ ...dirs, SHIPHERD_EPIC: "3" }, "s1")).toBeNull();
    expect(sessionsOptionsFromEnv({ ...dirs, SHIPHERD_FEATURE: "7", SHIPHERD_FEATURE_EPIC: "1" }, "s1")?.scope).toEqual({ featureId: 7 });
  });
});

describe("workflow tools (BTL-273)", () => {
  it("both coordinators get get/set/list_workflow_presets in both languages; a ticket session gets workflow_step_done", async () => {
    for (const scope of [{ featureId: 7 }, { shipherd: true }] as const) {
      const zh = (await tools(setup(2000, scope).server)).map((t) => t.name);
      const en = (await tools(setup(2000, scope, "en").server)).map((t) => t.name);
      for (const n of ["get_workflow", "set_workflow", "list_workflow_presets"]) {
        expect(zh, JSON.stringify(scope)).toContain(n);
        expect(en).toContain(n);
      }
      expect(zh).not.toContain("workflow_step_done");
    }
    const member = await tools(setup(2000, { ticketKey: "P-1" }).server);
    expect(member.map((t) => t.name)).toContain("workflow_step_done");
    expect(member.map((t) => t.name)).not.toContain("set_workflow");
    const zhSet = FEATURE_TOOLS.find((t) => t.name === "set_workflow")!;
    const enSet = FEATURE_TOOLS_EN.find((t) => t.name === "set_workflow")!;
    expect(zhSet.description).toMatch(/[\u4e00-\u9fff]/);
    expect(/[\u4e00-\u9fff]/.test(JSON.stringify(enSet))).toBe(false);
    expect(Object.keys(enSet.inputSchema.properties)).toEqual(Object.keys(zhSet.inputSchema.properties));
    expect(SHIPHERD_TOOLS.find((t) => t.name === "set_workflow")).toBe(zhSet);
  });

  it("sends the workflow requests with the caller's scope, and refuses bad arguments without asking Shipherd", async () => {
    const f = setup(2000, { featureId: 7 });
    const get = callTool(f.server, "get_workflow", { ticket: "DMS-1" });
    expect(await f.answer({ v: 1, ok: true, value: {} })).toEqual({ v: 1, featureId: 7, from: "boss", op: "get_workflow", ticket: "DMS-1" });
    await get;
    const set = callTool(f.server, "set_workflow", { scope: "epic:4.3.0", steps: ["implement", "open_pr", { id: "merge", mergeBy: "coordinator" }] });
    expect(await f.answer({ v: 1, ok: true, value: {} })).toEqual({
      v: 1, featureId: 7, from: "boss", op: "set_workflow", scope: "epic:4.3.0", steps: ["implement", "open_pr", { id: "merge", mergeBy: "coordinator" }],
    });
    await set;
    const g = setup(2000, { shipherd: true });
    const clear = callTool(g.server, "set_workflow", { scope: "global", steps: null });
    expect(await g.answer({ v: 1, ok: true, value: {} })).toEqual({ v: 1, shipherd: true, from: "boss", op: "set_workflow", scope: "global", steps: null });
    await clear;
    const bad = setup(200, { shipherd: true });
    for (const args of [{ scope: "planet:x", steps: null }, { steps: [] }, {}, { steps: ["implement"], notes: "x".repeat(4001) }]) {
      expect(await callTool(bad.server, "set_workflow", args), JSON.stringify(args).slice(0, 80)).toMatchObject({ result: { isError: true } });
    }
    expect(existsSync(bad.requestsDir) ? readdirSync(bad.requestsDir) : []).toEqual([]);
  });

  it("a ticket session sends workflow_step_done and can't send coordinator workflow tools", async () => {
    const t = setup(2000, { ticketKey: "P-1" });
    const done = callTool(t.server, "workflow_step_done", { step: "self_review", note: " ran code-review " });
    expect(await t.answer({ v: 1, ok: true, value: {} })).toEqual({ v: 1, ticketKey: "P-1", from: "boss", op: "workflow_step_done", step: "self_review", note: "ran code-review" });
    await done;
    const bad = setup(200, { ticketKey: "P-1" });
    for (const [name, args] of [["workflow_step_done", { step: "fly" }], ["workflow_step_done", {}], ["set_workflow", { steps: null }]] as const) {
      expect(await callTool(bad.server, name, args), name).toMatchObject({ result: { isError: true } });
    }
    expect(existsSync(bad.requestsDir) ? readdirSync(bad.requestsDir) : []).toEqual([]);
  });
});
