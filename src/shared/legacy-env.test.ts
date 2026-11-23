// BTL-260：BUTLER_* 是改名前的环境变量名，测的就是它们还被认得。
import { describe, expect, it } from "vitest";
import { envValue, LEGACY_SESSION_VARS } from "./legacy-env";

describe("envValue", () => {
  it("prefers SHIPHERD_<name> and falls back to the pre-rename BUTLER_<name>", () => {
    expect(envValue({ SHIPHERD_TICKET: "A-1", BUTLER_TICKET: "B-1" }, "TICKET")).toBe("A-1");
    expect(envValue({ BUTLER_TICKET: "B-1" }, "TICKET")).toBe("B-1");
    expect(envValue({}, "TICKET")).toBeUndefined();
  });

  it("treats an empty or blank new name as unset", () => {
    expect(envValue({ SHIPHERD_LANG: "", BUTLER_LANG: "en" }, "LANG")).toBe("en");
    expect(envValue({ SHIPHERD_LANG: "  ", BUTLER_LANG: "en" }, "LANG")).toBe("en");
    expect(envValue({ SHIPHERD_LANG: "" }, "LANG")).toBe("");
  });

  it("lists only the old session variables the hook reads, not every BUTLER_ variable", () => {
    expect(LEGACY_SESSION_VARS).toEqual(["BUTLER_HOME", "BUTLER_SESSION", "BUTLER_TICKET"]);
  });
});
