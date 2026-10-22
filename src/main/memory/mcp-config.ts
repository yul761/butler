import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ticketScope, WORKSPACE_SCOPE } from "../../shared/memory";

/** 挂给 claude 的 server 名：不和用户自己装的 statecore 重名（设计文档 8.4）。 */
export const MEMORY_SERVER = "butler-memory";
export const WORKSPACE_SERVER = "butler-workspace";

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

/**
 * mcp/<ticket>.json（设计文档 2.3）。自定义的 ticket 正则可能放进 /、空格之类的字符：
 * 不能做文件名的字符换成 _，并加上原值的短哈希免得两个 ticket 撞名；结果永远在 mcpDir 里面。
 */
export function ticketMcpFile(mcpDir: string, ticketKey: string): string {
  const safe = ticketKey.replace(/[^A-Za-z0-9._-]/g, "_");
  const plain = safe === ticketKey && !/^\.*$/.test(safe);
  const name = plain ? safe : `${safe.slice(0, 60)}-${createHash("sha1").update(ticketKey).digest("hex").slice(0, 8)}`;
  return join(mcpDir, `${name}.json`);
}

/** 写（覆盖）这个 ticket 的 --mcp-config 文件：随机名的临时文件（0600、wx）再 rename，返回文件路径。 */
export function writeTicketMcpConfig(o: { mcpDir: string; ticketKey: string; launcher: MemoryMcpLauncher; statecoreDir: string }): string {
  const file = ticketMcpFile(o.mcpDir, o.ticketKey);
  mkdirSync(o.mcpDir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ mcpServers: memoryServers(o) }, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
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
