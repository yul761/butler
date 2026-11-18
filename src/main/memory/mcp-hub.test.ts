import { describe, expect, it } from "vitest";
import { type HubChild, McpHub } from "./mcp-hub";

class FakeChild implements HubChild {
  written: string[] = [];
  ended = false;
  killed = false;
  private handlers: Record<string, ((...a: never[]) => void)[]> = {};
  stdin = { write: (s: string) => this.written.push(s), end: () => { this.ended = true; } };
  stdout = { on: (_ev: "data", cb: (c: string) => void) => this.on("data", cb) };
  constructor(readonly args: string[]) {}
  on(ev: string, cb: (...a: never[]) => void): this {
    (this.handlers[ev] ??= []).push(cb);
    return this;
  }
  emit(ev: string, ...a: unknown[]): void {
    for (const h of this.handlers[ev] ?? []) (h as (...x: unknown[]) => void)(...a);
  }
  ready(port: number): void {
    this.emit("data", `${JSON.stringify({ ready: true, port })}\n`);
  }
  kill(): void {
    this.killed = true;
  }
  cmds(): { op: string; token: string; route?: unknown }[] {
    return this.written.map((l) => JSON.parse(l));
  }
}

function setup() {
  const children: FakeChild[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  let now = 0;
  let changes = 0;
  const logs: string[] = [];
  const hub = new McpHub({
    spawn: (args) => {
      const c = new FakeChild(args);
      children.push(c);
      return c;
    },
    dataDir: "/data",
    now: () => now,
    timers: {
      setTimeout: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimeout: (t) => void ((t as { cleared: boolean }).cleared = true),
    },
    log: (m) => logs.push(m),
    changed: () => void changes++,
  });
  /** 跑掉最早一个还没清掉的定时器。 */
  const fire = (): number => {
    const t = timers.find((x) => !x.cleared);
    if (!t) throw new Error("no timer");
    t.cleared = true;
    t.fn();
    return t.ms;
  };
  return { hub, children, timers, fire, logs, tick: (ms: number) => (now += ms), changes: () => changes };
}

const memory = { "butler-workspace": { server: "memory" as const, scope: "workspace" } };

describe("McpHub", () => {
  it("starts lazily on the first route and gives stdio until the hub is ready", () => {
    const s = setup();
    expect(s.children).toHaveLength(0);
    expect(s.hub.route("t1", memory)).toBeNull();
    expect(s.children).toHaveLength(1);
    expect(s.children[0].args).toEqual(["--data", "/data", "--port", "0"]);
    expect(s.hub.status().state).toBe("starting");
    s.children[0].ready(4100);
    expect(s.hub.status()).toEqual({ state: "running", error: null });
    const urls = s.hub.route("t1", memory)!;
    expect(urls["butler-workspace"]).toMatch(/^http:\/\/127\.0\.0\.1:4100\/mcp\/[A-Za-z0-9_-]{43}$/);
    expect(s.children[0].cmds()).toEqual([{ op: "add", token: urls["butler-workspace"].split("/").pop(), route: { server: "memory", scope: "workspace" } }]);
  });

  it("gives every terminal and server its own token and removes a terminal's tokens when it exits", () => {
    const s = setup();
    s.hub.start();
    s.children[0].ready(4100);
    const sessions = { server: "sessions" as const, env: { BUTLER_TICKET: "A" }, from: "t1" };
    const a = s.hub.route("t1", { ...memory, "butler-sessions": sessions })!;
    const b = s.hub.route("t2", memory)!;
    const tokens = new Set([a["butler-workspace"], a["butler-sessions"], b["butler-workspace"]]);
    expect(tokens.size).toBe(3);
    s.children[0].written = [];
    s.hub.removeTerminal("t1");
    expect(s.children[0].cmds().map((c) => c.op)).toEqual(["remove", "remove"]);
    expect(s.children[0].cmds().map((c) => c.token).sort()).toEqual([a["butler-workspace"], a["butler-sessions"]].map((u) => u.split("/").pop()).sort());
  });

  it("restarts a hub that died, asks for the same port and sends every route again", () => {
    const s = setup();
    s.hub.start();
    s.children[0].ready(4100);
    const urls = s.hub.route("t1", memory)!;
    s.children[0].emit("exit", 1, null);
    expect(s.hub.status()).toEqual({ state: "failed", error: "exited (1)" });
    expect(s.hub.route("t2", memory)).toBeNull();
    expect(s.fire()).toBe(1000);
    expect(s.children[1].args).toEqual(["--data", "/data", "--port", "4100"]);
    s.children[1].ready(4100);
    expect(s.children[1].cmds()).toEqual([{ op: "add", token: urls["butler-workspace"].split("/").pop(), route: { server: "memory", scope: "workspace" } }]);
  });

  it("backs off 1 s, 2 s, 4 s … up to a minute while the hub keeps failing, and starts over after it ran for a minute", () => {
    const s = setup();
    s.hub.start();
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      s.children.at(-1)!.emit("exit", 1, null);
      waits.push(s.fire());
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    s.children.at(-1)!.ready(4100);
    s.tick(61_000);
    s.children.at(-1)!.emit("exit", 1, null);
    expect(s.fire()).toBe(1000);
  });

  it("kills a hub that does not print its ready line in time, and one that prints something else", () => {
    const s = setup();
    s.hub.start();
    expect(s.fire()).toBe(15_000);
    expect(s.children[0].killed).toBe(true);
    s.children[0].emit("exit", null, "SIGTERM");
    s.fire();
    s.children[1].emit("data", "hello\n");
    expect(s.children[1].killed).toBe(true);
  });

  it("reports a hub that cannot be spawned as failed and tries again later", () => {
    let fail = true;
    const timers: (() => void)[] = [];
    const hub = new McpHub({
      spawn: () => {
        if (fail) throw new Error("ENOENT");
        return new FakeChild([]);
      },
      dataDir: "/d",
      timers: { setTimeout: (fn) => timers.push(fn), clearTimeout: () => {} },
    });
    expect(hub.route("t", memory)).toBeNull();
    expect(hub.status()).toEqual({ state: "failed", error: "could not start: ENOENT" });
    fail = false;
    timers.shift()!();
    expect(hub.status().state).toBe("starting");
  });

  it("stops for good: closes the hub's stdin and does not restart it", () => {
    const s = setup();
    s.hub.start();
    s.children[0].ready(4100);
    s.hub.stop();
    expect(s.children[0].ended).toBe(true);
    expect(s.children[0].killed).toBe(false);
    s.children[0].emit("exit", 0, null);
    expect(s.timers.filter((t) => !t.cleared)).toHaveLength(0);
    expect(s.hub.status().state).toBe("stopped");
    expect(s.hub.route("t", memory)).toBeNull();
    expect(s.children).toHaveLength(2);
  });

  it("logs when the hub had to move to another port", () => {
    const s = setup();
    s.hub.start();
    s.children[0].ready(4100);
    s.hub.route("t1", memory);
    s.children[0].emit("exit", 1, null);
    s.fire();
    s.children[1].ready(4200);
    expect(s.logs.some((l) => /moved from port 4100 to 4200/.test(l))).toBe(true);
    // 旧端口的 token 不发给新 hub。
    expect(s.children[1].cmds()).toEqual([]);
    expect(s.changes()).toBeGreaterThan(0);
  });

  it("keeps serving the terminals it has after the setting is turned off, and stops once the last one exits", () => {
    const s = setup();
    s.hub.start();
    s.children[0].ready(4100);
    s.hub.route("t1", memory);
    s.hub.stopWhenIdle();
    expect(s.hub.status().state).toBe("running");
    expect(s.hub.route("t2", memory)).toBeNull();
    s.hub.removeTerminal("t1");
    expect(s.hub.status().state).toBe("stopped");
    expect(s.children[0].ended).toBe(true);
    s.hub.start();
    expect(s.children).toHaveLength(2);
  });

  it("stops right away when the setting is turned off and no terminal uses it", () => {
    const s = setup();
    s.hub.start();
    s.children[0].ready(4100);
    s.hub.stopWhenIdle();
    expect(s.hub.status().state).toBe("stopped");
  });

  it("kills a hub that does not exit within 5 s of being stopped", () => {
    const s = setup();
    s.hub.start();
    s.children[0].ready(4100);
    s.hub.stop();
    expect(s.fire()).toBe(5000);
    expect(s.children[0].killed).toBe(true);
  });
});
