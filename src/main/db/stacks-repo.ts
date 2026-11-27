import type { SQLInputValue } from "node:sqlite";
import type {
  ConflictLease, StackConfirmWhy, StackLayerMode, StackLayerState, StackRunMode, StackRunOutcome, StackSource, StackTrigger,
} from "../../shared/stacks";
import { type Db, withTransaction } from "./database";

export interface StackRow {
  id: number;
  repoPath: string;
  repoSlug: string | null;
  trunk: string;
  remote: string;
  name: string;
  featureId: number | null;
  source: StackSource;
  mergeMethod: "squash" | "merge" | null;
  trunkSha: string | null;
  overviewNumber: number | null;
  overviewUrl: string | null;
  overviewHash: string | null;
  lastDailyAt: number | null;
  createdAt: number;
  updatedAt: number;
  removedAt: number | null;
}

export interface LayerRow {
  id: number;
  stackId: number;
  position: number;
  branch: string;
  ticketKey: string | null;
  ticketRepoId: number | null;
  mode: StackLayerMode;
  state: StackLayerState;
  prNumber: number | null;
  prUrl: string | null;
  /** 上次同步时父层的顶端（这一层自己那段提交的起点）。 */
  baseSha: string | null;
  /** 上次同步时的顶端。 */
  tipSha: string | null;
  /** 远端上已知可以被覆盖的提交（K 改写之前远端那个；开关关着没推出去时用）。 */
  remoteOkSha: string | null;
  /** 合并时 PR 的 head（squash 后 rebase --onto 的起点）。 */
  mergedHead: string | null;
  draftSince: number | null;
  mergedAt: number | null;
  lastRebaseAt: number | null;
  /** 最近一次送出去的冲突（同一个冲突只送一次）。 */
  conflictKey: string | null;
  createdAt: number;
}

export interface RunLayerDetail {
  position: number;
  branch: string;
  oldTip: string;
  newTip: string;
  backupRef: string | null;
}

export interface RunDetail {
  layers?: RunLayerDetail[];
  /** key：交给 session 后记到层的 conflictKey 上的值；ident：同一个冲突的判断（冲突文件和它们在 onto 里的内容）。 */
  /** lease：交给 session 的强推命令锁哪个 remote 的哪个 sha，ahead = 远端有本地没有的提交（BTL-278）。 */
  conflict?: { branch: string; files: string[]; commit: string | null; onto: string; upstream: string; ident?: string; key?: string; lease?: ConflictLease };
  /**
   * 引擎跑出这次结果时的输入（BTL-278）：trunk 和各层顶端（有交给 session 的冲突时只算它下面的层）。
   * 上一次没落地（冲突、失败、要确认、回滚）、输入又没变时不再跑。
   */
  inputs?: string;
  /** needs_confirm：为什么、哪几层。 */
  /** push：确认以后会不会强推（这几层的「强推」开关开着），文案用；旧行没有，按会推算。 */
  confirm?: { why: StackConfirmWhy; branches: string[]; push?: boolean; toSession?: boolean };
  /** 改写后真的排进了 session 信箱的核对请求（BTL-278）。 */
  verifyAsked?: string[];
  /** needs_confirm：这次是 autosquash（确认时也 autosquash）。 */
  autosquash?: boolean;
  /** 手动 run：谁点的（BTL-278）。 */
  actor?: "user" | "coordinator" | "shipherd";
  /** 手动 run 确认的是哪一次 needs_confirm。 */
  confirms?: number;
  mergeMethod?: "squash" | "merge";
  pushed?: string[];
  unpushed?: string[];
  /** 同一原因连续推迟了几次（只留一行）。 */
  repeats?: number;
  restoredFrom?: number;
  /** 冲突已经送进那一层的 session。 */
  delivered?: boolean;
}

export interface RunRow {
  id: number;
  stackId: number;
  trigger: StackTrigger;
  mode: StackRunMode | null;
  outcome: StackRunOutcome;
  reason: string | null;
  detail: RunDetail;
  startedAt: number;
  finishedAt: number | null;
}

export interface NewStack {
  repoPath: string;
  repoSlug: string | null;
  trunk: string;
  remote: string;
  name: string;
  featureId: number | null;
  source: StackSource;
}

export interface NewLayer {
  branch: string;
  ticketKey: string | null;
  ticketRepoId: number | null;
  mode?: StackLayerMode;
  state?: StackLayerState;
  prNumber?: number | null;
  prUrl?: string | null;
  baseSha?: string | null;
  tipSha?: string | null;
  draftSince?: number | null;
}

type Raw = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toStack(r: Raw): StackRow {
  return {
    id: Number(r.id), repoPath: String(r.repo_path), repoSlug: str(r.repo_slug), trunk: String(r.trunk), remote: String(r.remote),
    name: String(r.name), featureId: num(r.feature_id), source: r.source as StackSource,
    mergeMethod: (r.merge_method as StackRow["mergeMethod"]) ?? null, trunkSha: str(r.trunk_sha), overviewNumber: num(r.overview_number),
    overviewUrl: str(r.overview_url), overviewHash: str(r.overview_hash), lastDailyAt: num(r.last_daily_at),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), removedAt: num(r.removed_at),
  };
}

function toLayer(r: Raw): LayerRow {
  return {
    id: Number(r.id), stackId: Number(r.stack_id), position: Number(r.position), branch: String(r.branch), ticketKey: str(r.ticket_key),
    ticketRepoId: num(r.ticket_repo_id), mode: r.mode as StackLayerMode, state: r.state as StackLayerState, prNumber: num(r.pr_number),
    prUrl: str(r.pr_url), baseSha: str(r.base_sha), tipSha: str(r.tip_sha), remoteOkSha: str(r.remote_ok_sha), mergedHead: str(r.merged_head),
    draftSince: num(r.draft_since), mergedAt: num(r.merged_at), lastRebaseAt: num(r.last_rebase_at), conflictKey: str(r.conflict_key),
    createdAt: Number(r.created_at),
  };
}

function parseDetail(raw: unknown): RunDetail {
  try {
    const v = JSON.parse(String(raw ?? "{}")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as RunDetail) : {};
  } catch {
    return {};
  }
}

function toRun(r: Raw): RunRow {
  return {
    id: Number(r.id), stackId: Number(r.stack_id), trigger: r.trigger as StackTrigger, mode: (r.mode as StackRunMode | null) ?? null,
    outcome: r.outcome as StackRunOutcome, reason: str(r.reason), detail: parseDetail(r.detail), startedAt: Number(r.started_at), finishedAt: num(r.finished_at),
  };
}

const STACK_COLS: Record<string, string> = {
  repoSlug: "repo_slug", trunk: "trunk", remote: "remote", name: "name", featureId: "feature_id", mergeMethod: "merge_method",
  trunkSha: "trunk_sha", overviewNumber: "overview_number", overviewUrl: "overview_url", overviewHash: "overview_hash", lastDailyAt: "last_daily_at",
};
const LAYER_COLS: Record<string, string> = {
  position: "position", ticketKey: "ticket_key", ticketRepoId: "ticket_repo_id", mode: "mode", state: "state", prNumber: "pr_number", prUrl: "pr_url",
  baseSha: "base_sha", tipSha: "tip_sha", remoteOkSha: "remote_ok_sha", mergedHead: "merged_head", draftSince: "draft_since", mergedAt: "merged_at",
  lastRebaseAt: "last_rebase_at", conflictKey: "conflict_key",
};

function setClause(cols: Record<string, string>, patch: Record<string, unknown>): [string, SQLInputValue[]] {
  const parts: string[] = [];
  const args: SQLInputValue[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const c = cols[k];
    if (!c || v === undefined) continue;
    parts.push(`${c} = ?`);
    args.push(v as SQLInputValue);
  }
  return [parts.join(", "), args];
}

export type StackPatch = Partial<Omit<StackRow, "id" | "repoPath" | "source" | "createdAt" | "updatedAt" | "removedAt">>;
export type LayerPatch = Partial<Omit<LayerRow, "id" | "stackId" | "branch" | "createdAt">>;

/** 本地栈表（工作流 K）。 */
export class StacksRepo {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  create(s: NewStack, layers: NewLayer[]): number {
    const at = this.now();
    return withTransaction(this.db, () => {
      const id = Number(
        this.db
          .prepare(
            `INSERT INTO stacks (repo_path, repo_slug, trunk, remote, name, feature_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(s.repoPath, s.repoSlug, s.trunk, s.remote, s.name, s.featureId, s.source, at, at).lastInsertRowid,
      );
      layers.forEach((l, i) => this.insertLayer(id, i, l, at));
      return id;
    });
  }

  private insertLayer(stackId: number, position: number, l: NewLayer, at: number): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO stack_layers (stack_id, position, branch, ticket_key, ticket_repo_id, mode, state, pr_number, pr_url, base_sha, tip_sha, draft_since, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          stackId, position, l.branch, l.ticketKey, l.ticketRepoId, l.mode ?? "branch", l.state ?? "branch_only", l.prNumber ?? null, l.prUrl ?? null,
          l.baseSha ?? null, l.tipSha ?? null, l.draftSince ?? null, at,
        ).lastInsertRowid,
    );
  }

  get(id: number): StackRow | null {
    const r = this.db.prepare(`SELECT * FROM stacks WHERE id = ?`).get(id) as Raw | undefined;
    return r ? toStack(r) : null;
  }

  /**
   * 建过栈的仓库（删掉的栈也算，栈只做软删除）：旧版在这些仓库里打开过 rerere（BTL-278）。
   * 不按 stack_runs 算：只跑过没变化的 run 的仓库（那种 run 不留行）旧版也打开过。
   */
  repoPathsOfStacks(): string[] {
    return (this.db.prepare(`SELECT DISTINCT repo_path AS p FROM stacks`).all() as { p: string }[]).map((r) => r.p);
  }

  /** 没删的栈，按 id。 */
  list(): StackRow[] {
    return (this.db.prepare(`SELECT * FROM stacks WHERE removed_at IS NULL ORDER BY id`).all() as Raw[]).map(toStack);
  }

  layers(stackId: number): LayerRow[] {
    return (this.db.prepare(`SELECT * FROM stack_layers WHERE stack_id = ? ORDER BY position, id`).all(stackId) as Raw[]).map(toLayer);
  }

  layer(id: number): LayerRow | null {
    const r = this.db.prepare(`SELECT * FROM stack_layers WHERE id = ?`).get(id) as Raw | undefined;
    return r ? toLayer(r) : null;
  }

  /** 这个仓库里这个分支在哪个没删的栈里。 */
  findBranch(repoPath: string, branch: string): { stack: StackRow; layer: LayerRow } | null {
    const r = this.db
      .prepare(`SELECT l.id AS lid, s.id AS sid FROM stack_layers l JOIN stacks s ON s.id = l.stack_id WHERE s.removed_at IS NULL AND s.repo_path = ? AND l.branch = ?`)
      .get(repoPath, branch) as { lid: number; sid: number } | undefined;
    if (!r) return null;
    return { stack: this.get(Number(r.sid))!, layer: this.layer(Number(r.lid))! };
  }

  /** 这个仓库里删掉过的栈有没有这个分支（自动检测不把用户删掉的栈再建回来）。 */
  inRemovedStack(repoPath: string, branch: string): boolean {
    return this.db
      .prepare(`SELECT 1 AS x FROM stack_layers l JOIN stacks s ON s.id = l.stack_id WHERE s.removed_at IS NOT NULL AND s.repo_path = ? AND l.branch = ? LIMIT 1`)
      .get(repoPath, branch) !== undefined;
  }

  /** 按分支名找（不知道仓库路径的写法不同时用）：所有没删的栈里叫这个名字的层。 */
  findBranchAnyRepo(branch: string): { stack: StackRow; layer: LayerRow }[] {
    const rows = this.db
      .prepare(`SELECT l.id AS lid, s.id AS sid FROM stack_layers l JOIN stacks s ON s.id = l.stack_id WHERE s.removed_at IS NULL AND l.branch = ?`)
      .all(branch) as { lid: number; sid: number }[];
    return rows.map((r) => ({ stack: this.get(Number(r.sid))!, layer: this.layer(Number(r.lid))! }));
  }

  addLayer(stackId: number, l: NewLayer): number {
    const max = this.db.prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM stack_layers WHERE stack_id = ?`).get(stackId) as { m: number };
    const id = this.insertLayer(stackId, Number(max.m) + 1, l, this.now());
    this.touch(stackId);
    return id;
  }

  /** 整个换成这些层（按顺序）：同名分支的行保留（状态、PR、base 都留着），不在里面的删掉。 */
  replaceLayers(stackId: number, layers: NewLayer[]): void {
    const at = this.now();
    withTransaction(this.db, () => {
      const existing = new Map(this.layers(stackId).map((l) => [l.branch, l]));
      const keep = new Set(layers.map((l) => l.branch));
      for (const [b, l] of existing) if (!keep.has(b)) this.db.prepare(`DELETE FROM stack_layers WHERE id = ?`).run(l.id);
      layers.forEach((l, i) => {
        const ex = existing.get(l.branch);
        if (ex) {
          this.db.prepare(`UPDATE stack_layers SET position = ?, ticket_key = COALESCE(?, ticket_key), ticket_repo_id = COALESCE(?, ticket_repo_id) WHERE id = ?`)
            .run(i, l.ticketKey, l.ticketRepoId, ex.id);
        } else {
          this.insertLayer(stackId, i, l, at);
        }
      });
      this.touch(stackId);
    });
  }

  updateStack(id: number, patch: StackPatch): void {
    const [set, args] = setClause(STACK_COLS, patch as Record<string, unknown>);
    if (!set) return;
    this.db.prepare(`UPDATE stacks SET ${set}, updated_at = ? WHERE id = ?`).run(...args, this.now(), id);
  }

  updateLayer(id: number, patch: LayerPatch): void {
    const [set, args] = setClause(LAYER_COLS, patch as Record<string, unknown>);
    if (!set) return;
    this.db.prepare(`UPDATE stack_layers SET ${set} WHERE id = ?`).run(...args, id);
  }

  private touch(stackId: number): void {
    this.db.prepare(`UPDATE stacks SET updated_at = ? WHERE id = ?`).run(this.now(), stackId);
  }

  remove(id: number): void {
    this.db.prepare(`UPDATE stacks SET removed_at = ?, updated_at = ? WHERE id = ?`).run(this.now(), this.now(), id);
  }

  // ---- runs ----

  startRun(stackId: number, trigger: StackTrigger, mode: StackRunMode | null): number {
    return Number(
      this.db.prepare(`INSERT INTO stack_runs (stack_id, trigger, mode, outcome, started_at) VALUES (?, ?, ?, 'noop', ?)`).run(stackId, trigger, mode, this.now()).lastInsertRowid,
    );
  }

  finishRun(id: number, r: { outcome: StackRunOutcome; reason?: string | null; detail?: RunDetail; mode?: StackRunMode | null }): void {
    const cur = this.run(id);
    this.db
      .prepare(`UPDATE stack_runs SET outcome = ?, reason = ?, detail = ?, mode = COALESCE(?, mode), finished_at = ? WHERE id = ?`)
      .run(r.outcome, r.reason ?? null, JSON.stringify(r.detail ?? cur?.detail ?? {}), r.mode ?? null, this.now(), id);
  }

  /** 开了头又没东西可记的 run（没变化的自动触发、被推迟的）。 */
  deleteRun(id: number): void {
    this.db.prepare(`DELETE FROM stack_runs WHERE id = ?`).run(id);
  }

  /**
   * 推迟（或同一原因的失败）：上一条 run 是同样的结果和原因就只更新它的时间和次数，不每分钟记一行。
   * 返回 true = 新记了一行。
   */
  recordRepeatable(stackId: number, trigger: StackTrigger, outcome: "deferred" | "failed", reason: string, extra?: RunDetail): boolean {
    const last = this.lastRun(stackId);
    const at = this.now();
    if (last && last.outcome === outcome && last.reason === reason) {
      const detail = { ...last.detail, ...extra, repeats: (last.detail.repeats ?? 1) + 1 };
      this.db.prepare(`UPDATE stack_runs SET finished_at = ?, detail = ? WHERE id = ?`).run(at, JSON.stringify(detail), last.id);
      return false;
    }
    this.db
      .prepare(`INSERT INTO stack_runs (stack_id, trigger, outcome, reason, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(stackId, trigger, outcome, reason, JSON.stringify({ ...extra, repeats: 1 }), at, at);
    return true;
  }

  run(id: number): RunRow | null {
    const r = this.db.prepare(`SELECT * FROM stack_runs WHERE id = ?`).get(id) as Raw | undefined;
    return r ? toRun(r) : null;
  }

  /** 最近的一次 run；给了 before 时是 id 比它小的那次（正在跑的那次之前的）。 */
  lastRun(stackId: number, before?: number): RunRow | null {
    const r = (before === undefined
      ? this.db.prepare(`SELECT * FROM stack_runs WHERE stack_id = ? ORDER BY id DESC LIMIT 1`).get(stackId)
      : this.db.prepare(`SELECT * FROM stack_runs WHERE stack_id = ? AND id < ? ORDER BY id DESC LIMIT 1`).get(stackId, before)) as Raw | undefined;
    return r ? toRun(r) : null;
  }

  runs(stackId: number, limit = 20): RunRow[] {
    return (this.db.prepare(`SELECT * FROM stack_runs WHERE stack_id = ? ORDER BY id DESC LIMIT ?`).all(stackId, limit) as Raw[]).map(toRun);
  }

  /** 最近一次留了备份、而且还没被恢复过的 run。 */
  lastRestorable(stackId: number): RunRow | null {
    for (const r of this.runs(stackId, 50)) {
      if (r.outcome === "restored") return null;
      if (r.outcome === "rebased" && (r.detail.layers ?? []).some((l) => l.backupRef)) return r;
    }
    return null;
  }

  /** 早于这个时间的 run 里的备份引用（每日清理用）；清理后把 backupRef 置空。 */
  backupsBefore(at: number): { runId: number; stackId: number; refs: string[] }[] {
    const rows = (this.db.prepare(`SELECT * FROM stack_runs WHERE started_at < ? AND detail LIKE '%backupRef%'`).all(at) as Raw[]).map(toRun);
    return rows
      .map((r) => ({ runId: r.id, stackId: r.stackId, refs: (r.detail.layers ?? []).map((l) => l.backupRef).filter((x): x is string => !!x) }))
      .filter((r) => r.refs.length > 0);
  }

  clearBackups(runId: number): void {
    const r = this.run(runId);
    if (!r) return;
    const detail = { ...r.detail, layers: (r.detail.layers ?? []).map((l) => ({ ...l, backupRef: null })) };
    this.db.prepare(`UPDATE stack_runs SET detail = ? WHERE id = ?`).run(JSON.stringify(detail), runId);
  }
}
