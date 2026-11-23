import type { RenameCounts, RepoRenamesRepo } from "../db/repo-renames-repo";
import { GH_NOT_FOUND } from "./gh";

/** 启动时最多查这么多个存着的 slug（每个一次 gh repo view）。 */
export const RENAME_SCAN_MAX = 30;
/** gh 查失败了的 slug，这么久以内的信号不再排队去查（gh 离线时别每轮堆一串 20 秒超时的调用）。 */
export const RENAME_RETRY_MS = 10 * 60_000;

export interface RenameCandidate {
  /** 库里存的 slug。 */
  slug: string;
  /** 它对应的本地仓库（有的话）：origin 换了的先查。 */
  path: string | null;
}

export interface RepoRenamesDeps {
  repo: Pick<RepoRenamesRepo, "record" | "apply" | "applyAll" | "canonical" | "all">;
  /** gh repo view <slug> 的 nameWithOwner（小写 slug）；GH_NOT_FOUND：仓库不在了；null：gh 失败。 */
  currentSlug(slug: string): Promise<string | typeof GH_NOT_FOUND | null>;
  /** 启动时要查的：库里存着、还在用的 slug。 */
  candidates(): RenameCandidate[];
  /** 本地仓库 origin 的 slug。 */
  slugOf(path: string): string | null;
  now(): number;
  log(msg: string, e?: unknown): void;
  /** 改写过数据以后（汇总表要重算）。 */
  onApplied?(): void;
}

const describe = (c: RenameCounts): string =>
  Object.entries(c)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");

/**
 * 仓库改名（BTL-261）。GitHub 上仓库改了名、换了 owner，gh 按旧名字还能找到，给的 nameWithOwner 是新的：
 * 这时把旧名字记进 repo_renames，库里的旧 slug、旧链接改写成新的（RepoRenamesRepo.apply）。
 * 什么时候查：启动时查存着的 slug（origin 换了的先查）；watcher 读到的 PR 链接、gh 列出来的 PR 链接换了仓库名的，马上查那一个。
 * 只信 GitHub：origin 换成了 fork 之类（旧名字在 GitHub 上还是它自己）不算改名；gh 不可用就不动，下次再查。
 */
export class RepoRenames {
  /** 这次运行里查过的（查成功的才算；gh 失败的过 RENAME_RETRY_MS 信号来了再查）。 */
  private readonly checked = new Set<string>();
  /** 排着队、还没查完的。 */
  private readonly pending = new Set<string>();
  /** gh 查失败的时间。 */
  private readonly failedAt = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly d: RepoRenamesDeps) {}

  /** 启动时：记下的改名再改写一遍，扫掉旧版本这段时间写进来的旧名字。同步，在读 PR 之前跑。 */
  applyRecorded(): void {
    if (this.d.repo.all().length === 0) return;
    try {
      const c = this.d.repo.applyAll(this.d.now(), (r, e) => this.d.log(`repo renames: rewriting ${r.oldSlug} → ${r.newSlug} failed; trying again next launch`, e));
      if (Object.keys(c).length > 0) {
        this.d.log(`repo renames: rewrote leftover old names (${describe(c)})`);
        this.d.onApplied?.();
      }
    } catch (e) {
      this.d.log("repo renames: rewriting recorded renames failed", e);
    }
  }

  /** 启动以后：查一遍存着的 slug。origin 和存的不一样的排前面。 */
  scan(): Promise<void> {
    const seen = new Set<string>();
    const first: string[] = [];
    const rest: string[] = [];
    for (const c of this.d.candidates()) {
      const slug = this.d.repo.canonical(c.slug);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const origin = c.path ? this.d.slugOf(c.path) : null;
      (origin && this.d.repo.canonical(origin) !== slug ? first : rest).push(slug);
    }
    const list = [...first, ...rest].slice(0, RENAME_SCAN_MAX);
    return this.enqueue(async () => {
      for (const s of list) await this.check(s, "scan");
    });
  }

  /** 有地方看到 old 的 PR 链接变成了 new 的：去 GitHub 确认，是改名就改写。不等它。 */
  suggest(oldSlug: string, newSlug: string): void {
    const o = this.d.repo.canonical(oldSlug);
    if (o === this.d.repo.canonical(newSlug) || this.checked.has(o) || this.pending.has(o)) return;
    const failed = this.failedAt.get(o);
    if (failed !== undefined && this.d.now() - failed < RENAME_RETRY_MS) return;
    this.pending.add(o);
    void this.enqueue(() => this.check(o, "watcher").finally(() => this.pending.delete(o)));
  }

  /** 一个接一个地查，不同时跑几个 gh。 */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn).catch((e: unknown) => this.d.log("repo renames: check failed", e));
    return this.chain;
  }

  private async check(slug: string, source: string): Promise<void> {
    if (this.checked.has(slug)) return;
    const cur = await this.d.currentSlug(slug);
    if (cur === null) {
      this.failedAt.set(slug, this.d.now());
      return;
    }
    this.failedAt.delete(slug);
    this.checked.add(slug);
    if (cur === GH_NOT_FOUND || cur === slug) return;
    if (!this.d.repo.record(slug, cur, source, this.d.now())) return;
    const to = this.d.repo.canonical(slug);
    this.d.log(`repo renames: GitHub says ${slug} is now ${to}; rewriting stored names`);
    const c = this.d.repo.applyAll(this.d.now(), (r, e) => this.d.log(`repo renames: rewriting ${r.oldSlug} → ${r.newSlug} failed; trying again next launch`, e));
    this.d.log(`repo renames: ${slug} → ${to}: ${describe(c) || "nothing to rewrite"}`);
    this.checked.add(to);
    this.d.onApplied?.();
  }
}
