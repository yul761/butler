import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ClaudeLoginState } from "../../shared/types";

/** ok：找到了登录记录；missing：一个都没找到（很可能还没登录）。 */
export type ClaudeLogin = ClaudeLoginState;

/** 这些环境变量任意一个有值，claude 就不用交互登录（API key、云厂商、长期 token）。 */
const LOGIN_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = JSON.parse(await readFile(file, "utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * claude 看起来登没登录（BTL-249，向导第 1 步提示用）：只读 Claude Code 自己留下的记录，不执行 claude、不联网，也不读出任何 key。
 * 认的记录：.claude.json 里的账号（oauthAccount）或 API key（primaryApiKey）；配置目录里的 .credentials.json（Linux、Windows）；
 * settings.json 里的 apiKeyHelper 或带登录变量的 env；进程环境里的登录变量。macOS 的钥匙串不读：登录以后 .claude.json 里总会有账号。
 * 只用来提示，不拦路：没认出来的登录方式照样能用。
 */
export async function claudeLoginState(d: { claudeJson: string; claudeConfigDir: string; claudeSettings: string; env: NodeJS.ProcessEnv }): Promise<ClaudeLogin> {
  if (LOGIN_ENV.some((k) => !!d.env[k])) return "ok";
  if (existsSync(join(d.claudeConfigDir, ".credentials.json"))) return "ok";
  const state = await readJson(d.claudeJson);
  if (state && (state.oauthAccount || state.primaryApiKey)) return "ok";
  const settings = await readJson(d.claudeSettings);
  if (settings?.apiKeyHelper) return "ok";
  const env = settings?.env;
  if (env && typeof env === "object" && LOGIN_ENV.some((k) => !!(env as Record<string, unknown>)[k])) return "ok";
  return "missing";
}
