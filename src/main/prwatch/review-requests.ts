// 「请你 review」的查询节奏（UI 重做第 1 层，计划 R9、spec §5.1）。
// 每轮一次 gh search prs --review-requested=@me：平时每 5 分钟，离开时每 15 分钟；窗口切到前台、打开首页时离上次超过 1 分钟就补查。
import type { ReviewRequestsRepo } from "../db/review-requests-repo";
import type { ReviewRequestedPr } from "../tickets/gh";
import { PR_SLOW_MS } from "./pr-schedule";

export const REVIEW_AWAY_MS = 15 * 60_000;
export const REVIEW_CATCHUP_MS = 60_000;
export const REVIEW_AWAY_IDLE_SECONDS = 600;
export const REVIEW_TICK_MS = 60_000;
export type ReviewRequestScope = "all" | "registered";

/** 到点了吗：没查过就到；平时 PR_SLOW_MS，离开时 REVIEW_AWAY_MS。 */
export function reviewPollDue(lastAt: number | null, now: number, away: boolean): boolean {
  return lastAt === null || now - lastAt >= (away ? REVIEW_AWAY_MS : PR_SLOW_MS);
}

/** 补查：没查过，或者离上次超过 REVIEW_CATCHUP_MS。 */
export function reviewCatchUpDue(lastAt: number | null, now: number): boolean {
  return lastAt === null || now - lastAt > REVIEW_CATCHUP_MS;
}

/** 读的时候按设置过滤：registered 只留 Shipherd 登记过的仓库（改了设置马上生效，不用等下一次查询）。 */
export function scopeReviews<T extends { slug: string }>(list: T[], scope: ReviewRequestScope, registered: ReadonlySet<string>): T[] {
  return scope === "all" ? list : list.filter((r) => registered.has(r.slug.toLowerCase()));
}

export interface ReviewPollerDeps {
  fetch(): Promise<ReviewRequestedPr[] | null>;
  repo: Pick<ReviewRequestsRepo, "replaceAll" | "list">;
  /** idle.locked() || idle.idleSeconds() >= REVIEW_AWAY_IDLE_SECONDS */
  away(): boolean;
  ghAvailable(): boolean;
  /** 列表变了（增、删、改标题）才调。 */
  changed(): void;
  now(): number;
  log(msg: string, e?: unknown): void;
}

const fingerprint = (rows: { url: string; title: string; author: string }[]): string =>
  rows.map((r) => `${r.url.toLowerCase()}|${r.title}|${r.author}`).sort().join("\n");

export class ReviewRequestPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private lastAt: number | null = null;
  private stopped = false;

  constructor(private readonly d: ReviewPollerDeps) {}

  start(tickMs = REVIEW_TICK_MS): void {
    this.stop();
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
  }

  /** 定时器调：reviewPollDue 才查。 */
  async tick(): Promise<void> {
    if (!reviewPollDue(this.lastAt, this.d.now(), this.d.away())) return;
    await this.run();
  }

  /** 窗口切到前台、打开首页时调：reviewCatchUpDue 才查；人离开时、停了以后不查（离开时交给 15 分钟一次的定时器）。不等结果。 */
  catchUp(): void {
    if (this.stopped || this.d.away() || !reviewCatchUpDue(this.lastAt, this.d.now())) return;
    void this.run();
  }

  /** 同一时间只跑一个查询；gh 不可用时不查。成功、失败都记下这次的时间，失败时保留已有列表。 */
  private run(): Promise<void> {
    if (this.running) return this.running;
    if (!this.d.ghAvailable()) return Promise.resolve();
    this.running = (async () => {
      try {
        const list = await this.d.fetch();
        if (list === null) {
          this.d.log("review requests: gh search failed, keeping the last list");
          return;
        }
        if (this.stopped) return; // 关闭时还在跑的查询：数据库可能已经关了
        const before = fingerprint(this.d.repo.list());
        this.d.repo.replaceAll(list, this.d.now());
        if (fingerprint(this.d.repo.list()) !== before) this.d.changed();
      } catch (e) {
        this.d.log("review requests: query failed", e);
      } finally {
        this.lastAt = this.d.now();
        this.running = null;
      }
    })();
    return this.running;
  }
}

/** 窗口切到前台时补查一次；返回解绑的函数（退出时调）。 */
export function bindFocusCatchUp(
  app: { on(event: "browser-window-focus", f: () => void): unknown; removeListener(event: "browser-window-focus", f: () => void): unknown },
  poller: { catchUp(): void },
): () => void {
  const f = () => poller.catchUp();
  app.on("browser-window-focus", f);
  return () => void app.removeListener("browser-window-focus", f);
}
