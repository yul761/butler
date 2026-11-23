import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeLoginState } from "./login";

function dirs() {
  const dir = mkdtempSync(join(tmpdir(), "shipherd-login-"));
  return { claudeJson: join(dir, ".claude.json"), claudeConfigDir: dir, claudeSettings: join(dir, "settings.json"), env: {} as NodeJS.ProcessEnv };
}

describe("claudeLoginState", () => {
  it("is missing on a machine with no records", async () => {
    expect(await claudeLoginState(dirs())).toBe("missing");
  });

  it("sees an account or an API key in .claude.json", async () => {
    const d = dirs();
    writeFileSync(d.claudeJson, JSON.stringify({ numStartups: 1 }));
    expect(await claudeLoginState(d)).toBe("missing");
    writeFileSync(d.claudeJson, JSON.stringify({ oauthAccount: { accountUuid: "x" } }));
    expect(await claudeLoginState(d)).toBe("ok");
    writeFileSync(d.claudeJson, JSON.stringify({ primaryApiKey: "k" }));
    expect(await claudeLoginState(d)).toBe("ok");
  });

  it("sees a credentials file, an apiKeyHelper, login variables in settings or in the environment", async () => {
    const a = dirs();
    writeFileSync(join(a.claudeConfigDir, ".credentials.json"), "{}");
    expect(await claudeLoginState(a)).toBe("ok");
    const b = dirs();
    writeFileSync(b.claudeSettings, JSON.stringify({ apiKeyHelper: "/bin/key" }));
    expect(await claudeLoginState(b)).toBe("ok");
    const c = dirs();
    writeFileSync(c.claudeSettings, JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }));
    expect(await claudeLoginState(c)).toBe("ok");
    expect(await claudeLoginState({ ...dirs(), env: { ANTHROPIC_API_KEY: "k" } })).toBe("ok");
  });

  it("treats a broken .claude.json as no record", async () => {
    const d = dirs();
    writeFileSync(d.claudeJson, "{not json");
    expect(await claudeLoginState(d)).toBe("missing");
  });
});
