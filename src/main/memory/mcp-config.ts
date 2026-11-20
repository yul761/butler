import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { epicScope, featureScope, ticketScope, WORKSPACE_SCOPE } from "../../shared/memory";
import { currentLang } from "../i18n";
import { renameWithRetrySync } from "../util/fs-retry";
import { ticketFileStem } from "../util/ticket-file";
import type { HubRouteSpec } from "./mcp-hub";

/** 挂给 claude 的 server 名：不和用户自己装的 statecore 重名（设计文档 8.4）。 */
export const MEMORY_SERVER = "butler-memory";
export const WORKSPACE_SERVER = "butler-workspace";
/** feature 的记忆：feature 下所有 ticket 的 session 和 feature 总控都挂（设计文档 2026-10-26）。 */
export const FEATURE_SERVER = "butler-feature";
/** epic 的记忆：epic session、epic 下 feature 的总控和这些 feature 下 ticket 的所有 session 都挂（设计文档 2026-11-01）。 */
export const EPIC_SERVER = "butler-epic";
/**
 * 总控 session：开子 session、列出仓库和 session（设计文档 2026-10-23 第二步）。
 * 普通 ticket session 也挂，但作用域是 member，只有 ask_user、report（BTL-190 第 2+3 点）和 submit_evidence、pre_review_result（工作流 G）。
 */
export const SESSIONS_SERVER = "butler-sessions";
/**
 * 交互 session 不用确认就能调用的 sessions 工具：
 * - ask_user 和 report（BTL-190 第 2+3 点）只是把问题、汇报交给 Butler，第一次用就弹权限确认的话 session 会卡在那里等人；
 * - 只读的查询工具（BTL-190 第 5 点，Butler 总控巡检时一路调用；同名的工具在总控里也只是读）。
 * 会动别的终端、建东西或花额度的（start_session、end_session、send_message、refresh_session、refresh_feature_summary、create_*、stack_define、stack_rebase、stack_layer_mode）照样要确认。
 */
export const SESSIONS_AUTO_ALLOW: readonly string[] = [
  "ask_user", "report",
  "list_epics", "list_features", "list_tickets", "list_prs", "list_sessions", "session_activity", "list_inbox", "progress_overview", "metrics_overview", "list_stacks",
  // 工作流 G：交证据（只在 Butler 里排一次预审）、取预审结果、看一个 PR 的评估。
  "submit_evidence", "pre_review_result", "pr_assessment",
].map((tool) => `mcp__${SESSIONS_SERVER}__${tool}`);

/** 怎么启动打包好的 StateCore MCP：command 是 Butler 自己的 Electron（process.execPath），script 是 bundle。 */
export interface MemoryMcpLauncher {
  command: string;
  script: string;
}

export interface StdioServerSpec {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** 共享 MCP（WS-M H）：hub 上这个终端、这个 server 的路由。 */
export interface HttpServerSpec {
  type: "http";
  url: string;
}

export type McpServerSpec = StdioServerSpec | HttpServerSpec;

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
}): Record<string, StdioServerSpec> {
  const server = (scope: string): StdioServerSpec => ({
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
   * epic: feature 总控的 feature 属于某个 epic（多出 epic_context 工具）。member: 普通 ticket session（只有 ask_user、report、submit_evidence、pre_review_result）。
   * butler: Butler 总控（BTL-190 第 5 点），全局一个。
   */
  scope: { ticketKey: string; member?: boolean } | { featureId: number; epic?: boolean } | { epicId: number } | { butler: true };
  requestsDir: string;
  resultsDir: string;
}): Record<string, StdioServerSpec> {
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

/**
 * 共享 MCP（WS-M H）：stdio 的 server 换成 hub 上的路由。记忆按 STATECORE_SCOPE，butler-sessions 带着它的变量和调用者（终端 id），
 * 和 stdio 时 claude 传下去的 BUTLER_SESSION 一样。认不出的 server 返回 null（这个终端就用 stdio）。
 */
export function hubRoutes(servers: Record<string, StdioServerSpec>, termId: string): Record<string, HubRouteSpec> | null {
  const out: Record<string, HubRouteSpec> = {};
  for (const [name, spec] of Object.entries(servers)) {
    if (name === SESSIONS_SERVER) {
      const env = Object.fromEntries(Object.entries(spec.env).filter(([k]) => k.startsWith("BUTLER_")));
      out[name] = { server: "sessions", env, from: termId };
    } else if (spec.env.STATECORE_SCOPE) {
      out[name] = { server: "memory", scope: spec.env.STATECORE_SCOPE };
    } else {
      return null;
    }
  }
  return out;
}

/** 共享 MCP 时每个终端一份配置：mcp/terms/<终端 id>.json（里面的 URL 带着这个终端的 token）。 */
export const TERMINAL_MCP_SUBDIR = "terms";

export function terminalMcpFile(mcpDir: string, termId: string): string {
  // 终端 id 是 Butler 生成的 UUID；别的字符一律换掉，路径永远在 mcp/terms 里面。
  return join(mcpDir, TERMINAL_MCP_SUBDIR, `${termId.replace(/[^A-Za-z0-9-]/g, "_")}.json`);
}

export function writeTerminalMcpConfig(o: { mcpDir: string; termId: string; servers: Record<string, McpServerSpec> }): string {
  return writeConfig(terminalMcpFile(o.mcpDir, o.termId), o.servers);
}

/** 终端退出：它的 token 已经撤掉，配置文件也删掉。 */
export function removeTerminalMcpConfig(mcpDir: string, termId: string): void {
  try {
    unlinkSync(terminalMcpFile(mcpDir, termId));
  } catch {
    // 本来就没有（这个终端用的是 stdio）。
  }
}

/**
 * 完整分叉自己的 --mcp-config（UI 重做第 5 层，Task 8 review I1）：分叉不走共享 MCP 的 hub（没有终端、没人撤路由），
 * 总是 stdio，跟开发 session 同一组 server。放在 mcp/forks/ 下、按内容起名：同一组 server 共用一个文件，
 * 换了 server 组写新文件，之前分叉接着问用的那份不动；启动时 pruneTerminalMcpConfigs 只清 mcp/terms，这里留着，重启后接着问照样能用。
 */
export const FORK_MCP_SUBDIR = "forks";

export function writeForkMcpConfig(o: { mcpDir: string; servers: Record<string, McpServerSpec> }): string {
  const hash = createHash("sha1").update(JSON.stringify(o.servers)).digest("hex").slice(0, 16);
  const file = join(o.mcpDir, FORK_MCP_SUBDIR, `${hash}.json`);
  return existsSync(file) ? file : writeConfig(file, o.servers);
}

/** 启动时：上次留下的终端配置都没用了（hub 是新的，token 全失效）。返回删掉的个数。 */
export function pruneTerminalMcpConfigs(mcpDir: string): number {
  const dir = join(mcpDir, TERMINAL_MCP_SUBDIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (!name.endsWith(".json") && !name.endsWith(".tmp")) continue;
    try {
      unlinkSync(join(dir, name));
      n++;
    } catch {
      // 删不掉的留到下次。
    }
  }
  return n;
}
