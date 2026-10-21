import { chmodSync, existsSync, lstatSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { handoffCommandPath, handoffCommandStatus, installHandoffCommand, uninstallHandoffCommand } from "./command";
import { HANDOFF_COMMAND_MARKER, HANDOFF_COMMAND_MD, renderHandoffCommand } from "./templates";

const OLD = renderHandoffCommand("---\ndescription: old\n---\n旧版正文\n");

describe("/handoff command file", () => {
  it("installs into a missing commands dir, reports installed, and uninstalls", async () => {
    const file = handoffCommandPath(join(tempDir(), "commands"));
    expect(await handoffCommandStatus(file)).toBe("missing");
    expect(await installHandoffCommand(file)).toBe("installed");
    expect(readFileSync(file, "utf8")).toBe(HANDOFF_COMMAND_MD);
    expect(await handoffCommandStatus(file)).toBe("installed");
    await uninstallHandoffCommand(file);
    expect(existsSync(file)).toBe(false);
  });

  it("updates an older Butler version", async () => {
    const file = handoffCommandPath(tempDir());
    writeFileSync(file, OLD);
    expect(await handoffCommandStatus(file)).toBe("stale");
    expect(await installHandoffCommand(file)).toBe("installed");
    expect(readFileSync(file, "utf8")).toBe(HANDOFF_COMMAND_MD);
  });

  it("never touches a user's own handoff.md", async () => {
    const file = handoffCommandPath(tempDir());
    writeFileSync(file, "我自己的 handoff 命令");
    expect(await installHandoffCommand(file)).toBe("conflict");
    await uninstallHandoffCommand(file);
    expect(readFileSync(file, "utf8")).toBe("我自己的 handoff 命令");
  });

  it("reads a BOM-prefixed Butler file and rewrites a stale one", async () => {
    const file = handoffCommandPath(tempDir());
    writeFileSync(file, `\uFEFF${HANDOFF_COMMAND_MD}`);
    expect(await handoffCommandStatus(file)).toBe("installed");
    writeFileSync(file, `\uFEFF${OLD}`);
    expect(await handoffCommandStatus(file)).toBe("stale");
    expect(await installHandoffCommand(file)).toBe("installed");
    expect(readFileSync(file, "utf8")).toBe(HANDOFF_COMMAND_MD);
  });

  it("treats a user-edited copy (valid marker, changed body) as a conflict and never overwrites or deletes it", async () => {
    const file = handoffCommandPath(tempDir());
    const edited = HANDOFF_COMMAND_MD.replace("只读", "我改过的只读");
    expect(edited).not.toBe(HANDOFF_COMMAND_MD);
    writeFileSync(file, edited);
    expect(await handoffCommandStatus(file)).toBe("conflict");
    expect(await installHandoffCommand(file)).toBe("conflict");
    await uninstallHandoffCommand(file);
    expect(readFileSync(file, "utf8")).toBe(edited);
  });

  it("treats a file that merely quotes the marker mid-text as a conflict", async () => {
    const file = handoffCommandPath(tempDir());
    const quoted = `我的命令，参考了 ${HANDOFF_COMMAND_MARKER} sha256:${"0".repeat(64)} -->\n正文\n`;
    writeFileSync(file, quoted);
    expect(await handoffCommandStatus(file)).toBe("conflict");
    expect(await installHandoffCommand(file)).toBe("conflict");
    await uninstallHandoffCommand(file);
    expect(readFileSync(file, "utf8")).toBe(quoted);
  });

  it("updates through a symlink, keeping the link and the target's mode", async () => {
    const dir = tempDir();
    const real = join(dir, "real.md");
    const file = handoffCommandPath(join(dir, "commands"));
    writeFileSync(real, OLD);
    chmodSync(real, 0o640);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "commands"));
    symlinkSync(real, file);
    expect(await installHandoffCommand(file)).toBe("installed");
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(HANDOFF_COMMAND_MD);
    expect(statSync(real).mode & 0o777).toBe(0o640);
  });

  it("install reports conflict and uninstall is a no-op when the path is unreadable (a directory)", async () => {
    const dir = tempDir();
    const { mkdirSync } = await import("node:fs");
    const file = handoffCommandPath(dir);
    mkdirSync(file);
    await expect(handoffCommandStatus(file)).rejects.toThrow();
    expect(await installHandoffCommand(file)).toBe("conflict");
    await expect(uninstallHandoffCommand(file)).resolves.toBeUndefined();
  });
});
