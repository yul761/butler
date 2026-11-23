// 应用菜单（BTL-253 / BTL-254）。Shipherd 原来用 Electron 的默认菜单；现在是同样的标准几项（用 role，文字是 Electron 自带的，和原来一样），
// 外加「帮助」里 Shipherd 自己的项：BTL-253 的「检查更新…」，BTL-254 的「发送反馈…」。
import type { MenuItemConstructorOptions } from "electron";
import { M } from "./strings";

export interface AppMenuOptions {
  platform: NodeJS.Platform;
  /** 「帮助」里的项，按顺序。 */
  help: MenuItemConstructorOptions[];
}

/** 菜单模板：macOS 上有应用菜单（关于、服务、隐藏、退出），其他平台没有；「帮助」放最后。 */
export function appMenuTemplate(o: AppMenuOptions): MenuItemConstructorOptions[] {
  return [
    ...(o.platform === "darwin" ? [{ role: "appMenu" } as const] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    { role: "help", label: M().menu.help, submenu: o.help },
  ];
}
