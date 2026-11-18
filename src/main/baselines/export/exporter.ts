// 导出成 lint（设计 §8）：在 Butler 管的 worktree（<BUTLER_HOME>/exports/<id>）里新建分支、写文件、本地提交，然后停下。
// 推送和开 PR 只经对外动作的开关（契约 4.8，branch_push / pr_open，默认关、都记录）；丢弃删掉 worktree 和本地分支。
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CheckExportResult, CheckExportView, RepoBaseline } from "../../../shared/baselines";
import type { ResolvedCheck } from "../../../shared/checks";
import type { BaselinesRepo } from "../../db/baselines-repo";
import { M } from "../../strings";
import { gitEnv } from "../../tickets/git";
import { GIT_SAFE_ARGS, gitBinary } from "../../util/git-path";
import type { OutwardGate } from "./outward";
import { buildExport, key6, type ExportPlan, type RepoLayout, type Wired } from "./targets";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRun = (cwd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<GitResult>;

/** 跑 git（带 GIT_SAFE_ARGS、英文报错、不弹窗），从不抛错。 */
export const runGit: GitRun = (cwd, args, opts = {}) =>
  new Promise((done) => {
    let bin: string;
    try {
      bin = gitBinary();
    } catch (e) {
      done({ code: 127, stdout: "", stderr: (e as Error).message });
      return;
    }
    execFile(
      bin, [...GIT_SAFE_ARGS, "-c", "core.quotepath=off", ...args],
      { cwd, env: { ...gitEnv(process.env), GIT_TERMINAL_PROMPT: "0" }, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 60_000, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        done({ code, stdout: String(stdout), stderr: String(stderr) || (err ? err.message : "") });
      },
    );
  });

export interface PrRequest {
  cwd: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}

export interface CheckExporterDeps {
  repo: BaselinesRepo;
  /** 这个仓库里的这条检查（含关掉的）。 */
  check(slug: string, key: string): (ResolvedCheck & { checkId: number | null }) | null;
  baseline(slug: string): RepoBaseline | null;
  localPath(slug: string): string | null;
  /** <BUTLER_HOME>/exports */
  exportsDir: string;
  outward: OutwardGate;
  ticketPattern(): string;
  now(): number;
  git?: GitRun;
  /** gh pr create；返回 PR 链接。 */
  openPr?(req: PrRequest): Promise<string>;
  openPath?(path: string): void;
  onChanged?(): void;
  log?(msg: string, err?: unknown): void;
}

const FETCH_TIMEOUT_MS = 20_000;
const COMMIT_MESSAGE = (name: string) => `chore: add Butler check "${name.replace(/[\r\n"]+/g, " ").trim()}" as a repo rule`;

function wiredText(w: Wired): string {
  const t = M().lintExport.wired;
  switch (w.kind) {
    case "pre_commit":
      return t.pre_commit(w.id, w.stage === "push");
    case "lint_staged":
      return t.lint_staged(w.file);
    case "husky":
      return t.husky(w.hook);
    case "eslint":
      return t.eslint(w.file);
    case "pkg_script":
      return t.pkg_script(w.run);
    case "make_target":
      return t.make_target(w.name);
    case "ci_pkg_lint":
      return t.ci_pkg_lint();
    case "ci_make_lint":
      return t.ci_make_lint();
  }
}

export function refusalText(reason: string, detail?: string): string {
  const t = M().lintExport;
  const r = t.refused[reason] ?? t.refused.unsupported_type;
  return typeof r === "function" ? r(t.regexWhy[detail ?? ""] ?? detail ?? "") : r;
}

/** 结果里的一条说明；pygrep 翻不过去的带上原因。 */
function noteText(n: string): string {
  const t = M().lintExport;
  if (n.startsWith("pygrep_")) {
    const why = t.regexWhy[n.slice("pygrep_".length)];
    return why ? t.pygrepFallback(why) : "";
  }
  return t.notes[n] ?? "";
}

export class CheckExporter {
  private readonly git: GitRun;
  private readonly busy = new Set<string>();

  constructor(private readonly d: CheckExporterDeps) {
    this.git = d.git ?? runGit;
  }

  list(): CheckExportView[] {
    return this.d.repo.exports();
  }

  async act(a: { kind: "run"; checkKey: string; slug: string } | { kind: "discard" | "push" | "pr" | "open"; id: number }): Promise<CheckExportResult> {
    try {
      if (a.kind === "run") return await this.run(a.checkKey, a.slug);
      if (a.kind === "discard") return await this.discard(a.id);
      if (a.kind === "push") return await this.push(a.id);
      if (a.kind === "pr") return await this.pr(a.id);
      return this.open(a.id);
    } catch (e) {
      this.d.log?.(`check export ${a.kind} failed`, e);
      return { ok: false, message: M().lintExport.gitFailed(e instanceof Error ? e.message : String(e)) };
    }
  }

  /** 按仓库现状挑接法、写进新分支、本地提交，然后停下。 */
  async run(checkKey: string, slug: string): Promise<CheckExportResult> {
    const t = M().lintExport;
    const check = this.d.check(slug, checkKey);
    if (!check) return { ok: false, message: refusalText("not_found") };
    const root = this.d.localPath(slug);
    if (!root || !existsSync(root)) return { ok: false, message: refusalText("no_repo") };
    const lock = `${slug}\n${checkKey}`;
    if (this.busy.has(lock)) return { ok: false, message: M().legacy.running };
    this.busy.add(lock);
    try {
      if ((await this.git(root, ["rev-parse", "--git-dir"])).code !== 0) return { ok: false, message: refusalText("not_git") };
      const baseline = this.d.baseline(slug);
      if (!baseline) return { ok: false, message: refusalText("no_baseline") };
      const base = await this.baseRef(root);
      const layout = await this.layoutAt(root, base);
      const cache = new Map<string, string | null>();
      const read = (p: string): string | null => cache.get(p) ?? null;
      for (const p of await this.candidates(root, base, layout)) cache.set(p, await this.show(root, base, p));
      const built = buildExport({ check, baseline, layout, read, ticketPattern: this.d.ticketPattern() });
      if (!built.ok) return { ok: false, message: refusalText(built.reason, built.detail) };
      const plan = built.plan;
      const branch = await this.freeBranch(root, `butler/check-${plan.name}-${key6(checkKey)}`);
      const now = this.d.now();
      const id = this.d.repo.insertExport(
        { checkId: check.checkId, checkKey, slug, target: plan.target, branch, base, worktree: "", files: plan.files.map((f) => f.path), diff: "", committed: false, status: "failed", detail: M().legacy.interrupted, createdAt: now },
        now,
      );
      const dir = this.dirOf(id);
      mkdirSync(this.d.exportsDir, { recursive: true });
      const add = await this.git(root, [...this.noHooks(), "worktree", "add", "-b", branch, dir, base], { timeoutMs: 120_000 });
      if (add.code !== 0) {
        await this.cleanup(root, dir, branch, slug);
        this.d.repo.updateExport(id, { status: "failed", detail: t.worktreeFailed(add.stderr.trim()) }, this.d.now());
        this.d.onChanged?.();
        return { ok: false, message: t.worktreeFailed(add.stderr.trim()) };
      }
      let result: Awaited<ReturnType<CheckExporter["writeAndCommit"]>>;
      try {
        result = await this.writeAndCommit(dir, plan, check.name);
      } catch (e) {
        // 写文件 / git add 失败：worktree 和分支都收回去，不留下删不掉的半成品（审查发现）。
        await this.cleanup(root, dir, branch, slug);
        const why = e instanceof Error ? e.message : String(e);
        this.d.repo.updateExport(id, { status: "failed", detail: t.gitFailed(why) }, this.d.now());
        this.d.onChanged?.();
        return { ok: false, message: t.gitFailed(why) };
      }
      const notes = [...plan.notes.map(noteText).filter(Boolean), ...(plan.notes.includes("pre_push_install") ? [t.prePushInstall] : [])];
      const detail = [t.summary({ branch, wired: plan.wired.map(wiredText), runAll: plan.runAll, committed: result.committed }), ...notes, ...(result.problem ? [result.problem] : [])].join("\n");
      this.d.repo.finishExport(id, { worktree: dir, diff: result.diff, committed: result.committed, status: "ready", detail }, this.d.now());
      this.d.onChanged?.();
      return { ok: true, export: this.d.repo.getExport(id) ?? undefined, message: detail };
    } finally {
      this.busy.delete(lock);
    }
  }

  /** origin/HEAD（先安静地 fetch 一次，20 秒为限），没有就本地默认分支，再没有就 HEAD。 */
  private async baseRef(root: string): Promise<string> {
    const remotes = (await this.git(root, ["remote"])).stdout.split(/\r?\n/).filter(Boolean);
    if (remotes.includes("origin")) {
      await this.git(root, ["fetch", "--quiet", "origin"], { timeoutMs: FETCH_TIMEOUT_MS });
      const head = await this.git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
      if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
      for (const b of ["main", "master"]) if ((await this.git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`])).code === 0) return `origin/${b}`;
    }
    const def = (await this.git(root, ["config", "--get", "init.defaultBranch"])).stdout.trim();
    for (const b of [def, "main", "master"].filter(Boolean)) if ((await this.git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])).code === 0) return b;
    return "HEAD";
  }

  /** base 那个提交的根目录（不看本地没提交的改动）。 */
  private async layoutAt(root: string, base: string): Promise<RepoLayout> {
    const top = (await this.git(root, ["ls-tree", "-z", base])).stdout.split("\0").filter(Boolean);
    const files: string[] = [];
    const dirs: string[] = [];
    for (const row of top) {
      const m = /^\d+ (\w+) [0-9a-f]+\t(.*)$/s.exec(row);
      if (!m) continue;
      if (m[1] === "tree") dirs.push(m[2]);
      else if (m[1] === "blob") files.push(m[2]);
    }
    const huskyFiles = dirs.includes(".husky")
      ? (await this.git(root, ["ls-tree", "-z", "--name-only", `${base}:.husky`])).stdout.split("\0").filter(Boolean)
      : [];
    return { files, dirs, huskyFiles };
  }

  /** 生成时可能要读的文件。 */
  private async candidates(root: string, base: string, layout: RepoLayout): Promise<string[]> {
    const want = /^(\.gitattributes|package\.json|\.pre-commit-config\.ya?ml|\.lintstagedrc(\.json)?|eslint\.config\.[cm]?[jt]s|\.eslintrc(\.json|\.ya?ml)?|GNUmakefile|Makefile|makefile)$/i;
    const out = layout.files.filter((f) => want.test(f));
    for (const h of layout.huskyFiles) out.push(`.husky/${h}`);
    // 同名脚本已经存在时要知道（结果里说明覆盖了）。
    const scripts = (await this.git(root, ["ls-tree", "-r", "-z", "--name-only", base, "--", "scripts/butler-checks", "scripts/butler_checks"])).stdout.split("\0").filter(Boolean);
    return [...out, ...scripts];
  }

  private async show(root: string, base: string, path: string): Promise<string | null> {
    const r = await this.git(root, ["show", `${base}:${path}`]);
    return r.code === 0 ? r.stdout : null;
  }

  private async freeBranch(root: string, want: string): Promise<string> {
    for (let n = 1; n < 100; n++) {
      const name = n === 1 ? want : `${want}-${n}`;
      if ((await this.git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])).code !== 0) return name;
    }
    return `${want}-${Date.now()}`;
  }

  private async writeAndCommit(dir: string, plan: ExportPlan, name: string): Promise<{ committed: boolean; diff: string; problem: string | null }> {
    const t = M().lintExport;
    for (const f of plan.files) {
      const abs = join(dir, ...f.path.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
      if (f.exec && process.platform !== "win32") chmodSync(abs, 0o755);
    }
    const paths = plan.files.map((f) => f.path);
    const add = await this.git(dir, ["add", "--", ...paths]);
    if (add.code !== 0) throw new Error(add.stderr.trim());
    const exec = plan.files.filter((f) => f.exec).map((f) => f.path);
    // Windows 上没有可执行位：直接改索引里的。
    if (exec.length) await this.git(dir, ["update-index", "--chmod=+x", "--", ...exec]);
    const nameSet = (await this.git(dir, ["config", "user.name"])).stdout.trim();
    const email = (await this.git(dir, ["config", "user.email"])).stdout.trim();
    let committed = false;
    let problem: string | null = null;
    if (!nameSet || !email) problem = t.noIdentity;
    else {
      // 不跑仓库自己的 hook（--no-verify 只管 pre-commit / commit-msg，prepare-commit-msg、post-commit 靠 hooksPath 指向空目录）：
      // hook 可能要装依赖、联网或等输入；这只是一个本地草稿提交，hook 在推送 / CI 时照样会跑。
      const c = await this.git(dir, [...this.noHooks(), "commit", "--no-verify", "-q", "-m", COMMIT_MESSAGE(name)], { timeoutMs: 60_000 });
      if (c.code === 0) committed = true;
      else problem = t.commitFailed(c.stderr.trim().split(/\r?\n/).slice(-3).join(" "));
    }
    const diff = committed ? (await this.git(dir, ["show", "--stat", "--patch", "--format=%s", "HEAD"])).stdout : (await this.git(dir, ["diff", "--cached", "--stat", "--patch"])).stdout;
    return { committed, diff, problem };
  }

  private dirOf(id: number): string {
    return join(this.d.exportsDir, String(id));
  }

  /**
   * 导出时不跑仓库自己的 git hook：worktree add 会触发 post-checkout（常见的是装依赖），提交会触发 prepare-commit-msg / post-commit
   * （有的等终端输入，一直卡到超时）。core.hooksPath 指向 Butler 自己的一个空目录，只对这两条命令生效。
   */
  private noHooks(): string[] {
    const empty = join(this.d.exportsDir, ".no-hooks");
    mkdirSync(empty, { recursive: true });
    return ["-c", `core.hooksPath=${empty}`];
  }

  /** 收回一次导出的 worktree 和分支（不管建到哪一步了；每一步失败都不要紧）。 */
  private async cleanup(root: string, dir: string, branch: string, slug: string): Promise<void> {
    if (existsSync(root)) {
      await this.git(root, ["worktree", "remove", "--force", dir]);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      await this.git(root, ["worktree", "prune"]);
      if (branch && !this.d.repo.exports().some((x) => x.slug === slug && x.branch === branch && x.status !== "failed" && x.status !== "discarded" && x.worktree !== dir)) {
        await this.git(root, ["branch", "-D", branch]);
      }
    } else if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  /**
   * 启动时：上次跑到一半就退出的导出（行停在失败、没记下 worktree）把建了的 worktree 和分支收回去。
   * 失败的导出不该留下任何东西，所以凡是失败的行，它的目录还在就清掉。
   */
  async recover(): Promise<void> {
    for (const e of this.d.repo.exports()) {
      if (e.status !== "failed") continue;
      const dir = e.worktree || this.dirOf(e.id);
      const root = this.d.localPath(e.slug);
      const leftover = existsSync(dir) || (root && existsSync(root) && (await this.git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${e.branch}`])).code === 0);
      if (!leftover) continue;
      try {
        if (root) await this.cleanup(root, dir, e.branch, e.slug);
        else if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        this.d.log?.(`check export: cleaning up interrupted export ${e.id} failed`, err);
      }
    }
  }

  private ready(id: number): CheckExportView | CheckExportResult {
    const e = this.d.repo.getExport(id);
    if (!e) return { ok: false, message: M().lintExport.notFound };
    return e;
  }

  async discard(id: number): Promise<CheckExportResult> {
    const e = this.ready(id);
    if ("ok" in e) return e;
    const root = this.d.localPath(e.slug);
    const dir = e.worktree || this.dirOf(e.id);
    if (root && existsSync(root)) {
      await this.git(root, ["worktree", "remove", "--force", dir]);
      await this.git(root, ["worktree", "prune"]);
      await this.git(root, ["branch", "-D", e.branch]);
    }
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    this.d.repo.updateExport(id, { status: "discarded", detail: `${e.detail ?? ""}\n${M().lintExport.discarded}`.trim() }, this.d.now());
    this.d.onChanged?.();
    return { ok: true, export: this.d.repo.getExport(id) ?? undefined, message: M().lintExport.discarded };
  }

  async push(id: number): Promise<CheckExportResult> {
    const t = M().lintExport;
    const e = this.ready(id);
    if ("ok" in e) return e;
    if (e.status !== "ready" || !e.committed) return { ok: false, message: t.notReady };
    const r = await this.d.outward.attempt("branch_push", { scope: { repoSlug: e.slug }, target: e.branch, summary: `push ${e.branch} (Butler check export)` }, async () => {
      const p = await this.git(e.worktree, ["push", "-u", "origin", `${e.branch}:${e.branch}`], { timeoutMs: 120_000 });
      if (p.code !== 0) throw new Error(p.stderr.trim());
      return true;
    });
    if (!r.ran) return { ok: false, message: t.pushOff };
    this.d.repo.updateExport(id, { status: "pushed" }, this.d.now());
    this.d.onChanged?.();
    return { ok: true, export: this.d.repo.getExport(id) ?? undefined, message: t.pushed(e.branch) };
  }

  async pr(id: number): Promise<CheckExportResult> {
    const t = M().lintExport;
    const e = this.ready(id);
    if ("ok" in e) return e;
    if (e.status === "ready") return { ok: false, message: t.prNeedsPush };
    if (e.status !== "pushed") return { ok: false, message: t.notReady };
    const open = this.d.openPr;
    if (!open) return { ok: false, message: t.ghMissing };
    const check = this.d.check(e.slug, e.checkKey);
    const name = check?.name ?? e.checkKey;
    const base = e.base.replace(/^origin\//, "");
    const body = (e.detail ?? "").split("\n").filter((l) => l.trim()).join("\n\n");
    const r = await this.d.outward.attempt("pr_open", { scope: { repoSlug: e.slug }, target: e.branch, summary: `open PR for ${e.branch}`, payload: t.prTitle(name) }, () =>
      open({ cwd: e.worktree, branch: e.branch, base: base === "HEAD" ? "" : base, title: t.prTitle(name), body }),
    );
    if (!r.ran) return { ok: false, message: t.prOff };
    this.d.repo.updateExport(id, { status: "pr_opened", prUrl: r.value }, this.d.now());
    this.d.onChanged?.();
    return { ok: true, export: this.d.repo.getExport(id) ?? undefined, message: t.prOpened(r.value) };
  }

  open(id: number): CheckExportResult {
    const e = this.ready(id);
    if ("ok" in e) return e;
    if (e.worktree && existsSync(e.worktree)) this.d.openPath?.(e.worktree);
    return { ok: true, export: e };
  }
}
