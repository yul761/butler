// BTL-260：~/.butler → ~/.shipherd 的迁移。用例里的 butler 都是旧名字（要迁移的东西），不能改名。
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memDb, tempDir } from "../test-utils";
import { LEGACY_ORIGIN } from "../db/sessions-repo";
import { finishLegacyHome } from "./legacy-finish";
import {
  claudeProjectDirName,
  copyClaudeJsonProjects,
  LEGACY_NOTE,
  mapLegacyPath,
  mapProjectDirName,
  migrateLegacyHome,
  MIGRATED_MARKER,
  moveClaudeProjects,
  readMigrationMarker,
  rewriteForkPaths,
  rewriteSessionCwds,
  rewriteTranscriptCursors,
} from "./legacy-home";

const posixOnly = it.skipIf(process.platform === "win32");

/** 一个装过 Butler 的家目录：数据库、hook、总控工作区和一个 ticket 工作区。 */
function oldHome(): { home: string; from: string; to: string } {
  const home = tempDir("shipherd-legacy-");
  const from = join(home, ".butler");
  mkdirSync(join(from, "bin"), { recursive: true });
  mkdirSync(join(from, "workspaces", "_butler"), { recursive: true });
  mkdirSync(join(from, "workspaces", "BTL-1"), { recursive: true });
  writeFileSync(join(from, "app.db"), "db");
  writeFileSync(join(from, "bin", "butler-hook"), "hook");
  writeFileSync(join(from, "workspaces", "_butler", "CLAUDE.md"), "controller");
  writeFileSync(join(from, "workspaces", "BTL-1", "notes.md"), "ticket");
  return { home, from, to: join(home, ".shipherd") };
}

describe("migrateLegacyHome", () => {
  posixOnly("renames ~/.butler, renames the controller workspace, writes the marker and leaves a symlink behind", () => {
    const { home, from, to } = oldHome();
    const r = migrateLegacyHome({ env: {}, home, platform: "darwin", now: () => 5 });
    expect(r).toEqual({ kind: "moved", marker: { from, to, how: "rename", at: 5 }, leftover: "symlink" });
    expect(readFileSync(join(to, "app.db"), "utf8")).toBe("db");
    expect(readFileSync(join(to, "workspaces", "_shipherd", "CLAUDE.md"), "utf8")).toBe("controller");
    expect(existsSync(join(to, "workspaces", "_butler"))).toBe(false);
    expect(readFileSync(join(to, "workspaces", "BTL-1", "notes.md"), "utf8")).toBe("ticket");
    expect(readMigrationMarker(to)).toEqual({ from, to, how: "rename", at: 5 });
    // 升级前起的 claude、hook 还按旧的绝对路径找：符号链接指向新目录。
    expect(lstatSync(from).isSymbolicLink()).toBe(true);
    expect(readlinkSync(from)).toBe(to);
    expect(readFileSync(join(from, "bin", "butler-hook"), "utf8")).toBe("hook");
  });

  it("on Windows leaves a directory junction behind (no admin rights needed)", () => {
    const { home, from, to } = oldHome();
    const links: [string, string, string][] = [];
    const r = migrateLegacyHome({ env: {}, home, platform: "win32", now: () => 5, symlink: (t, p, type) => void links.push([t, p, type]) });
    expect(r).toMatchObject({ kind: "moved", leftover: "symlink", marker: { how: "rename" } });
    expect(links).toEqual([[to, from, "junction"]]);
  });

  it("leaves a folder with only the note behind when no link can be made", () => {
    const { home, from, to } = oldHome();
    const r = migrateLegacyHome({ env: {}, home, platform: "win32", now: () => 5, symlink: () => { throw new Error("EPERM"); } });
    expect(r).toMatchObject({ kind: "moved", leftover: "note", marker: { how: "rename" } });
    expect(readdirSync(from)).toEqual([LEGACY_NOTE]);
    const note = readFileSync(join(from, LEGACY_NOTE), "utf8");
    expect(note).toContain(to);
    expect(note).toContain("Shipherd");
    expect(readFileSync(join(to, "app.db"), "utf8")).toBe("db");
  });

  it("copies when rename fails (another volume, a file in use), keeps the old folder and leaves the note in it", () => {
    const { home, from, to } = oldHome();
    const r = migrateLegacyHome({ env: {}, home, platform: "darwin", now: () => 7, rename: () => { throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }); } });
    expect(r).toMatchObject({ kind: "moved", leftover: "note", marker: { how: "copy" } });
    expect(readFileSync(join(to, "app.db"), "utf8")).toBe("db");
    expect(readFileSync(join(to, "workspaces", "_shipherd", "CLAUDE.md"), "utf8")).toBe("controller");
    expect(readFileSync(join(from, "app.db"), "utf8")).toBe("db");
    expect(existsSync(join(from, LEGACY_NOTE))).toBe(true);
    // 复制用的临时目录改名成了 ~/.shipherd，不留半截。
    expect(readdirSync(home).filter((n) => n.includes("migrating"))).toEqual([]);
  });

  it("leaves the data where it is when ~/.butler is a link to another disk, and links ~/.shipherd to the same place", () => {
    const home = tempDir("shipherd-legacy-");
    const real = join(home, "elsewhere", "data");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "app.db"), "db");
    symlinkSync(real, join(home, ".butler"), process.platform === "win32" ? "junction" : "dir");
    const r = migrateLegacyHome({ env: {}, home, now: () => 1 });
    expect(r).toMatchObject({ kind: "moved", leftover: "none", marker: { how: "symlink", alias: realpathSync(real) } });
    expect(readMigrationMarker(join(home, ".shipherd"))).toMatchObject({ how: "symlink", alias: realpathSync(real) });
    expect(realpathSync(join(home, ".shipherd"))).toBe(realpathSync(real));
    expect(readFileSync(join(home, ".shipherd", "app.db"), "utf8")).toBe("db");
    expect(lstatSync(join(home, ".butler")).isSymbolicLink()).toBe(true);
  });

  it("does nothing when SHIPHERD_HOME or the old BUTLER_HOME is set", () => {
    for (const env of [{ SHIPHERD_HOME: "/x" }, { BUTLER_HOME: "/x" }]) {
      const { home, from, to } = oldHome();
      expect(migrateLegacyHome({ env, home })).toEqual({ kind: "skipped", reason: "env" });
      expect(existsSync(to)).toBe(false);
      expect(existsSync(join(from, "app.db"))).toBe(true);
    }
  });

  it("does nothing for a new user, or when ~/.shipherd is already there (second launch, or both exist)", () => {
    const fresh = tempDir("shipherd-legacy-");
    expect(migrateLegacyHome({ env: {}, home: fresh })).toEqual({ kind: "skipped", reason: "no_legacy" });
    expect(existsSync(join(fresh, ".shipherd"))).toBe(false);

    const { home, from, to } = oldHome();
    mkdirSync(to);
    expect(migrateLegacyHome({ env: {}, home })).toEqual({ kind: "skipped", reason: "already" });
    expect(readFileSync(join(from, "app.db"), "utf8")).toBe("db");
    expect(readdirSync(to)).toEqual([]);
  });

  posixOnly("is a no-op on the next launch after a migration", () => {
    const { home, to } = oldHome();
    migrateLegacyHome({ env: {}, home, platform: "darwin", now: () => 5 });
    expect(migrateLegacyHome({ env: {}, home, platform: "darwin", now: () => 6 })).toEqual({ kind: "skipped", reason: "already" });
    expect(readMigrationMarker(to)?.at).toBe(5);
  });

  posixOnly("reports a failure instead of throwing when the copy fails too, and keeps the old data", () => {
    if (process.getuid?.() === 0) return;
    const { home, from, to } = oldHome();
    const locked = join(from, "locked");
    writeFileSync(locked, "x");
    chmodSync(locked, 0o000);
    try {
      const r = migrateLegacyHome({ env: {}, home, now: () => 1, rename: () => { throw new Error("EXDEV"); } });
      expect(r).toMatchObject({ kind: "failed", legacy: from });
      expect(existsSync(to)).toBe(false);
      expect(readFileSync(join(from, "app.db"), "utf8")).toBe("db");
      // 半截的临时目录、写进旧目录的标记都清掉了：下次启动从头再来。
      expect(readdirSync(home).filter((n) => n.includes("migrating"))).toEqual([]);
      expect(existsSync(join(from, MIGRATED_MARKER))).toBe(false);
    } finally {
      chmodSync(locked, 0o600);
    }
  });
});

describe("migrateLegacyHome when something goes wrong half way", () => {
  it("cleans up a half-made copy, keeps the old data and migrates at the next start", () => {
    const { home, from, to } = oldHome();
    const fail = () => { throw new Error("EXDEV"); };
    const r = migrateLegacyHome({
      env: {}, home, now: () => 1, rename: fail,
      copy: (_f, tmp) => {
        mkdirSync(tmp);
        writeFileSync(join(tmp, "app.db"), "half");
        throw new Error("ENOSPC");
      },
    });
    expect(r).toEqual({ kind: "failed", error: "ENOSPC", legacy: from });
    expect(readdirSync(home).sort()).toEqual([".butler"]);
    expect(readFileSync(join(from, "app.db"), "utf8")).toBe("db");
    // 下次启动：~/.shipherd 还没有，照常搬。
    expect(migrateLegacyHome({ env: {}, home, platform: "darwin", now: () => 2 })).toMatchObject({ kind: "moved", marker: { how: "rename", at: 2 } });
    expect(readFileSync(join(to, "app.db"), "utf8")).toBe("db");
  });

  it("writes the marker before the move, so it arrives together with the data", () => {
    const { home, from, to } = oldHome();
    const r = migrateLegacyHome({
      env: {}, home, platform: "darwin", now: () => 3,
      rename: (f, t) => {
        expect(readMigrationMarker(f)).toEqual({ from, to, how: "rename", at: 3 });
        renameSync(f, t);
        // rename 其实成功了却报错（Windows 上重试时偶尔会这样）：不能当成失败、拿已经不存在的旧目录启动。
        throw new Error("EPERM");
      },
    });
    expect(r).toMatchObject({ kind: "moved", marker: { from, to, how: "rename" } });
    expect(readFileSync(join(to, "workspaces", "_shipherd", "CLAUDE.md"), "utf8")).toBe("controller");
  });

  it("finishes at the next start when it crashed right after the move (marker there, workspace not renamed yet)", async () => {
    const { home, from, to } = oldHome();
    writeFileSync(join(from, MIGRATED_MARKER), JSON.stringify({ from, to, how: "rename", at: 1 }));
    renameSync(from, to);
    expect(migrateLegacyHome({ env: {}, home })).toEqual({ kind: "skipped", reason: "already" });
    const logs: string[] = [];
    await finishLegacyHome({ kind: "skipped", reason: "already" }, { home: to, claudeProjects: join(home, "p"), claudeJson: join(home, "c.json") }, memDb(), (l) => logs.push(l));
    expect(readFileSync(join(to, "workspaces", "_shipherd", "CLAUDE.md"), "utf8")).toBe("controller");
    expect(existsSync(join(to, "workspaces", "_butler"))).toBe(false);
    expect(logs).toContain("legacy data dir: coordinator workspace renamed 1");
  });

  it("renames the controller workspace over an empty one created at startup, but never over a non-empty one", () => {
    const { home, to } = oldHome();
    migrateLegacyHome({ env: {}, home, platform: "darwin", rename: (f, t) => {
      renameSync(f, t);
      mkdirSync(join(t, "workspaces", "_shipherd"));
    } });
    expect(readFileSync(join(to, "workspaces", "_shipherd", "CLAUDE.md"), "utf8")).toBe("controller");

    const other = oldHome();
    migrateLegacyHome({ env: {}, home: other.home, platform: "darwin", rename: (f, t) => {
      renameSync(f, t);
      mkdirSync(join(t, "workspaces", "_shipherd"));
      writeFileSync(join(t, "workspaces", "_shipherd", "mine.md"), "x");
    } });
    expect(readFileSync(join(other.to, "workspaces", "_shipherd", "mine.md"), "utf8")).toBe("x");
    expect(readFileSync(join(other.to, "workspaces", "_butler", "CLAUDE.md"), "utf8")).toBe("controller");
  });
});

describe("mapLegacyPath / mapProjectDirName", () => {
  it("swaps the data folder prefix and the controller workspace name, and leaves other paths alone", () => {
    const m = { from: join("/h", ".butler"), to: join("/h", ".shipherd") };
    expect(mapLegacyPath(join("/h", ".butler", "workspaces", "BTL-1"), m)).toBe(join("/h", ".shipherd", "workspaces", "BTL-1"));
    expect(mapLegacyPath(join("/h", ".butler", "workspaces", "_butler"), m)).toBe(join("/h", ".shipherd", "workspaces", "_shipherd"));
    expect(mapLegacyPath(join("/h", ".butler", "workspaces", "_butler", "x"), m)).toBe(join("/h", ".shipherd", "workspaces", "_shipherd", "x"));
    expect(mapLegacyPath(join("/h", ".butler"), m)).toBe(join("/h", ".shipherd"));
    expect(mapLegacyPath(join("/h", ".butler-old", "x"), m)).toBeNull();
    expect(mapLegacyPath(join("/h", "code", "butler"), m)).toBeNull();
  });

  it("handles Windows paths: any case, and the forward slashes Claude Code writes", () => {
    const m = { from: "C:\\Users\\u\\.butler", to: "C:\\Users\\u\\.shipherd" };
    expect(mapLegacyPath("C:\\Users\\u\\.butler\\workspaces\\_butler", m)).toBe("C:\\Users\\u\\.shipherd\\workspaces\\_shipherd");
    expect(mapLegacyPath("c:\\users\\U\\.Butler\\workspaces\\BTL-1", m)).toBe("C:\\Users\\u\\.shipherd\\workspaces\\BTL-1");
    expect(mapLegacyPath("C:/Users/u/.butler/workspaces/_butler/x", m)).toBe("C:/Users/u/.shipherd/workspaces/_shipherd/x");
    expect(mapLegacyPath("C:/Users/u/.butler/mcp/fork-1.json", m)).toBe("C:/Users/u/.shipherd/mcp/fork-1.json");
    expect(mapLegacyPath("C:\\Users\\u\\.butlerx", m)).toBeNull();
    expect(mapLegacyPath("D:\\Users\\u\\.butler", m)).toBeNull();
    expect(mapProjectDirName("c--Users-u--butler-workspaces-BTL-1", m)).toBe("C--Users-u--shipherd-workspaces-BTL-1");
    expect(mapProjectDirName("C--Users-u--butler-workspaces--butler", m)).toBe("C--Users-u--shipherd-workspaces--shipherd");
  });

  it("keeps POSIX paths case-sensitive", () => {
    const m = { from: "/Users/u/.butler", to: "/Users/u/.shipherd" };
    expect(mapLegacyPath("/Users/u/.Butler/x", m)).toBeNull();
    expect(mapProjectDirName("-users-u--butler", m)).toBeNull();
  });

  it("also maps the real path of a linked ~/.butler, changing only the controller workspace", () => {
    const m = { from: "/Users/u/.butler", to: "/Users/u/.shipherd", alias: "/Volumes/data/butler" };
    expect(mapLegacyPath("/Volumes/data/butler/workspaces/_butler", m)).toBe("/Volumes/data/butler/workspaces/_shipherd");
    expect(mapLegacyPath("/Volumes/data/butler/workspaces/BTL-1", m)).toBe("/Volumes/data/butler/workspaces/BTL-1");
    expect(mapProjectDirName("-Volumes-data-butler-workspaces--butler", m)).toBe("-Volumes-data-butler-workspaces--shipherd");
    expect(mapProjectDirName("-Volumes-data-butler-workspaces-BTL-1", m)).toBe("-Volumes-data-butler-workspaces-BTL-1");
  });

  it("maps Claude's project folder names the same way", () => {
    const m = { from: "/Users/u/.butler", to: "/Users/u/.shipherd" };
    expect(claudeProjectDirName("/Users/u/.butler/workspaces/BTL-1")).toBe("-Users-u--butler-workspaces-BTL-1");
    expect(mapProjectDirName("-Users-u--butler-workspaces-BTL-1", m)).toBe("-Users-u--shipherd-workspaces-BTL-1");
    expect(mapProjectDirName("-Users-u--butler-workspaces--butler", m)).toBe("-Users-u--shipherd-workspaces--shipherd");
    expect(mapProjectDirName("-Users-u--butler", m)).toBe("-Users-u--shipherd");
    expect(mapProjectDirName("-Users-u-code-app", m)).toBeNull();
  });
});

/** ~/.claude/projects 下一个对话目录，里面一条记录带着它的 cwd。 */
function transcriptDir(projects: string, cwd: string, file = "s1.jsonl"): string {
  const dir = join(projects, claudeProjectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify({ type: "user", cwd, sessionId: "s1" }) + "\n");
  return dir;
}

describe("moveClaudeProjects", () => {
  it("renames the folders of sessions that ran under the old data folder, so claude --resume finds them", () => {
    const root = tempDir("shipherd-proj-");
    const projects = join(root, "projects");
    const m = { from: join(root, ".butler"), to: join(root, ".shipherd") };
    transcriptDir(projects, join(m.from, "workspaces", "BTL-1"));
    transcriptDir(projects, join(m.from, "workspaces", "_butler"));
    const mine = transcriptDir(projects, join(root, "code", "app"));
    expect(moveClaudeProjects(projects, m)).toBe(2);
    expect(existsSync(join(projects, claudeProjectDirName(join(m.to, "workspaces", "BTL-1")), "s1.jsonl"))).toBe(true);
    expect(existsSync(join(projects, claudeProjectDirName(join(m.to, "workspaces", "_shipherd")), "s1.jsonl"))).toBe(true);
    expect(existsSync(join(mine, "s1.jsonl"))).toBe(true);
    // 再跑一遍什么都不动。
    expect(moveClaudeProjects(projects, m)).toBe(0);
  });

  it("does not touch a folder whose name only looks like ours (~/.butler-old)", () => {
    const root = tempDir("shipherd-proj-");
    const projects = join(root, "projects");
    const m = { from: join(root, ".butler"), to: join(root, ".shipherd") };
    const other = transcriptDir(projects, join(root, ".butler-old"));
    expect(claudeProjectDirName(join(root, ".butler-old")).startsWith(claudeProjectDirName(m.from) + "-")).toBe(true);
    expect(moveClaudeProjects(projects, m)).toBe(0);
    expect(existsSync(join(other, "s1.jsonl"))).toBe(true);
  });

  it("merges into a folder that already exists under the new name without overwriting its files", () => {
    const root = tempDir("shipherd-proj-");
    const projects = join(root, "projects");
    const m = { from: join(root, ".butler"), to: join(root, ".shipherd") };
    const ws = (h: string) => join(h, "workspaces", "BTL-1");
    const oldDir = transcriptDir(projects, ws(m.from));
    writeFileSync(join(oldDir, "both.jsonl"), "old\n");
    const newDir = transcriptDir(projects, ws(m.to), "new.jsonl");
    writeFileSync(join(newDir, "both.jsonl"), "new\n");
    expect(moveClaudeProjects(projects, m)).toBe(1);
    expect(readFileSync(join(newDir, "both.jsonl"), "utf8")).toBe("new\n");
    expect(existsSync(join(newDir, "s1.jsonl"))).toBe(true);
    expect(existsSync(join(newDir, "new.jsonl"))).toBe(true);
    expect(existsSync(join(oldDir, "both.jsonl"))).toBe(true);
  });
});

describe("copyClaudeJsonProjects", () => {
  it("adds entries for the new paths, keeps the old ones and never changes entries the user already has", async () => {
    const root = tempDir("shipherd-cj-");
    const file = join(root, ".claude.json");
    const m = { from: join(root, ".butler"), to: join(root, ".shipherd") };
    const ws = join(m.from, "workspaces", "BTL-1");
    const ctl = join(m.from, "workspaces", "_butler");
    const userOwn = join(root, "code", "app");
    const already = join(m.to, "workspaces", "BTL-2");
    const data = {
      numStartups: 3,
      projects: {
        [ws]: { hasTrustDialogAccepted: true, allowedTools: ["Bash"] },
        [ctl]: { hasTrustDialogAccepted: true },
        [join(m.from, "workspaces", "BTL-2")]: { hasTrustDialogAccepted: true, allowedTools: ["old"] },
        [already]: { hasTrustDialogAccepted: false, allowedTools: ["mine"] },
        [userOwn]: { hasTrustDialogAccepted: true },
      },
    };
    writeFileSync(file, JSON.stringify(data));
    chmodSync(file, 0o600);
    expect(await copyClaudeJsonProjects(file, m)).toBe(2);
    const out = JSON.parse(readFileSync(file, "utf8")) as typeof data;
    expect(out.numStartups).toBe(3);
    expect(out.projects[join(m.to, "workspaces", "BTL-1")]).toEqual({ hasTrustDialogAccepted: true, allowedTools: ["Bash"] });
    expect(out.projects[join(m.to, "workspaces", "_shipherd")]).toEqual({ hasTrustDialogAccepted: true });
    expect(out.projects[already]).toEqual({ hasTrustDialogAccepted: false, allowedTools: ["mine"] });
    expect(out.projects[ws]).toEqual(data.projects[ws]);
    expect(out.projects[userOwn]).toEqual({ hasTrustDialogAccepted: true });
    expect(Object.keys(out.projects)).toHaveLength(7);
    expect(readdirSync(root).filter((n) => n.includes("tmp"))).toEqual([]);
    // ~/.claude.json 里有 Claude 的登录信息：权限位不能被放宽。
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    // 再跑一遍不写文件。
    const before = readFileSync(file, "utf8");
    expect(await copyClaudeJsonProjects(file, m)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  posixOnly("writes through a symlinked ~/.claude.json to the real file", async () => {
    const root = tempDir("shipherd-cj-");
    const real = join(root, "dotfiles", "claude.json");
    mkdirSync(join(root, "dotfiles"));
    const m = { from: join(root, ".butler"), to: join(root, ".shipherd") };
    writeFileSync(real, JSON.stringify({ projects: { [join(m.from, "workspaces", "BTL-1")]: { hasTrustDialogAccepted: true } } }));
    const link = join(root, ".claude.json");
    symlinkSync(real, link);
    expect(await copyClaudeJsonProjects(link, m)).toBe(1);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(Object.keys((JSON.parse(readFileSync(real, "utf8")) as { projects: object }).projects)).toContain(join(m.to, "workspaces", "BTL-1"));
  });

  it("leaves a missing or unreadable file alone", async () => {
    const root = tempDir("shipherd-cj-");
    const m = { from: join(root, ".butler"), to: join(root, ".shipherd") };
    expect(await copyClaudeJsonProjects(join(root, "none.json"), m)).toBe(0);
    writeFileSync(join(root, "bad.json"), "{nope");
    expect(await copyClaudeJsonProjects(join(root, "bad.json"), m)).toBe(0);
    expect(readFileSync(join(root, "bad.json"), "utf8")).toBe("{nope");
  });
});

describe("database paths", () => {
  const session = (db: ReturnType<typeof memDb>, id: string, cwd: string) =>
    db.prepare(`INSERT INTO sessions (id, cwd, origin, created_at) VALUES (?, ?, '${LEGACY_ORIGIN}', 1)`).run(id, cwd);

  it("rewrites session working folders under the old data folder only", () => {
    const db = memDb();
    const m = { from: join("/h", ".butler"), to: join("/h", ".shipherd") };
    session(db, "ctl", join(m.from, "workspaces", "_butler"));
    session(db, "ws", join(m.from, "workspaces", "BTL-1"));
    session(db, "repo", join("/h", "code", "butler"));
    session(db, "near", join("/h", ".butler-old"));
    expect(rewriteSessionCwds(db, m)).toBe(2);
    const cwd = (id: string) => (db.prepare(`SELECT cwd FROM sessions WHERE id = ?`).get(id) as { cwd: string }).cwd;
    expect(cwd("ctl")).toBe(join(m.to, "workspaces", "_shipherd"));
    expect(cwd("ws")).toBe(join(m.to, "workspaces", "BTL-1"));
    expect(cwd("repo")).toBe(join("/h", "code", "butler"));
    expect(cwd("near")).toBe(join("/h", ".butler-old"));
    expect(rewriteSessionCwds(db, m)).toBe(0);
  });

  it("rewrites Windows session folders whatever the case or slashes", () => {
    const db = memDb();
    const m = { from: "C:\\Users\\u\\.butler", to: "C:\\Users\\u\\.shipherd" };
    session(db, "a", "c:\\users\\u\\.butler\\workspaces\\_butler");
    session(db, "b", "C:/Users/u/.butler/workspaces/BTL-1");
    expect(rewriteSessionCwds(db, m)).toBe(2);
    const cwd = (id: string) => (db.prepare(`SELECT cwd FROM sessions WHERE id = ?`).get(id) as { cwd: string }).cwd;
    expect(cwd("a")).toBe("C:\\Users\\u\\.shipherd\\workspaces\\_shipherd");
    expect(cwd("b")).toBe("C:/Users/u/.shipherd/workspaces/BTL-1");
  });

  it("rewrites the folder and the --settings / --mcp-config paths a fork discussion resumes with", () => {
    const db = memDb();
    const m = { from: join("/h", ".butler"), to: join("/h", ".shipherd") };
    session(db, "s", join("/h", "code", "app"));
    const fork = (cwd: string, args: string[]) =>
      Number(db.prepare(`INSERT INTO fork_discussions (root_session_id, mode, started_at, last_at, cwd, launch_args) VALUES ('s', 'full', 1, 1, ?, ?)`).run(cwd, JSON.stringify(args)).lastInsertRowid);
    const mine = fork(join(m.from, "workspaces", "_butler"), ["--settings", join(m.from, "mcp", "fork-1.json"), "--mcp-config", join(m.from, "mcp", "s.json"), "--model", "opus"]);
    const other = fork(join("/h", "code", "app"), ["--settings", join("/h", "code", "butler.json")]);
    expect(rewriteForkPaths(db, m)).toBe(1);
    const row = (id: number) => db.prepare(`SELECT cwd, launch_args FROM fork_discussions WHERE id = ?`).get(id) as { cwd: string; launch_args: string };
    expect(row(mine).cwd).toBe(join(m.to, "workspaces", "_shipherd"));
    expect(JSON.parse(row(mine).launch_args)).toEqual(["--settings", join(m.to, "mcp", "fork-1.json"), "--mcp-config", join(m.to, "mcp", "s.json"), "--model", "opus"]);
    expect(JSON.parse(row(other).launch_args)).toEqual(["--settings", join("/h", "code", "butler.json")]);
    expect(rewriteForkPaths(db, m)).toBe(0);
  });

  it("moves transcript cursors with the files, so usage and conversations are not read twice", () => {
    const db = memDb();
    const root = tempDir("shipherd-cur-");
    const projects = join(root, "projects");
    const m = { from: join(root, ".butler"), to: join(root, ".shipherd") };
    const oldDir = transcriptDir(projects, join(m.from, "workspaces", "BTL-1"));
    const oldFile = join(oldDir, "s1.jsonl");
    const kept = transcriptDir(projects, join(root, ".butler-old"));
    const keptFile = join(kept, "s1.jsonl");
    db.prepare(`INSERT INTO usage_cursors (file, offset, size) VALUES (?, 100, 100), (?, 50, 50)`).run(oldFile, keptFile);
    db.prepare(`INSERT INTO conv_cursors (session_id, root_session_id, file, ino, byte_offset, open_turn_id, updated_at) VALUES ('s1', 's1', ?, 1, 100, NULL, 1)`).run(oldFile);
    expect(moveClaudeProjects(projects, m)).toBe(1);
    expect(rewriteTranscriptCursors(db, projects, m)).toBe(2);
    const newFile = join(projects, claudeProjectDirName(join(m.to, "workspaces", "BTL-1")), "s1.jsonl");
    const usage = db.prepare(`SELECT file, offset FROM usage_cursors ORDER BY offset`).all() as { file: string; offset: number }[];
    expect(usage.map((r) => [r.file, Number(r.offset)])).toEqual([[keptFile, 50], [newFile, 100]]);
    expect((db.prepare(`SELECT file FROM conv_cursors WHERE session_id = 's1'`).get() as { file: string }).file).toBe(newFile);
    expect(rewriteTranscriptCursors(db, projects, m)).toBe(0);
  });

  it("keeps the newer cursor when the new path was already read, and leaves cursors of files that did not move", () => {
    const db = memDb();
    const root = tempDir("shipherd-cur-");
    const projects = join(root, "projects");
    const m = { from: join(root, ".butler"), to: join(root, ".shipherd") };
    const oldDir = transcriptDir(projects, join(m.from, "workspaces", "BTL-1"));
    writeFileSync(join(oldDir, "both.jsonl"), "old\n");
    const newDir = transcriptDir(projects, join(m.to, "workspaces", "BTL-1"), "x.jsonl");
    writeFileSync(join(newDir, "both.jsonl"), "new\n");
    const oldS1 = join(oldDir, "s1.jsonl");
    const newS1 = join(newDir, "s1.jsonl");
    // s1 在两边都有游标（迁移后又读过新路径）；both 没挪走（新目录里已有同名文件）。
    db.prepare(`INSERT INTO usage_cursors (file, offset, size) VALUES (?, 10, 10), (?, 99, 99), (?, 4, 4)`).run(oldS1, newS1, join(oldDir, "both.jsonl"));
    moveClaudeProjects(projects, m);
    expect(rewriteTranscriptCursors(db, projects, m)).toBe(1);
    const usage = db.prepare(`SELECT file, offset FROM usage_cursors ORDER BY offset`).all() as { file: string; offset: number }[];
    expect(usage.map((r) => [r.file, Number(r.offset)])).toEqual([[join(oldDir, "both.jsonl"), 4], [newS1, 99]]);
  });
});

describe("finishLegacyHome", () => {
  posixOnly("after a real migration, fixes sessions, Claude's folders, cursors and ~/.claude.json, once", async () => {
    const { home, from, to } = oldHome();
    const claude = join(home, ".claude");
    const projects = join(claude, "projects");
    const claudeJson = join(home, ".claude.json");
    const oldWs = join(from, "workspaces", "BTL-1");
    const dir = transcriptDir(projects, oldWs);
    writeFileSync(claudeJson, JSON.stringify({ projects: { [oldWs]: { hasTrustDialogAccepted: true } } }));
    const db = memDb();
    db.prepare(`INSERT INTO sessions (id, cwd, origin, created_at) VALUES ('s1', ?, '${LEGACY_ORIGIN}', 1)`).run(oldWs);
    db.prepare(`INSERT INTO usage_cursors (file, offset, size) VALUES (?, 7, 7)`).run(join(dir, "s1.jsonl"));

    const result = migrateLegacyHome({ env: {}, home, platform: "darwin", now: () => 1 });
    const logs: string[] = [];
    const paths = { home: to, claudeProjects: projects, claudeJson };
    await finishLegacyHome(result, paths, db, (l) => logs.push(l));
    const newWs = join(to, "workspaces", "BTL-1");
    expect((db.prepare(`SELECT cwd FROM sessions WHERE id = 's1'`).get() as { cwd: string }).cwd).toBe(newWs);
    const newFile = join(projects, claudeProjectDirName(newWs), "s1.jsonl");
    expect(existsSync(newFile)).toBe(true);
    expect((db.prepare(`SELECT file FROM usage_cursors`).get() as { file: string }).file).toBe(newFile);
    expect(Object.keys((JSON.parse(readFileSync(claudeJson, "utf8")) as { projects: object }).projects)).toEqual([oldWs, newWs]);
    expect(logs[0]).toContain("legacy data dir moved");
    expect(logs.some((l) => l.includes("failed"))).toBe(false);

    // 重启：再跑一遍收尾，什么都不改，也不记日志。
    const again: string[] = [];
    await finishLegacyHome(migrateLegacyHome({ env: {}, home, platform: "darwin" }), paths, db, (l) => again.push(l));
    expect(again).toEqual([]);
  });

  it("does nothing without a marker for this data folder (new user, or SHIPHERD_HOME points somewhere else)", async () => {
    const home = tempDir("shipherd-fin-");
    const db = memDb();
    const logs: string[] = [];
    await finishLegacyHome({ kind: "skipped", reason: "no_legacy" }, { home, claudeProjects: join(home, "p"), claudeJson: join(home, "c.json") }, db, (l) => logs.push(l));
    expect(logs).toEqual([]);
    writeFileSync(join(home, MIGRATED_MARKER), JSON.stringify({ from: "/a/.butler", to: "/elsewhere", how: "rename", at: 1 }));
    await finishLegacyHome({ kind: "skipped", reason: "env" }, { home, claudeProjects: join(home, "p"), claudeJson: join(home, "c.json") }, db, (l) => logs.push(l));
    expect(logs).toEqual([]);
  });

  it("logs a failed migration and keeps going", async () => {
    const home = tempDir("shipherd-fin-");
    const logs: string[] = [];
    await finishLegacyHome({ kind: "failed", error: "EACCES", legacy: join(home, ".butler") }, { home, claudeProjects: join(home, "p"), claudeJson: join(home, "c.json") }, memDb(), (l) => logs.push(l));
    expect(logs).toEqual([expect.stringContaining("EACCES")]);
  });
});
