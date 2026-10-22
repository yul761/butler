import { describe, expect, it } from "vitest";
import { sanitizeEnv } from "./sanitize";

describe("memory MCP environment (R1)", () => {
  it("deletes every model variable in place, whatever the letter case, and keeps the rest", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/bin", STATECORE_SCOPE: "ticket:A-1", ELECTRON_RUN_AS_NODE: "1",
      MODEL_API_KEY: "k", openai_api_key: "k2", ANTHROPIC_API_KEY: "k3", FEATURE_LLM: "true", STATECORE_DIGEST_THRESHOLD: "1",
    };
    sanitizeEnv(env);
    expect(env).toEqual({ PATH: "/bin", STATECORE_SCOPE: "ticket:A-1", ELECTRON_RUN_AS_NODE: "1" });
  });
});
