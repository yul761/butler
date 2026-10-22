import type { AutostartState } from "../shared/types";

/**
 * 开机自启（设计文档 2.2，app.setLoginItemSettings）只对安装好的 app 有意义：开发模式下登记的会是 node_modules 里的 Electron。
 * 只支持 macOS 和 Windows。不支持时不去读系统设置。
 */
export function autostartState(o: { packaged: boolean; platform: NodeJS.Platform; openAtLogin: () => boolean }): AutostartState {
  const supported = o.packaged && (o.platform === "darwin" || o.platform === "win32");
  return { supported, enabled: supported ? o.openAtLogin() : false };
}
