import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { tempDir } from "../src/main/test-utils";
import { FEATURE_TOOLS, SessionsServer, serveStdio, TOOLS } from "./sessions-server";

function setup(timeoutMs = 2000, scope: { ticketKey: string } | { featureId: number } = { ticketKey: "P-1" }, lang: "zh" | "en" = "zh") {
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
    expect(list.result.tools.map((t) => t.name)).toEqual(["list_repos", "start_session", "list_sessions"]);
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
    expect(TOOLS.length).toBe(3);
  });
});

describe("butler-sessions for a feature coordinator (design 2026-10-26)", () => {
  it("lists the feature tools", async () => {
    const { server } = setup(2000, { featureId: 7 });
    const list = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["list_tickets", "start_session", "list_sessions"]);
    expect(list.result.tools).toEqual(FEATURE_TOOLS);
    const start = FEATURE_TOOLS.find((t) => t.name === "start_session")!;
    expect(start.inputSchema.required).toEqual(["ticket", "task"]);
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

  it("rejects start_session without a ticket, and the ticket-only tool", async () => {
    const { server } = setup(2000, { featureId: 7 });
    const noTicket = (await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "start_session", arguments: { task: "x" } } })) as { result: { isError?: boolean } };
    expect(noTicket.result.isError).toBe(true);
    const repos = (await server.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_repos", arguments: {} } })) as { result: { isError?: boolean } };
    expect(repos.result.isError).toBe(true);
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
