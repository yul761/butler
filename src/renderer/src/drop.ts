/** 把一个路径转成适合粘贴进 shell 的形式（mac/linux 单引号，Windows 双引号）。 */
export function quotePath(path: string, platform: string): string {
  if (platform === "win32") return `"${path}"`;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** 多个拖入的文件用空格连接，不带回车。 */
export function dropText(paths: string[], platform: string): string {
  return paths.map((p) => quotePath(p, platform)).join(" ");
}
