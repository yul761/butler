import { describe, expect, it } from "vitest";
import { Hub, type HubBackend, parseHubCommand } from "./hub";

const T1 = "1".repeat(43);
const T2 = "2".repeat(43);

function fakeBackend(scope: string, log: string[]): HubBackend {
  return {
    init: async () => void log.push(`init ${scope}`),
    close: async () => void log.push(`close ${scope}`),
    remember: async ({ text }) => {
      log.push(`remember ${scope} ${text}`);
      return { ok: true, mode: "note" };
    },
    recall: async () => ({ scope }),
    facts: async () => [],
    why: async () => null,
    forget: async () => ({ ok: true }),
    handoff: async () => ({ ok: true, superseded: false }),
  };
}

const call = (id: number, name: string, args: object = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

describe("Hub", () => {
  it("serves memory routes per scope and shares one backend between routes of the same scope", async () => {
    const log: string[] = [];
    const hub = new Hub({ backend: (s) => fakeBackend(s, log) });
    hub.apply({ op: "add", token: T1, route: { server: "memory", scope: "ticket:A" } });
    hub.apply({ op: "add", token: T2, route: { server: "memory", scope: "ticket:A" } });
    await hub.handler(T1)!(call(1, "remember", { text: "one" }));
    await hub.handler(T2)!(call(2, "remember", { text: "two" }));
    expect(log).toEqual(["init ticket:A", "remember ticket:A one", "remember ticket:A two"]);
    expect(hub.openBackends).toBe(1);
  });

  it("does not open a backend for the handshake or the tool list", async () => {
    const log: string[] = [];
    const hub = new Hub({ backend: (s) => fakeBackend(s, log) });
    hub.apply({ op: "add", token: T1, route: { server: "memory", scope: "s" } });
    const init = await hub.handler(T1)!({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init).toMatchObject({ result: { serverInfo: { name: "statecore" } } });
    await hub.handler(T1)!({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(log).toEqual([]);
  });

  it("closes a backend unused for 30 minutes and opens it again when needed", async () => {
    const log: string[] = [];
    let now = 0;
    const hub = new Hub({ backend: (s) => fakeBackend(s, log), now: () => now });
    hub.apply({ op: "add", token: T1, route: { server: "memory", scope: "s" } });
    await hub.handler(T1)!(call(1, "recall"));
    now = 29 * 60_000;
    await hub.sweep();
    expect(hub.openBackends).toBe(1);
    now = 31 * 60_000;
    await hub.sweep();
    expect(hub.openBackends).toBe(0);
    await hub.handler(T1)!(call(2, "recall"));
    expect(log).toEqual(["init s", "close s", "init s"]);
  });

  it("forgets a removed token: 404 afterwards", async () => {
    const hub = new Hub({ backend: (s) => fakeBackend(s, []) });
    hub.apply({ op: "add", token: T1, route: { server: "memory", scope: "s" } });
    hub.apply({ op: "remove", token: T1 });
    expect(hub.handler(T1)).toBeNull();
    expect(hub.size).toBe(0);
  });

  it("gives each sessions route its own server with the route's caller, and withdraws its requests when the route goes", async () => {
    const made: { from: string | null; withdrawn: number }[] = [];
    const hub = new Hub({
      backend: (s) => fakeBackend(s, []),
      sessions: (r) => {
        const m = { from: r.from, withdrawn: 0 };
        made.push(m);
        return { handle: async () => ({ from: r.from }), withdrawAll: () => void m.withdrawn++ };
      },
    });
    hub.apply({ op: "add", token: T1, route: { server: "sessions", env: { SHIPHERD_TICKET: "A" }, from: "term-1" } });
    hub.apply({ op: "add", token: T2, route: { server: "sessions", env: { SHIPHERD_TICKET: "A" }, from: "term-2" } });
    expect(await hub.handler(T2)!({ id: 1, method: "tools/list" })).toEqual({ from: "term-2" });
    hub.apply({ op: "remove", token: T1 });
    expect(made).toEqual([{ from: "term-1", withdrawn: 1 }, { from: "term-2", withdrawn: 0 }]);
    // 重发同一个 token（hub 重启后）：旧的撤掉，换成新的。
    hub.apply({ op: "add", token: T2, route: { server: "sessions", env: { SHIPHERD_TICKET: "A" }, from: "term-2" } });
    expect(made[1].withdrawn).toBe(1);
    await hub.closeAll();
    expect(made[2].withdrawn).toBe(1);
  });

  it("builds the real shipherd-sessions server from the route's variables and its caller", async () => {
    const hub = new Hub({ backend: (s) => fakeBackend(s, []) });
    hub.apply({ op: "add", token: T1, route: { server: "sessions", env: { SHIPHERD_TICKET: "A", SHIPHERD_MEMBER: "1", SHIPHERD_CONTROL_REQUESTS: "/r", SHIPHERD_CONTROL_RESULTS: "/s" }, from: "t" } });
    const r = (await hub.handler(T1)!({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(r.result.tools.map((t) => t.name)).toEqual(["submit_evidence", "pre_review_result", "workflow_step_done", "ask_user", "report"]);
    // 少了控制目录：不建，也不报错。
    hub.apply({ op: "add", token: T2, route: { server: "sessions", env: { SHIPHERD_TICKET: "A" }, from: null } });
    expect(hub.handler(T2)).toBeNull();
  });

  it("drops a scope whose backend failed to open, so the next call tries again", async () => {
    let fail = true;
    const hub = new Hub({
      backend: (s) => ({ ...fakeBackend(s, []), init: async () => { if (fail) throw new Error("locked"); } }),
    });
    hub.apply({ op: "add", token: T1, route: { server: "memory", scope: "s" } });
    const r = (await hub.handler(T1)!(call(1, "recall"))) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(r.result).toMatchObject({ isError: true, content: [{ text: "locked" }] });
    fail = false;
    const ok = (await hub.handler(T1)!(call(2, "recall"))) as { result: { isError?: boolean } };
    expect(ok.result.isError).toBeUndefined();
  });
});

describe("parseHubCommand", () => {
  it("reads add and remove lines and rejects anything else", () => {
    expect(parseHubCommand(JSON.stringify({ op: "add", token: T1, route: { server: "memory", scope: "s" } }))).toEqual({ op: "add", token: T1, route: { server: "memory", scope: "s" } });
    expect(parseHubCommand(JSON.stringify({ op: "remove", token: T1 }))).toEqual({ op: "remove", token: T1 });
    expect(parseHubCommand(JSON.stringify({ op: "add", token: T1, route: { server: "sessions", env: { A: "1", B: 2 }, from: null } }))).toEqual({
      op: "add", token: T1, route: { server: "sessions", env: { A: "1" }, from: null },
    });
    expect(parseHubCommand("nope")).toBeNull();
    expect(parseHubCommand(JSON.stringify({ op: "add", token: "short", route: { server: "memory", scope: "s" } }))).toBeNull();
    expect(parseHubCommand(JSON.stringify({ op: "add", token: T1, route: { server: "other" } }))).toBeNull();
  });
});
