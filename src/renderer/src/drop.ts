import { stripControl } from "../../shared/text";

/**
 * 把一个路径转成适合粘贴进 shell 的形式（mac/linux 单引号，Windows 双引号）。
 * 文件名里的控制字符（恶意命名的 ESC、换行）一律去掉，免得被 claude 的界面当成按键。
 */
export function quotePath(path: string, platform: string): string {
  const clean = stripControl(path);
  if (platform === "win32") return `"${clean}"`;
  return `'${clean.replace(/'/g, "'\\''")}'`;
}

/** 多个拖入的文件用空格连接，不带回车。 */
export function dropText(paths: string[], platform: string): string {
  return paths.map((p) => quotePath(p, platform)).join(" ");
}
