import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mailboxHookCommand, messageFileName, messageIdOf, wakesTarget } from "./mailbox";

describe("mailbox names", () => {
  it("file names sort by time and give back the id whatever the suffix", () => {
    const a = messageFileName(5, "1b2c-3d");
    const b = messageFileName(40, "aa");
    expect([b, a].sort()).toEqual([a, b]);
    expect(messageIdOf(a)).toBe("1b2c-3d");
    expect(messageIdOf(`${a}.taken-123`)).toBe("1b2c-3d");
    expect(messageIdOf(`${a}.done`)).toBe("1b2c-3d");
    expect(messageIdOf(`${a}.main`)).toBe("1b2c-3d");
    expect(messageIdOf(`${a}.tmp`)).toBeNull();
    expect(messageIdOf("x.json")).toBeNull();
  });
});

describe("mailboxHookCommand", () => {
  it("uses forward slashes on Windows and escapes shell metacharacters", () => {
    expect(mailboxHookCommand('"C:/b/shipherd-hook.exe"', "C:\\Users\\a b\\.shipherd\\mailbox", "win32")).toBe(
      '[ ! -d "C:/Users/a b/.shipherd/mailbox/${SHIPHERD_SESSION:-_}" ] || exec "C:/b/shipherd-hook.exe" mailbox "C:/Users/a b/.shipherd/mailbox"',
    );
    expect(mailboxHookCommand('"/h"', '/x/$y"`z', "darwin")).toContain('"/x/\\$y\\"\\`z/${SHIPHERD_SESSION:-_}"');
  });

  it.skipIf(process.platform === "win32")("runs the hook only when the session's folder exists, and exits 0 either way", () => {
    const root = mkdtempSync(join(tmpdir(), "mbc-"));
    const hook = join(root, "hook.sh");
    writeFileSync(hook, '#!/bin/sh\necho "ran $1 $2"\n');
    chmodSync(hook, 0o755);
    const cmd = mailboxHookCommand(`"${hook}"`, join(root, "mb"), process.platform);
    const run = (sid?: string) => execFileSync("/bin/sh", ["-c", cmd], { env: { PATH: process.env.PATH, ...(sid ? { SHIPHERD_SESSION: sid } : {}) }, encoding: "utf8" });
    expect(run("t1")).toBe("");
    expect(run()).toBe("");
    mkdirSync(join(root, "mb", "t1"), { recursive: true });
    expect(run("t1")).toBe(`ran mailbox ${join(root, "mb")}\n`);
    expect(run("t2")).toBe("");
  });
});

describe("wakesTarget (BTL-272)", () => {
  it("wakes for messages, not for conventions, and for facts only when marked", () => {
    expect(wakesTarget({ kind: "instruction" })).toBe(true);
    expect(wakesTarget({ kind: "convention" })).toBe(false);
    expect(wakesTarget({ kind: "fact", meta: null })).toBe(false);
    expect(wakesTarget({ kind: "fact", meta: { wake: false } })).toBe(false);
    expect(wakesTarget({ kind: "fact", meta: { wake: true } })).toBe(true);
  });
});
