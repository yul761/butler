import type { PrivacyLevel } from "../../shared/llm";

/**
 * 设计文档 8.5：StateCore 的 consolidate / 自动蒸馏会把原始事件发给 MODEL_API_KEY 对应的服务商，
 * 所以只有 full 档位才给它 key 并打开 FEATURE_LLM；其他档位连从用户环境继承来的 MODEL_* / FEATURE_LLM 也去掉。
 * 计划 4 接入 StateCore 时，它的环境变量必须由这个函数生成。
 */
export function statecoreEnv(base: NodeJS.ProcessEnv, level: PrivacyLevel, apiKey: string | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k === "FEATURE_LLM" || k.startsWith("MODEL_")) continue;
    env[k] = v;
  }
  if (level === "full" && apiKey) {
    env.FEATURE_LLM = "true";
    env.MODEL_API_KEY = apiKey;
  }
  return env;
}
