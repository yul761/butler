import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { runSmoke } from "./smoke";

if (process.argv.includes("--smoke")) {
  void runSmoke()
    .then((code) => app.exit(code))
    .catch(() => app.exit(1));
} else {
  void app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      webPreferences: { preload: join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void win.loadFile(join(__dirname, "../renderer/index.html"));
  });
}
