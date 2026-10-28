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

  it("has app icons for electron-builder, rendered from the SVG sources", () => {
    expect(pngInfo(readFileSync(`${root}build-resources/icon.png`))).toEqual({ width: 1024, height: 1024, alpha: true });
    for (const f of ["app-mac.svg", "app-win.svg", "tray-template.svg", "tray-win.svg"]) {
      expect(existsSync(`${root}build-resources/icon-src/${f}`), f).toBe(true);
    }
  });

  it("ships a Windows .ico with every size the shell asks for, each a real PNG of that size", () => {
    const buf = readFileSync(`${root}build-resources/icon.ico`);
    expect([buf.readUInt16LE(0), buf.readUInt16LE(2)]).toEqual([0, 1]);
    const sizes: number[] = [];
    for (let i = 0; i < buf.readUInt16LE(4); i++) {
      const e = 6 + 16 * i;
      const size = buf[e] === 0 ? 256 : buf[e];
      const png = buf.subarray(buf.readUInt32LE(e + 12), buf.readUInt32LE(e + 12) + buf.readUInt32LE(e + 8));
      expect(pngInfo(png), `${size}`).toEqual({ width: size, height: size, alpha: true });
      sizes.push(size);
    }
    expect(sizes).toEqual(expect.arrayContaining([16, 20, 24, 32, 40, 48, 64, 256]));
  });

  // 不用去每种主题下实测，靠两条（WCAG 的非文字对比度 3:1）：
  // 1. 白卡片和底色拉开，缩到 16 px 也认得出卡片叠（旧图标浅灰底白卡片只有 1.1，任务栏上成了一个白块）；
  // 2. 在深色、浅色的任务栏 / Dock 上，底色和白卡片至少有一个和背景拉开（深色上靠卡片，浅色上靠底色）。
  // macOS 托盘是模板图，系统负责着色，不在这里。
  it("keeps every icon readable on dark and light taskbars", () => {
    const backgrounds = { "Windows dark taskbar": "#202020", "Windows light taskbar": "#F3F3F3", "macOS dark Dock": "#3A3A3C", "macOS light Dock": "#E8E8E8" };
    for (const f of ["app-mac.svg", "app-win.svg", "tray-win.svg"]) {
      const svg = readFileSync(`${root}build-resources/icon-src/${f}`, "utf8");
      const tile = /<rect[^>]*\bfill="(#[0-9A-Fa-f]{6})"/.exec(svg)?.[1];
      expect(tile, f).toBeDefined();
      expect(svg, f).toContain('fill="#FFFFFF"');
      expect(contrast(tile!, "#FFFFFF"), `${f}: white cards on the tile`).toBeGreaterThanOrEqual(3);
      for (const [name, bg] of Object.entries(backgrounds)) {
        expect(Math.max(contrast(tile!, bg), contrast("#FFFFFF", bg)), `${f} on ${name}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

/** WCAG 2 的对比度。 */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
