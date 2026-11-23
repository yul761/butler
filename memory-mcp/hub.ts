// 共享 MCP 的路由表（WS-M H，设计文档 2026-11-17 §8）：每个 token 对应一个 server（某个作用域的记忆，或某个终端的 shipherd-sessions）。
// 记忆后端按作用域共用一个，懒加载，30 分钟没人用就关掉；shipherd-sessions 每条路由一个 SessionsServer，和 stdio 时每个进程一个一样。
import type { RpcHandler, RpcMessage } from "./loopback-http";
import { type MemoryBackendLike, MemoryServer } from "./memory-tools";
import { SessionsServer } from "./sessions-server";
import { sessionsOptionsFromEnv } from "./sessions-options";

/** 一条路由：Shipherd 经 hub 的 stdin 发来（一行一个 JSON）。 */
export type HubRoute = { server: "memory"; scope: string } | { server: "sessions"; env: Record<string, string>; from: string | null };
export type HubCommand = { op: "add"; token: string; route: HubRoute } | { op: "remove"; token: string };

export interface HubBackend extends MemoryBackendLike {
  init(): Promise<void>;
  close(): Promise<void>;
}

/** 记忆后端多久没人用就关掉。 */
export const BACKEND_IDLE_MS = 30 * 60_000;

interface SessionsLike {
  handle(msg: RpcMessage): Promise<object | null>;
  withdrawAll(): void;
}

interface Route {
  handler: RpcHandler;
  /** 路由撤掉时：shipherd-sessions 撤回没人再等的请求（和 stdio 时进程退出一样）。 */
  dispose?: () => void;
}

export class Hub {
  private readonly routes = new Map<string, Route>();
  private readonly backends = new Map<string, { ready: Promise<HubBackend>; usedAt: number; busy: number }>();

  constructor(private readonly d: {
    backend: (scope: string) => HubBackend;
    sessions?: (route: Extract<HubRoute, { server: "sessions" }>) => SessionsLike | null;
    now?: () => number;
    idleMs?: number;
    log?: (msg: string, e?: unknown) => void;
  }) {}

  handler(token: string): RpcHandler | null {
    return this.routes.get(token)?.handler ?? null;
  }

  /** 路由数（测试和日志用）。 */
  get size(): number {
    return this.routes.size;
  }

  apply(cmd: HubCommand): void {
    if (cmd.op === "remove") {
      this.routes.get(cmd.token)?.dispose?.();
      this.routes.delete(cmd.token);
      return;
    }
    // 同一个 token 再发一次（hub 重启后 Shipherd 重发路由）：先撤掉旧的。
    this.routes.get(cmd.token)?.dispose?.();
    const route = cmd.route;
    if (route.server === "memory") {
      const server = new MemoryServer(() => this.backend(route.scope));
      // 只有调用工具才打开后端：握手和列工具不碰数据库。
      this.routes.set(cmd.token, { handler: (m) => (m.method === "tools/call" ? this.using(route.scope, () => server.handle(m)) : server.handle(m)) });
      return;
    }
    const sessions = (this.d.sessions ?? defaultSessions)(route);
    if (!sessions) {
      this.d.log?.("shared MCP: a sessions route without its scope or control directories was ignored");
      return;
    }
    this.routes.set(cmd.token, { handler: (m) => sessions.handle(m), dispose: () => sessions.withdrawAll() });
  }

  /** 关掉 idleMs 没用过、也没有调用在进行中的记忆后端（下次用到时再开）。 */
  async sweep(): Promise<void> {
    const now = (this.d.now ?? Date.now)();
    for (const [scope, b] of [...this.backends]) {
      if (b.busy > 0 || now - b.usedAt < (this.d.idleMs ?? BACKEND_IDLE_MS)) continue;
      this.backends.delete(scope);
      await closeQuietly(b.ready, this.d.log);
    }
  }

  /** 退出前：撤回所有 shipherd-sessions 的请求，关掉所有记忆后端。 */
  async closeAll(): Promise<void> {
    for (const r of this.routes.values()) r.dispose?.();
    this.routes.clear();
    const all = [...this.backends.values()];
    this.backends.clear();
    for (const b of all) await closeQuietly(b.ready, this.d.log);
  }

  /** 这个作用域开着的后端数（测试用）。 */
  get openBackends(): number {
    return this.backends.size;
  }

  private async using<T>(scope: string, fn: () => Promise<T>): Promise<T> {
    const b = this.entry(scope);
    b.busy++;
    try {
      return await fn();
    } finally {
      b.busy--;
      b.usedAt = (this.d.now ?? Date.now)();
    }
  }

  private backend(scope: string): Promise<HubBackend> {
    return this.entry(scope).ready;
  }

  private entry(scope: string) {
    let b = this.backends.get(scope);
    if (!b) {
      const backend = this.d.backend(scope);
      const ready = backend.init().then(() => backend);
      b = { ready, usedAt: (this.d.now ?? Date.now)(), busy: 0 };
      // 打开失败的不留着：下次用到时重新开。
      ready.catch((e: unknown) => {
        this.d.log?.(`shared MCP: memory scope ${scope} did not open`, e);
        if (this.backends.get(scope)?.ready === ready) this.backends.delete(scope);
      });
      this.backends.set(scope, b);
    }
    return b;
  }
}

function defaultSessions(route: Extract<HubRoute, { server: "sessions" }>): SessionsLike | null {
  const options = sessionsOptionsFromEnv(route.env, route.from ?? undefined);
  return options ? new SessionsServer(options) : null;
}

async function closeQuietly(ready: Promise<HubBackend>, log?: (msg: string, e?: unknown) => void): Promise<void> {
  try {
    await (await ready).close();
  } catch (e) {
    log?.("shared MCP: closing a memory scope failed", e);
  }
}

/** stdin 上的一行：解析不了、字段不对的返回 null。 */
export function parseHubCommand(line: string): HubCommand | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const c = v as Record<string, unknown>;
  if (typeof c.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(c.token)) return null;
  if (c.op === "remove") return { op: "remove", token: c.token };
  if (c.op !== "add" || typeof c.route !== "object" || c.route === null) return null;
  const r = c.route as Record<string, unknown>;
  if (r.server === "memory" && typeof r.scope === "string" && r.scope) return { op: "add", token: c.token, route: { server: "memory", scope: r.scope } };
  if (r.server === "sessions" && typeof r.env === "object" && r.env !== null && (r.from === null || typeof r.from === "string")) {
    const env = Object.fromEntries(Object.entries(r.env as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
    return { op: "add", token: c.token, route: { server: "sessions", env, from: r.from as string | null } };
  }
  return null;
}
