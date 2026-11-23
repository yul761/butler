import type { Db } from "./database";
import { withTransaction } from "./database";

/**
 * 仓库改名（BTL-261）：GitHub 上一个仓库改了名、换了 owner 以后，库里存的旧 slug、旧链接改写成新的。
 * slug 都是小写的 owner/repo（github.com 以外是 host/owner/repo），和 parseRemoteSlug、prUrlParts 一样。
 */
export interface RepoRename {
  oldSlug: string;
  newSlug: string;
  source: string;
  detectedAt: number;
  appliedAt: number | null;
}

interface Row {
  old_slug: string;
  new_slug: string;
  source: string;
  detected_at: number;
  applied_at: number | null;
}

const toRename = (r: Row): RepoRename => ({
  oldSlug: String(r.old_slug), newSlug: String(r.new_slug), source: String(r.source), detectedAt: Number(r.detected_at),
  appliedAt: r.applied_at === null ? null : Number(r.applied_at),
});

/** slug 对应的链接前缀（没有协议）：github.com/owner/repo，或 host/owner/repo。 */
export function slugUrlBase(slug: string): string {
  return slug.split("/").length === 3 ? slug : `github.com/${slug}`;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 纯函数：文本里旧仓库的链接（https://github.com/<old>/…、没写协议的 github.com/<old>、正好到 <old> 为止的）和正好是旧 slug 的 JSON 字符串（"<old>"）换成新的。
 * 不分大小写；别的仓库（<old>-web 之类前缀相同的）不动。
 */
export function rewriteSlugText(text: string, oldSlug: string, newSlug: string): string {
  const url = new RegExp(`(\\/\\/|^|[^\\w./-])${escapeRe(slugUrlBase(oldSlug))}(?=[/"'#?\\s)\\]>,]|$)`, "gi");
  const json = new RegExp(`"${escapeRe(oldSlug)}"`, "gi");
  return text.replace(url, `$1${slugUrlBase(newSlug)}`).replace(json, `"${newSlug}"`);
}

/** 纯函数：一条链接是旧仓库的就换成新仓库的，别的原样返回。 */
export function rewriteSlugUrl(url: string, oldSlug: string, newSlug: string): string {
  return rewriteSlugText(url, oldSlug, newSlug);
}

/** 一次改写各表动了几行（只算有变化的表），写日志用；「<表.列> dropped」是和已有新行冲突、删掉的旧行。 */
export type RenameCounts = Record<string, number>;

type Add = (k: string, v: number | bigint) => void;

export class RepoRenamesRepo {
  constructor(private readonly db: Db) {}

  all(): RepoRename[] {
    return (this.db.prepare(`SELECT * FROM repo_renames ORDER BY detected_at, old_slug`).all() as unknown as Row[]).map(toRename);
  }

  /**
   * 启动时要去 GitHub 查一下的 slug：开着的、since 以后链接的 PR 的仓库，学习的仓库，栈的仓库；带上对应的本地路径（有的话）。
   */
  candidates(since: number): { slug: string; path: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT tp.slug AS slug, tr.repo_path AS path FROM ticket_prs tp LEFT JOIN ticket_repos tr ON tr.id = tp.repo_id
           WHERE tp.state = 'open' OR tp.linked_at >= ?
         UNION SELECT slug, local_path FROM lesson_repos
         UNION SELECT repo_slug, repo_path FROM stacks WHERE repo_slug IS NOT NULL`,
      )
      .all(since) as { slug: string; path: string | null }[];
    return rows.map((r) => ({ slug: String(r.slug), path: r.path === null ? null : String(r.path) }));
  }

  /** slug 现在的名字：记过改名的给新名字，否则原样（小写）。 */
  canonical(slug: string): string {
    const s = slug.toLowerCase();
    const r = this.db.prepare(`SELECT new_slug FROM repo_renames WHERE old_slug = ?`).get(s) as { new_slug: string } | undefined;
    return r ? String(r.new_slug) : s;
  }

  /**
   * 记下 old 改名成了 new。链式的改名接起来：a→old 的变成 a→new；new 又改回过 old 的（old→new 之前记过 new→old），删掉那条。
   * 返回是不是新的（之前没有 old→new 这一条）。
   */
  record(oldSlug: string, newSlug: string, source: string, now: number): boolean {
    const o = oldSlug.toLowerCase();
    // 改回了以前的名字（new 记成过 o 的旧名字）：new 就是现在的名字，不再往下接。
    const resolved = this.canonical(newSlug);
    const n = resolved === o ? newSlug.toLowerCase() : resolved;
    if (o === n) return false;
    return withTransaction(this.db, () => {
      const before = this.db.prepare(`SELECT new_slug FROM repo_renames WHERE old_slug = ?`).get(o) as { new_slug: string } | undefined;
      if (before && String(before.new_slug) === n) return false;
      this.db.prepare(`DELETE FROM repo_renames WHERE old_slug = ?`).run(n);
      this.db.prepare(`UPDATE repo_renames SET new_slug = ?, applied_at = NULL WHERE new_slug = ?`).run(n, o);
      this.db.prepare(`DELETE FROM repo_renames WHERE old_slug = new_slug`).run();
      this.db
        .prepare(
          `INSERT INTO repo_renames (old_slug, new_slug, source, detected_at, applied_at) VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT (old_slug) DO UPDATE SET new_slug = excluded.new_slug, source = excluded.source, detected_at = excluded.detected_at, applied_at = NULL`,
        )
        .run(o, n, source, now);
      return true;
    });
  }

  /**
   * 把记下的每一条改名都改写一遍（幂等：没有旧名字的就什么也不动）。返回各表动了几行。
   * 每一条单独一个事务：一条改写失败（回滚，交给 onError）不挡后面的；它的 applied_at 不记，下次启动再试。
   */
  applyAll(now: number, onError?: (r: RepoRename, e: unknown) => void): RenameCounts {
    const total: RenameCounts = {};
    for (const r of this.all()) {
      let c: RenameCounts;
      try {
        c = this.apply(r.oldSlug, r.newSlug);
      } catch (e) {
        if (!onError) throw e;
        onError(r, e);
        continue;
      }
      for (const [k, v] of Object.entries(c)) total[k] = (total[k] ?? 0) + v;
      this.db.prepare(`UPDATE repo_renames SET applied_at = ? WHERE old_slug = ?`).run(now, r.oldSlug);
    }
    return total;
  }

  /**
   * 一个事务里把 old 改写成 new：
   * - ticket_prs：同一个 ticket 在新旧两个链接下各有一行的，合并到旧行（id 小、别的表引用的多），后读到的状态为准；
   *   新行的子表（阶段事件、预审、证据、简报、评论、CI 分诊、指标事件，和一对一的 review 效果、就绪、风险）挪到旧行，冲突时旧行的留下。
   * - lesson_repos（主键 slug，lessons / lesson_queue / lesson_runs / lesson_product_repos 引用它）：挪到新名字，两个都有就并进新的。
   * - 其余 slug 列、链接列：改成新的；改了会和已有的行冲突（唯一约束）的，留新的、删旧的。
   * - metrics_daily 按仓库分的行：并进新名字（相加）；调用方随后重算汇总。
   * - handoff、epic handoff、阶段事件里的 JSON 文本：链接和正好是 slug 的字符串换成新的。
   */
  apply(oldSlug: string, newSlug: string): RenameCounts {
    const o = oldSlug.toLowerCase();
    const n = newSlug.toLowerCase();
    const counts: RenameCounts = {};
    if (o === n) return counts;
    const add = (k: string, v: number | bigint) => {
      const x = Number(v);
      if (x > 0) counts[k] = (counts[k] ?? 0) + x;
    };
    withTransaction(this.db, () => {
      // lesson_repos 的主键要改，子表跟着改：外键推迟到提交时再查（PRAGMA 在提交时自己复原）。
      this.db.exec("PRAGMA defer_foreign_keys = ON");
      this.mergeTicketPrs(o, n, add);
      this.moveLessonRepo(o, n, add);
      for (const [table, col] of SLUG_COLUMNS) this.moveValue(`${table}.${col}`, add, table, col, `lower(${col}) = ?`, "?", [o], [n]);
      for (const [table, col] of URL_COLUMNS) this.moveUrl(`${table}.${col}`, add, table, col, o, n);
      add("metrics_daily", this.mergeDaily(o, n));
      for (const [table, col] of JSON_COLUMNS) add(`${table}.${col}`, this.rewriteText(table, col, o, n));
      this.rewriteStageKeys(add, o, n);
    });
    return counts;
  }

  /**
   * UPDATE OR IGNORE 再删掉没改成的（和已有行冲突的：留已有的新行）。改了的记在 key 下，删了的记在「key dropped」下。
   * 只改 slug / 链接这一列（新值不是 NULL），所以 OR IGNORE 跳过的只会是唯一约束冲突。
   */
  private moveValue(key: string, add: Add, table: string, col: string, where: string, expr: string, whereArgs: string[], exprArgs: string[]): void {
    add(key, this.db.prepare(`UPDATE OR IGNORE ${table} SET ${col} = ${expr} WHERE ${where}`).run(...exprArgs, ...whereArgs).changes);
    add(`${key} dropped`, this.db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...whereArgs).changes);
  }

  private moveUrl(key: string, add: Add, table: string, col: string, o: string, n: string): void {
    for (const scheme of ["https://", "http://"]) {
      const from = `${scheme}${slugUrlBase(o)}`;
      const to = `${scheme}${slugUrlBase(n)}`;
      const where = `(lower(${col}) = ? OR lower(substr(${col}, 1, ${from.length + 1})) IN (? || '/', ? || '#', ? || '?'))`;
      this.moveValue(key, add, table, col, where, `? || substr(${col}, ${from.length + 1})`, [from, from, from, from], [to]);
    }
  }

  private mergeTicketPrs(o: string, n: string, add: Add): void {
    const olds = this.db.prepare(`SELECT id, ticket_key, url FROM ticket_prs WHERE lower(slug) = ? ORDER BY id`).all(o) as { id: number; ticket_key: string; url: string }[];
    for (const r of olds) {
      const url = rewriteSlugUrl(String(r.url), o, n).toLowerCase();
      const dup = this.db.prepare(`SELECT id FROM ticket_prs WHERE ticket_key = ? AND url = ? AND id <> ?`).get(r.ticket_key, url, r.id) as { id: number } | undefined;
      if (dup) {
        this.mergePrInto(Number(dup.id), Number(r.id), add);
        add("ticket_prs merged", 1);
      }
      // 链接换了：按旧链接读失败攒下的（失败次数、放弃、认定不存在）不再算数，下一轮按新链接重新读。
      this.db
        .prepare(
          `UPDATE ticket_prs SET url = ?, slug = ?, read_failures = 0, read_failing_since = NULL, read_retry_at = NULL,
             read_not_found = 0, read_not_found_since = NULL, read_gone_at = NULL WHERE id = ?`,
        )
        .run(url, n, r.id);
      add("ticket_prs", 1);
    }
  }

  /** 新行 from 并进旧行 into：后读到的那行的状态为准，空着的字段补上，子表挪过去，删掉 from。 */
  private mergePrInto(from: number, into: number, add: Add): void {
    const pick = STATUS_COLS.map((c) => `CASE WHEN f.checked_at > i.checked_at THEN f.${c} ELSE i.${c} END`);
    const fill = FILL_COLS.map((c) => `COALESCE(i.${c}, f.${c})`);
    this.db
      .prepare(
        `UPDATE ticket_prs SET (${[...STATUS_COLS, ...FILL_COLS].join(", ")}) =
           (SELECT ${[...pick, ...fill].join(", ")} FROM ticket_prs f, ticket_prs i WHERE f.id = ? AND i.id = ?)
         WHERE id = ?`,
      )
      .run(from, into, into);
    for (const t of ["pre_reviews", "pr_evidence", "pr_briefs", "pr_stage_events"]) this.db.prepare(`UPDATE ${t} SET pr_id = ? WHERE pr_id = ?`).run(into, from);
    this.moveValue("pr_comment_items", add, "pr_comment_items", "pr_id", "pr_id = ?", "?", [String(from)], [String(into)]);
    this.moveValue("ci_triage", add, "ci_triage", "item_id", "item_kind = 'pr' AND item_id = ?", "?", [String(from)], [String(into)]);
    // 一对一的表：旧行已经有的留旧的，没有的把新行的挪过来（review_effect_comments 跟着 review_effect_prs 走）。
    for (const t of ["review_effect_prs", "pr_readiness", "pr_risk"]) {
      const has = this.db.prepare(`SELECT 1 FROM ${t} WHERE pr_id = ?`).get(into) !== undefined;
      if (has) {
        if (t === "review_effect_prs") this.db.prepare(`DELETE FROM review_effect_comments WHERE pr_id = ?`).run(from);
        this.db.prepare(`DELETE FROM ${t} WHERE pr_id = ?`).run(from);
      } else {
        this.db.prepare(`UPDATE ${t} SET pr_id = ? WHERE pr_id = ?`).run(into, from);
        if (t === "review_effect_prs") this.db.prepare(`UPDATE review_effect_comments SET pr_id = ? WHERE pr_id = ?`).run(into, from);
      }
    }
    // 指标事件：pr_id 改过去，去重键里的 PR id（merge:<id>、ready:<id>:<sha>…）也改；旧行已经有同一个事件的，删掉新行的。
    const events = this.db.prepare(`SELECT id, dedupe_key FROM metrics_events WHERE pr_id = ?`).all(from) as { id: number; dedupe_key: string | null }[];
    const token = new RegExp(`^([^:]+):${from}(?=:|$)`);
    for (const e of events) {
      const key = e.dedupe_key === null ? null : String(e.dedupe_key).replace(token, `$1:${into}`);
      const moved = this.db.prepare(`UPDATE OR IGNORE metrics_events SET pr_id = ?, dedupe_key = ? WHERE id = ?`).run(into, key, e.id).changes;
      if (Number(moved) === 0) this.db.prepare(`DELETE FROM metrics_events WHERE id = ?`).run(e.id);
    }
    this.db.prepare(`DELETE FROM ticket_prs WHERE id = ?`).run(from);
  }

  private moveLessonRepo(o: string, n: string, add: Add): void {
    const old = this.db.prepare(`SELECT * FROM lesson_repos WHERE lower(slug) = ?`).get(o) as Record<string, unknown> | undefined;
    if (!old) return;
    const exists = this.db.prepare(`SELECT 1 FROM lesson_repos WHERE slug = ?`).get(n) !== undefined;
    if (!exists) {
      this.db.prepare(`UPDATE lesson_repos SET slug = ? WHERE slug = ?`).run(n, old.slug as string);
    } else {
      // 两个都有：新的那行留着，补上它没有的进度。
      this.db
        .prepare(
          `UPDATE lesson_repos SET merged_cursor = COALESCE(merged_cursor, ?), backfilled_at = COALESCE(backfilled_at, ?),
             last_analyzed_at = MAX(COALESCE(last_analyzed_at, 0), COALESCE(?, 0)), analyzed_count = analyzed_count + ?,
             created_at = MIN(created_at, ?) WHERE slug = ?`,
        )
        .run(
          (old.merged_cursor as string | null) ?? null, (old.backfilled_at as number | null) ?? null, (old.last_analyzed_at as number | null) ?? null,
          Number(old.analyzed_count ?? 0), Number(old.created_at), n,
        );
      this.db.prepare(`UPDATE lesson_repos SET last_analyzed_at = NULL WHERE slug = ? AND last_analyzed_at = 0`).run(n);
    }
    add("lesson_repos", 1);
    for (const t of ["lesson_product_repos", "lessons", "lesson_queue", "lesson_runs"]) this.moveValue(`${t}.repo_slug`, add, t, "repo_slug", "lower(repo_slug) = ?", "?", [o], [n]);
    if (exists) this.db.prepare(`DELETE FROM lesson_repos WHERE slug = ?`).run(old.slug as string);
  }

  private mergeDaily(o: string, n: string): number {
    const moved = this.db
      .prepare(
        `INSERT INTO metrics_daily (day, group_kind, group_key, shipherd, metric, n, total)
           SELECT day, group_kind, ?, shipherd, metric, n, total FROM metrics_daily WHERE group_kind = 'repo' AND lower(group_key) = ? AND true
         ON CONFLICT (day, group_kind, group_key, shipherd, metric) DO UPDATE SET n = n + excluded.n, total = total + excluded.total`,
      )
      .run(n, o).changes;
    this.db.prepare(`DELETE FROM metrics_daily WHERE group_kind = 'repo' AND lower(group_key) = ?`).run(o);
    return Number(moved);
  }

  private rewriteText(table: string, col: string, o: string, n: string): number {
    const rows = this.db.prepare(`SELECT rowid AS id, ${col} AS v FROM ${table} WHERE instr(lower(${col}), ?) > 0`).all(o) as { id: number; v: string }[];
    let c = 0;
    const set = this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`);
    for (const r of rows) {
      const v = rewriteSlugText(String(r.v), o, n);
      if (v === r.v) continue;
      set.run(v, r.id);
      c++;
    }
    return c;
  }

  /** 不是 ticket 仓库的 PR，阶段事件的去重键以 <ticket>@<slug>: 开头（pr-observe 的 scopeOf）。 */
  private rewriteStageKeys(add: Add, o: string, n: string): void {
    const needle = `@${o}:`;
    const rows = this.db.prepare(`SELECT id, dedupe_key FROM pr_stage_events WHERE instr(lower(dedupe_key), ?) > 0`).all(needle) as { id: number; dedupe_key: string }[];
    for (const r of rows) {
      const i = String(r.dedupe_key).toLowerCase().indexOf(needle);
      const key = `${r.dedupe_key.slice(0, i)}@${n}:${r.dedupe_key.slice(i + needle.length)}`;
      const moved = this.db.prepare(`UPDATE OR IGNORE pr_stage_events SET dedupe_key = ? WHERE id = ?`).run(key, r.id).changes;
      if (Number(moved) > 0) add("pr_stage_events.dedupe_key", moved);
      else add("pr_stage_events.dedupe_key dropped", this.db.prepare(`DELETE FROM pr_stage_events WHERE id = ?`).run(r.id).changes);
    }
  }
}

/** 合并 ticket_prs 时取后读到的那一行的列（PR 的状态）。 */
const STATUS_COLS = [
  "state", "review", "ci", "read_error", "head_sha", "failed", "opened_at", "merged_at", "closed_at", "checked_at", "read_failures", "read_failing_since",
  "read_retry_at", "read_not_found", "read_not_found_since", "read_gone_at", "base_branch", "is_draft", "title", "author", "labels", "review_requests", "reviewers", "mergeable",
  "merge_state", "status_changed_at", "head_branch",
];
/** 合并时旧行空着才用新行的列（处理过的、送过的标记：哪一行有就算处理过）。 */
const FILL_COLS = ["repo_id", "merged_handled_at", "delivered_key", "delivered_at", "delivered_to", "shipherd_made"];

/** 存 slug 的列（ticket_prs、lesson_* 另外处理）。 */
const SLUG_COLUMNS: [string, string][] = [
  ...[
    "admission_policies", "checks", "check_hits", "external_action_audit", "metrics_events", "lesson_principles", "lesson_wizard_runs", "cost_caps",
    "loop_policies", "ci_triage", "ci_flaky_events", "ci_flaky_list", "repo_baselines", "baseline_rules", "legacy_scans", "check_exports", "stacks",
    "stack_policies", "backtest_prs", "backtest_repos", "backtest_comments", "backtest_files", "check_backtests", "check_bypasses", "pre_reviews",
    "pr_evidence", "pr_briefs", "pr_policies", "review_effect_prs", "intake_items", "intake_policies", "lesson_sources",
  ].map((t): [string, string] => [t, "repo_slug"]),
  ["metrics_baseline_prs", "slug"],
  ["permission_profiles", "slug"],
  ["review_requests", "slug"],
];

/** 存仓库链接（PR 链接之类）的列。 */
const URL_COLUMNS: [string, string][] = [
  ["merge_holds", "pr_url"], ["lesson_sources", "url"], ["lesson_runs", "pr_url"], ["pr_comment_items", "url"], ["check_exports", "pr_url"],
  ["stacks", "overview_url"], ["stack_layers", "pr_url"], ["pr_briefs", "posted_url"], ["intake_items", "url"], ["review_requests", "url"],
  ["review_requests", "url_key"],
];

/** 存 JSON 的列：里面的链接、slug 字符串。 */
const JSON_COLUMNS: [string, string][] = [["handoffs", "payload"], ["feature_handoffs", "payload"], ["pr_stage_events", "data"]];
