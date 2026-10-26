import { randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { featureScope, ticketScope, WORKSPACE_SCOPE } from "../../shared/memory";
import { renameWithRetrySync } from "../util/fs-retry";
import { ticketFileStem } from "../util/ticket-file";

/** 挂给 claude 的 server 名：不和用户自己装的 statecore 重名（设计文档 8.4）。 */
export const MEMORY_SERVER = "butler-memory";
export const WORKSPACE_SERVER = "butler-workspace";
/** feature 的记忆：feature 下所有 ticket 的 session 和 feature 总控都挂（设计文档 2026-10-26）。 */
export const FEATURE_SERVER = "butler-feature";
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

/** ticket 的记忆（给了 ticketKey）、全局记忆，以及 feature 的记忆（给了 featureId）。feature 总控只有后两个。 */
export function memoryServers(o: {
  launcher: MemoryMcpLauncher;
  statecoreDir: string;
  ticketKey?: string;
  featureId?: number | null;
}): Record<string, McpServerSpec> {
  const server = (scope: string): McpServerSpec => ({
    type: "stdio",
    command: o.launcher.command,
    args: [o.launcher.script, "--data", o.statecoreDir],
    // 只有这三个变量，没有任何 key（R1）。claude 还会把自己的环境变量传下来，memory-mcp/entry.ts 启动时再清一遍。
    env: { ELECTRON_RUN_AS_NODE: "1", STATECORE_SCOPE: scope, LOG_LEVEL: "warn" },
  });
  return {
    ...(o.ticketKey !== undefined && { [MEMORY_SERVER]: server(ticketScope(o.ticketKey)) }),
    [WORKSPACE_SERVER]: server(WORKSPACE_SCOPE),
    ...(o.featureId != null && { [FEATURE_SERVER]: server(featureScope(o.featureId)) }),
  };
}

/** 总控的 butler-sessions server：同样用 Butler 自己的 Electron 运行；ticket（或 feature）和控制目录写死在配置里。 */
export function sessionsServer(o: {
  launcher: MemoryMcpLauncher;
  scope: { ticketKey: string } | { featureId: number };
  requestsDir: string;
  resultsDir: string;
}): Record<string, McpServerSpec> {
  const target: Record<string, string> = "featureId" in o.scope ? { BUTLER_FEATURE: String(o.scope.featureId) } : { BUTLER_TICKET: o.scope.ticketKey };
  return {
    [SESSIONS_SERVER]: {
      type: "stdio",
      command: o.launcher.command,
      args: [o.launcher.script],
      env: { ELECTRON_RUN_AS_NODE: "1", ...target, BUTLER_CONTROL_REQUESTS: o.requestsDir, BUTLER_CONTROL_RESULTS: o.resultsDir },
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
  return writeConfig(ticketMcpFile(o.mcpDir, o.ticketKey, o.coordinator), o.servers);
}

/** feature 总控的配置：mcp/features/<id>.json。 */
export function featureMcpFile(mcpDir: string, featureId: number): string {
  return join(mcpDir, "features", `${featureId}.json`);
}

export function writeFeatureMcpConfig(o: { mcpDir: string; featureId: number; servers: Record<string, McpServerSpec> }): string {
  return writeConfig(featureMcpFile(o.mcpDir, o.featureId), o.servers);
}

/** feature 归档时删掉它总控的 --mcp-config 文件。 */
export function removeFeatureMcpConfig(mcpDir: string, featureId: number): void {
  try {
    unlinkSync(featureMcpFile(mcpDir, featureId));
  } catch {
    // 本来就没有。
  }
}

function writeConfig(file: string, servers: Record<string, McpServerSpec>): string {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600, flag: "wx" });
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

/** ticket 归档时删掉它的 --mcp-config 文件（普通的和总控的）；恢复后下次打开 session 会重新写。 */
export function removeTicketMcpConfigs(mcpDir: string, ticketKey: string): void {
  for (const file of [ticketMcpFile(mcpDir, ticketKey), ticketMcpFile(mcpDir, ticketKey, true)]) {
    try {
      unlinkSync(file);
    } catch {
      // 本来就没有。
    }
  }
}
