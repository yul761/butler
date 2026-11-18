// 共享 MCP hub 的管理（WS-M H，设计文档 2026-11-17 §8）：懒启动、挂了按退避重启（尽量用原来的端口）、重启后重发全部路由。
// hub 起不来的时候 route() 返回 null，调用方给 session 写今天的 stdio 配置。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

/** hub 子进程里这里用到的部分（测试里换成假的）。 */
export interface HubChild {
  stdin: { write(s: string): unknown; end(): void } | null;
  stdout: { on(ev: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  on(ev: "exit", cb: (code: number | null, signal: string | null) => void): unknown;
  on(ev: "error", cb: (e: Error) => void): unknown;
  kill(): unknown;
}

export type HubRouteSpec = { server: "memory"; scope: string } | { server: "sessions"; env: Record<string, string>; from: string | null };

export type HubState = "stopped" | "starting" | "running" | "failed";

/** 等 hub 打出 ready 那行最多多久。 */
export const HUB_START_TIMEOUT_MS = 15_000;
/** stop() 关了 stdin 之后等 hub 自己退出多久，过了就强制结束（卡住的 hub 不能留成孤儿、占着端口和数据目录）。 */
export const HUB_STOP_GRACE_MS = 5_000;
/** 重启的退避：1 秒起，每次翻倍，最多 1 分钟；正常跑满 1 分钟后从头算。 */
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

export class McpHub {
  private child: HubChild | null = null;
  private state: HubState = "stopped";
  private port: number | null = null;
  /** 上次监听的端口：重启时先要它，之前开的 session 的配置里写的就是它。 */
  private lastPort = 0;
  private readonly routes = new Map<string, { termId: string; route: HubRouteSpec }>();
  private backoff = BACKOFF_MIN_MS;
  private restartTimer: unknown = null;
  private startTimer: unknown = null;
  private startedAt = 0;
  private stopped = false;
  /** 设置关掉了：已经接上 hub 的终端照常用，最后一个退出后停掉 hub。 */
  private draining = false;
  private lastError: string | null = null;

  constructor(private readonly d: {
    /** 启动 hub：Butler 自己的 Electron 当 Node 跑 mcp-hub.cjs，参数由这里给。 */
    spawn: (args: string[]) => HubChild;
    dataDir: string;
    now?: () => number;
    timers?: Timers;
    startTimeoutMs?: number;
    log?: (msg: string, e?: unknown) => void;
    /** 状态变了（起来了、起不来）：「现在」页的提醒跟着变。 */
    changed?: () => void;
  }) {}

  /** 现在的状态，和起不来时的原因。 */
  status(): { state: HubState; error: string | null } {
    return { state: this.state, error: this.lastError };
  }

  /** 没在跑就启动（懒启动；设置打开时、第一次开 session 时调用）。 */
  start(): void {
    this.stopped = false;
    this.draining = false;
    if (this.child || this.restartTimer !== null) return;
    this.spawn();
  }

  /**
   * 给一个终端登记它的 server，返回每个 server 的 URL；hub 没在跑（还在启动、挂了、起不来）返回 null，
   * 调用方就给这个终端写 stdio 配置。顺手把没启动的 hub 启动起来。
   */
  route(termId: string, servers: Record<string, HubRouteSpec>): Record<string, string> | null {
    if (this.draining) return null;
    this.start();
    if (this.state !== "running" || this.port === null) return null;
    this.removeTerminal(termId);
    const urls: Record<string, string> = {};
    for (const [name, route] of Object.entries(servers)) {
      const token = randomBytes(32).toString("base64url");
      this.routes.set(token, { termId, route });
      this.send({ op: "add", token, route });
      urls[name] = `http://127.0.0.1:${this.port}/mcp/${token}`;
    }
    return urls;
  }

  /** 终端退出：撤掉它的路由（butler-sessions 撤回没人再等的请求）。 */
  removeTerminal(termId: string): void {
    for (const [token, r] of [...this.routes]) {
      if (r.termId !== termId) continue;
      this.routes.delete(token);
      this.send({ op: "remove", token });
    }
    if (this.draining && this.routes.size === 0) this.stop();
  }

  /** 设置关掉：不再给新终端路由；还接着 hub 的终端退完了再停（关掉开关不会让开着的 session 断掉 Butler 的 MCP）。 */
  stopWhenIdle(): void {
    if (this.routes.size === 0) {
      this.stop();
      return;
    }
    this.draining = true;
  }

  /** 设置关掉或 Butler 退出：停掉 hub，不再重启。已经开着的 session 的 Butler MCP 跟着断开。 */
  stop(): void {
    this.stopped = true;
    this.draining = false;
    this.clearTimers();
    const c = this.child;
    this.child = null;
    this.port = null;
    this.routes.clear();
    this.setState("stopped");
    if (c) {
      const timers = this.d.timers ?? globalThis;
      const t = timers.setTimeout(() => c.kill(), HUB_STOP_GRACE_MS);
      (t as { unref?: () => void } | null)?.unref?.();
      c.on("exit", () => timers.clearTimeout(t));
      try {
        c.stdin?.end();
      } catch {
        // 已经退出了。
      }
    }
  }

  private spawn(): void {
    const timers = this.d.timers ?? globalThis;
    let child: HubChild;
    try {
      child = this.d.spawn(["--data", this.d.dataDir, "--port", String(this.lastPort)]);
    } catch (e) {
      this.fail(`could not start: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.child = child;
    this.setState("starting");
    let buf = "";
    const onData = (chunk: Buffer | string) => {
      if (this.child !== child || this.state !== "starting") return;
      buf += String(chunk);
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let port: number | null = null;
      try {
        const v = JSON.parse(buf.slice(0, nl)) as { ready?: boolean; port?: unknown };
        if (v.ready === true && Number.isInteger(v.port)) port = v.port as number;
      } catch {
        // 不是 ready 那行。
      }
      if (port === null) {
        this.d.log?.("shared MCP hub printed something other than its ready line");
        child.kill();
        return;
      }
      this.ready(child, port);
    };
    child.stdout?.on("data", onData);
    child.on("error", (e) => this.exited(child, `error: ${e.message}`));
    child.on("exit", (code, signal) => this.exited(child, `exited (${signal ?? code})`));
    this.startTimer = timers.setTimeout(() => {
      this.startTimer = null;
      if (this.child !== child || this.state !== "starting") return;
      this.d.log?.("shared MCP hub did not start in time");
      child.kill();
    }, this.d.startTimeoutMs ?? HUB_START_TIMEOUT_MS);
  }

  private ready(child: HubChild, port: number): void {
    this.clearStartTimer();
    if (this.lastPort !== 0 && port !== this.lastPort) {
      // 旧端口上的 token 作废，不发给新的 hub：端口空着的那段时间别的程序可能占了它、收到了 token。
      this.d.log?.(`shared MCP hub moved from port ${this.lastPort} to ${port}; sessions opened before it can no longer reach Butler's MCP until reopened`);
      this.routes.clear();
      if (this.draining) {
        // 设置已经关了，又没有终端接着它：不用再跑。
        this.stop();
        return;
      }
    }
    this.port = port;
    this.lastPort = port;
    this.startedAt = (this.d.now ?? Date.now)();
    this.lastError = null;
    this.d.log?.(`shared MCP hub listening on 127.0.0.1:${port}`);
    // 重启后：hub 是空的，把还开着的终端的路由全部重发（token 不变，配置文件不用重写）。
    for (const [token, r] of this.routes) this.write(child, { op: "add", token, route: r.route });
    this.setState("running");
  }

  private exited(child: HubChild, why: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.port = null;
    this.clearStartTimer();
    if (this.stopped) return;
    const now = (this.d.now ?? Date.now)();
    const wasRunning = this.state === "running";
    // 正常跑了 1 分钟以上才挂的：退避从头算。
    if (wasRunning && now - this.startedAt >= BACKOFF_MAX_MS) this.backoff = BACKOFF_MIN_MS;
    this.fail(why);
  }

  private fail(why: string): void {
    this.lastError = why;
    this.d.log?.(`shared MCP hub ${why}; retrying in ${Math.round(this.backoff / 1000)} s (sessions opened meanwhile use their own MCP processes)`);
    this.setState("failed");
    const timers = this.d.timers ?? globalThis;
    const wait = this.backoff;
    this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2);
    this.restartTimer = timers.setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) this.spawn();
    }, wait);
  }

  private send(cmd: object): void {
    if (this.child && this.state === "running") this.write(this.child, cmd);
  }

  private write(child: HubChild, cmd: object): void {
    try {
      child.stdin?.write(`${JSON.stringify(cmd)}\n`);
    } catch (e) {
      this.d.log?.("writing to the shared MCP hub failed", e);
    }
  }

  private setState(s: HubState): void {
    if (this.state === s) return;
    this.state = s;
    this.d.changed?.();
  }

  private clearStartTimer(): void {
    if (this.startTimer !== null) (this.d.timers ?? globalThis).clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private clearTimers(): void {
    this.clearStartTimer();
    if (this.restartTimer !== null) (this.d.timers ?? globalThis).clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }
}

/** 真的 hub 子进程：Butler 自己的 Electron 当 Node 跑 mcp-hub.cjs（和 stdio 的记忆 MCP 一样），stderr 一行一行进 Butler 的日志。 */
export function spawnHub(script: string, log: (msg: string) => void): (args: string[]) => HubChild {
  return (args) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", LOG_LEVEL: "warn" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      err += c;
      for (let nl = err.indexOf("\n"); nl >= 0; nl = err.indexOf("\n")) {
        const line = err.slice(0, nl).trim();
        err = err.slice(nl + 1);
        if (line) log(line);
      }
    });
    // hub 退出后再往 stdin 写会 EPIPE：吞掉，退出由 exit 事件处理。
    child.stdin.on("error", () => {});
    return child;
  };
}
