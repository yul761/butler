import { describe, expect, it } from "vitest";
import { healthText, parseChain } from "./routing-view";
import { STRINGS } from "./strings";


describe("routing view helpers", () => {
  it("health text", () => {
    const S = STRINGS.en;
    expect(healthText(undefined, S)).toBe("Healthy");
    expect(healthText({ model: "M", state: "limited", kind: "usage_limit", until: null, resetKnown: false, suspected: true, consecutiveFailures: 1, lastSuccessAt: null, lastFailureAt: 1, lastFailureText: "x" }, S)).toBe(
      "Limited · suspected · Reset time unknown; Shipherd backs off, then probes",
    );
  });

  it("chain text parsing", () => {
    expect(parseChain(" a, b\nc,, a ")).toEqual(["a", "b", "c"]);
  });
});
