// PR 进度：把存下来的原始事件推导成六步进度条和时间线。纯函数，宁可"跳过"/"未知"，也不给错的状态。
import type { StageEvent } from "../db/pr-stage-repo";
import {
  PR_STAGES, skillCategory,
  type PrStageCell, type PrStageId, type PrStageState, type PrStagesView, type PrTimelineEntry, type PrTimelineKind,
} from "../../shared/pr-stages";

export interface DeriveInput {
  ticketKey: string; featureId: number | null; repoId: number; repoName: string; branch: string;
  ticketCreatedAt: number;
  /** forRepo 的结果。 */
  events: StageEvent[];
  /** upperDesign 的结果。 */
  upperDesign: StageEvent[];
  /** 这个 ticket 的 report（inbox_items kind=report），已经按仓库筛好（session 的 repoId 等于这个仓库或为 null）。 */
  reports: { at: number; text: string }[];
  /** pr_watch 的当前行，没有为 null。 */
  pr: { number: number | null; url: string | null; state: "open" | "merged" | "closed" | null } | null;
  /** hook 程序是当前版本，能看到 skill 调用。 */
  skillTracking: boolean;
}

const REPORT_MAX = 200;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const idOf = (v: unknown): string | null => (typeof v === "number" || typeof v === "string" ? String(v) : null);

type Item = { at: number; event: StageEvent } | { at: number; report: string };

export function derivePrStages(i: DeriveInput): PrStagesView {
  const cells = new Map<PrStageId, PrStageCell>(
    PR_STAGES.map((id) => [id, { id, state: id === "design" && !i.skillTracking ? "unknown" : "todo", round: 1, at: null }]),
  );
  const timeline: PrTimelineEntry[] = [];
  let round = 1;
  let cur: PrStageId = "design";
  /** 看到 closed 事件之后状态不再变。 */
  let closed = false;
  /** 看到 merged 事件之后状态也不再变（同一轮里晚到的 ci、review 只进时间线）。 */
  let merged = false;
  const frozen = () => closed || merged;
  let devStarted = false;

  const events = i.events.filter((e) => Number.isFinite(e.at));
  // 升级前就合并的 PR 不再被监视，没有 merged 事件：当作在已知的最晚事件的时间合并（没有事件就用 ticket 创建时间），确定、不会排到别的事件前面。
  if (i.pr?.state === "merged" && !events.some((e) => e.kind === "merged")) {
    const at = events.reduce((m, e) => Math.max(m, e.at), i.ticketCreatedAt);
    events.push({ id: Number.MAX_SAFE_INTEGER, ticketKey: i.ticketKey, repoId: i.repoId, branch: i.branch, featureId: i.featureId, epicId: null, sessionId: null, kind: "merged", at, data: { number: i.pr.number } });
  }
  const hasFirstCommit = events.some((e) => e.kind === "first_commit");
  const hasPr = i.pr?.number != null || events.some((e) => e.kind === "pr_opened");
  const untracked: PrStageState = i.skillTracking ? "skipped" : "unknown";

  const cell = (id: PrStageId) => cells.get(id)!;
  const set = (id: PrStageId, state: PrStageState, at: number) => {
    const c = cell(id);
    c.state = state;
    c.at = at;
    if (state === "active" || state === "failed" || state === "done") c.round = round;
  };
  const log = (at: number, stage: PrStageId, kind: PrTimelineKind, detail: string | null = null, back = false) =>
    timeline.push({ at, stage, kind, detail, back });

  /** first_commit 的效果：判断设计，进入开发。只在还没开发时生效。 */
  const startDev = (at: number) => {
    if (devStarted) return;
    devStarted = true;
    if (cell("design").state === "active") set("design", "done", at);
    else if (i.upperDesign.some((e) => e.at < i.ticketCreatedAt)) set("design", "feature_level", at);
    else set("design", untracked, at);
    set("dev", "active", at);
    cur = "dev";
  };
  /** 没有 first_commit 事件但有 PR：在第一个 ci / pr_opened / merged 时补一次。 */
  const implyDev = (at: number) => {
    if (!hasFirstCommit && hasPr) startDev(at);
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
          if (!frozen() && (cur === "dev" || cur === "self_review")) {
            // 进入自我 review：开发这一步算完成，同一时间只有一步进行中。
            if (cell("dev").state === "active") set("dev", "done", at);
            set("self_review", "active", at);
            cur = "self_review";
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
          implyDev(at);
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
          if (state === "CHANGES_REQUESTED") {
            if (!frozen()) {
              set("peer_review", "failed", at);
              if (cell("merge").state === "active") set("merge", "todo", at);
              cur = "peer_review";
            }
            log(at, "peer_review", "human_changes", login);
          } else if (state === "APPROVED") {
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
        // DISMISSED、author、bot：忽略。
        return;
      }
      case "merged":
        if (!frozen()) {
          implyDev(at);
          finishDev(at);
          if (cell("peer_review").state !== "done") set("peer_review", "skipped", at);
          set("merge", "done", at);
          for (const id of PR_STAGES) {
            const s = cell(id).state;
            // 剩下的 todo 都是跳过。设计还是 todo 只可能是有 skill 记录（没有时一开始就是"未知"）、开发一直没开始。
            if (s === "todo") set(id, "skipped", at);
            // CI 没出结果就合并，不知道结果。
            else if (s === "active" && id === "ci") set(id, "unknown", at);
          }
          cur = "merge";
          merged = true;
        }
        log(at, "merge", "merged");
        return;
      case "closed":
        closed = true;
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

  return {
    ticketKey: i.ticketKey, featureId: i.featureId, repoId: i.repoId, repoName: i.repoName, branch: i.branch,
    prNumber: i.pr?.number ?? null, prUrl: i.pr?.url ?? null, closed: closed || i.pr?.state === "closed",
    stages: PR_STAGES.map((id) => cell(id)), timeline,
  };
}
