import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TRAY_ICONS } from "./tray-icons";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** PNG 的宽高（IHDR 块，紧跟 8 字节签名之后）和是否带透明通道（颜色类型 6 = RGBA）。 */
function pngInfo(buf: Buffer): { width: number; height: number; alpha: boolean } {
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(buf.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), alpha: buf[25] === 6 };
}

describe("app and tray icons (direction E1)", () => {
  it("ships 16 px and @2x 32 px tray images for macOS (template) and Windows, with transparency", () => {
    for (const set of [TRAY_ICONS.macTemplate, TRAY_ICONS.win]) {
      expect(pngInfo(Buffer.from(set[1], "base64"))).toEqual({ width: 16, height: 16, alpha: true });
      expect(pngInfo(Buffer.from(set[2], "base64"))).toEqual({ width: 32, height: 32, alpha: true });
    }
  });

  it("has 1024 px app icons for electron-builder, rendered from the SVG sources", () => {
    for (const f of ["build-resources/icon.png", "build-resources/icon-win.png"]) {
      expect(pngInfo(readFileSync(`${root}${f}`)), f).toEqual({ width: 1024, height: 1024, alpha: true });
    }
    for (const f of ["app-mac.svg", "app-win.svg", "tray-template.svg", "tray-win.svg"]) {
      expect(existsSync(`${root}build-resources/icon-src/${f}`), f).toBe(true);
    }
  });
});
