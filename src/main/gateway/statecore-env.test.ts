import { describe, expect, it } from "vitest";
import { statecoreEnv } from "./statecore-env";

describe("statecoreEnv (design 8.5, plan 4 R1)", () => {
  it("strips every model setting StateCore could use, at any letter case, and keeps the rest", () => {
    const dirty = {
      PATH: "/bin",
      HOME: "/h",
      MODEL_API_KEY: "a",
      MODEL_BASE_URL: "https://x",
      MODEL_NAME: "m",
      MODEL_STRUCTURED_OUTPUT_API_KEY: "d",
      OPENAI_API_KEY: "b",
      OPENAI_BASE_URL: "https://proxy.corp",
      OPENAI_MODEL: "g",
      ANTHROPIC_API_KEY: "c",
      model_api_key: "e",
      Feature_Llm: "true",
      FEATURE_LLM: "true",
      STATECORE_DIGEST_THRESHOLD: "1",
      UNSET: undefined,
    };
    expect(statecoreEnv(dirty)).toEqual({ PATH: "/bin", HOME: "/h" });
  });

  it("never adds anything", () => {
    expect(statecoreEnv({})).toEqual({});
    expect(Object.keys(statecoreEnv({ STATECORE_SCOPE: "ticket:A-1", LOG_LEVEL: "warn" })).sort()).toEqual(["LOG_LEVEL", "STATECORE_SCOPE"]);
  });
});
