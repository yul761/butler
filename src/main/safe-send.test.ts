import { describe, expect, it } from "vitest";
import { canSend } from "./safe-send";

const win = (w: boolean, c: boolean) => ({ isDestroyed: () => w, webContents: { isDestroyed: () => c } });

describe("canSend", () => {
  it("rejects null", () => expect(canSend(null)).toBe(false));
  it("rejects a destroyed window", () => expect(canSend(win(true, false))).toBe(false));
  it("rejects destroyed webContents", () => expect(canSend(win(false, true))).toBe(false));
  it("accepts a live window", () => expect(canSend(win(false, false))).toBe(true));
});
