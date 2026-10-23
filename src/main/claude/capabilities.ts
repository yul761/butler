import type { ClaudeHealth } from "../../shared/types";
import { execText, type ExecText } from "../util/exec";

/** Butler 依赖的 Claude Code 参数；缺任何一个都要在设置页报警。 */
export const REQUIRED_FLAGS = [
  "--print",
  "--session-id",
  "--resume",
  "--fork-session",
  "--mcp-config",
  "--output-format",
  "--json-schema",
  "--allowedTools",
  "--disallowedTools",
  "--no-session-persistence",
  "--permission-mode",
  /** 后台运行只读用户级设置（headlessArgs / PROBE_ARGS）。老版本没有它，每次后台运行都会失败。 */
  "--setting-sources",
  // 总控 session：每个仓库一个 --add-dir（多仓库 ticket）。
  "--add-dir",
] as const;

export function parseVersion(out: string): string | null {
  return /\d+\.\d+\.\d+/.exec(out)?.[0] ?? null;
}

export function parseFlags(help: string): Record<string, boolean> {
  return Object.fromEntries(REQUIRED_FLAGS.map((f) => [f, new RegExp(`(^|[\\s,])${f}(?![\\w-])`, "m").test(help)]));
}

export async function probeClaude(claudePath: string | null, env: NodeJS.ProcessEnv, run: ExecText = execText): Promise<ClaudeHealth> {
  const none = Object.fromEntries(REQUIRED_FLAGS.map((f) => [f, false]));
  if (!claudePath) return { path: null, version: null, flags: none, missingFlags: [...REQUIRED_FLAGS], error: "claude_not_found" };
  try {
    const [version, help] = await Promise.all([
      run(claudePath, ["--version"], { env, timeoutMs: 15_000 }),
      run(claudePath, ["--help"], { env, timeoutMs: 15_000 }),
    ]);
    const flags = parseFlags(help);
    return { path: claudePath, version: parseVersion(version), flags, missingFlags: REQUIRED_FLAGS.filter((f) => !flags[f]), error: null };
  } catch (e) {
    return { path: claudePath, version: null, flags: none, missingFlags: [...REQUIRED_FLAGS], error: (e as Error).message };
  }
}
