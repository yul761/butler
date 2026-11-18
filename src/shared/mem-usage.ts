/** 内存与卡顿（WS-M）的共享类型：main 采样，「现在」页显示。 */

/** 进程在 session 树里的类别（设计 §1）。 */
export type ProcClass = "claude" | "mcp_butler" | "mcp_other" | "shell" | "watcher" | "dev_server" | "other";
export const PROC_CLASSES: readonly ProcClass[] = ["claude", "mcp_butler", "mcp_other", "shell", "watcher", "dev_server", "other"];

export interface TopProc {
  pid: number;
  cls: ProcClass;
  rssKb: number;
  /** 给人看的短名字（chrome-devtools-mcp、Google Chrome、vite）。 */
  name: string;
}

/** 一棵进程树的汇总。 */
export interface TreeSummary {
  totalKb: number;
  count: number;
  byClass: Record<ProcClass, number>;
  /** 最大的几个进程，从大到小。 */
  top: TopProc[];
}

/** 一个开着的 session 最近一次的读数（NowRow.mem）。 */
export interface SessionMemory extends TreeSummary {
  at: number;
}

/** Butler 自己的进程，按 Electron 的进程类型和 Butler 起的后台进程分（设计 §2）。 */
export type ButlerPart = "main" | "renderer" | "gpu" | "utility" | "terminals" | "headless" | "hub";
export const BUTLER_PARTS: readonly ButlerPart[] = ["main", "renderer", "gpu", "utility", "terminals", "headless", "hub"];

export interface SystemMemoryView {
  totalKb: number;
  freeKb: number;
  freePercent: number;
}

/** 「现在」页顶上那张卡片：最近一次采样。 */
export interface MemorySnapshot {
  at: number;
  butlerKb: number;
  butler: Record<ButlerPart, number>;
  /** 所有开着的 session 的树加起来。 */
  sessionsKb: number;
  sessions: number;
  /** 其中 Butler 自己的 MCP（statecore、butler-sessions）占了多少：大的话提示打开共享 MCP（H）。 */
  butlerMcpKb: number;
  system: SystemMemoryView | null;
}

/** 历史曲线上的一个点（每 5 分钟一个）。 */
export interface MemoryHistoryPoint {
  at: number;
  butlerKb: number;
  sessionsKb: number;
  freePercent: number | null;
}
