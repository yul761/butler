import type { ClosePrErrorKind, ManualTicketStatus, TicketCloseSource, TicketStatus, UnclosablePrKind } from "../../shared/types";
import { prUrlKey } from "../../shared/pr-url";
import { effectiveStatus, RETRYABLE_CLOSE_PR_ERRORS } from "../../shared/types";
import type { FollowupsRepo } from "../db/followups-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { M } from "../strings";

/** 关 ticket 时要关的一个开着的 PR：gh 在 cwd 里跑，slug 是仓库（-R）。 */
export interface ClosablePr {
  url: string;
  number: number;
  slug: string | null;
  cwd: string;
}

/**
 * 关不了的 PR 为什么关不了（shared/types 的 UnclosablePrKind）。not_own_branch 包括 handoff 里写的同仓库别人的 PR、合并闸门看到的别的 PR。
 * 没关掉的（PrCloseErrorKind）还有 failed（gh 失败）和 skipped（对外动作开关关着，总控、路由发起的才看开关）。
 */
export type UnclosableKind = UnclosablePrKind;
export type PrCloseErrorKind = ClosePrErrorKind;

export interface PrCloseError {
  url: string;
  /** 给人看的原因（gh 的报错原文，或者按 kind 写的中英文说明）。 */
  error: string;
  kind: PrCloseErrorKind;
  /** shared：也挂着它的那个 ticket；shared_branch：也用过这个分支名的那个 ticket。 */
  ticket?: string;
}

/** 带 ticket 的关不了的原因：shared（PR 也挂在它上）、shared_branch（它也用过这个分支名）。 */
export type UnclosableWithTicket = "shared" | "shared_branch";

/**
 * 关不了的一个开着的 PR。unverified 是关之前核对 head 失败（gh 失败、超时，BTL-270 审查）：这次不关，可以重试，error 写着原因。
 */
export type UnclosablePr =
  | { url: string; number: number; kind: UnclosableKind; /** shared、shared_branch：牵涉到的那个 ticket。 */ ticket?: string; error?: undefined }
  | { url: string; number: number; kind: "unverified"; error: string; ticket?: undefined };

/** 这个 ticket 开着的 PR：能关的，和看着开着、但关不了的，后者照样报告。 */
export interface OpenPrs {
  closable: ClosablePr[];
  unclosable: UnclosablePr[];
}

/** classifyOpenPrs 要看的一行 PR（ticket_prs）。 */
export interface OpenPrRow {
  url: string;
  number: number;
  slug: string;
  repoId: number | null;
  headBranch: string | null;
  /** PR 的目标分支（读到过的话）。 */
  baseBranch?: string | null;
  state: "open" | "merged" | "closed";
  checkedAt: number;
}

/**
 * 关 ticket 时哪些开着的 PR 能关（BTL-270 审查）：读过的、没放弃的、在 ticket 自己仓库里的、head 分支是这个 ticket 自己的分支
 * （ticket 仓库的分支、session 推过的有归属的分支）、而且没挂在别的 ticket 上。其余报出来，写明为什么不关：
 * 不替别人关 PR、不往别人的 PR 上发公开评论。head 是公共分支（publicBranch：仓库的默认分支、main / master）或者就是 PR 的目标分支的，
 * 就算 ticket 记的分支也叫这个名字也不是它自己的（BTL-270 审查）。同一个仓库里别的 ticket 也用过这个分支名的（sharedBranch）单独报
 * shared_branch，写明是哪个 ticket。fork 上的同名分支由调用方关之前核对（verifyHeads）。
 */
export function classifyOpenPrs<R extends OpenPrRow>(rows: readonly R[], c: {
  givenUp(r: R): boolean;
  ownBranch(repoId: number, branch: string): boolean;
  /** 这个仓库的公共分支（默认分支等）：从这里开的 PR 不是哪个 ticket 自己的。 */
  publicBranch?(repoId: number, branch: string): boolean;
  /** 同一个仓库里也用过这个分支名的别的 ticket（没有是 null）。 */
  sharedBranch?(repoId: number, branch: string): string | null;
  sharedWith(r: R): string | null;
  ghDir(r: R): string;
}): OpenPrs {
  const closable: ClosablePr[] = [];
  const unclosable: UnclosablePr[] = [];
  for (const r of rows) {
    if (r.state !== "open") continue;
    const no = (kind: UnclosableKind, ticket?: string) => unclosable.push({ url: r.url, number: r.number, kind, ...(ticket && { ticket }) });
    if (r.checkedAt === 0) no("never_read");
    else if (c.givenUp(r)) no("given_up");
    else if (r.repoId === null) no("foreign");
    else if (
      r.headBranch === null || r.headBranch === (r.baseBranch ?? null) || (c.publicBranch?.(r.repoId, r.headBranch) ?? false) || !c.ownBranch(r.repoId, r.headBranch)
    ) no("not_own_branch");
    else {
      // 两个都成立时报 shared（更确定：这个 PR 本身就挂在那个 ticket 上），不再去看分支名。
      const other = c.sharedWith(r);
      const branchToo = other === null ? c.sharedBranch?.(r.repoId, r.headBranch) ?? null : null;
      if (other) no("shared", other);
      else if (branchToo) no("shared_branch", branchToo);
      else closable.push({ url: r.url, number: r.number, slug: r.slug, cwd: c.ghDir(r) });
    }
  }
  return { closable, unclosable };
}

/**
 * 马上重读一个 ticket 的 PR 时怎么读（BTL-270 审查）：用户发起的（关闭框、状态菜单）和 ticket 的 session 停下来才强制读放弃了的、认定不存在的；
 * 总控、路由发起的不强制（BTL-261：不然放弃等于没放弃）。在等决定（needs_decision）的 ticket 连关掉的也读一次：在 GitHub 网页上重开的 PR，
 * 平时不读关掉的行就永远看不到。关掉的行照样守 resting / read_gone_at（PrWatcher.pollPrs）。
 */
export function prRefreshOptions(status: TicketStatus | null, source: TicketCloseSource | "session"): { retryGivenUp: boolean; includeSettled: boolean } {
  return { retryGivenUp: source === "user" || source === "session", includeSettled: status === "needs_decision" };
}

/** 关闭框里列的（BTL-270 审查）：能关的逐个勾选，关不了的写明原因，用户确认了才关。 */
export interface ClosePreview {
  closable: { url: string; number: number }[];
  unclosable: PrCloseError[];
}

/** 关闭框打开时：这个 ticket 开着的 PR 里哪些能关、哪些不能（原因写成当前语言）。没有这个 ticket 时为 null。 */
export async function closePreview(d: Pick<TicketCloseDeps, "tickets" | "openPrs">, key: string): Promise<ClosePreview | null> {
  if (!d.tickets.get(key)) return null;
  const open = await d.openPrs(key);
  return { closable: open.closable.map((p) => ({ url: p.url, number: p.number })), unclosable: open.unclosable.map(unclosableError) };
}

/** 关不了的 PR 变成报告里的一条：原因按 kind 写成当前语言。 */
export const unclosableError = (u: UnclosablePr): PrCloseError =>
  u.kind === "unverified"
    ? { url: u.url, error: u.error, kind: "unverified" }
    : { url: u.url, error: M().ticketClosePrWhy(u.kind, u.ticket ?? null), kind: u.kind, ...(u.ticket && { ticket: u.ticket }) };

/** 点名能关的：能关的，和核对失败、再试可能成的（RETRYABLE_CLOSE_PR_ERRORS）。 */
const nameable = (open: OpenPrs): number => open.closable.length + open.unclosable.filter((u) => RETRYABLE_CLOSE_PR_ERRORS.includes(u.kind)).length;

/** ticket 的一个还在的 session（head）：终端开着（termId），或者休眠着。 */
export interface LiveSession {
  id: string;
  termId: string | null;
  hibernated: boolean;
}

export interface TicketCloseDeps {
  tickets: Pick<TicketsRepo, "get" | "close" | "setStatusManual">;
  followups: Pick<FollowupsRepo, "ignoreForClose" | "restoreAfterReopen">;
  transaction<T>(fn: () => T): T;
  /**
   * 这个 ticket 开着的 PR：能关的和关不了的（classifyOpenPrs）。要核对 gh（默认分支、head 在不在 fork 上），所以是异步的。
   * 给了 onlyPrs（prUrlKey）就只看、只核对点名的这些（BTL-270 审查）。
   */
  openPrs(key: string, onlyPrs?: ReadonlySet<string>): Promise<OpenPrs>;
  /** 关一个 PR：closed 关了；skipped 开关关着没跑（抛错是 gh 失败）。key 是审计里记的 ticket。 */
  closePr(pr: ClosablePr, reason: string, o: { key: string; source: TicketCloseSource }): Promise<"closed" | "skipped">;
  /** 这个 ticket 开着终端或休眠着的 session。 */
  liveSessions(key: string): LiveSession[];
  /**
   * 关终端（休眠着的不再唤醒），记成用户结束的。用户自己关的和点 × 一样直接关；总控、路由发起的和 end_session 一样，
   * 正在干活、屏幕上有等用户回答的确认不关（返回原因）。
   */
  endSession(s: LiveSession, source: TicketCloseSource): { ok: true } | { ok: false; error: string };
  /** followup 变了以后重算自动状态（rederiveTicketStatus）。 */
  rederive(key: string): void;
  /**
   * 马上重读这个 ticket 的 PR（prWatcher.soonTicket），不等下一轮轮询。source 不是 user 时不强制读放弃了的、认定不存在的 PR（BTL-261）；
   * ticket 在等决定（needs_decision）时连关掉的也重读一次，在 GitHub 上重开过的才看得到。
   */
  refreshPrs(key: string, source: TicketCloseSource): void;
  notify(): void;
  now(): number;
  log(msg: string, err?: unknown): void;
}

export interface CloseOptions {
  reason: string;
  source: TicketCloseSource;
  /** 顺便把 ticket 开着的、能关的 PR 关掉（gh pr close，评论里写原因）。 */
  closePrs?: boolean;
  /**
   * 只关这些（关闭框里勾了的、总控 pr_urls 点名的），结果里也只报这些（没点名的关不了的 PR，预览里已经写明了原因）。
   * 不给时：用户（关闭框）是能关的全部，关不了的全报；别的来源（总控、路由）一个都不关：有能点名的就先回一份清单（pick_prs），
   * ticket 也不关，让它点名再来；一个能点名的都没有就直接关 ticket，关不了的列进 prErrors（BTL-270 审查）。
   */
  prUrls?: string[];
  /** 顺便结束 ticket 的 session（开着的关终端、休眠着的不再唤醒）。 */
  endSessions?: boolean;
  /** 不结束的 session（发起关闭的那个自己）。 */
  except?: string | null;
}

export type CloseResult =
  | {
      ok: true; ticket: string; ignoredFollowups: number; closedPrs: string[]; prErrors: PrCloseError[]; endedSessions: string[];
      sessionErrors: { id: string; error: string }[];
      /** 关 PR 的时候有人重新打开了 ticket：后面的 PR 没关、session 没结束。 */
      reopenedMeanwhile: boolean;
      /** ticket 本来就关着：这次只关了剩下的 PR、结束了剩下的 session，关闭的时间、原因、来源不变。 */
      alreadyClosed?: true;
    }
  | { ok: false; error: "no_ticket" | "empty_reason" }
  /**
   * 已经关着，这次也没什么可做。checkedPrs：读过 PR、确实没有剩下能关的；false 是这次没要求关 PR（没读），剩下的 PR 不知道。
   */
  | { ok: false; error: "already_closed"; checkedPrs: boolean }
  /**
   * 不是用户、要关 PR 却没点名（prUrls）：什么都没做。closable 是能关的（点名用），prErrors 是关不了的（核对失败的 unverified 也能点名）。
   * alreadyClosed：ticket 本来就关着，这次是关剩下的 PR。
   */
  | { ok: false; error: "pick_prs"; ticket: string; closable: { url: string; number: number }[]; prErrors: PrCloseError[]; alreadyClosed: boolean };

export type ReopenResult = { ok: true; ticket: string; restoredFollowups: number; status: TicketStatus } | { ok: false; error: "no_ticket" | "not_closed" };

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * 关掉 ticket（BTL-270）：不做了，和 done（做完了）分开。手动状态写 closed，记下原因和来源；没做完的后续事项（open、snoozed）
 * 标成忽略、记下原来的状态（reopenTicket 还原）。要求了就关开着的 PR、结束 session：这两步失败不回滚关闭，结果里分项报告
 * （没关成的 PR、关不了的 PR、没结束的 session 都列出来）。关 PR 时等 gh，每一步之前核对 ticket 还关着，被重新打开了就停。
 * 最后马上重读 PR、通知界面刷新。
 */
export async function closeTicket(d: TicketCloseDeps, key: string, o: CloseOptions): Promise<CloseResult> {
  const reason = oneLine(o.reason);
  const t = d.tickets.get(key);
  if (!t) return { ok: false, error: "no_ticket" };
  if (!reason) return { ok: false, error: "empty_reason" };
  // 已经关着：不再关一次，第一次关的时间、原因、来源留着；要关 PR、结束 session 的，去关剩下的（BTL-270 审查）。
  // PR 评论：用户在关闭框里填了原因（打开框以后总控先关了），评论用用户填的；总控、路由再来一次用第一次关时的原因。
  if (t.statusManual === "closed") return closeRemaining(d, key, o.source === "user" ? reason : oneLine(t.closure?.reason ?? "") || reason, o);
  // 总控、路由要关 PR 必须点名：PR 的评论是公开发到 GitHub 的，不让它一句「全关」就关掉没看过的 PR。
  // ticket 也先不关：点名了再来一次时一起关。没有能点名的（全是关不了的）就不用再来一趟：直接关，就用这次读到的清单，不再去读一次 gh。
  let known: OpenPrs | undefined;
  if (o.closePrs && o.source !== "user" && o.prUrls === undefined) {
    known = await d.openPrs(key);
    if (nameable(known) > 0) return pickPrs(key, known, false);
    // 等 gh 的时候可能有人关了它：那就按关着的走（关剩下的）。
    if (d.tickets.get(key)?.statusManual === "closed") return closeTicket(d, key, o);
  }
  const ignoredFollowups = d.transaction(() => {
    d.tickets.close(key, { at: d.now(), reason, source: o.source });
    return d.followups.ignoreForClose(key, reason, o.source);
  });
  d.log(`ticket ${key} closed by ${o.source}: ${reason}`);
  d.notify();
  // 点名了的（关闭框里勾了的、pr_urls）才关、才报；没点名时关不了的照样全报出来（它们还开着，不当作关完了）。
  const r = await closeLeftovers(d, key, reason, { ...o, ...(o.prUrls && { onlyPrs: new Set(o.prUrls.map(prUrlKey)) }), ...(known && { known, noClose: true }) });
  return { ok: true, ticket: key, ignoredFollowups, ...r };
}

const pickPrs = (key: string, open: OpenPrs, alreadyClosed: boolean): CloseResult => ({
  ok: false, error: "pick_prs", ticket: key, closable: open.closable.map((p) => ({ url: p.url, number: p.number })), prErrors: open.unclosable.map(unclosableError), alreadyClosed,
});

/**
 * 已经关着的 ticket 再要关 PR、结束 session（BTL-270 审查）：只对剩下的、开着的本 ticket PR 走 closeLeftovers，核对和第一次关一样；
 * 总控、路由没点名（prUrls）就回 pick_prs。没点名、也没有能关的 PR（能关的和核对失败、可以再试的都没有）、也不结束 session 时回 already_closed；
 * 点名了的照样回 ok，关不了的（not_own_branch、shared_branch 这些）和第一次关时一样写在 prErrors 里。
 * 读 PR 要等 gh：等完重新看一眼，被重新打开了就什么都不做，按 reopenedMeanwhile 回。
 * 用户（关闭框）打开框以后别人先关了、这次什么都没勾：不算出错，回一个什么都没做的 ok（alreadyClosed），界面提示刚被关了、没有要再做的。
 */
async function closeRemaining(d: TicketCloseDeps, key: string, reason: string, o: CloseOptions): Promise<CloseResult> {
  if (!o.closePrs && !o.endSessions) {
    if (o.source === "user") return { ok: true, ticket: key, ignoredFollowups: 0, closedPrs: [], prErrors: [], endedSessions: [], sessionErrors: [], reopenedMeanwhile: false, alreadyClosed: true };
    return { ok: false, error: "already_closed", checkedPrs: false };
  }
  const onlyPrs = o.prUrls && new Set(o.prUrls.map(prUrlKey));
  const unnamed = o.source !== "user" && o.prUrls === undefined;
  let known: OpenPrs | undefined;
  if (o.closePrs) {
    known = await d.openPrs(key, onlyPrs);
    const now = d.tickets.get(key);
    if (!now) return { ok: false, error: "no_ticket" };
    if (now.statusManual !== "closed") {
      d.log(`ticket ${key}: reopened while reading its PRs; closed nothing`);
      return { ok: true, ticket: key, ignoredFollowups: 0, closedPrs: [], prErrors: [], endedSessions: [], sessionErrors: [], reopenedMeanwhile: true, alreadyClosed: true };
    }
    const left = nameable(known);
    if (unnamed && left > 0) return pickPrs(key, known, true);
    if (o.prUrls === undefined && left === 0 && !o.endSessions) return { ok: false, error: "already_closed", checkedPrs: true };
  }
  const r = await closeLeftovers(d, key, reason, { ...o, ...(onlyPrs && { onlyPrs }), ...(known && { known, noClose: unnamed }) });
  return { ok: true, ticket: key, ignoredFollowups: 0, ...r, alreadyClosed: true };
}

export interface RetryCloseOptions {
  source: TicketCloseSource;
  /** 再试着关的 PR（上次没关成的链接）；空就不关 PR。 */
  prUrls: string[];
  /** 再试着结束的 session（上次没结束的 id）；空就不结束 session。 */
  sessionIds: string[];
}

export type RetryCloseResult =
  | { ok: true; ticket: string; closedPrs: string[]; prErrors: PrCloseError[]; endedSessions: string[]; sessionErrors: { id: string; error: string }[]; reopenedMeanwhile: boolean }
  | { ok: false; error: "no_ticket" | "not_closed" };

/**
 * 关闭以后重试剩下的（BTL-270）：上次没关成的 PR、没结束的 session 再试一次，只试给的这些，评论里写关闭时记下的原因。
 * ticket 已经不是关着的（重新打开了）就不做。已经不开着的 PR、已经结束的 session 不再出现在结果里。
 */
export async function retryClose(d: TicketCloseDeps, key: string, o: RetryCloseOptions): Promise<RetryCloseResult> {
  const t = d.tickets.get(key);
  if (!t) return { ok: false, error: "no_ticket" };
  if (t.statusManual !== "closed") return { ok: false, error: "not_closed" };
  const reason = oneLine(t.closure?.reason ?? "");
  const r = await closeLeftovers(d, key, reason, {
    source: o.source, closePrs: o.prUrls.length > 0, endSessions: o.sessionIds.length > 0,
    onlyPrs: new Set(o.prUrls.map(prUrlKey)), onlySessions: new Set(o.sessionIds),
  });
  return { ok: true, ticket: key, ...r };
}

interface LeftoverOptions {
  source: TicketCloseSource;
  closePrs?: boolean;
  endSessions?: boolean;
  except?: string | null;
  /** 只处理这些 PR / session（重试时）；不给就是全部。 */
  onlyPrs?: ReadonlySet<string>;
  onlySessions?: ReadonlySet<string>;
  /** 已经读到的开着的 PR（closeTicket 刚读过），给了就不再读。 */
  known?: OpenPrs;
  /** 一个都不关，只报关不了的（总控没点名、也没有能点名的）。 */
  noClose?: boolean;
}

/** 关 PR、结束 session（closeTicket 和 retryClose 共用）：失败不抛，分项报告；每一步之前核对 ticket 还关着。 */
async function closeLeftovers(d: TicketCloseDeps, key: string, reason: string, o: LeftoverOptions) {
  const closedPrs: string[] = [];
  const prErrors: PrCloseError[] = [];
  // 关 PR 要等 gh：每一步之前重新看一眼，等的时候有人重新打开了就停下，不去关一个又开着的 ticket 的 PR、结束它的 session。
  const stillClosed = () => d.tickets.get(key)?.statusManual === "closed";
  let reopenedMeanwhile = false;
  if (o.closePrs) {
    const open = o.known ?? (await d.openPrs(key, o.onlyPrs));
    const wanted = (url: string) => !o.onlyPrs || o.onlyPrs.has(prUrlKey(url));
    for (const u of open.unclosable) if (wanted(u.url)) prErrors.push(unclosableError(u));
    for (const pr of o.noClose ? [] : open.closable) {
      if (!wanted(pr.url)) continue;
      if (!stillClosed()) {
        reopenedMeanwhile = true;
        break;
      }
      try {
        if ((await d.closePr(pr, reason, { key, source: o.source })) === "closed") closedPrs.push(pr.url);
        else prErrors.push({ url: pr.url, error: M().ticketClosePrSkipped, kind: "skipped" });
      } catch (e) {
        prErrors.push({ url: pr.url, error: e instanceof Error ? e.message : String(e), kind: "failed" });
        d.log(`ticket ${key}: closing ${pr.url} failed`, e);
      }
    }
  }
  const endedSessions: string[] = [];
  const sessionErrors: { id: string; error: string }[] = [];
  if (o.endSessions && !reopenedMeanwhile && stillClosed()) {
    for (const s of d.liveSessions(key)) {
      if (s.id === o.except || (o.onlySessions && !o.onlySessions.has(s.id))) continue;
      try {
        const r = d.endSession(s, o.source);
        if (r.ok) endedSessions.push(s.id);
        else sessionErrors.push({ id: s.id, error: r.error });
      } catch (e) {
        sessionErrors.push({ id: s.id, error: e instanceof Error ? e.message : String(e) });
        d.log(`ticket ${key}: ending session ${s.id} failed`, e);
      }
    }
  } else if (o.endSessions) reopenedMeanwhile = true;
  if (reopenedMeanwhile) d.log(`ticket ${key}: reopened while closing; stopped closing PRs and ending sessions`);
  // 重新打开的那一路已经重算过状态了，这里不再用关着时的结果覆盖。
  if (!reopenedMeanwhile) d.rederive(key);
  d.refreshPrs(key, o.source);
  d.notify();
  return { closedPrs, prErrors, endedSessions, sessionErrors, reopenedMeanwhile };
}

/** 撤销关闭：回到自动状态，关闭时忽略的后续事项（之后没人动过的）还原。关掉的 PR、结束的 session 不会自己回来。 */
export function reopenTicket(d: TicketCloseDeps, key: string, source: TicketCloseSource): ReopenResult {
  const t = d.tickets.get(key);
  if (!t) return { ok: false, error: "no_ticket" };
  if (t.statusManual !== "closed") return { ok: false, error: "not_closed" };
  const restoredFollowups = d.transaction(() => {
    d.tickets.setStatusManual(key, null);
    return d.followups.restoreAfterReopen(key);
  });
  d.log(`ticket ${key} reopened by ${source}`);
  d.rederive(key);
  d.refreshPrs(key, source);
  d.notify();
  const after = d.tickets.get(key);
  return { ok: true, ticket: key, restoredFollowups, status: after ? effectiveStatus(after) : t.status };
}

export type SetStatusResult = { ok: true; ticket: string; status: TicketStatus; reopened: boolean } | { ok: false; error: "no_ticket" };

/**
 * 手动设状态（closed 以外；null 是清掉手动状态、回到自动）：界面的状态下拉框和总控的 set_ticket_status 共用。
 * 关着的先撤销关闭（reopenTicket：后续事项还原），再设；只是撤销关闭时（null）不再多写一次。
 */
export function setTicketStatus(d: TicketCloseDeps, key: string, status: Exclude<ManualTicketStatus, "closed"> | null, source: TicketCloseSource): SetStatusResult {
  const t = d.tickets.get(key);
  if (!t) return { ok: false, error: "no_ticket" };
  const reopened = t.statusManual === "closed";
  if (reopened) reopenTicket(d, key, source);
  if (status !== null || !reopened) d.tickets.setStatusManual(key, status, d.now());
  d.notify();
  const after = d.tickets.get(key);
  return { ok: true, ticket: key, status: after ? effectiveStatus(after) : t.status, reopened };
}
