import { randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { epicScope, featureScope, ticketScope, WORKSPACE_SCOPE } from "../../shared/memory";
import { currentLang } from "../i18n";
import { renameWithRetrySync } from "../util/fs-retry";
import { ticketFileStem } from "../util/ticket-file";

/** 挂给 claude 的 server 名：不和用户自己装的 statecore 重名（设计文档 8.4）。 */
export const MEMORY_SERVER = "butler-memory";
export const WORKSPACE_SERVER = "butler-workspace";
/** feature 的记忆：feature 下所有 ticket 的 session 和 feature 总控都挂（设计文档 2026-10-26）。 */
export const FEATURE_SERVER = "butler-feature";
/** epic 的记忆：epic session、epic 下 feature 的总控和这些 feature 下 ticket 的所有 session 都挂（设计文档 2026-11-01）。 */
export const EPIC_SERVER = "butler-epic";
/**
 * 总控 session：开子 session、列出仓库和 session（设计文档 2026-10-23 第二步）。
 * 普通 ticket session 也挂，但作用域是 member，只有 ask_user 和 report（BTL-190 第 2+3 点）。
 */
export const SESSIONS_SERVER = "butler-sessions";
/**
 * 交互 session 不用确认就能调用的 sessions 工具：
 * - ask_user 和 report（BTL-190 第 2+3 点）只是把问题、汇报交给 Butler，第一次用就弹权限确认的话 session 会卡在那里等人；
 * - 只读的查询工具（BTL-190 第 5 点，Butler 总控巡检时一路调用；同名的工具在总控里也只是读）。
 * 会动别的终端或建东西的（start_session、end_session、send_message、refresh_session、create_*）照样要确认。
 */
export const SESSIONS_AUTO_ALLOW: readonly string[] = [
  "ask_user", "report",
  "list_epics", "list_features", "list_tickets", "list_prs", "list_sessions", "session_activity", "list_inbox",
].map((tool) => `mcp__${SESSIONS_SERVER}__${tool}`);

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

/**
 * ticket 的记忆（给了 ticketKey）、全局记忆、feature 的记忆（给了 featureId）和 epic 的记忆（给了 epicId）。
 * feature 总控没有 ticket 的记忆；epic session 只有全局记忆和 epic 的记忆。
 */
export function memoryServers(o: {
  launcher: MemoryMcpLauncher;
  statecoreDir: string;
  ticketKey?: string;
  featureId?: number | null;
  epicId?: number | null;
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
    ...(o.epicId != null && { [EPIC_SERVER]: server(epicScope(o.epicId)) }),
  };
}

/** butler-sessions server：同样用 Butler 自己的 Electron 运行；ticket（feature、epic）和控制目录写死在配置里。 */
export function sessionsServer(o: {
  launcher: MemoryMcpLauncher;
  /**
   * epic: feature 总控的 feature 属于某个 epic（多出 epic_context 工具）。member: 普通 ticket session（只有 ask_user、report）。
   * butler: Butler 总控（BTL-190 第 5 点），全局一个。
   */
  scope: { ticketKey: string; member?: boolean } | { featureId: number; epic?: boolean } | { epicId: number } | { butler: true };
  requestsDir: string;
  resultsDir: string;
}): Record<string, McpServerSpec> {
  const scope = o.scope;
  const target: Record<string, string> =
    "butler" in scope ? { BUTLER_SCOPE: "butler" }
    : "epicId" in scope ? { BUTLER_EPIC: String(scope.epicId) }
    : "featureId" in scope ? { BUTLER_FEATURE: String(scope.featureId), ...(scope.epic && { BUTLER_FEATURE_EPIC: "1" }) }
    : { BUTLER_TICKET: scope.ticketKey, ...(scope.member && { BUTLER_MEMBER: "1" }) };
  // 工具描述跟着 Butler 的语言（设计文档 2026-10-26）。
  target.BUTLER_LANG = currentLang();
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
 * 总控的配置（butler-sessions 带总控的工具）分开存；普通 session 的配置里 butler-sessions 只是 member（BTL-190 第 2+3 点）。
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

/** epic session 的配置：mcp/epics/<id>.json。 */
export function epicMcpFile(mcpDir: string, epicId: number): string {
  return join(mcpDir, "epics", `${epicId}.json`);
}

export function writeEpicMcpConfig(o: { mcpDir: string; epicId: number; servers: Record<string, McpServerSpec> }): string {
  return writeConfig(epicMcpFile(o.mcpDir, o.epicId), o.servers);
}

/** Butler 总控的配置（BTL-190 第 5 点）：全局只有一个，mcp/butler.json。 */
export function butlerMcpFile(mcpDir: string): string {
  return join(mcpDir, "butler.json");
}

export function writeButlerMcpConfig(o: { mcpDir: string; servers: Record<string, McpServerSpec> }): string {
  return writeConfig(butlerMcpFile(o.mcpDir), o.servers);
}

/** feature 归档时删掉它总控的 --mcp-config 文件。 */
export function removeFeatureMcpConfig(mcpDir: string, featureId: number): void {
  try {
    unlinkSync(featureMcpFile(mcpDir, featureId));
  } catch {
    // 本来就没有。
  }
}

/** epic 归档时删掉 epic session 的 --mcp-config 文件。 */
export function removeEpicMcpConfig(mcpDir: string, epicId: number): void {
  try {
    unlinkSync(epicMcpFile(mcpDir, epicId));
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
