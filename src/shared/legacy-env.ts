/**
 * BTL-260：产品从 Butler 改名为 Shipherd，环境变量也从 BUTLER_* 改成 SHIPHERD_*。
 * 改名前起的 claude（升级时还在跑的、hook 和 MCP server 继承了旧变量的）、用户自己设的 BUTLER_HOME / BUTLER_LANG
 * 还带着旧名字，所以读的时候新名字优先、新名字没有（或是空的）再看旧名字。写只写新名字。
 * TODO(5.0)：旧名字的回退保留一个大版本，5.0 删掉 LEGACY_ENV_PREFIX 和用到它的地方。
 */
export const LEGACY_ENV_PREFIX = "BUTLER_";
export const ENV_PREFIX = "SHIPHERD_";

/** SHIPHERD_<name>，没有（或只有空白）时退回 BUTLER_<name>。两个都没有为 undefined。 */
export function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[ENV_PREFIX + name];
  if (v !== undefined && v.trim() !== "") return v;
  return env[LEGACY_ENV_PREFIX + name] ?? v;
}

/**
 * 起 claude 子进程前要去掉的旧名字：hook 读这几个，新名字没设时会退回旧名字，
 * 所以外层环境里漏进来的 BUTLER_TICKET（比如从旧 Butler 的终端里启动了 Shipherd）会被当成这个 session 的 ticket。
 * 只去掉这几个，别的 BUTLER_ 开头的变量可能是用户别的工具的，不动。
 */
export const LEGACY_SESSION_VARS = ["HOME", "SESSION", "TICKET"].map((n) => LEGACY_ENV_PREFIX + n);
