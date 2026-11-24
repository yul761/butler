import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { git } from "./git";

/** 在同一个 key 的锁里又去拿这个 key（会永远等下去）：直接报错，不静默挂死。 */
export class LockReentryError extends Error {
  constructor(readonly key: string, readonly what: string) {
    super(`lock ${key} is already held by this call chain (${what}); taking it again would wait forever`);
    this.name = "LockReentryError";
  }
}

/** 等锁等过了上限：前面那个还没做完（holder 是它的说明）。 */
export class LockWaitTimeoutError extends Error {
  constructor(readonly key: string, readonly what: string, readonly holder: string | null, readonly waitedMs: number) {
    super(`gave up after ${Math.round(waitedMs / 1000)}s waiting for lock ${key} to ${what}; still held by ${holder ?? "an unknown operation"}`);
    this.name = "LockWaitTimeoutError";
  }
}

export interface KeyedMutexOptions {
  /** 等锁超过这么久写一条日志（写明在等谁）。 */
  warnAfterMs?: number;
  /** 等锁超过这么久放弃，抛 LockWaitTimeoutError。Infinity = 一直等。 */
  maxWaitMs?: number;
  log?: (msg: string) => void;
  now?: () => number;
}

/** 当前调用链拿着的锁。release 之后 active 变 false：锁里起的、锁放了以后才跑的异步活不算重入。 */
type Held = { mutex: KeyedMutex; key: string; active: boolean };
const heldChain = new AsyncLocalStorage<readonly Held[]>();

/**
 * 按 key 串行的互斥锁（BTL-264）：同一个 key 的 fn 一个接一个跑（按到达顺序），不同 key 互不等待。
 * fn 抛错不影响排在后面的。不可重入：在 fn 里再拿同一个 key 会抛 LockReentryError（不会死锁）。
 * 等锁超过 warnAfterMs 写日志，超过 maxWaitMs 抛 LockWaitTimeoutError；放弃等的那个不会让后面的人插到前面的持有者之前。
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();
  /** 正拿着锁的：做什么、从什么时候开始。 */
  private readonly holders = new Map<string, { what: string; since: number }>();

  constructor(private readonly o: KeyedMutexOptions = {}) {}

  /** 默认的日志：没设 log 的锁可以之后再接上（模块级的 repoLocks 在 logger 建好之前就有了）。 */
  log: ((msg: string) => void) | undefined = undefined;

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private write(msg: string): void {
    (this.o.log ?? this.log)?.(msg);
  }

  async run<T>(key: string, fn: () => Promise<T>, what = "run"): Promise<T> {
    const chain = heldChain.getStore() ?? [];
    if (chain.some((h) => h.mutex === this && h.key === key && h.active)) throw new LockReentryError(key, what);

    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    const done = () => {
      release();
      // 后面没人排队了就删掉，Map 不会越长越大。
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };

    const startedAt = this.now();
    if (!(await this.waitFor(prev, key, what, startedAt))) {
      // 放弃等：轮到自己时立刻放掉，排在后面的人照样要等前面那个做完。
      void prev.then(done);
      throw new LockWaitTimeoutError(key, what, this.holders.get(key)?.what ?? null, this.now() - startedAt);
    }

    const held: Held = { mutex: this, key, active: true };
    this.holders.set(key, { what, since: this.now() });
    try {
      return await heldChain.run([...chain, held], fn);
    } finally {
      held.active = false;
      this.holders.delete(key);
      done();
    }
  }

  /** 等 prev；超过 warnAfterMs 写日志，超过 maxWaitMs 返回 false。 */
  private async waitFor(prev: Promise<void>, key: string, what: string, startedAt: number): Promise<boolean> {
    const warnAfter = this.o.warnAfterMs ?? Infinity;
    const maxWait = this.o.maxWaitMs ?? Infinity;
    if (!Number.isFinite(warnAfter) && !Number.isFinite(maxWait)) {
      await prev;
      return true;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    try {
      return await new Promise<boolean>((res) => {
        void prev.then(() => res(true));
        if (Number.isFinite(warnAfter)) {
          timers.push(
            setTimeout(() => {
              const h = this.holders.get(key);
              const by = h ? `${h.what} (holding it for ${Math.round((this.now() - h.since) / 1000)}s)` : "an operation still queued ahead";
              this.write(`lock ${key}: ${what} has waited ${Math.round((this.now() - startedAt) / 1000)}s; waiting for ${by}`);
            }, warnAfter),
          );
        }
        if (Number.isFinite(maxWait)) timers.push(setTimeout(() => res(false), maxWait));
      });
    } finally {
      for (const t of timers) clearTimeout(t);
    }
  }

  /** 测试用：现在有没有人拿着或在等这个 key。 */
  held(key: string): boolean {
    return this.tails.has(key);
  }

  /** 拿着这个 key 的操作的说明；没人拿着返回 null。 */
  holder(key: string): string | null {
    return this.holders.get(key)?.what ?? null;
  }
}

/**
 * 仓库锁的 key：git 目录（`git rev-parse --git-common-dir`，worktree 也归到它的主仓库的 git 目录，refs、worktrees 都在那里）的真实路径，
 * Windows 上不分大小写。用 git 目录本身而不是它的上一级：--separate-git-dir 放在同一个目录下的几个 git 目录、submodule
 * （.git/modules/<名字>）都是各自的仓库。不是 git 仓库（或 git 失败）时用 dir 自己的真实路径。
 */
export async function repoLockKey(dir: string): Promise<string> {
  let target: string;
  try {
    // 老版本 git 返回相对 dir 的路径，resolve 统一成绝对路径。
    target = resolve(dir, await git(dir, ["rev-parse", "--git-common-dir"]));
  } catch {
    target = dir;
  }
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    real = resolve(target);
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/** 等仓库锁超过这么久写一条日志。 */
export const REPO_LOCK_WARN_MS = 30_000;
/** 等仓库锁的上限：再长就放弃（报 busy）。不给 git 本身加超时：LFS、hook 本来就可能跑很久。 */
export const REPO_LOCK_MAX_WAIT_MS = 10 * 60_000;

/**
 * 同一个仓库里改 refs / worktree 的 git 操作共用的一把锁，按仓库的 git 目录分（BTL-264）。拿这把锁的：
 * 建 ticket / 加仓库 / 改工作方式 / 切分支 / 重建 worktree（TicketService.locked）、合并后删 worktree（worktree-cleanup），
 * stack 的临时 worktree add/remove/prune、清临时分支和定时 fetch（只锁这几条 git 命令，不锁整个 rebase）。
 * 还没拿的：gate/ 的 fetchQuiet（合并门的 fetch，见 PR #96 的后续）。
 * 同一个仓库里这些操作同时跑会互相抢：并发 fetch 抢 refs/remotes/origin/<默认分支> 的锁（cannot lock ref），
 * 一边 worktree add 一边别的 git 读 .git/worktrees（failed to read .../commondir）。
 */
export const repoLocks = new KeyedMutex({ warnAfterMs: REPO_LOCK_WARN_MS, maxWaitMs: REPO_LOCK_MAX_WAIT_MS });

/** 拿着 dir 所在仓库的锁跑 fn。what 写进等锁日志（「在等谁」）。 */
export async function withRepoLock<T>(dir: string, fn: () => Promise<T>, what?: string): Promise<T> {
  return repoLocks.run(await repoLockKey(dir), fn, what ?? `git work in ${dir}`);
}
