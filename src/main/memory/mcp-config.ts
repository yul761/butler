import { randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ticketScope, WORKSPACE_SCOPE } from "../../shared/memory";
import { renameWithRetrySync } from "../util/fs-retry";
import { ticketFileStem } from "../util/ticket-file";

/** 挂给 claude 的 server 名：不和用户自己装的 statecore 重名（设计文档 8.4）。 */
export const MEMORY_SERVER = "butler-memory";
export const WORKSPACE_SERVER = "butler-workspace";
/** 只挂给总控 session：开子 session、列出仓库和 session（设计文档 2026-10-23 第二步）。 */
export const SESSIONS_SERVER = "butler-sessions";

/** 怎么启动打包好的 StateCore MCP：command 是 Butler 自己的 Electron（process.execPath），script 是 bundle。 */
export interface MemoryMcpLauncher {
  command: string;
  script: string;
}

export interface McpServerSpec {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function memoryServers(o: { launcher: MemoryMcpLauncher; statecoreDir: string; ticketKey: string }): Record<string, McpServerSpec> {
  const server = (scope: string): McpServerSpec => ({
    type: "stdio",
    command: o.launcher.command,
    args: [o.launcher.script, "--data", o.statecoreDir],
    // 只有这三个变量，没有任何 key（R1）。claude 还会把自己的环境变量传下来，memory-mcp/entry.ts 启动时再清一遍。
    env: { ELECTRON_RUN_AS_NODE: "1", STATECORE_SCOPE: scope, LOG_LEVEL: "warn" },
  });
  return { [MEMORY_SERVER]: server(ticketScope(o.ticketKey)), [WORKSPACE_SERVER]: server(WORKSPACE_SCOPE) };
}

/** 总控的 butler-sessions server：同样用 Butler 自己的 Electron 运行；ticket 和控制目录写死在配置里。 */
export function sessionsServer(o: { launcher: MemoryMcpLauncher; ticketKey: string; requestsDir: string; resultsDir: string }): Record<string, McpServerSpec> {
  return {
    [SESSIONS_SERVER]: {
      type: "stdio",
      command: o.launcher.command,
      args: [o.launcher.script],
      env: { ELECTRON_RUN_AS_NODE: "1", BUTLER_TICKET: o.ticketKey, BUTLER_CONTROL_REQUESTS: o.requestsDir, BUTLER_CONTROL_RESULTS: o.resultsDir },
    },
  };
}

/** ticket 的记忆配置放在 mcp/ 下自己的子目录里：和计划 3 的 project-* / local-* 文件（headless 用）永远分开（P4-R6）。 */
export const TICKET_MCP_SUBDIR = "tickets";

/** 总控 session 的配置放在 mcp/tickets/ 下自己的子目录里：ticket 号再怎么起名也不会和普通配置撞上。 */
export const COORDINATOR_MCP_SUBDIR = "coordinator";

/**
 * mcp/tickets/<ticket>.json（设计文档 2.3）；总控的是 mcp/tickets/coordinator/<ticket>.json。文件名规则见 ticketFileStem：
 * 结果永远在 mcpDir/tickets 里面。
 */
export function ticketMcpFile(mcpDir: string, ticketKey: string, coordinator = false): string {
  return join(mcpDir, TICKET_MCP_SUBDIR, ...(coordinator ? [COORDINATOR_MCP_SUBDIR] : []), `${ticketFileStem(ticketKey)}.json`);
}

/**
 * 写（覆盖）这个 ticket 的 --mcp-config 文件：随机名的临时文件（0600、wx）再 rename，返回文件路径。
 * 总控的配置（多一个 butler-sessions）分开存，普通 session 的配置里永远没有它。
 */
export function writeTicketMcpConfig(o: { mcpDir: string; ticketKey: string; servers: Record<string, McpServerSpec>; coordinator?: boolean }): string {
  const file = ticketMcpFile(o.mcpDir, o.ticketKey, o.coordinator);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ mcpServers: o.servers }, null, 2), { mode: 0o600, flag: "wx" });
    renameWithRetrySync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件没建成。
    }
    throw e;
  }
  return file;
}
