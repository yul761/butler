// shipherd-sessions 的作用域和控制目录：Shipherd 写进 mcp 配置的环境变量（stdio 时）或共享 MCP 的路由（WS-M H）里的同一组变量。
import { HEADLESS_SESSION_PREFIX } from "../src/shared/hook-envelope";
import type { SessionsServerOptions } from "./sessions-server";

/**
 * 从这组变量读出 SessionsServer 的选项；缺了必需的（作用域、两个控制目录）返回 null。
 * from 是调用者的 session id：stdio 时是 claude 传下来的 SHIPHERD_SESSION，共享 MCP 时由路由带着。headless 运行不算调用者。
 */
export function sessionsOptionsFromEnv(env: Record<string, string | undefined>, from = env.SHIPHERD_SESSION): SessionsServerOptions | null {
  const ticketKey = env.SHIPHERD_TICKET ?? "";
  // feature 总控（设计文档 2026-10-26）：SHIPHERD_FEATURE 是正整数。
  const featureId = /^[1-9]\d{0,15}$/.test(env.SHIPHERD_FEATURE ?? "") ? Number(env.SHIPHERD_FEATURE) : null;
  // Shipherd 总控（BTL-190 第 5 点）：SHIPHERD_SCOPE=shipherd，全局一个，没有 ticket、feature。
  const shipherd = env.SHIPHERD_SCOPE === "shipherd";
  const requestsDir = env.SHIPHERD_CONTROL_REQUESTS ?? "";
  const resultsDir = env.SHIPHERD_CONTROL_RESULTS ?? "";
  if ((!shipherd && !ticketKey && featureId === null) || !requestsDir || !resultsDir) return null;
  const lang = env.SHIPHERD_LANG === "en" ? "en" : "zh";
  const scope = shipherd ? { shipherd: true as const } : featureId !== null ? { featureId } : { ticketKey };
  return { scope, lang, from: from && !from.startsWith(HEADLESS_SESSION_PREFIX) ? from : null, requestsDir, resultsDir };
}
