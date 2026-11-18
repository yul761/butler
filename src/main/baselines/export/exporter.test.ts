import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoBaseline } from "../../../shared/baselines";
import type { ResolvedCheck } from "../../../shared/checks";
import { BaselinesRepo } from "../../db/baselines-repo";
import { memDb } from "../../test-utils";
import { writeRepo } from "../test-repo";
import { CheckExporter, runGit, type GitRun } from "./exporter";
import type { OutwardGate } from "./outward";
import { ExternalAuditRepo } from "../../db/external-audit-repo";
import { SettingsRepo } from "../../db/settings-repo";
import { ExternalActions } from "../../external/actions";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function baseline(): RepoBaseline {
  return {
    id: 1, slug: "acme/app", scannedAt: 1, status: "ok", skipReason: null, detail: null, origin: "local", projects: [], checks: [], advice: [],
    profile: { projects: [], dirs: [], ci: [], pitfalls: [] }, inputs: [], listingHash: "", staleAt: null, inferred: "none", inferDetail: null, durationMs: 1,
  };
}

const CHECK: ResolvedCheck = {
  id: 1, key: "ck_a1b2c3d4e5f6", type: "forbidden_pattern", name: "No debugger", params: { pattern: "debugger;" }, globs: ["src/**"], excludeGlobs: [], severity: "block", mode: "enforce", message: "remove it",
};

/** 一个带 origin（本地裸仓库）的仓库。 */
function setup(files: Record<string, string>, o: { outward?: OutwardGate; git?: GitRun; check?: ResolvedCheck; noBaseline?: boolean } = {}) {
  const root = writeRepo(files);
  dirs.push(root);
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "commit.gpgsign", "false");
  const remote = mkdtempSync(join(tmpdir(), "butler-remote-"));
  dirs.push(remote);
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "origin", "main");
  git(root, "remote", "set-head", "origin", "main");
  const home = mkdtempSync(join(tmpdir(), "butler-home-"));
  dirs.push(home);
  const db = memDb();
  const repo = new BaselinesRepo(db);
  const audit = new ExternalAuditRepo(db);
  const settings = new SettingsRepo(db);
  const prs: unknown[] = [];
  let t = 1000;
  const ex = new CheckExporter({
    repo, check: (slug, key) => (slug === "acme/app" && key === (o.check ?? CHECK).key ? { ...(o.check ?? CHECK), checkId: null } : null),
    baseline: () => (o.noBaseline ? null : baseline()), localPath: (s) => (s === "acme/app" ? root : null), exportsDir: join(home, "exports"),
    outward: o.outward ?? new ExternalActions({ repo: audit, setting: (k) => settings.get(k), now: () => t }), ticketPattern: () => "", now: () => ++t, git: o.git,
    openPr: async (req) => {
      prs.push(req);
      return "https://example.invalid/pr/1";
    },
  });
  return { root, remote, home, repo, ex, audit, prs };
}

const allowAll: OutwardGate = { allowed: () => true, attempt: async (_k, _d, run) => ({ ran: true, value: await run(), auditId: 1 }) };

describe("check export into a Butler worktree", () => {
  it("writes a branch off origin/HEAD, commits locally, keeps the exec bit, and leaves the checkout alone", async () => {
    const { root, home, ex } = setup({ "go.mod": "module x\n", "src/a.go": "package a\n" });
    // 本地 checkout 有没提交的改动和别的分支：都不该被碰
    git(root, "checkout", "-q", "-b", "wip");
    appendFileSync(join(root, "go.mod"), "dirty\n");
    const r = await ex.run(CHECK.key, "acme/app");
    expect(r.ok).toBe(true);
    const e = (r as { export: { id: number; branch: string; worktree: string; base: string; committed: boolean; status: string; diff: string; files: string[]; target: string } }).export;
    expect(e).toMatchObject({ branch: "butler/check-no-debugger-a1b2c3", base: "origin/main", committed: true, status: "ready", target: "script", files: ["scripts/butler-checks/no-debugger.sh", ".gitattributes"] });
    expect(readFileSync(join(e.worktree, ".gitattributes"), "utf8")).toBe("/scripts/butler-checks/no-debugger.sh text eol=lf\n");
    expect(e.worktree).toBe(join(home, "exports", String(e.id)));
    expect(git(e.worktree, "log", "-1", "--format=%s")).toBe('chore: add Butler check "No debugger" as a repo rule');
    expect(git(e.worktree, "ls-files", "-s", "scripts/butler-checks/no-debugger.sh")).toMatch(/^100755 /);
    expect(e.diff).toContain("scripts/butler-checks/no-debugger.sh");
    expect(git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("wip");
    expect(readFileSync(join(root, "go.mod"), "utf8")).toContain("dirty");
    expect(r.ok && r.message).toContain("butler/check-no-debugger-a1b2c3");
    // 再导出一次：分支名不冲突
    const again = await ex.run(CHECK.key, "acme/app");
    expect(again.ok && again.export?.branch).toBe("butler/check-no-debugger-a1b2c3-2");
  });

  it("edits existing files from the base commit, not the local working copy", async () => {
    const { root, ex } = setup({ "package.json": `{\r\n  "name": "x"\r\n}\r\n`, "src/a.ts": "" });
    writeFileSync(join(root, "package.json"), "{}");
    const r = await ex.run(CHECK.key, "acme/app");
    if (!r.ok) throw new Error(r.message);
    const pkg = readFileSync(join(r.export!.worktree, "package.json"), "utf8");
    expect(pkg).toBe(`{\r\n  "name": "x",\r\n  "scripts": {\r\n    "butler:no-debugger": "node scripts/butler-checks/no-debugger.mjs --all"\r\n  }\r\n}\r\n`);
  });

  it("leaves the files staged when git has no identity", async () => {
    const noIdentity: GitRun = (cwd, args, o) => (args[0] === "config" && args[1]?.startsWith("user.") ? Promise.resolve({ code: 1, stdout: "", stderr: "" }) : runGit(cwd, args, o));
    const { ex } = setup({ "go.mod": "" }, { git: noIdentity });
    const r = await ex.run(CHECK.key, "acme/app");
    if (!r.ok) throw new Error(r.message);
    expect(r.export).toMatchObject({ committed: false, status: "ready" });
    expect(git(r.export!.worktree, "diff", "--cached", "--name-only")).toBe(".gitattributes\nscripts/butler-checks/no-debugger.sh");
    expect(r.message).toContain("user.name");
  });

  it("explains refusals without creating anything", async () => {
    const policy: ResolvedCheck = { ...CHECK, type: "comment_policy", params: {} };
    const { root, ex, repo } = setup({ "go.mod": "" }, { check: policy });
    const r = await ex.run(CHECK.key, "acme/app");
    expect(r).toEqual({ ok: false, message: expect.stringContaining("Node") });
    expect(repo.exports()).toEqual([]);
    expect(git(root, "branch", "--list", "butler/*")).toBe("");
    expect(await ex.run("ck_missing", "acme/app")).toMatchObject({ ok: false });
    expect(await ex.run(CHECK.key, "other/repo")).toMatchObject({ ok: false });
    const nb = setup({ "go.mod": "" }, { noBaseline: true });
    expect(await nb.ex.run(CHECK.key, "acme/app")).toMatchObject({ ok: false });
  });

  it("does not push or open a PR while the outward switches are off, and records each attempt as skipped", async () => {
    const { remote, ex, audit, repo } = setup({ "go.mod": "" });
    const r = await ex.run(CHECK.key, "acme/app");
    if (!r.ok) throw new Error(r.message);
    const id = r.export!.id;
    const push = await ex.act({ kind: "push", id });
    expect(push.ok).toBe(false);
    expect(repo.getExport(id)!.status).toBe("ready");
    expect(git(remote, "branch", "--list")).not.toContain("butler/");
    expect(await ex.act({ kind: "pr", id })).toMatchObject({ ok: false });
    const rows = audit.list();
    expect(rows.find((r) => r.kind === "branch_push")).toMatchObject({ outcome: "skipped", repoSlug: "acme/app", target: "butler/check-no-debugger-a1b2c3" });
    // 没推送就开不了 PR：不算一次对外尝试。
    expect(rows.filter((r) => r.kind === "pr_open")).toEqual([]);
  });

  it("pushes and opens a PR when the switches allow it", async () => {
    const { remote, ex, prs, repo } = setup({ "go.mod": "" }, { outward: allowAll });
    const r = await ex.run(CHECK.key, "acme/app");
    if (!r.ok) throw new Error(r.message);
    const id = r.export!.id;
    expect(await ex.act({ kind: "push", id })).toMatchObject({ ok: true });
    expect(git(remote, "branch", "--list")).toContain("butler/check-no-debugger-a1b2c3");
    expect(await ex.act({ kind: "pr", id })).toMatchObject({ ok: true });
    expect(prs[0]).toMatchObject({ branch: "butler/check-no-debugger-a1b2c3", base: "main", title: 'Add Butler check "No debugger" as a repo rule' });
    expect(repo.getExport(id)).toMatchObject({ status: "pr_opened", prUrl: "https://example.invalid/pr/1" });
  });

  it("discard removes the worktree and the local branch", async () => {
    const { root, ex, repo } = setup({ "go.mod": "" });
    const r = await ex.run(CHECK.key, "acme/app");
    if (!r.ok) throw new Error(r.message);
    const e = r.export!;
    expect(await ex.act({ kind: "discard", id: e.id })).toMatchObject({ ok: true });
    expect(existsSync(e.worktree)).toBe(false);
    expect(git(root, "branch", "--list", e.branch)).toBe("");
    expect(repo.getExport(e.id)!.status).toBe("discarded");
    expect(await ex.act({ kind: "push", id: e.id })).toMatchObject({ ok: false });
  });

  it("removes the worktree and branch again when writing or committing fails", async () => {
    const failAdd: GitRun = (cwd, args, o) => (args[0] === "add" ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: index.lock exists" }) : runGit(cwd, args, o));
    const { root, home, ex, repo } = setup({ "go.mod": "" }, { git: failAdd });
    const r = await ex.run(CHECK.key, "acme/app");
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toContain("index.lock");
    const e = repo.exports()[0];
    expect(e.status).toBe("failed");
    expect(existsSync(join(home, "exports", String(e.id)))).toBe(false);
    expect(git(root, "branch", "--list", "butler/*")).toBe("");
    expect(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  it("does not run the repo's own git hooks while exporting", async () => {
    const { root, ex } = setup({ "go.mod": "" });
    const hooks = git(root, "rev-parse", "--git-path", "hooks");
    const marker = join(root, "..", `hook-ran-${Date.now()}`);
    dirs.push(marker);
    for (const h of ["post-checkout", "prepare-commit-msg", "post-commit", "pre-commit"]) {
      const f = join(root, hooks, h);
      writeFileSync(f, `#!/bin/sh\necho ${h} >> "${marker.split("\\").join("/")}"\n`);
      chmodSync(f, 0o755);
    }
    const r = await ex.run(CHECK.key, "acme/app");
    if (!r.ok) throw new Error(r.message);
    expect(r.export!.committed).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("on startup cleans up an export that was interrupted half way, without touching live ones", async () => {
    const { root, home, ex, repo } = setup({ "go.mod": "" });
    const live = await ex.run(CHECK.key, "acme/app");
    if (!live.ok) throw new Error(live.message);
    // 上次跑到一半退出了：行还是「中断」，worktree 和分支已经建了
    const id = repo.insertExport(
      { checkId: null, checkKey: CHECK.key, slug: "acme/app", target: "script", branch: "butler/half-done", base: "main", worktree: "", files: [], diff: "", committed: false, status: "failed", detail: "interrupted", createdAt: 1 },
      1,
    );
    const dir = join(home, "exports", String(id));
    git(root, "worktree", "add", "-q", "-b", "butler/half-done", dir, "main");
    await ex.recover();
    expect(existsSync(dir)).toBe(false);
    expect(git(root, "branch", "--list", "butler/half-done")).toBe("");
    expect(existsSync(live.export!.worktree)).toBe(true);
    expect(git(root, "branch", "--list", live.export!.branch)).not.toBe("");
  });
});
