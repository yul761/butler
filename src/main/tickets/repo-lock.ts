import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { mainRepoRoot } from "./git";

/**
 * 按 key 串行的互斥锁（BTL-264）：同一个 key 的 fn 一个接一个跑（按到达顺序），不同 key 互不等待。
 * fn 抛错不影响排在后面的。不可重入：在 fn 里再拿同一个 key 会死锁。
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      // 后面没人排队了就删掉，Map 不会越长越大。
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** 测试用：现在有没有人拿着或在等这个 key。 */
  held(key: string): boolean {
    return this.tails.has(key);
  }
}

/**
 * 仓库锁的 key：主仓库目录（worktree 也归到它的主仓库，refs、.git/worktrees 都是共用的）的真实路径，
 * Windows 上不分大小写。不是 git 仓库（或 git 失败）时用 dir 自己的真实路径。
 */
export async function repoLockKey(dir: string): Promise<string> {
  let main: string;
  try {
    main = await mainRepoRoot(dir);
  } catch {
    main = dir;
  }
  let real: string;
  try {
    real = await realpath(main);
  } catch {
    real = resolve(main);
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/**
 * 进程里所有改仓库的 git 操作（建 worktree / 分支、fetch 新分支的起点、删 worktree）共用的一把锁，按主仓库分（BTL-264）。
 * 同一个仓库里的这些操作同时跑会互相抢：并发 fetch 抢 refs/remotes/origin/<默认分支> 的锁（cannot lock ref），
 * 一边 worktree add 一边别的 git 读 .git/worktrees（failed to read .../commondir）。
 */
export const repoLocks = new KeyedMutex();

/** 拿着 dir 所在仓库的锁跑 fn。 */
export async function withRepoLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  return repoLocks.run(await repoLockKey(dir), fn);
}
