import { describe, expect, it } from "vitest";
import { titlePrefix } from "./progress";

describe("titlePrefix", () => {
  it("takes bracket tags, conventional-commit types and short colon heads", () => {
    expect(titlePrefix("[ui] Add page")).toBe("ui");
    expect(titlePrefix("feat(api): add x")).toBe("feat(api)");
    expect(titlePrefix("fix!: breaking")).toBe("fix");
    expect(titlePrefix("Docs: tidy up")).toBe("Docs");
    expect(titlePrefix("数据 导出: 加一列")).toBe("数据 导出");
  });
  it("returns null without a usable prefix", () => {
    expect(titlePrefix(null)).toBeNull();
    expect(titlePrefix("   ")).toBeNull();
    expect(titlePrefix("Add a page")).toBeNull();
    expect(titlePrefix("A very long sentence that goes on and on: then")).toBeNull();
    expect(titlePrefix("[] empty")).toBeNull();
    expect(titlePrefix("see https://x: y")).toBeNull();
  });
});
