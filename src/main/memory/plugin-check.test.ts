import { describe, expect, it } from "vitest";
import { statecorePluginInstalled } from "./plugin-check";

describe("StateCore capture plugin check (design 8.5)", () => {
  it("finds an enabled StateCore plugin or a StateCore hook command", () => {
    expect(statecorePluginInstalled({ enabledPlugins: { "statecore@statecore-marketplace": true } })).toBe(true);
    expect(statecorePluginInstalled({ hooks: { Stop: [{ hooks: [{ type: "command", command: "npx -y statecore-mcp hook stop" }] }] } })).toBe(true);
  });

  it("ignores disabled plugins, Butler's own hook and anything malformed", () => {
    expect(statecorePluginInstalled({ enabledPlugins: { "statecore@x": false } })).toBe(false);
    expect(statecorePluginInstalled({ hooks: { Stop: [{ hooks: [{ type: "command", command: '"/Users/me/.butler/bin/butler-hook"' }] }] } })).toBe(false);
    expect(statecorePluginInstalled({ mcpServers: { statecore: { command: "statecore-mcp" } } })).toBe(false);
    for (const v of [null, undefined, "x", 1, [], { enabledPlugins: "statecore" }]) expect(statecorePluginInstalled(v)).toBe(false);
  });
});
