import { upgradeLegacyPr, type Handoff, type Pr } from "../../shared/handoff";
import { dedupeHandoffPrs, rememberMergedPrs } from "../../shared/pr-memory";
import type { HandoffRecord, HandoffTrigger } from "../../shared/types";
import type { Db } from "./database";
import { tableGen } from "./table-gen";

interface HandoffRow {
  id: number;
  ticket_key: string;
  session_id: string | null;
  trigger: string;
  created_at: number;
  payload: string | null;
  degraded: number;
  raw_text: string | null;
  source_ref: string | null;
}

function parsePayload(text: string | null): Handoff | null {
  if (!text) return null;
  try {
    // 1.1 之前存的是单个 pr。
    return upgradeLegacyPr(JSON.parse(text)) as Handoff;
  } catch {
    return null;
  }
}

/** json_extract 的结果变回 JS 值：对象、数组是 JSON 文本，true / false 是 1 / 0，null 是 NULL，别的是本来的值。 */
function sqlJson(type: string, v: unknown): unknown {
  if (type === "object" || type === "array") return JSON.parse(v as string);
  if (type === "true") return true;
  if (type === "false") return false;
  return v;
}

function toRecord(r: HandoffRow): HandoffRecord {
  const payload = parsePayload(r.payload);
  return {
    id: r.id,
    ticketKey: r.ticket_key,
    sessionId: r.session_id,
    trigger: r.trigger as HandoffTrigger,
    createdAt: r.created_at,
    payload,
    degraded: r.degraded === 1 || payload === null,
    rawText: r.raw_text,
    sourceRef: r.source_ref,
  };
}

export interface NewHandoff {
  ticketKey: string;
  sessionId: string | null;
  trigger: HandoffTrigger;
  createdAt: number;
  /** null 表示 degraded（校验失败）。 */
  payload: Handoff | null;
  rawText: string | null;
  /** /handoff 输出所在的 transcript 条目 uuid，用来去重。 */
  sourceRef?: string | null;
}

interface PrCache {
  stamp: string;
  lists: Pr[][];
  known?: Pr[];
  all?: Pr[];
}

export class HandoffsRepo {
  constructor(private readonly db: Db) {}

  /** 只追加。sourceRef 重复（同一个 /handoff 输出被处理两次）时不插入，返回 null。 */
  insert(h: NewHandoff): number | null {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO handoffs (ticket_key, session_id, trigger, created_at, payload, degraded, raw_text, source_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(h.ticketKey, h.sessionId, h.trigger, h.createdAt, h.payload ? JSON.stringify(h.payload) : null, h.payload ? 0 : 1, h.rawText, h.sourceRef ?? null);
    return Number(r.changes) > 0 ? Number(r.lastInsertRowid) : null;
  }

  get(id: number): HandoffRecord | null {
    const row = this.db.prepare(`SELECT * FROM handoffs WHERE id = ?`).get(id) as HandoffRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 最新的在前。 */
  listByTicket(ticketKey: string, limit = 50): HandoffRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM handoffs WHERE ticket_key = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(ticketKey, limit) as unknown as HandoffRow[];
    return rows.map(toRecord);
  }

  /** 最新的一条（任何触发方式，可能是 degraded）。 */
  latest(ticketKey: string): HandoffRecord | null {
    return this.listByTicket(ticketKey, 1)[0] ?? null;
  }

  /** 最新的一条完整 handoff（含刷新）。payload 读不出来的行跳过，取下一条。 */
  latestValid(ticketKey: string): HandoffRecord | null {
    const rows = this.db
      .prepare(`SELECT * FROM handoffs WHERE ticket_key = ? AND degraded = 0 AND payload IS NOT NULL ORDER BY created_at DESC, id DESC`)
      .iterate(ticketKey) as Iterable<HandoffRow>;
    for (const row of rows) {
      const rec = toRecord(row);
      if (rec.payload) return rec;
    }
    return null;
  }

  /**
   * 这个 ticket 的 PR：最新一条有效 handoff（含刷新）里的，加上以前任何一条里记下“已合并”的（rememberMergedPrs）。
   * 没有有效 handoff 时是 []。
   */
  knownPrs(ticketKey: string): Pr[] {
    const c = this.prsOf(ticketKey);
    c.known ??= c.lists.length === 0 ? [] : rememberMergedPrs(c.lists[0], c.lists.slice(1));
    return c.known.map((p) => ({ ...p }));
  }

  /** 这个 ticket 任何一条有效 handoff 里出现过的 PR（不看状态），新的在前，同一个 PR 只留一个。 */
  allPrs(ticketKey: string): Pr[] {
    const c = this.prsOf(ticketKey);
    c.all ??= dedupeHandoffPrs(c.lists.flat());
    return c.all.map((p) => ({ ...p }));
  }

  /**
   * 每条有效 handoff 里的 prs，新的在前（BTL-265）。首页每次刷新对每个 ticket 都要读一遍：只取 payload（不取大的 raw_text），
   * 解析结果按 ticket 缓存，戳是（行数、最大 id、表的原地改写代数）。handoff 只追加；原地改的（仓库改名改写链接）会 bumpTableGen。
   * 以后谁要原地 UPDATE handoffs 的 payload / degraded，也要调 bumpTableGen，不然这里读到旧的。删行会改行数，不用管。
   * knownPrs / allPrs 给出去的是复制的（Pr 只有平铺的字段，浅拷贝就够），调用方改了不会改到缓存。
   * 不淘汰：一个 ticket 一条，条数最多是 ticket 数（几十到几百），每条只有几个 PR。
   */
  private prsOf(ticketKey: string): PrCache {
    const s = this.db.prepare(`SELECT COUNT(*) AS n, MAX(id) AS m FROM handoffs WHERE ticket_key = ?`).get(ticketKey) as { n: number; m: number | null };
    const stamp = `${s.n}:${s.m ?? 0}:${tableGen(this.db, "handoffs")}`;
    const hit = this.prCache.get(ticketKey);
    if (hit?.stamp === stamp) return hit;
    // 只在库里取出 prs（1.1 之前的是单个 pr），不把整个 payload 解析一遍：和 parsePayload + upgradeLegacyPr 读到的一样
    //（读不出来的 JSON、不是对象的跳过；有 prs 用 prs，没有 prs 有 pr 时是 [pr] 或 []，都没有跳过）。
    const rows = this.db
      .prepare(
        `SELECT json_type(payload, '$.prs') AS prs_type, json_extract(payload, '$.prs') AS prs, json_type(payload, '$.pr') AS pr_type, json_extract(payload, '$.pr') AS pr
         FROM handoffs WHERE ticket_key = ? AND degraded = 0 AND payload IS NOT NULL AND json_valid(payload) ORDER BY created_at DESC, id DESC`,
      )
      .all(ticketKey) as { prs_type: string | null; prs: unknown; pr_type: string | null; pr: unknown }[];
    const lists: Pr[][] = [];
    for (const r of rows) {
      if (r.prs_type !== null) {
        const prs = sqlJson(r.prs_type, r.prs) as Pr[] | null;
        if (prs) lists.push(prs);
      } else if (r.pr_type !== null) {
        const pr = sqlJson(r.pr_type, r.pr) as Pr | null;
        lists.push(pr ? [pr] : []);
      }
    }
    const c: PrCache = { stamp, lists };
    this.prCache.set(ticketKey, c);
    return c;
  }

  private readonly prCache = new Map<string, PrCache>();

  /** 最新的一条非刷新 handoff（任何有效性）；早间刷新不会把它顶掉。 */
  latestFull(ticketKey: string): HandoffRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM handoffs WHERE ticket_key = ? AND trigger != 'refresh' ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(ticketKey) as HandoffRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 最新的一条非刷新、payload 有效的 handoff。 */
  latestValidFull(ticketKey: string): HandoffRecord | null {
    const rows = this.db
      .prepare(`SELECT * FROM handoffs WHERE ticket_key = ? AND trigger != 'refresh' AND degraded = 0 AND payload IS NOT NULL ORDER BY created_at DESC, id DESC`)
      .iterate(ticketKey) as Iterable<HandoffRow>;
    for (const row of rows) {
      const rec = toRecord(row);
      if (rec.payload) return rec;
    }
    return null;
  }

  /** 最近一次读过 session 的完整 handoff（不算早间刷新和不完整的）的时间；晚间批量据此判断有没有新活动。 */
  lastCapturedAt(ticketKey: string): number | null {
    const r = this.db.prepare(`SELECT MAX(created_at) AS at FROM handoffs WHERE ticket_key = ? AND trigger != 'refresh' AND degraded = 0`).get(ticketKey) as
      | { at: number | null }
      | undefined;
    return r?.at ?? null;
  }

  /** created_at 在 [fromMs, toMs) 之间，旧的在前。 */
  listBetween(fromMs: number, toMs: number): HandoffRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM handoffs WHERE created_at >= ? AND created_at < ? ORDER BY created_at, id`)
      .all(fromMs, toMs) as unknown as HandoffRow[];
    return rows.map(toRecord);
  }
}
