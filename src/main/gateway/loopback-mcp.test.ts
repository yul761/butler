import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { type LoopbackMcp, type RpcMessage, startLoopbackMcp } from "./loopback-mcp";

const TOKEN = "a".repeat(43);
let hub: LoopbackMcp | null = null;
const seen: RpcMessage[] = [];

afterEach(async () => {
  await hub?.close();
  hub = null;
  seen.length = 0;
});

async function start(): Promise<LoopbackMcp> {
  hub = await startLoopbackMcp({
    port: 0,
    route: (t) => (t === TOKEN ? async (msg) => {
      seen.push(msg);
      return msg.id === undefined ? null : { jsonrpc: "2.0", id: msg.id, result: { echo: msg.method } };
    } : null),
  });
  return hub;
}

function call(port: number, o: { method?: string; path?: string; body?: string; headers?: Record<string, string> }): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, method: o.method ?? "POST", path: o.path ?? `/mcp/${TOKEN}`,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...o.headers },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

const rpc = (id: number | undefined, method: string) => JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined && { id }), method });

describe("startLoopbackMcp", () => {
  it("answers a request on its token with a JSON body and no session id", async () => {
    const { port } = await start();
    const r = await call(port, { body: rpc(1, "tools/list") });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers["mcp-session-id"]).toBeUndefined();
    expect(JSON.parse(r.body)).toEqual({ jsonrpc: "2.0", id: 1, result: { echo: "tools/list" } });
  });

  it("returns 202 for a notification and still passes it to the server", async () => {
    const { port } = await start();
    const r = await call(port, { body: rpc(undefined, "notifications/initialized") });
    expect(r.status).toBe(202);
    expect(r.body).toBe("");
    expect(seen.map((m) => m.method)).toEqual(["notifications/initialized"]);
  });

  it("answers a batch with an array of the replies", async () => {
    const { port } = await start();
    const r = await call(port, { body: `[${rpc(1, "a")},${rpc(undefined, "n")},${rpc(2, "b")}]` });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual([{ jsonrpc: "2.0", id: 1, result: { echo: "a" } }, { jsonrpc: "2.0", id: 2, result: { echo: "b" } }]);
  });

  it("returns 404 for an unknown or malformed token, never 401", async () => {
    const { port } = await start();
    expect((await call(port, { path: `/mcp/${"b".repeat(43)}`, body: rpc(1, "x") })).status).toBe(404);
    expect((await call(port, { path: "/mcp/short", body: rpc(1, "x") })).status).toBe(404);
    expect((await call(port, { path: `/other/${TOKEN}`, body: rpc(1, "x") })).status).toBe(404);
    expect(seen).toEqual([]);
  });

  it("rejects a Host that is not 127.0.0.1:<port> and any Origin (DNS rebinding, browsers)", async () => {
    const { port } = await start();
    expect((await call(port, { body: rpc(1, "x"), headers: { Host: `localhost:${port}` } })).status).toBe(403);
    expect((await call(port, { body: rpc(1, "x"), headers: { Host: `evil.example:${port}` } })).status).toBe(403);
    expect((await call(port, { body: rpc(1, "x"), headers: { Origin: "http://127.0.0.1" } })).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("returns 405 for GET and DELETE: no streams, no sessions", async () => {
    const { port } = await start();
    const get = await call(port, { method: "GET" });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST");
    expect((await call(port, { method: "DELETE" })).status).toBe(405);
  });

  it("returns a JSON-RPC parse error for a body that is not JSON, and 400 for an empty batch", async () => {
    const { port } = await start();
    const r = await call(port, { body: "{nope" });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error.code).toBe(-32700);
    expect((await call(port, { body: "[]" })).status).toBe(400);
  });

  it("turns a handler that throws into a JSON-RPC internal error", async () => {
    hub = await startLoopbackMcp({ port: 0, route: () => async () => { throw new Error("boom"); } });
    const r = await call(hub.port, { body: rpc(7, "x") });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ id: 7, error: { code: -32603, message: "Error: boom" } });
  });

  it("still returns 202 for a notification whose handler throws", async () => {
    const logs: string[] = [];
    hub = await startLoopbackMcp({ port: 0, route: () => async () => { throw new Error("boom"); }, log: (m) => logs.push(m) });
    const r = await call(hub.port, { body: rpc(undefined, "notifications/initialized") });
    expect(r.status).toBe(202);
    expect(logs).toEqual(["MCP notification failed"]);
  });

  it("listens on 127.0.0.1 only, on the port it was asked for", async () => {
    const first = await start();
    await first.close();
    hub = await startLoopbackMcp({ port: first.port, route: () => null });
    expect(hub.port).toBe(first.port);
    await expect(startLoopbackMcp({ port: first.port, route: () => null })).rejects.toThrow(/EADDRINUSE/);
  });
});
