import type { PrivacyLevel } from "../../shared/llm";

export interface StatecoreLlm {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const STRIPPED_PREFIXES = ["MODEL_", "OPENAI_", "ANTHROPIC_"];
const STRIPPED_NAMES = new Set(["FEATURE_LLM", "STATECORE_DIGEST_THRESHOLD"]);

/**
 * 设计文档 8.5：StateCore 的 consolidate / 自动蒸馏会把原始事件发给 MODEL_API_KEY 对应的服务商，
 * 所以只有 full 档位才给它 key 并打开 FEATURE_LLM。StateCore 会从 MODEL_* 回退到 OPENAI_*，
 * 再回退到 api.openai.com，所以任何档位都先去掉继承来的 MODEL_* / OPENAI_* / ANTHROPIC_* / FEATURE_LLM
 * （不区分大小写）；full 且 key、baseUrl、model 都非空时，才把 Butler 自己的三项一起交过去。
 * 计划 4 接入 StateCore 时，它的环境变量必须由这个函数生成。
 */
export function statecoreEnv(base: NodeJS.ProcessEnv, level: PrivacyLevel, llm: StatecoreLlm | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    const name = k.toUpperCase();
    if (v === undefined || STRIPPED_NAMES.has(name) || STRIPPED_PREFIXES.some((p) => name.startsWith(p))) continue;
    env[k] = v;
  }
  if (level === "full" && llm && llm.apiKey && llm.baseUrl && llm.model) {
    env.FEATURE_LLM = "true";
    env.MODEL_API_KEY = llm.apiKey;
    env.MODEL_BASE_URL = llm.baseUrl;
    env.MODEL_NAME = llm.model;
  }
  return env;
}
