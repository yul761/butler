// UI 重做第 5 层 Task 1 的结论：完整分叉照抄开发 session 的参数时，第一轮能不能读到开发 session 留下的缓存。
// 实测脚本：scripts/fork-cache-spike.mjs（手动跑，不进 app）。Claude Code 升级后如果分叉变贵，先重跑它。

export interface FullForkPlan {
  /** 完整分叉照抄开发 session 的参数，第一轮能读到它的缓存（spike 实测）。false：完整分叉走 strictForkArgs，自动选择永远选精简。 */
  cacheOk: boolean;
  /** 加 --permission-mode dontAsk 和 --allowedTools 后缓存还在。false 时这两样不加（只读全靠 readonly hook；-p 下没放行的工具本来就是拒绝）。 */
  permissionArgs: boolean;
  /** 分叉另写一份 MCP 配置（换了 termId、server 集合不变）缓存还在。false 时直接用开发 session 那份配置文件。 */
  ownMcpConfig: boolean;
}

/**
 * 实测（2026-11-20，Claude Code 2.1.329，模型 claude-opus-5-5，CLAUDE_EFFORT=high），变体都是 v2（生产候选）：
 * 开发参数原样、--session-id 换成 --resume、加 -p --output-format json --fork-session、
 * --settings 换成拷贝（permissions.allow = []，hooks 只剩一个 PreToolUse），--mcp-config 换成拷贝，
 * 再加 --permission-mode dontAsk --allowedTools Read Grep Glob Bash(git …)。提示词「只回答 OK」，整次只有一轮。
 *
 * 1. 普通 ticket session（Shipherd 开的 BTL-235 开发 session，--model opus，无 --add-dir），开发上下文 152,125：
 *    input 2、write1h 3,155、read 157,539、output 75，$0.058；r1 = 0.980，r2 = 1.036 → PASS。
 *    （开发 session 当时正在跑一轮，transcript 末尾挂着没结果的 tool_use；前缀照样命中。）
 * 2. 总控形状的 session（features/1.json 的 MCP、--add-dir、coordinator guide，不带 --model），交互模式下读了两份文件，开发上下文 93,407：
 *    input 2、write1h 2,710、read 93,405、output 4，$0.040；r1 = 0.972，r2 = 1.000 → PASS。
 * 一共跑了 2 次，合计约 $0.10。v1 / v2-no-perm / v2-dev-mcp 没有跑（v2 直接通过，按计划不用拆）。
 *
 * 前提：分叉的环境变量要跟开发 session 一样带上 CLAUDE_EFFORT 之类的 CLAUDE_*（都来自 Shipherd 自己的 process.env，
 * 生产代码用同一个 baseEnv，自然一致）；参数里不能有 --disallowedTools、--json-schema、--setting-sources、--no-session-persistence。
 * 没测过的情形：开发参数里没有 --settings 时，devForkArgs 把分叉的 --settings 追加在 --fork-session 之后（readonly hook 靠它）；
 * Shipherd 开的 session 平常都带 --settings，只有 mcpSettings 返回 null 时才会走到。
 */
export const FULL_FORK: FullForkPlan = { cacheOk: true, permissionArgs: true, ownMcpConfig: true };
