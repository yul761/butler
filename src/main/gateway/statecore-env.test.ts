import { describe, expect, it } from "vitest";
import { statecoreEnv } from "./statecore-env";

const llm = { apiKey: "sk-mine", baseUrl: "https://api.mine.example/v1", model: "m-1" };
const mine = { FEATURE_LLM: "true", MODEL_API_KEY: "sk-mine", MODEL_BASE_URL: llm.baseUrl, MODEL_NAME: "m-1" };

describe("statecoreEnv (design 8.5)", () => {
  const base = { PATH: "/bin", HOME: "/h", MODEL_API_KEY: "inherited", MODEL_BASE_URL: "https://x", FEATURE_LLM: "true", UNSET: undefined };

  it("never gives StateCore a personal key below the full level, and strips inherited model settings", () => {
    for (const level of ["off", "metadata", "redacted"] as const) {
      expect(statecoreEnv(base, level, llm), level).toEqual({ PATH: "/bin", HOME: "/h" });
    }
  });

  it("hands over key, base URL and model together, only at the full level", () => {
    expect(statecoreEnv(base, "full", llm)).toEqual({ PATH: "/bin", HOME: "/h", ...mine });
    expect(statecoreEnv(base, "full", null)).toEqual({ PATH: "/bin", HOME: "/h" });
  });

  it("sets nothing when any of key, base URL or model is empty", () => {
    for (const bad of [{ ...llm, apiKey: "" }, { ...llm, baseUrl: "" }, { ...llm, model: "" }]) {
      expect(statecoreEnv(base, "full", bad)).toEqual({ PATH: "/bin", HOME: "/h" });
    }
  });

  it("strips fallback and differently-cased variables at every level", () => {
    const dirty = {
      PATH: "/bin",
      HOME: "/h",
      OPENAI_API_KEY: "a",
      OPENAI_BASE_URL: "https://proxy.corp",
      OPENAI_MODEL: "g",
      ANTHROPIC_API_KEY: "b",
      model_api_key: "c",
      Feature_Llm: "true",
      MODEL_STRUCTURED_OUTPUT_API_KEY: "d",
      STATECORE_DIGEST_THRESHOLD: "1",
    };
    for (const level of ["off", "metadata", "redacted"] as const) {
      expect(statecoreEnv(dirty, level, llm), level).toEqual({ PATH: "/bin", HOME: "/h" });
    }
  });

  it("at full, an inherited OPENAI_BASE_URL is gone and MODEL_BASE_URL is Butler's", () => {
    const env = statecoreEnv({ PATH: "/bin", OPENAI_BASE_URL: "https://proxy.corp" }, "full", llm);
    expect(env).toEqual({ PATH: "/bin", ...mine });
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });
});
