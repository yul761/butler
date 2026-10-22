import { describe, expect, it } from "vitest";
import { autostartState } from "./autostart";

describe("autostart (design 2.2)", () => {
  it("is only offered by an installed app on macOS and Windows", () => {
    expect(autostartState({ packaged: true, platform: "darwin", openAtLogin: () => true })).toEqual({ supported: true, enabled: true });
    expect(autostartState({ packaged: true, platform: "win32", openAtLogin: () => false })).toEqual({ supported: true, enabled: false });
    let asked = false;
    const read = () => (asked = true);
    expect(autostartState({ packaged: false, platform: "darwin", openAtLogin: read })).toEqual({ supported: false, enabled: false });
    expect(autostartState({ packaged: true, platform: "linux", openAtLogin: read })).toEqual({ supported: false, enabled: false });
    expect(asked).toBe(false);
  });
});
