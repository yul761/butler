import { describe, expect, it } from "vitest";
import { claudeArgs } from "../claude/spawn";
import { FULL_FORK } from "./fork-cache";
import { continueArgs, type DevLaunch, devForkArgs, FORK_ALLOWED_TOOLS, forkSettings, strictForkArgs } from "./fork-args";

const dev: DevLaunch = {
  sessionId: "s1",
  cwd: "/w",
  claudeArgs: claudeArgs({ mode: "new", sessionId: "s1", mcpConfigPath: "/m.json", settingsPath: "/s.json", addDirs: ["/r2"], guidePath: "/g.md", model: "opus" }),
  mcpConfigPath: "/m.json",
  settingsPath: "/s.json",
  addDirs: ["/r2"],
  model: "opus",
};
const o = { forkSettingsPath: "/fs.json", forkMcpConfigPath: "/fm.json", plan: FULL_FORK };
const after = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

describe("devForkArgs", () => {
  it("copies the dev args, resumes and forks, and swaps settings and mcp config", () => {
    const a = devForkArgs(dev, o);
    expect(a).toContain("-p");
    expect(a.join(" ")).toContain("--output-format json");
    expect(a.join(" ")).toContain("--resume s1 ");
    expect(a).toContain("--fork-session");
    expect(a).not.toContain("--session-id");
    expect(after(a, "--settings")).toBe("/fs.json");
    expect(after(a, "--mcp-config")).toBe("/fm.json");
    expect(a.join(" ")).toContain("--append-system-prompt-file /g.md");
    expect(a.join(" ")).toContain("--add-dir /r2");
    expect(a.join(" ")).toContain("--model opus");
    for (const f of ["--disallowedTools", "--json-schema", "--setting-sources", "--no-session-persistence"]) expect(a).not.toContain(f);
    expect(a.slice(a.indexOf("--allowedTools"))).toEqual(["--allowedTools", ...FORK_ALLOWED_TOOLS]);
    expect(after(a, "--permission-mode")).toBe("dontAsk");
  });
  it("leaves out permission args when the plan says so", () => {
    const a = devForkArgs(dev, { ...o, plan: { ...FULL_FORK, permissionArgs: false } });
    expect(a).not.toContain("--permission-mode");
    expect(a).not.toContain("--allowedTools");
  });
  it("keeps the spike's order: dev args in place, then -p --output-format json --fork-session, permission args last", () => {
    const a = devForkArgs(dev, o);
    expect(a.slice(0, 2)).toEqual(["--resume", "s1"]);
    const at = a.indexOf("-p");
    expect(a.slice(at, at + 4)).toEqual(["-p", "--output-format", "json", "--fork-session"]);
    expect(a.indexOf("--mcp-config")).toBeLessThan(at);
    expect(a.indexOf("--permission-mode")).toBeGreaterThan(at);
  });
  it("appends the fork settings when the dev args had none, and keeps a dev --resume", () => {
    const a = devForkArgs({ ...dev, claudeArgs: ["--resume", "s1", "--model", "opus"] }, o);
    expect(a.slice(0, 5)).toEqual(["--resume", "s1", "--model", "opus", "-p"]);
    expect(after(a, "--settings")).toBe("/fs.json");
    expect(a.indexOf("--settings")).toBeGreaterThan(a.indexOf("--fork-session"));
  });
  it("keeps the dev mcp config when the plan says so", () => {
    const a = devForkArgs(dev, { ...o, plan: { ...FULL_FORK, ownMcpConfig: false } });
    expect(after(a, "--mcp-config")).toBe("/m.json");
  });
});

describe("strictForkArgs", () => {
  it("has no --resume without a session to fork", () => {
    const a = strictForkArgs({ model: null, addDirs: [], forkSettingsPath: "/fs.json" });
    expect(a).not.toContain("--resume");
    expect(a).not.toContain("--model");
    expect(after(a, "--settings")).toBe("/fs.json");
  });
  it("forks the given session and keeps the strict flags", () => {
    const a = strictForkArgs({ resumeSessionId: "X", model: "opus", addDirs: ["/r"], forkSettingsPath: "/fs.json" });
    expect(a.join(" ")).toContain("--resume X --fork-session");
    expect(a.join(" ")).toContain("--setting-sources user");
    expect(a.join(" ")).toContain("--disallowedTools Edit Write NotebookEdit");
    expect(a.join(" ")).toContain("--model opus");
    expect(a.join(" ")).toContain("--add-dir /r");
    expect(after(a, "--settings")).toBe("/fs.json");
    expect(a.slice(a.indexOf("--allowedTools"))).toEqual(["--allowedTools", ...FORK_ALLOWED_TOOLS]);
    expect(a).not.toContain("--json-schema");
    expect(a).not.toContain("--no-session-persistence");
  });
});

describe("continueArgs", () => {
  it("replaces the dev resume and fork flag of a full fork", () => {
    const first = devForkArgs(dev, o);
    const a = continueArgs(first, "f1");
    expect(a.filter((x) => x === "--resume")).toHaveLength(1);
    expect(a.join(" ")).toContain("--resume f1");
    expect(a).not.toContain("--fork-session");
    expect(a).not.toContain("s1");
    expect(a.filter((x) => x !== "--resume" && x !== "f1")).toEqual(first.filter((x) => x !== "--resume" && x !== "s1" && x !== "--fork-session"));
  });
  it("inserts --resume after -p for a lean fork", () => {
    const first = strictForkArgs({ model: null, addDirs: [], forkSettingsPath: "/fs.json" });
    const a = continueArgs(first, "f1");
    expect(a.slice(0, 3)).toEqual(["-p", "--resume", "f1"]);
    expect(a.slice(3)).toEqual(first.slice(1));
  });
  it("applied twice leaves only the latest id", () => {
    const a = continueArgs(continueArgs(devForkArgs(dev, o), "f1"), "f2");
    expect(a.filter((x) => x === "--resume")).toHaveLength(1);
    expect(a).toContain("f2");
    expect(a).not.toContain("f1");
    const b = continueArgs(continueArgs(strictForkArgs({ model: null, addDirs: [], forkSettingsPath: "/fs.json" }), "f1"), "f2");
    expect(b.filter((x) => x === "--resume")).toHaveLength(1);
    expect(b).toContain("f2");
    expect(b).not.toContain("f1");
  });
});

interface Settings {
  enableAllProjectMcpServers: boolean;
  disabledMcpjsonServers: string[];
  permissions: { allow: string[] };
  hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
}

describe("forkSettings", () => {
  const devSettings = {
    enableAllProjectMcpServers: true,
    disabledMcpjsonServers: ["x"],
    permissions: { allow: ["Bash(*)"], deny: [] },
    hooks: { PreToolUse: [{ matcher: "Skill", hooks: [{ type: "command", command: "gate" }] }], Stop: [] },
  };
  it("keeps everything but permissions and hooks", () => {
    const s = forkSettings(devSettings, "/bin/guard") as unknown as Settings;
    expect(s.enableAllProjectMcpServers).toBe(true);
    expect(s.disabledMcpjsonServers).toEqual(["x"]);
    expect(s.permissions.allow).toEqual([]);
    expect(Object.keys(s.hooks)).toEqual(["PreToolUse"]);
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks[0].command.endsWith(" readonly")).toBe(true);
    expect(JSON.stringify(s)).not.toContain("gate");
  });
  it("works without dev settings", () => {
    const s = forkSettings(null, "g") as unknown as Settings;
    expect(Object.keys(s).sort()).toEqual(["hooks", "permissions"]);
    expect(s.hooks.PreToolUse[0]).toEqual({ matcher: "*", hooks: [{ type: "command", command: "g readonly", timeout: 10 }] });
  });
});
