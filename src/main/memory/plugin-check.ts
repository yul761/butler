/**
 * 用户是不是另外装了 StateCore 自己的 Claude Code 捕获插件（设计文档 8.5：Butler 已覆盖它的功能，不要另装）。
 * 看用户级 settings.json：enabledPlugins 里有启用的 statecore 插件，或者有调用 `statecore-mcp hook` 的 hook 命令。
 * 只读，不改任何东西。
 */
export function statecorePluginInstalled(settings: unknown): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  const s = settings as Record<string, unknown>;
  const plugins = s.enabledPlugins;
  if (plugins && typeof plugins === "object" && !Array.isArray(plugins)) {
    if (Object.entries(plugins as Record<string, unknown>).some(([name, on]) => /statecore/i.test(name) && on !== false)) return true;
  }
  return /statecore-mcp[^"]*\bhook\b/i.test(JSON.stringify(s.hooks ?? null));
}
