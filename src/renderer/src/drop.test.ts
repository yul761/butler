import { describe, expect, it } from "vitest";
import { dropText, quotePath } from "./drop";

describe("drop quoting", () => {
  it("single-quotes on posix and escapes embedded quotes", () => {
    expect(quotePath("/a b/c.txt", "darwin")).toBe("'/a b/c.txt'");
    expect(quotePath("/it's", "linux")).toBe("'/it'\\''s'");
  });
  it("double-quotes on Windows", () => {
    expect(quotePath("C:\\My Files\\a.txt", "win32")).toBe('"C:\\My Files\\a.txt"');
  });
  it("joins several paths with spaces and no newline", () => {
    expect(dropText(["/a", "/b c"], "darwin")).toBe("'/a' '/b c'");
    expect(dropText([], "darwin")).toBe("");
  });
  it("strips control characters from dropped names", () => {
    expect(quotePath("/tmp/evil\u001b[31m\nname.txt", "darwin")).toBe("'/tmp/evil[31mname.txt'");
    expect(dropText(["C:\\a\rb.txt"], "win32")).toBe('"C:\\ab.txt"');
  });
});
