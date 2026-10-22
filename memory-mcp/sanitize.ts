import { statecoreEnv } from "../src/main/gateway/statecore-env";

/**
 * 原地删掉 StateCore 会用来调用模型的变量（计划 4 R1）。claude 启动 MCP server 时会把它自己的环境变量
 * （可能有用户 shell 里导出的 OPENAI_API_KEY 等）一起传下来，所以 server 进程启动时必须自己再清一遍。
 */
export function sanitizeEnv(env: NodeJS.ProcessEnv): void {
  const keep = statecoreEnv(env);
  for (const k of Object.keys(env)) if (!(k in keep)) delete env[k];
}
