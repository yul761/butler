import { effectiveStatus, type Block, type Feature, type Session, type Ticket } from "../../shared/types";
import type { BlocksRepo } from "../db/blocks-repo";
import type { FeaturesRepo } from "../db/features-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { closedMeanwhile, closeOutcome, retryRequest } from "../../shared/close-ticket-outcome";
import type { ClosePreview, CloseResult, ReopenResult, RetryCloseOptions, RetryCloseResult } from "../tickets/ticket-close";
import type { ActionWorld, CloseStep, TicketActions } from "./actions";
import type { ExtractContext } from "./extract";
import type { RecipientLookup, SourceInfo, TargetLookup } from "./targets";

/**
 * 信息流转（BTL-272）要的查询，按 Shipherd 的库实现：放在这里而不是 index.ts，免得和别的 ticket 抢同一段。
 * ticket 号一律按大写找（和 control-handler 的 set_ticket_feature 一样）。
 */

export interface InfoflowLookupDeps {
  tickets: Pick<TicketsRepo, "get" | "listByFeature">;
  features: Pick<FeaturesRepo, "get" | "list">;
  blocks: Pick<BlocksRepo, "list" | "get">;
  sessions: Pick<SessionsRepo, "head" | "listByTicket" | "listByFeature" | "listFeatureCoordinators" | "listShipherd" | "listByTickets">;
  /** 开着终端，或者休眠着。 */
  live(headId: string): boolean;
  /** ticket 已经关掉了（BTL-270 的 closed：effectiveStatus 是 closed）。 */
  closed(t: Ticket): boolean;
}

const KEY_RE = /\b[A-Za-z][A-Za-z0-9]*-\d+\b/g;
const CONTEXT_TICKETS = 80;
const CONTEXT_EPICS = 40;

const norm = (s: string): string => s.trim().toLowerCase();

/** head 去重，不要隐藏的和复盘分析的。 */
function heads(list: readonly Session[], head: (id: string) => Session | null): Session[] {
  const out = new Map<string, Session>();
  for (const s of list) {
    const h = s.replacedBy === null ? s : head(s.id);
    if (h && !h.dismissed && h.lessonRunId === null) out.set(h.id, h);
  }
  return [...out.values()];
}

export function infoflowLookups(d: InfoflowLookupDeps): {
  sourceOf: (s: Session) => SourceInfo;
  context: (src: SourceInfo, sourceName: string, text: string) => ExtractContext;
  targets: TargetLookup;
  epicOfTicket: (key: string) => number | null;
  recipients: RecipientLookup;
  world: ActionWorld;
  blockName: (id: number) => string | null;
  finished: (sessionId: string) => boolean;
} {
  const head = (id: string) => d.sessions.head(id);
  const ticket = (key: string): Ticket | null => {
    const t = d.tickets.get(key.trim().toUpperCase());
    return t && t.archivedAt === null ? t : null;
  };
  const liveEpic = (id: number): Feature | null => {
    const f = d.features.get(id);
    return f && f.archivedAt === null ? f : null;
  };
  const epic = (idOrName: string): number | null => {
    const s = idOrName.trim();
    if (/^\d+$/.test(s)) return liveEpic(Number(s))?.id ?? null;
    const hits = d.features.list().filter((f) => norm(f.name) === norm(s));
    return hits.length === 1 ? hits[0].id : null;
  };
  const findBlock = (epicId: number | null, ref: string | number): Block | null => {
    const pool = epicId === null ? d.features.list().flatMap((f) => d.blocks.list(f.id)) : d.blocks.list(epicId);
    const asId = typeof ref === "number" ? ref : /^\d+$/.test(ref.trim()) ? Number(ref.trim()) : null;
    const hits = pool.filter((b) => (asId !== null && b.id === asId) || (typeof ref === "string" && norm(b.name) === norm(ref)));
    return hits.length === 1 ? hits[0] : null;
  };
  /**
   * 还在做的 ticket：没归档、没关、没做完。关掉的、做完的 ticket 的 session 不再收要点（不叫醒、不排队等它打开），
   * 要点照样写进记忆。
   */
  const working = (key: string): boolean => {
    const t = ticket(key);
    return t !== null && !d.closed(t) && effectiveStatus(t) !== "done";
  };
  /** 最近活动的一个（总控关着也发：信箱排队）。开着的优先。 */
  const pick = (list: Session[]): Session | null => list.find((s) => d.live(s.id)) ?? list[0] ?? null;

  return {
    sourceOf: (s) => ({
      ticketKey: s.ticketKey,
      featureId: s.featureId ?? (s.ticketKey === null ? null : (d.tickets.get(s.ticketKey)?.featureId ?? null)),
      shipherd: s.shipherd,
    }),
    context: (src, sourceName, text) => {
      const epics = d.features.list().slice(0, CONTEXT_EPICS);
      const mentioned = [...new Set([...text.matchAll(KEY_RE)].map((m) => m[0].toUpperCase()))].map(ticket).filter((t): t is Ticket => t !== null);
      const own = src.featureId === null ? [] : d.tickets.listByFeature(src.featureId);
      const picked = new Map<string, Ticket>();
      for (const t of [...mentioned, ...(src.ticketKey ? [ticket(src.ticketKey)].filter((t): t is Ticket => t !== null) : []), ...own]) {
        if (picked.size >= CONTEXT_TICKETS) break;
        picked.set(t.key, t);
      }
      const epicIds = new Set([...(src.featureId === null ? [] : [src.featureId]), ...[...picked.values()].flatMap((t) => (t.featureId === null ? [] : [t.featureId]))]);
      const blockName = new Map<number, string>();
      const features = [...epicIds].flatMap((id) =>
        d.blocks.list(id).map((b) => {
          blockName.set(b.id, b.name);
          return { id: b.id, epicId: id, name: b.name };
        }),
      );
      return {
        source: sourceName,
        epics: epics.map((f) => ({ id: f.id, name: f.name })),
        tickets: [...picked.values()].map((t) => ({
          key: t.key, title: t.title, epicId: t.featureId, feature: t.blockId == null ? null : (blockName.get(t.blockId) ?? null), status: d.closed(t) ? "closed" : (t.statusManual ?? t.status),
        })),
        features,
      };
    },
    targets: {
      ticket: (k) => {
        const t = ticket(k);
        return t ? { key: t.key, featureId: t.featureId } : null;
      },
      epic,
    },
    epicOfTicket: (k) => ticket(k)?.featureId ?? null,
    recipients: {
      ticketHeads: (k) => (working(k) ? heads(d.sessions.listByTicket(k), head) : []),
      epicHeads: (f) => {
        const own = d.tickets.listByFeature(f).map((t) => t.key).filter(working);
        // epic 自己名下的 session 里也可能有挂在 ticket 上的（修复 session）：那个 ticket 关了、做完了也不发。
        return heads([...d.sessions.listByFeature(f), ...[...d.sessions.listByTickets(own).values()].flat()], head).filter(
          (s) => s.ticketKey === null || working(s.ticketKey),
        );
      },
      coordinator: (f) => pick(heads(d.sessions.listFeatureCoordinators(f), head).filter((s) => s.ticketKey === null && s.fixesSession === null)),
      shipherd: () => pick(heads(d.sessions.listShipherd(), head)),
      coordinators: () =>
        d.features.list().flatMap((f) => {
          const c = pick(heads(d.sessions.listFeatureCoordinators(f.id), head).filter((s) => s.fixesSession === null));
          return c ? [c] : [];
        }),
      live: (id) => d.live(id),
    },
    world: {
      // 关掉的、归档的也要找得到：判断「已经关了」、撤销时重新打开、找它所在的 epic 告诉总控都靠它。
      ticket: (k) => {
        const t = d.tickets.get(k.trim().toUpperCase());
        return t ? { key: t.key, featureId: t.featureId, blockId: t.blockId ?? null, closed: d.closed(t) } : null;
      },
      block: (epicId, ref) => {
        const b = findBlock(epicId, ref);
        return b ? { id: b.id, featureId: b.featureId } : null;
      },
      blockOrder: (f) => d.blocks.list(f).map((b) => b.id),
    },
    blockName: (id) => d.blocks.get(id)?.name ?? null,
    // 和 recipients 同一个判断（working）：挂的 ticket 关了、做完了、归档了。换新过的按最新那个算；不挂 ticket 的（总控）不算。
    finished: (id) => {
      const h = head(id);
      return h !== null && h.ticketKey !== null && !working(h.ticketKey);
    },
  };
}

/** ticket 的关闭 / 重试剩下的 / 重新打开：BTL-270 的 closeTicket / retryClose / reopenTicket（index.ts 里的 ticketClose）。 */
export interface TicketCloser {
  /** prUrls：closePrs 时只关这些（BTL-270：路由要关 PR 必须点名，不给什么都不做、回 pick_prs）。 */
  close(key: string, reason: string, closePrs: boolean, prUrls?: string[]): Promise<CloseResult>;
  /** 关闭框同一份预览：能关的、关不了的（原因写成当前语言）。 */
  preview(key: string): Promise<ClosePreview | null>;
  retry(key: string, o: RetryCloseOptions): Promise<RetryCloseResult>;
  reopen(key: string): Promise<ReopenResult>;
}

/**
 * 关 ticket（或重试）的结果，用和关闭对话框同一个判断（shared 的 closeOutcome，覆盖每一项）：ticket 没关上就抛错（状态记 failed）；
 * 半路被重新打开了是 reopened；有 PR 没关上、session 没结束是 partial（不算完成）；都处理完了是 done。
 * 重试时 ticket 已经不是关着的（not_closed）也是 reopened。要关 PR 却没点名（pick_prs）：什么都没做，不是出错，
 * 带回现在能关的和关不了的（pick），换成这份再问一次。
 * 关的时候别人先关了（BTL-270：already_closed，或者 ok 带 alreadyClosed）：按关闭框同一个判断（closedMeanwhile）说这次实际做了什么；
 * 有没处理成的（failed）是 partial、标上 closedMeanwhile（写明原因，能重试，不给撤销），其余是 closed_meanwhile。
 */
export function closeStep(r: CloseResult | RetryCloseResult): CloseStep {
  if (!r.ok) {
    if (r.error === "not_closed") return { kind: "reopened" };
    if (r.error === "pick_prs") return { kind: "pick", prs: { closable: r.closable.map((p) => p.url), unclosable: r.prErrors.map((e) => ({ url: e.url, error: e.error })) } };
    if (r.error === "already_closed") return { kind: "closed_meanwhile", how: "nothing" };
    throw new Error(r.error);
  }
  const meanwhile = closedMeanwhile(r, false);
  if (meanwhile === "failed") return { kind: "partial", leftovers: { prErrors: r.prErrors, sessionErrors: r.sessionErrors, closedMeanwhile: true } };
  if (meanwhile !== null) return { kind: "closed_meanwhile", how: meanwhile };
  const o = closeOutcome(r);
  if (o.done) return o.reopenedMeanwhile ? { kind: "reopened" } : { kind: "done" };
  return { kind: "partial", leftovers: { prErrors: o.prErrors, sessionErrors: o.sessionErrors } };
}

/** 同步状态变化真正动手的那几下：关 / 开 ticket、换 feature、排 feature 的先后。动完都通知界面刷新。 */
export function infoflowTicketActions(d: {
  tickets: Pick<TicketsRepo, "setBlock">;
  blocks: Pick<BlocksRepo, "reorder">;
  closer: TicketCloser;
  notify: () => void;
}): TicketActions {
  return {
    closeTicket: async (key, reason, closePrs, prUrls) => {
      const r = await d.closer.close(key, reason, closePrs, prUrls);
      d.notify();
      return closeStep(r);
    },
    previewClose: async (key) => {
      const p = await d.closer.preview(key);
      return p ? { closable: p.closable.map((x) => x.url), unclosable: p.unclosable.map((e) => ({ url: e.url, error: e.error })) } : null;
    },
    retryClose: async (key, leftovers) => {
      // 剩下的都是再试也关不了的（不是这个 ticket 的分支、别的 ticket 也在用、读不到）：不再调 gh，照旧留着。
      const again = retryRequest(leftovers);
      if (!again) return { kind: "partial", leftovers };
      const r = await d.closer.retry(key, { source: "routing", ...again });
      d.notify();
      return closeStep(r);
    },
    reopenTicket: async (key) => {
      const r = await d.closer.reopen(key);
      d.notify();
      if (!r.ok) throw new Error(r.error);
    },
    setBlock: (key, blockId) => {
      d.tickets.setBlock(key, blockId);
      d.notify();
    },
    reorderBlocks: (_featureId, ids) => {
      d.blocks.reorder(ids);
      d.notify();
    },
  };
}
