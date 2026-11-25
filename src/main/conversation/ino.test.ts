import { describe, expect, it } from "vitest";
import { inoText, sameIno } from "./ino";

describe("ino", () => {
  it("keeps NTFS ids above 2^53 apart", () => {
    const a = inoText(18858823440414828n);
    const b = inoText(18858823440414829n); // Number() 会把这两个舍成同一个值
    expect(Number(18858823440414828n)).toBe(Number(18858823440414829n));
    expect(sameIno(a, a)).toBe(true);
    expect(sameIno(a, b)).toBe(false);
  });
  it("matches a legacy digits-only row by its rounded number", () => {
    expect(sameIno("42", inoText(42n))).toBe(true);
    expect(sameIno("43", inoText(42n))).toBe(false);
    expect(sameIno("18858823440414828", inoText(18858823440414829n))).toBe(true);
  });
});
