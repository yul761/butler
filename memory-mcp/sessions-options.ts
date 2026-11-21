// butler-sessions 的作用域和控制目录：Butler 写进 mcp 配置的环境变量（stdio 时）或共享 MCP 的路由（WS-M H）里的同一组变量。
import { HEADLESS_SESSION_PREFIX } from "../src/shared/hook-envelope";
import type { SessionsServerOptions } from "./sessions-server";

/**
 * 从这组变量读出 SessionsServer 的选项；缺了必需的（作用域、两个控制目录）返回 null。
 * from 是调用者的 session id：stdio 时是 claude 传下来的 BUTLER_SESSION，共享 MCP 时由路由带着。headless 运行不算调用者。
 */
export function sessionsOptionsFromEnv(env: Record<string, string | undefined>, from = env.BUTLER_SESSION): SessionsServerOptions | null {
  const ticketKey = env.BUTLER_TICKET ?? "";
  // feature 总控（设计文档 2026-10-26）：BUTLER_FEATURE 是正整数。
  const featureId = /^[1-9]\d{0,15}$/.test(env.BUTLER_FEATURE ?? "") ? Number(env.BUTLER_FEATURE) : null;
  // Butler 总控（BTL-190 第 5 点）：BUTLER_SCOPE=butler，全局一个，没有 ticket、feature。
  const butler = env.BUTLER_SCOPE === "butler";
  const requestsDir = env.BUTLER_CONTROL_REQUESTS ?? "";
  const resultsDir = env.BUTLER_CONTROL_RESULTS ?? "";
  if ((!butler && !ticketKey && featureId === null) || !requestsDir || !resultsDir) return null;
  const lang = env.BUTLER_LANG === "en" ? "en" : "zh";
  const scope = butler ? { butler: true as const } : featureId !== null ? { featureId } : { ticketKey };
  return { scope, lang, from: from && !from.startsWith(HEADLESS_SESSION_PREFIX) ? from : null, requestsDir, resultsDir };
}
