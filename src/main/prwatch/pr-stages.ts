// PR 进度：把存下来的原始事件推导成六步进度条和时间线。纯函数，宁可"跳过"/"未知"，也不给错的状态。
import type { StageEvent } from "../db/pr-stage-repo";
import type { WatchedPr } from "../../shared/types";
import {
  PR_STAGES, skillCategory,
  type PrStageCell, type PrStageId, type PrStageState, type PrStagesView, type PrTimelineEntry, type PrTimelineKind,
} from "../../shared/pr-stages";

export interface DeriveInput {
  ticketKey: string; featureId: number | null; repoId: number | null; repoName: string; branch: string | null;
  ticketCreatedAt: number;
  /** 已经分到这一行（这个 PR，或仓库没有 PR 的那一行）的事件。 */
  events: StageEvent[];
  /** upperDesign 的结果。 */
  upperDesign: StageEvent[];
  /** 已经分到这一行的 report（inbox_items kind=report）。 */
  reports: { at: number; text: string }[];
  /** 这一行的 PR；没有 PR 的行为 null。 */
  pr: {
    number: number; url: string; state: "open" | "merged" | "closed"; ci: WatchedPr["ci"]; review: WatchedPr["review"];
    mergedAt: number | null; closedAt: number | null; checkedAt: number;
  } | null;
  /** hook 从什么时候起记 skill 调用；null = 看不到 skill 调用。 */
  skillTrackingSince: number | null;
}

/** 推导出的一行；prId、slug、noPr 由调用方补上。 */
export type DerivedStages = Omit<PrStagesView, "prId" | "slug" | "noPr">;

const REPORT_MAX = 200;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const idOf = (v: unknown): string | null => (typeof v === "number" || typeof v === "string" ? String(v) : null);

type Item = { at: number; event: StageEvent } | { at: number; report: string };

const firstAt = (events: StageEvent[], kinds: StageEvent["kind"][]): number | null =>
  events.reduce<number | null>((m, e) => (kinds.includes(e.kind) && (m === null || e.at < m) ? e.at : m), null);

/**
 * 合并、关闭但没有事件时补的那一条：PR 行上的时间，不晚于 checkedAt（checkedAt 为 0 = 还没读过，不限）。
 * 时间不知道（没有 at，checkedAt 也是 0）时用最晚的事件时间，不在 1970 年切一刀。
 */
const syntheticAt = (at: number | null, checkedAt: number, latest: number): number =>
  Math.min(at ?? (checkedAt || latest), checkedAt || Infinity);

export function derivePrStages(i: DeriveInput): DerivedStages {
  const events = i.events.filter((e) => Number.isFinite(e.at));
  /** 已知的最晚事件时间，没有事件用 ticket 创建时间：时间不知道时的退路。 */
  const latest = events.reduce((m, e) => Math.max(m, e.at), events.length ? -Infinity : i.ticketCreatedAt);
  const hasPr = i.pr !== null || events.some((e) => e.kind === "pr_opened");
  /**
   * 开发开始：第一个 commit 或开 PR，取早的；有 PR 时第一个 ci / push 更早也算（没有 pr_opened 事件、first_commit 晚到）。
   * 都没有就是第一个 ci / push，再没有用 ticket 创建时间。
   */
  const commitOrPr = firstAt(events, ["first_commit", "pr_opened"]);
  const ciOrPush = firstAt(events, ["ci", "push"]);
  const devStart = commitOrPr !== null && ciOrPush !== null && hasPr
    ? Math.min(commitOrPr, ciOrPush)
    : commitOrPr ?? ciOrPush ?? i.ticketCreatedAt;
  // 开发开始时 hook 已经在记 skill 调用，才知道设计、自我 review 是不是跳过了。
  const tracked = i.skillTrackingSince !== null && devStart >= i.skillTrackingSince;
  const untracked: PrStageState = tracked ? "skipped" : "unknown";
  /** 观察过这个 PR（有 ci、push 或 review）；没观察过，合并时没有证据的步骤是"未知"。 */
  const observed = events.some((e) => e.kind === "ci" || e.kind === "push" || e.kind === "review");
  const cells = new Map<PrStageId, PrStageCell>(
    PR_STAGES.map((id) => [id, { id, state: (id === "design" || id === "self_review") && !tracked ? "unknown" : "todo", round: 1, at: null }]),
  );
  const timeline: PrTimelineEntry[] = [];
  let round = 1;
  // 写法避免 TS 把 cur 收窄成 "design"（它只在闭包里改）。
  let cur = "design" as PrStageId;
  /** PR 现在是关闭的，看到最后一个 closed 事件之后状态不再变（关了又重开的 PR 只记时间线）。 */
  let closed = false;
  /** 看到 merged 事件之后状态也不再变（同一轮里晚到的 ci、review 只进时间线）。 */
  let merged = false;
  const frozen = () => closed || merged;
  let devStarted = false;
  /** 冻结（合并或关闭）的时间。 */
  let endAt: number | null = null;
  /** 每条 review（按 id）最近的状态；DISMISSED 要看它撤销的是哪一种。 */
  const reviewState = new Map<string, string>();
  /** 每个人当前的立场：最近一条不是 COMMENTED / PENDING 的 review；它被撤销就没有立场。 */
  const stance = new Map<string, { id: string | null; state: "APPROVED" | "CHANGES_REQUESTED" }>();
  const standing = (st: string) => [...stance.values()].some((v) => v.state === st);

  const hasCi = events.some((e) => e.kind === "ci");
  const hasHumanReview = events.some((e) => e.kind === "review" && e.data?.who === "human");
  /** PR 行上的时间不知道时的退路（见 syntheticAt）。 */
  const rowAt = (at: number | null, checkedAt: number) => syntheticAt(at, checkedAt, latest);
  // 合并、关闭前没被监视的 PR 没有 merged / closed 事件：用 PR 行上的时间补一条，之后的事件照样冻结在外。
  // since：这个时间或之后已经有这种事件就不补（关了、重开、又关了，第二次关闭没有事件时也补）；null = 有一条就不补。
  const synthetic = (kind: "merged" | "closed", since: number | null, at: number, id: number) => {
    if (i.pr && !events.some((e) => e.kind === kind && (since === null || e.at >= since))) {
      events.push({ id, ticketKey: i.ticketKey, repoId: i.repoId, prId: null, branch: i.branch, featureId: i.featureId, epicId: null, sessionId: null, kind, at, data: { number: i.pr.number } });
    }
  };
  if (i.pr?.state === "merged") synthetic("merged", null, rowAt(i.pr.mergedAt, i.pr.checkedAt), Number.MAX_SAFE_INTEGER);
  if (i.pr?.state === "closed") synthetic("closed", i.pr.closedAt, rowAt(i.pr.closedAt, i.pr.checkedAt), Number.MAX_SAFE_INTEGER - 1);
  /** 冻结的 closed 事件：PR 现在关着时最后一个。 */
  const closing = i.pr?.state === "closed"
    ? events.reduce<StageEvent | null>((m, e) => (e.kind === "closed" && (m === null || e.at >= m.at) ? e : m), null)
    : null;

  const cell = (id: PrStageId) => cells.get(id)!;
  const set = (id: PrStageId, state: PrStageState, at: number) => {
    const c = cell(id);
    c.state = state;
    c.at = at;
    if (state === "active" || state === "failed" || state === "done") c.round = round;
  };
  const log = (at: number, stage: PrStageId, kind: PrTimelineKind, detail: string | null = null, back = false) =>
    timeline.push({ at, stage, kind, detail, back });

  /** first_commit / pr_opened 的效果：判断设计，进入开发。只在还没开发时生效。 */
  const startDev = (at: number) => {
    if (devStarted) return;
    devStarted = true;
    if (cell("design").state === "active") set("design", "done", at);
    else if (i.upperDesign.some((e) => e.at < devStart)) set("design", "feature_level", at);
    else set("design", untracked, at);
    set("dev", "active", at);
    cur = "dev";
  };
  /** 有 PR、还没开始开发：开发开始之后的 ci / push / merged 补一次（first_commit 晚到也不丢前面的 CI）。 */
  const implyDev = (at: number) => {
    if (hasPr && at >= devStart) startDev(at);
  };

  /** 开发阶段结束（开了 PR、CI 开始或已合并）：进行中的开发和自我 review 算完成，没做的自我 review 算跳过/未知。 */
  const finishDev = (at: number) => {
    if (cell("dev").state === "active") set("dev", "done", at);
    const sr = cell("self_review").state;
    if (sr === "active") set("self_review", "done", at);
    else if (sr === "todo") set("self_review", untracked, at);
  };
  /** 在 peer review 之前的某一步还在进行或失败了（比如 CI 挂了）：批准只记下，不往合并走。 */
  const beforeReviewOpen = () =>
    PR_STAGES.slice(0, PR_STAGES.indexOf("peer_review")).some((id) => cell(id).state === "active" || cell(id).state === "failed");

  /** ci pending 的效果；ci 结果之前没看到 pending 时也先走一遍。 */
  const ciPending = (at: number): boolean => {
    if (hasPr && (cur === "dev" || cur === "self_review")) {
      finishDev(at);
    } else if (cur === "ci" && cell("ci").state === "todo") {
      // 开了 PR 之后第一次看到 CI。
    } else if ((cur === "peer_review" || cur === "merge") && cell(cur).state !== "failed") {
      // 同一轮回到 CI：后面"进行中"的步骤退回 todo，免得同时有两步在进行。
      for (const id of ["peer_review", "merge"] as const) if (cell(id).state === "active") set(id, "todo", at);
    } else {
      return false;
    }
    set("ci", "active", at);
    cur = "ci";
    return true;
  };

  const onEvent = (e: StageEvent) => {
    const d = e.data ?? {};
    const at = e.at;
    switch (e.kind) {
      case "skill": {
        const name = str(d.name);
        if (!name) return;
        const category = d.category === "design" || d.category === "review" ? d.category : skillCategory(name);
        if (category === "design") {
          if (!frozen() && cur === "design") set("design", "active", at);
          log(at, "design", "design_skill", name);
        } else if (category === "review") {
          // 还没有第一个 commit 就用了 review skill：先判断设计、进入开发，再进自我 review（之后的 first_commit 不会重启开发）。
          if (!frozen() && cur === "design") startDev(at);
          if (!frozen() && (cur === "dev" || cur === "self_review")) {
            // 进入自我 review：开发这一步算完成，同一时间只有一步进行中。
            if (cell("dev").state === "active") set("dev", "done", at);
            set("self_review", "active", at);
            cur = "self_review";
          } else if (!frozen()) {
            // 已经过了这一轮的自我 review（PR 开了或 CI 开始了）才做的 review：自我 review 算这一轮做了，进度不动。
            const sr = cell("self_review").state;
            if (sr === "skipped" || sr === "unknown" || sr === "todo") set("self_review", "done", at);
          }
          log(at, "self_review", "review_skill", name);
        }
        return;
      }
      case "first_commit":
        if (!frozen()) startDev(at);
        log(at, "dev", "first_commit");
        return;
      case "pr_opened":
        if (!frozen()) {
          startDev(at);
          // 开了 PR，开发和自我 review 结束；进入 CI 但不标"进行中"，没有 CI 的仓库不会卡着一步。
          if (cur === "dev" || cur === "self_review") {
            finishDev(at);
            cur = "ci";
          }
        }
        log(at, cur, "pr_opened");
        return;
      case "ci": {
        const result = d.result;
        if (result !== "pending" && result !== "passing" && result !== "failing") return;
        if (!frozen()) {
          implyDev(at);
          if (result === "pending") ciPending(at);
          else if (cur !== "ci" && cell("ci").state === "active") {
            // CI 还在跑时进度已经往后走了（比如有人要求修改）：结果只写到 CI 这一格，不动当前步骤。
            set("ci", result === "failing" ? "failed" : "done", at);
          } else if (cur === "ci" || ciPending(at)) {
            if (result === "failing") set("ci", "failed", at);
            else {
              set("ci", "done", at);
              // 这一轮已经有人批准过（批准在 CI 结束之前），直接到合并，不把批准抹掉。
              cur = cell("peer_review").state === "done" ? "merge" : "peer_review";
              set(cur, "active", at);
            }
          }
        }
        log(at, "ci", result === "pending" ? "ci_pending" : result === "passing" ? "ci_passed" : "ci_failed");
        return;
      }
      case "push": {
        if (!frozen()) implyDev(at);
        const back = !frozen() && cell(cur).state === "failed";
        if (back) {
          round += 1;
          set("dev", "active", at);
          for (const id of ["self_review", "ci", "peer_review", "merge"] as const) {
            set(id, "todo", at);
            cell(id).round = round;
          }
          cur = "dev";
        }
        log(at, back ? "dev" : cur, "push", null, back);
        return;
      }
      case "review": {
        const who = d.who;
        const state = str(d.state);
        if (!state) return;
        if (who === "copilot") {
          const id = idOf(d.id);
          const count = id === null ? 0 : events.filter((c) => c.kind === "comment" && idOf(c.data?.reviewId) === id).length;
          log(at, "peer_review", "copilot_review", String(count));
        } else if (who === "human") {
          const login = str(d.author);
          const rid = idOf(d.id);
          const earlier = rid === null ? undefined : reviewState.get(rid);
          if (rid !== null && state !== "PENDING") reviewState.set(rid, state);
          if (state === "DISMISSED") {
            if (stance.get(login ?? "")?.id === rid) stance.delete(login ?? "");
            if (!frozen() && (earlier === "APPROVED" || earlier === "CHANGES_REQUESTED")) {
              if (standing("CHANGES_REQUESTED")) {
                // 还有别人的修改请求在：批准不算，回到失败。
                set("peer_review", "failed", at);
                if (cell("merge").state === "active") set("merge", "todo", at);
                cur = "peer_review";
              } else if (!standing("APPROVED")) {
                if (beforeReviewOpen()) {
                  // 前面还有一步在进行或失败（CI 还在跑）：评审等它走完，当前停在最早的那一步。
                  set("peer_review", "todo", at);
                  cur = PR_STAGES.find((id) => cell(id).state === "active" || cell(id).state === "failed") ?? cur;
                } else {
                  if (cell("merge").state === "active") set("merge", "todo", at);
                  set("peer_review", "active", at);
                  cur = "peer_review";
                }
              }
            }
            log(at, "peer_review", "human_dismissed", login);
          } else if (state === "CHANGES_REQUESTED") {
            stance.set(login ?? "", { id: rid, state });
            if (!frozen()) {
              set("peer_review", "failed", at);
              if (cell("merge").state === "active") set("merge", "todo", at);
              cur = "peer_review";
            }
            log(at, "peer_review", "human_changes", login);
          } else if (state === "APPROVED") {
            stance.set(login ?? "", { id: rid, state });
            if (!frozen()) {
              set("peer_review", "done", at);
              // 前面还有一步在进行或失败（通常是 CI 在跑或挂了）：只记批准，等 CI 通过再进入合并。
              if (!beforeReviewOpen()) {
                set("merge", "active", at);
                cur = "merge";
              }
            }
            log(at, "peer_review", "human_approved", login);
          } else if (state === "COMMENTED") {
            log(at, "peer_review", "human_commented", login);
          }
        }
        // author、bot：忽略。
        return;
      }
      case "merged":
        if (!frozen()) {
          // 没观察过的 PR 不知道开发什么时候开始：不补开发。
          if (observed) implyDev(at);
          if (devStarted) finishDev(at);
          // 剩下没做的：观察过就是跳过，没观察过就是未知。
          const none: PrStageState = observed ? "skipped" : "unknown";
          if (cell("peer_review").state !== "done") set("peer_review", none, at);
          set("merge", "done", at);
          for (const id of PR_STAGES) {
            const s = cell(id).state;
            // 设计还是 todo 只可能是有 skill 记录（没有时一开始就是"未知"）、开发一直没开始。
            if (s === "todo") set(id, none, at);
            // CI 没出结果就合并，不知道结果。
            else if (s === "active" && id === "ci") set(id, "unknown", at);
          }
          cur = "merge";
          merged = true;
          endAt = at;
        }
        log(at, "merge", "merged");
        return;
      case "closed":
        if (!frozen() && e === closing) {
          closed = true;
          endAt = at;
        }
        log(at, cur, "closed");
        return;
      default:
        // comment：只用来数 Copilot review 的行内评论。
        return;
    }
  };

  // 同一时间：事件在前，report 在后；同类保持输入顺序（sort 是稳定的）。
  const items: Item[] = [
    ...events.map((event) => ({ at: event.at, event })),
    ...i.reports.filter((r) => Number.isFinite(r.at)).map((r) => ({ at: r.at, report: r.text })),
  ];
  items.sort((a, b) => a.at - b.at);
  for (const it of items) {
    if ("event" in it) onEvent(it.event);
    else log(it.at, cur, "report", [...it.report].slice(0, REPORT_MAX).join(""));
  }

  // 没有 ci / 人的 review 事件（升级前、回填的 PR）：用 PR 行上最近读到的状态。
  if (i.pr) {
    const at = endAt ?? rowAt(null, i.pr.checkedAt);
    if (!hasCi) {
      if (i.pr.ci === "passing") {
        set("ci", "done", at);
        // 停在 CI 这一步（开了 PR）：和 ci 事件一样往评审走；这一轮已经批准过就到合并。
        if (cur === "ci" && !frozen()) {
          cur = cell("peer_review").state === "done" ? "merge" : "peer_review";
          set(cur, "active", at);
        }
      } else if (i.pr.ci === "failing") set("ci", "failed", at);
      // 合并、关闭之后不再"进行中"。
      else if (i.pr.ci === "pending" && !frozen() && !PR_STAGES.some((id) => cell(id).state === "active")) set("ci", "active", at);
    }
    if (!hasHumanReview) {
      const wasActive = cell("peer_review").state === "active";
      if (i.pr.review === "approved") {
        set("peer_review", "done", at);
        // 进行中的评审有了结果：进入合并，同一时间仍只有一步进行中。
        if (wasActive && !frozen()) set("merge", "active", at);
      } else if (i.pr.review === "changes_requested") set("peer_review", "failed", at);
    }
  }

  return {
    ticketKey: i.ticketKey, featureId: i.featureId, repoId: i.repoId, repoName: i.repoName,
    prNumber: i.pr?.number ?? null, prUrl: i.pr?.url ?? null, closed: i.pr?.state === "closed",
    stages: PR_STAGES.map((id) => cell(id)), timeline,
  };
}
