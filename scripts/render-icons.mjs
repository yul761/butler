// 把 build-resources/icon-src/ 里的 SVG 渲染成打包和托盘要用的 PNG（Electron 离屏渲染，不需要别的图片工具）。
// 改了 SVG 之后重新生成：pnpm icons（即 electron scripts/render-icons.mjs）。生成的文件都提交进仓库：
//   build-resources/icon.png       macOS 应用图标（1024，electron-builder 转成 .icns）
//   build-resources/icon-win.png   Windows 应用图标（1024，electron-builder 转成 .ico）
//   src/main/tray-icons.ts         托盘图标（macOS 模板图 tray-template.svg、Windows 彩色图 tray-win.svg，各 16 和 32 px，base64）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (name) => fs.readFileSync(path.join(root, "build-resources", "icon-src", name), "utf8");

/** 把一段 SVG 在 size×size 的透明离屏窗口里渲染，返回 PNG。 */
async function render(svg, size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: true, javascript: false },
  });
  win.webContents.setFrameRate(1);
  // 每次一个临时目录：SVG 和页面都是本地文件（连续加载 data: URL 会被 Chromium 中止）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "butler-icon-"));
  fs.writeFileSync(path.join(dir, "icon.svg"), svg);
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden"><img src="icon.svg" width="${size}" height="${size}" style="display:block"></body></html>`,
  );
  await win.loadFile(path.join(dir, "index.html"));
  await delay(300);
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
  const out = image.resize({ width: size, height: size, quality: "best" });
  return out.toPNG();
}

app.disableHardwareAcceleration();
// 每渲染一张就关掉它的窗口：不能让“所有窗口都关了”把应用退出（之后的加载会被中止）。
app.on("window-all-closed", () => undefined);
app.whenReady().then(async () => {
  const mac = src("app-mac.svg");
  const winIcon = src("app-win.svg");
  const tray = src("tray-template.svg");
  const trayWin = src("tray-win.svg");
  fs.writeFileSync(path.join(root, "build-resources", "icon.png"), await render(mac, 1024));
  fs.writeFileSync(path.join(root, "build-resources", "icon-win.png"), await render(winIcon, 1024));
  const b64 = async (svg, size) => (await render(svg, size)).toString("base64");
  const ts = `// 由 scripts/render-icons.mjs 生成（源文件在 build-resources/icon-src/），不要手改。
/** 托盘图标（方向 E1：卡片叠）。macOS 用模板图（黑色加透明度，系统按菜单栏深浅着色），Windows 用蓝底白卡片的彩色版。 */
export const TRAY_ICONS = {
  macTemplate: { 1: "${await b64(tray, 16)}", 2: "${await b64(tray, 32)}" },
  win: { 1: "${await b64(trayWin, 16)}", 2: "${await b64(trayWin, 32)}" },
} as const;
`;
  fs.writeFileSync(path.join(root, "src", "main", "tray-icons.ts"), ts);
  console.log("icons rendered");
  app.quit();
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
