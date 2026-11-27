import { describe, expect, it } from "vitest";
import { WORKFLOW_STEPS } from "../../shared/workflow";
import { WORKFLOW_STRINGS } from "./strings";

const CJK = /[一-鿿]/;

describe("workflow strings (BTL-273)", () => {
  it("both languages have the same keys, and English has no Chinese in it", () => {
    const { zh, en } = WORKFLOW_STRINGS;
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const [k, v] of Object.entries(en)) {
      if (typeof v === "string") expect(CJK.test(v), k).toBe(false);
      else if (typeof v === "object") expect(CJK.test(JSON.stringify(v)), k).toBe(false);
    }
    for (const id of WORKFLOW_STEPS) {
      expect(en.step(id)).toBeTruthy();
      expect(CJK.test(en.step(id)), id).toBe(false);
      expect(zh.stepHelp[id]).toBeTruthy();
      expect(en.stepHelp[id]).toBeTruthy();
    }
  });
});
