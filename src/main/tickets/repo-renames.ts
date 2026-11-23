import type { RenameCounts, RepoRename, RepoRenamesRepo } from "../db/repo-renames-repo";
import { GH_NOT_FOUND } from "./gh";

/** 启动时最多查这么多个存着的 slug（每个一次 gh repo view）。 */
export const RENAME_SCAN_MAX = 30;
/** gh 查失败了的 slug，这么久以内的信号不再排队去查（gh 离线时别每轮堆一串 20 秒超时的调用）。 */
export const RENAME_RETRY_MS = 10 * 60_000;
/** 记下的改名确认过以后，隔这么久再去 GitHub 复查一次（旧名字可能被新建的仓库占了）。 */
export const RENAME_REVERIFY_MS = 24 * 60 * 60_000;

export interface RenameCandidate {
  /** 库里存的 slug。 */
  slug: string;
  /** 它对应的本地仓库（有的话）：origin 换了的先查。 */
  path: string | null;
}

export interface RepoRenamesDeps {
  repo: Pick<RepoRenamesRepo, "record" | "forget" | "apply" | "applyAll" | "canonical" | "all">;
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
 *
 * 记下的改名不是永久的：旧名字可能被新建的仓库占了（o/app 改名成 o/app-legacy，又新建了一个 o/app），
 * 那以后 o/app 的链接是另一个仓库的 PR，不能再改写。所以每次运行都先去 GitHub 复查（verifyRecorded，之后每 RENAME_REVERIFY_MS 一次）：
 * 旧名字现在又是它自己的，删掉这条；复查过的才拿来改写、才给 canonical 用。没复查过的（gh 离线）先不用，旧名字照原样存，复查过以后再改写。
 */
export class RepoRenames {
  /**
   * 这次运行里查过的时间（查成功的才算；gh 失败的过 RENAME_RETRY_MS 信号来了再查）。启动扫描查过的不再扫；
   * watcher、linker 的信号（链接换了仓库名）隔了 RENAME_RETRY_MS 就再查：仓库可能是 app 开着的时候改的名。
   */
  private readonly checkedAt = new Map<string, number>();
  /** 排着队、还没查完的。 */
  private readonly pending = new Set<string>();
  /** gh 查失败的时间。 */
  private readonly failedAt = new Map<string, number>();
  /** 记下的改名（旧 slug）这次运行里复查确认的时间：确认过的才用。 */
  private readonly verifiedAt = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly d: RepoRenamesDeps) {}

  /**
   * 这次运行里去 GitHub 确认过 slug 是什么了：查过是它自己（不是改名），或者是复查确认过的改名的旧名字。
   * 没确认过的（gh 失败、还没轮到）不知道它现在叫什么，按名字判断「不是这个仓库的」时不能信。
   */
  settled(slug: string): boolean {
    const s = slug.toLowerCase();
    return this.verifiedAt.has(s) || this.checkedAt.has(s) || this.checkedAt.has(this.canonical(s));
  }

  /** slug 现在的名字：复查确认过的改名给新名字，否则原样（小写）。链接、slug 入库前用它。 */
  canonical(slug: string): string {
    const s = slug.toLowerCase();
    return this.verifiedAt.has(s) ? this.d.repo.canonical(s) : s;
  }

  /**
   * 记下的改名逐条去 GitHub 复查（确认过、还没过 RENAME_REVERIFY_MS 的跳过），再把确认过的改写一遍
   * （扫掉旧版本、复查之前这段时间写进来的旧名字）。启动时调一次，之后定时调：gh 失败了的下次再查。
   */
  verifyRecorded(): Promise<void> {
    return this.enqueue(async () => {
      const now = this.d.now();
      let fresh = false;
      for (const r of this.d.repo.all()) {
        const at = this.verifiedAt.get(r.oldSlug);
        if (at !== undefined && now - at < RENAME_REVERIFY_MS) continue;
        const failed = this.failedAt.get(r.oldSlug);
        if (failed !== undefined && now - failed < RENAME_RETRY_MS) continue;
        const before = this.d.repo.canonical(r.oldSlug);
        if ((await this.verify(r.oldSlug, "verify")) && (at === undefined || this.d.repo.canonical(r.oldSlug) !== before)) fresh = true;
        // gh 不可用：这一轮剩下的也别查了（每条都要等超时），下一轮再来。
        if (this.failedAt.has(r.oldSlug)) break;
      }
      if (fresh) this.applyVerified("rewrote leftover old names");
    });
  }

  /** 启动以后：查一遍存着的 slug。origin 和存的不一样的排前面。 */
  scan(): Promise<void> {
    const seen = new Set<string>();
    const first: string[] = [];
    const rest: string[] = [];
    for (const c of this.d.candidates()) {
      const slug = this.canonical(c.slug);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const origin = c.path ? this.d.slugOf(c.path) : null;
      (origin && this.canonical(origin) !== slug ? first : rest).push(slug);
    }
    const list = [...first, ...rest].slice(0, RENAME_SCAN_MAX);
    return this.enqueue(async () => {
      for (const s of list) await this.check(s, "scan");
    });
  }

  /** 有地方看到 old 的 PR 链接变成了 new 的：去 GitHub 确认，是改名就改写。不等它。 */
  suggest(oldSlug: string, newSlug: string): void {
    const o = this.canonical(oldSlug);
    if (o === this.canonical(newSlug) || this.pending.has(o)) return;
    const now = this.d.now();
    const at = this.checkedAt.get(o);
    if (at !== undefined && now - at < RENAME_RETRY_MS) return;
    const failed = this.failedAt.get(o);
    if (failed !== undefined && now - failed < RENAME_RETRY_MS) return;
    this.pending.add(o);
    void this.enqueue(() => this.check(o, "watcher", RENAME_RETRY_MS).finally(() => this.pending.delete(o)));
  }

  /** 一个接一个地查，不同时跑几个 gh。 */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn).catch((e: unknown) => this.d.log("repo renames: check failed", e));
    return this.chain;
  }

  private applyVerified(what: string): void {
    const c = this.d.repo.applyAll(
      this.d.now(),
      (r, e) => this.d.log(`repo renames: rewriting ${r.oldSlug} → ${r.newSlug} failed; trying again later`, e),
      (r: RepoRename) => this.verifiedAt.has(r.oldSlug),
      (m) => this.d.log(m),
    );
    if (Object.keys(c).length === 0) return;
    this.d.log(`repo renames: ${what} (${describe(c)})`);
    this.d.onApplied?.();
  }

  /**
   * 去 GitHub 查 slug 现在叫什么，按结果更新记录。返回 slug 是不是一条（还在的）改名的旧名字、这次确认了。
   * - gh 失败：记下时间，什么也不动。
   * - 还是它自己：不是改名；以前记成过改名的（名字又被占了），删掉那条。
   * - 别的名字：记下改名（链式的接起来），确认。
   * - 不存在了：以前记过改名的，留着、算确认（旧名字下没有别的仓库，不会改错）；没记过的什么也不做。
   */
  private async verify(slug: string, source: string): Promise<boolean> {
    const cur = await this.d.currentSlug(slug);
    const now = this.d.now();
    if (cur === null) {
      this.failedAt.set(slug, now);
      return false;
    }
    this.failedAt.delete(slug);
    const recorded = this.d.repo.canonical(slug) !== slug;
    if (cur === slug) {
      this.verifiedAt.delete(slug);
      if (recorded && this.d.repo.forget(slug)) {
        this.d.log(`repo renames: GitHub says ${slug} is a repository of its own again (the name was taken by a new repo); no longer rewriting it`);
      }
      return false;
    }
    if (cur !== GH_NOT_FOUND && cur !== this.d.repo.canonical(slug)) {
      if (this.d.repo.record(slug, cur, source, now)) this.d.log(`repo renames: GitHub says ${slug} is now ${this.d.repo.canonical(slug)}; rewriting stored names`);
    }
    if (this.d.repo.canonical(slug) === slug) return false;
    this.verifiedAt.set(slug, now);
    return true;
  }

  /** 查一个 slug；minAgeMs 以内查过的跳过（默认：这次运行查过就不再查）。 */
  private async check(slug: string, source: string, minAgeMs = Infinity): Promise<void> {
    const at = this.checkedAt.get(slug);
    if (at !== undefined && this.d.now() - at < minAgeMs) return;
    const before = this.d.repo.canonical(slug);
    const wasVerified = this.verifiedAt.has(slug);
    const renamed = await this.verify(slug, source);
    if (this.failedAt.has(slug)) return;
    const now = this.d.now();
    this.checkedAt.set(slug, now);
    if (!renamed) return;
    const to = this.d.repo.canonical(slug);
    this.checkedAt.set(to, now);
    if (wasVerified && before === to) return;
    this.applyVerified(`${slug} → ${to}`);
  }
}
