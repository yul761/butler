import { chmodSync, existsSync, lstatSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { handoffCommandPath, handoffCommandStatus, installHandoffCommand, uninstallHandoffCommand } from "./command";
import { setLang } from "../i18n";
import { commandBodyHash, featureCoordinatorSection, HANDOFF_COMMAND_MARKER, HANDOFF_COMMAND_MD, handoffCommandBody, renderHandoffCommand } from "./templates";

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

  it("updates through a symlink, keeping the link and the target's mode", async (ctx) => {
    const dir = tempDir();
    const real = join(dir, "real.md");
    const file = handoffCommandPath(join(dir, "commands"));
    writeFileSync(real, OLD);
    chmodSync(real, 0o640);
    // Windows 没有 POSIX 权限位：chmod 只切换只读属性，0o640 读回来是 0o666。所以比较的是 chmod 之后实际读到的 mode。
    const mode = statSync(real).mode & 0o777;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "commands"));
    try {
      symlinkSync(real, file);
    } catch (e) {
      // Windows 上建符号链接需要管理员或开发者模式；没有这个权限时（EPERM）跳过，其他错误照常失败。
      if (process.platform === "win32" && (e as NodeJS.ErrnoException).code === "EPERM") ctx.skip();
      throw e;
    }
    expect(await installHandoffCommand(file)).toBe("installed");
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(HANDOFF_COMMAND_MD);
    expect(statSync(real).mode & 0o777).toBe(mode);
    if (process.platform !== "win32") expect(mode).toBe(0o640);
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

describe("/handoff command for feature coordinators", () => {
  afterEach(() => setLang("zh"));

  /** 加 feature 总控那一段之前的正文（计划 8 之前）：去掉那一段、换回原来的 description，hash 必须和当时的一致。 */
  const PREVIOUS = {
    zh: {
      hash: "e1b25b8d150d6a4496b2c2361e31cbe2b17d7c233d7430e8d724b1346aa4e8e8",
      description: ["生成 Butler handoff（当前 ticket 的进度摘要；在 feature 总控里是 feature 汇总）", "生成 Butler handoff（当前 ticket 的进度摘要）"],
    },
    en: {
      hash: "d942faeb2ca90337a20ae215bef582b6206c62eb252be0c4ad8d06eb4b6c46f8",
      description: [
        "Write a Butler handoff (a progress summary of the current ticket; in a feature coordinator, of the feature)",
        "Write a Butler handoff (a progress summary of the current ticket)",
      ],
    },
  } as const;

  for (const l of ["zh", "en"] as const) {
    it(`reports the previous ${l} body as stale and replaces it`, async () => {
      setLang(l);
      const [now, before] = PREVIOUS[l].description;
      const current = handoffCommandBody(l);
      expect(current).toContain(featureCoordinatorSection(l));
      const previous = current.replace(featureCoordinatorSection(l), "").replace(now, before);
      expect(commandBodyHash(previous)).toBe(PREVIOUS[l].hash);
      const file = handoffCommandPath(tempDir());
      writeFileSync(file, renderHandoffCommand(previous));
      expect(await handoffCommandStatus(file)).toBe("stale");
      expect(await installHandoffCommand(file)).toBe("installed");
      expect(readFileSync(file, "utf8")).toContain("butler-feature-handoff");
    });
  }
});
