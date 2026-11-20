import { DENIED_TOOLS, SETTING_SOURCES_ARGS } from "../claude/headless";
import type { FullForkPlan } from "./fork-cache";

/** 分叉只读：能读文件、搜索、看 git 历史；没有写，也没有别的 shell 命令。 */
export const FORK_ALLOWED_TOOLS: readonly string[] = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git status)", "Bash(git show:*)"];

/** 开发 session 这次启动时传给 claude 的参数（claudeArgs 的输出，不含 resolveLaunch 的前缀）。 */
export interface DevLaunch {
  sessionId: string;
  cwd: string;
  claudeArgs: string[];
  mcpConfigPath: string | null;
  settingsPath: string | null;
  addDirs: string[];
  /** 启动时的 --model；终端里用 /model 切换不会反映在这里（第一轮分叉会因此错过缓存）。 */
  model: string | null;
}

/**
 * 完整分叉（参数顺序与 scripts/fork-cache-spike.mjs 实测的一致）：开发参数原位保留，--session-id 换成 --resume，
 * --settings 换成分叉那份，ownMcpConfig 时 --mcp-config 换成分叉那份；然后追加 -p --output-format json --fork-session；
 * 开发参数里没有 --settings 就在这之后补上（只读 hook 靠它）；permissionArgs 时最后加 dontAsk 和 --allowedTools（变长参数，必须放最后）。
 */
export function devForkArgs(dev: DevLaunch, o: { forkSettingsPath: string; forkMcpConfigPath: string | null; plan: FullForkPlan }): string[] {
  const out: string[] = [];
  const src = dev.claudeArgs;
  let settings = false;
  for (let i = 0; i < src.length; i++) {
    const a = src[i];
    if (a === "--session-id") {
      out.push("--resume");
    } else if (a === "--settings") {
      out.push(a, o.forkSettingsPath);
      i++;
      settings = true;
    } else if (a === "--mcp-config" && o.plan.ownMcpConfig && o.forkMcpConfigPath) {
      out.push(a, o.forkMcpConfigPath);
      i++;
    } else {
      out.push(a);
    }
  }
  out.push("-p", "--output-format", "json", "--fork-session");
  if (!settings) out.push("--settings", o.forkSettingsPath);
  if (o.plan.permissionArgs) out.push("--permission-mode", "dontAsk", "--allowedTools", ...FORK_ALLOWED_TOOLS);
  return out;
}

/**
 * 严格参数：精简分叉和 B 分支的完整分叉。没有 --json-schema，没有 --no-session-persistence，没有 MCP。
 */
export function strictForkArgs(o: { resumeSessionId?: string; model: string | null; addDirs: string[]; forkSettingsPath: string }): string[] {
  const args = ["-p", "--output-format", "json", "--permission-mode", "dontAsk", ...SETTING_SOURCES_ARGS];
  if (o.model) args.push("--model", o.model);
  if (o.resumeSessionId) args.push("--resume", o.resumeSessionId, "--fork-session");
  for (const d of o.addDirs) args.push("--add-dir", d);
  args.push("--settings", o.forkSettingsPath);
  args.push("--disallowedTools", ...DENIED_TOOLS, "--allowedTools", ...FORK_ALLOWED_TOOLS);
  return args;
}

/** 接着问：第一轮的 `--resume <开发 id> --fork-session` 换成 `--resume <分叉 id>`；第一轮没有 --resume（精简）就在 -p 后面插入。 */
export function continueArgs(first: readonly string[], forkSessionId: string): string[] {
  const args = first.filter((a) => a !== "--fork-session");
  const at = args.indexOf("--resume");
  if (at >= 0) args[at + 1] = forkSessionId;
  else args.splice(args.indexOf("-p") + 1, 0, "--resume", forkSessionId);
  return args;
}

/**
 * 分叉用的 settings：开发那份除 permissions、hooks 以外原样保留（工具集合才不变）；allow 清空，hook 只剩只读那一个。
 * disableAllHooks 固定为 false：用户级（或开发那份）设了 true 也关不掉只读 hook。
 */
export function forkSettings(dev: Record<string, unknown> | null, guardCommand: string): Record<string, unknown> {
  const rest = { ...dev };
  delete rest.permissions;
  delete rest.hooks;
  return {
    ...rest,
    permissions: { allow: [] },
    disableAllHooks: false,
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${guardCommand} readonly`, timeout: 10 }] }] },
  };
}
