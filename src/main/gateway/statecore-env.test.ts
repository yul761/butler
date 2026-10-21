import { describe, expect, it } from "vitest";
import { statecoreEnv } from "./statecore-env";

describe("statecoreEnv (design 8.5)", () => {
  const base = { PATH: "/bin", HOME: "/h", MODEL_API_KEY: "inherited", MODEL_BASE_URL: "https://x", FEATURE_LLM: "true", UNSET: undefined };

  it("never gives StateCore a personal key below the full level, and strips inherited model settings", () => {
    for (const level of ["off", "metadata", "redacted"] as const) {
      expect(statecoreEnv(base, level, "sk-mine"), level).toEqual({ PATH: "/bin", HOME: "/h" });
    }
  });

  it("hands over the key only at the full level", () => {
    expect(statecoreEnv(base, "full", "sk-mine")).toEqual({ PATH: "/bin", HOME: "/h", FEATURE_LLM: "true", MODEL_API_KEY: "sk-mine" });
    expect(statecoreEnv(base, "full", null)).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});
