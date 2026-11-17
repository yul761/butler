import { existsSync } from "node:fs";
import type { Lesson, LessonAction, LessonProductView, LessonRepoView, LessonsState, LessonUnknownRepo } from "../../shared/lessons";
import type { LessonsRepo } from "../db/lessons-repo";
import { isAllowedGithubUrl } from "../util/github-url";
import type { LessonRunner } from "./lesson-runner";
import type { RepoIdentity } from "./repo-identity";
import { overflowFor, productSuggestions } from "./select";

export interface LessonsServiceDeps {
  repo: LessonsRepo;
  identity: RepoIdentity;
  runner: Pick<LessonRunner, "backfill">;
  /** Butler 知道的所有仓库根路径（ticket_repos、feature_repos、epic_repos 的 repo_path 去重）。 */
  knownRepoPaths: () => string[];
  /** 每个 ticket 和每个 feature 的仓库根路径，一组一个数组，给归组建议用。 */
  repoGroups: () => string[][];
  /** 路径是否存在，默认 existsSync。不存在的已知路径整个跳过。 */
  exists?: (p: string) => boolean;
  ghAvailable: () => boolean;
  openExternal: (url: string) => void;
  now: () => number;
  notify: () => void;
}

export type LessonActResult = { ok: true } | { ok: false; reason: string };

const NOT_FOUND = { ok: false, reason: "not_found" } as const;

/** 复盘规矩页：拼出整页的状态，执行页面上的操作。 */
export class LessonsService {
  constructor(private readonly d: LessonsServiceDeps) {}

  /** 只打开 github.com，或者某个已知仓库自己的主机（企业版 GitHub，slug 是 host/owner/repo）上的 https 链接。 */
  private allowedUrl(url: string): boolean {
    return isAllowedGithubUrl(url, this.d.repo.repos().map((r) => r.slug));
  }

  /** 先把 knownRepoPaths 里解析得出、且表里还没有（或路径变了）的 upsertRepo，再拼视图。 */
  state(): LessonsState {
    const { repo, identity } = this.d;
    const exists = this.d.exists ?? existsSync;
    const unknownRepos: LessonUnknownRepo[] = [];
    let rows = repo.repos();
    const known = new Map(rows.map((r) => [r.slug, r.localPath]));
    const seen = new Set<string>(); // 同一个 slug 多个路径：本轮第一个赢，免得每次刷新来回改。
    let changed = false;
    for (const path of new Set(this.d.knownRepoPaths())) {
      if (!exists(path)) continue;
      const r = identity.resolve(path);
      if (!("slug" in r)) {
        unknownRepos.push({ path, reason: r.reason });
        continue;
      }
      if (seen.has(r.slug)) continue;
      seen.add(r.slug);
      if (known.get(r.slug) !== path) {
        repo.upsertRepo(r.slug, path, this.d.now());
        changed = true;
      }
    }
    if (changed) rows = repo.repos();
    const repos: LessonRepoView[] = rows
      .map((r) => ({
        slug: r.slug,
        localPath: r.localPath,
        lastAnalyzedAt: r.lastAnalyzedAt,
        analyzedCount: r.analyzedCount,
        ...repo.queueCounts(r.slug),
        backfilled: r.backfilledAt !== null,
        overflow: overflowFor(repo, r.slug),
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    const products = repo.products();
    const groups = this.d.repoGroups().map((g) => g.flatMap((p) => identity.slugOf(p) ?? []));
    return {
      repos,
      unknownRepos,
      products,
      suggestions: productSuggestions(groups, products),
      lessons: repo.lessons().filter((l) => l.status !== "rejected"),
      ghAvailable: this.d.ghAvailable(),
    };
  }

  pendingCount(): number {
    return this.d.repo.pendingCount();
  }

  async act(a: LessonAction): Promise<LessonActResult> {
    const r = await this.run(a);
    if (r.ok) this.d.notify();
    return r;
  }

  private async run(a: LessonAction): Promise<LessonActResult> {
    const { repo } = this.d;
    const now = this.d.now();
    switch (a.op) {
      case "confirm":
        if (!repo.get(a.id)) return NOT_FOUND;
        repo.transaction(() => {
          if (a.text !== undefined) repo.setText(a.id, a.text, now);
          repo.setStatus(a.id, "confirmed", now);
        });
        return { ok: true };
      case "reject":
        if (!repo.get(a.id)) return NOT_FOUND;
        repo.setStatus(a.id, "rejected", now);
        return { ok: true };
      case "edit":
        if (!repo.get(a.id)) return NOT_FOUND;
        repo.setText(a.id, a.text, now);
        return { ok: true };
      case "setDisabled": {
        const l = repo.get(a.id);
        if (!l) return NOT_FOUND;
        // 只在已确认和停用之间切换：待确认的不能靠这个绕过确认。
        if (l.status !== "confirmed" && l.status !== "disabled") return { ok: false, reason: "bad_status" };
        repo.setStatus(a.id, a.disabled ? "disabled" : "confirmed", now);
        return { ok: true };
      }
      case "delete":
        if (!repo.get(a.id)) return NOT_FOUND;
        repo.remove(a.id);
        return { ok: true };
      case "merge": {
        if (a.keepId === a.dropId) return { ok: false, reason: "same_lesson" };
        const keep = repo.get(a.keepId);
        const drop = repo.get(a.dropId);
        if (!keep || !drop) return NOT_FOUND;
        if (!sameScope(keep, drop)) return { ok: false, reason: "scope_mismatch" };
        repo.merge(a.keepId, a.dropId, a.text, now);
        return { ok: true };
      }
      case "createProduct":
        if (repo.products().some((p: LessonProductView) => p.name === a.name)) return { ok: false, reason: "name_taken" };
        repo.createProduct(a.name, a.slugs, now);
        return { ok: true };
      case "deleteProduct":
        repo.deleteProduct(a.id);
        return { ok: true };
      case "addToProduct":
        repo.addToProduct(a.id, a.slug);
        return { ok: true };
      case "removeFromProduct":
        repo.removeFromProduct(a.id, a.slug);
        return { ok: true };
      case "backfill":
        return this.d.runner.backfill(a.slug);
      case "openSource": {
        const url = repo.source(a.sourceId)?.url;
        if (!url || !this.allowedUrl(url)) return { ok: false, reason: "bad_url" };
        this.d.openExternal(url);
        return { ok: true };
      }
    }
  }
}

const sameScope = (a: Lesson, b: Lesson): boolean =>
  a.scope.kind === "repo" ? b.scope.kind === "repo" && a.scope.slug === b.scope.slug : b.scope.kind === "product" && a.scope.productId === b.scope.productId;
