import { classifyPrState, type PrStateCommand } from "../../shared/gate-command";
import { isHeadlessEnvelope, type HookEnvelope } from "../../shared/hook-envelope";
import type { TicketPr } from "../db/ticket-prs-repo";

/** 一次 Bash 里跑的 gh pr merge / close / reopen（BTL-270），和是哪个 session、哪个 ticket 跑的。 */
export interface PrStateSeen {
  sessionId: string | null;
  /** hook 环境里的 ticket（ticket session 才有；总控没有）。 */
  ticket: string | null;
  commands: PrStateCommand[];
}

const ACTIONS = new Set(["merge", "close", "reopen"]);
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

function parsed(v: unknown): PrStateCommand[] | null {
  if (!Array.isArray(v)) return null;
  const out: PrStateCommand[] = [];
  for (const c of v) {
    if (!c || typeof c !== "object") return null;
    const o = c as Record<string, unknown>;
    if (typeof o.action !== "string" || !ACTIONS.has(o.action) || !strOrNull(o.dir) || !strOrNull(o.pr) || !strOrNull(o.repo)) return null;
    out.push({ action: o.action as PrStateCommand["action"], dir: o.dir, pr: o.pr, repo: o.repo });
  }
  return out;
}

/** Bash 跑完（成功或失败）的 gh pr merge / close / reopen；别的信封为 null。新版 hook 解析好了（pr_state），旧版的照命令解析。 */
export function prStateFromEnvelope(env: HookEnvelope): PrStateSeen | null {
  const p = env.payload;
  if (isHeadlessEnvelope(env) || !p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  if ((o.hook_event_name !== "PostToolUse" && o.hook_event_name !== "PostToolUseFailure") || o.tool_name !== "Bash") return null;
  const input = o.tool_input && typeof o.tool_input === "object" ? (o.tool_input as Record<string, unknown>) : {};
  const commands = parsed(o.pr_state) ?? (typeof input.command === "string" ? classifyPrState(input.command) : []);
  if (commands.length === 0) return null;
  const sessionId = env.shipherdSession ?? (typeof o.session_id === "string" ? o.session_id : null);
  return { sessionId, ticket: env.ticket, commands };
}

export interface PrCommandDeps {
  /** 跑命令的 session：它的 ticket（ticket session），或者它管的 epic（epic 总控）；Shipherd 总控两个都是 null。 */
  session(id: string): { ticketKey: string | null; featureId: number | null } | null;
  /** 一个 epic 的 ticket 号。 */
  ticketsOfFeature(featureId: number): string[];
  prsByUrl(url: string): TicketPr[];
  prsByNumber(n: number): TicketPr[];
  prsOfTicket(key: string): TicketPr[];
}

const PR_URL = /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+/i;
const sameSlug = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * 这些命令动了哪些 ticket 的 PR，要马上重读。PR 链接带着仓库，直接按链接找。号码要和仓库一起对
 * （-R、GH_REPO 或链接里的；跨仓库的 epic 里同一个号码可能是好几个 PR）；没写仓库时只在跑命令的 session 的范围里找：
 * ticket session 就是它的 ticket，epic 总控是它的 epic 里的 ticket（几个仓库都有这个号码就都重读，只是多读一次）。
 * 没写 PR（当前分支）或写的是分支名：ticket session 就是它的 ticket；总控按分支名在范围里找。认不出的不重读，等下一轮轮询。
 */
export function ticketsForPrCommands(seen: PrStateSeen, d: PrCommandDeps): string[] {
  const s = seen.sessionId ? d.session(seen.sessionId) : null;
  const own = seen.ticket ?? s?.ticketKey ?? null;
  // 号码、分支没写仓库时找的范围：null = 不限（Shipherd 总控，或认不出 session）。
  const scope: ReadonlySet<string> | null = own ? new Set([own]) : s?.featureId != null ? new Set(d.ticketsOfFeature(s.featureId)) : null;
  const inScope = (key: string) => scope === null || scope.has(key);
  const out = new Set<string>();
  for (const c of seen.commands) {
    const ref = c.pr?.trim().replace(/^#/, "") ?? null;
    if (ref && PR_URL.test(ref)) {
      for (const r of d.prsByUrl(ref)) out.add(r.ticketKey);
      continue;
    }
    if (ref && /^\d+$/.test(ref)) {
      const rows = d.prsByNumber(Number(ref)).filter((r) => (c.repo ? sameSlug(r.slug, c.repo) : true));
      // 没写仓库、也没有范围：认不准是哪个仓库的，不猜。
      const hit = !c.repo && scope === null ? [] : rows.filter((r) => inScope(r.ticketKey));
      for (const r of hit) out.add(r.ticketKey);
      // 还没收录的 PR（刚开的）：ticket session 照样重读自己的 ticket。
      if (hit.length === 0 && own) out.add(own);
      continue;
    }
    if (own) {
      out.add(own);
      continue;
    }
    if (ref && scope) {
      for (const key of scope) if (d.prsOfTicket(key).some((r) => r.headBranch === ref && (!c.repo || sameSlug(r.slug, c.repo)))) out.add(key);
    }
  }
  return [...out];
}
