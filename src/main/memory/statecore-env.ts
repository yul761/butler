const STRIPPED_PREFIXES = ["MODEL_", "OPENAI_", "ANTHROPIC_"];
const STRIPPED_NAMES = new Set(["FEATURE_LLM", "STATECORE_DIGEST_THRESHOLD"]);

/**
 * StateCore 进程（主进程里的嵌入式后端、给 claude 挂的 MCP）的环境变量（设计文档 8.5，计划 4 Ruling R1 / P4-R3）。
 * StateCore 的蒸馏会读 FEATURE_LLM 和 MODEL_*（再回退到 OPENAI_*，最后回退到 api.openai.com），把原始事件直接发给服务商。
 * Butler 不让任何 StateCore 进程走这条路：去掉这些变量（不区分大小写），也从不交出 key。
 * Butler 自己不调用任何模型（BTL-243 拿掉了个人 API 和蒸馏）：数据只经过用户自己的 claude。
 */
export function statecoreEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    const name = k.toUpperCase();
    if (v === undefined || STRIPPED_NAMES.has(name) || STRIPPED_PREFIXES.some((p) => name.startsWith(p))) continue;
    env[k] = v;
  }
  return env;
}
