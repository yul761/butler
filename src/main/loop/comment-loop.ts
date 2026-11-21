import type { CommentItem, CommentItemsRepo } from "../db/comment-items-repo";
import type { TicketPr, TicketPrsRepo } from "../db/ticket-prs-repo";
import type { ExternalActions } from "../external/actions";
import type { Recipient } from "../prwatch/ci-delivery";
import type { Mailbox } from "../mailbox/mailbox";
import type { SessionMessage } from "../db/session-messages-repo";
import type { PrStatus } from "../tickets/gh";
import type { GhWrite, ReviewThread } from "../tickets/gh-loop";
import { sanitizeTask } from "../../shared/control";
import type { CommentAction, CommentCategory, CommentItemView, CommentsWaiting, CommentVerified, PrCommentsView } from "../../shared/loop";
import type { AttributionMode, LoopPolicy } from "../../shared/loop-policy";
import { M } from "../strings";
import { candidates, classifyCommentByRule, type Candidate } from "./comment-rules";
import { COMMENT_MODEL_BATCH, type CommentModelItem, type CommentVerdicts } from "./comment-model";
import { safeRecord, type RecordEvent } from "./metrics";
import { commentView } from "../db/comment-items-repo";

/**
 * 评论闭环（工作流 I，设计补充第 2 节）：PrWatcher 读完一个开着的 PR 调 observe；拉 review thread、分类、按归属策略排队，
 * 递送排进 session 的信箱（BTL-245：在忙的下一次工具调用时读到，停着的直接输入），push 以后核对位置、回复、resolve（对外动作开关管着）。
 */

export const COMMENT_GH_TIMEOUT_MS = 30_000;
/** 送进 session 的每条原文截到这么长。 */
export const COMMENT_DELIVERY_BODY_CHARS = 800;
/** 该送的评论这么久还没送出去：「现在」页提醒。 */
export const COMMENT_UNDELIVERED_MS = 30 * 60_000;
/** 行号前后这么多行内有改动就算改到了。 */
export const COMMENT_LINE_SLACK = 3;
/** 连续这么多次 push 位置都没变：交给你判断。 */
export const COMMENT_UNCHANGED_MAX = 2;
/** compare 失败后多久再试。 */
const COMPARE_RETRY_MS = 5 * 60_000;

export interface CommentLoopDeps {
  items: CommentItemsRepo;
  prs: Pick<TicketPrsRepo, "get" | "byTicket" | "byUrl">;
  /** 栈式 PR（工作流 K）：这个 PR 是栈的一层时补一段话，追加在送进 session 的正文后面；不是就返回 null。 */
  stackNote?(row: TicketPr): string | null;
  policy(slug: string | null): LoopPolicy;
  /** PR 行在哪个目录跑 gh（用户在界面上点「再回复一次」时用；observe 时用 PrWatcher 给的）。 */
  cwdOf(pr: TicketPr): string | null;
  gh: {
    reviewThreads(cwd: string, number: number, timeoutMs: number, repo?: string | null): Promise<ReviewThread[] | null>;
    compareFiles(cwd: string, base: string, head: string, timeoutMs: number, repo?: string | null): Promise<{ filename: string; patch: string }[] | null>;
    replyToReviewComment(cwd: string, number: number, commentId: number, body: string, timeoutMs: number, repo?: string | null): Promise<GhWrite>;
    commentOnPr(cwd: string, number: number, body: string, timeoutMs: number, repo?: string | null): Promise<GhWrite>;
    resolveReviewThread(cwd: string, threadId: string, timeoutMs: number, repo?: string | null): Promise<GhWrite>;
  };
  /** 后台模型（comment_classify）；失败返回 null。 */
  model(cwd: string, items: CommentModelItem[]): Promise<CommentVerdicts | null>;
  external: Pick<ExternalActions, "attempt">;
  recipient(ticketKey: string, repoId: number, branch: string): Recipient;
  /** 信箱（BTL-245）：每个 PR 一条（ref comments:<prId>），评论多了就替换还在排队的那条；送到后在 on("comments") 里把评论项标成 delivered。 */
  mailbox: Pick<Mailbox, "send" | "on" | "queuedByRef" | "withdraw" | "queuedRefs">;
  recordEvent: RecordEvent;
  /** 评论项变了（界面刷新）。 */
  changed(): void;
  /** 一个 session 现在的 head（沿 replaced_by 走到底）；不认识为 null。比较「递给了谁」用。 */
  headOf(id: string): string | null;
  now(): number;
  log(msg: string, err?: unknown): void;
}

const short = (sha: string | null): string => (sha ?? "").slice(0, 7);
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** compare 里一个文件的 patch：旧侧、新侧被改动的行范围（每个 hunk 一段）。 */
export function patchRanges(patch: string): { old: [number, number][]; new: [number, number][] } {
  const out = { old: [] as [number, number][], new: [] as [number, number][] };
  for (const m of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const range = (start: string, len: string | undefined): [number, number] => {
      const a = Number(start);
      const n = len === undefined ? 1 : Number(len);
      return [a, a + Math.max(n, 1) - 1];
    };
    out.old.push(range(m[1], m[2]));
    out.new.push(range(m[3], m[4]));
  }
  return out;
}

/** 评论的那一行（送达时的行号，或者 thread 现在的行号）附近有改动。 */
export function touches(patch: string, oldLine: number | null, newLine: number | null): boolean {
  const r = patchRanges(patch);
  const near = (ranges: [number, number][], line: number | null): boolean =>
    line !== null && ranges.some(([a, b]) => a <= line + COMMENT_LINE_SLACK && b >= line - COMMENT_LINE_SLACK);
  return near(r.old, oldLine) || near(r.new, newLine);
}

/** 自动回复的固定措辞（语言跟 comments.replyLanguage，不跟界面）。 */
export function replyText(lang: "en" | "zh", sha: string, quote: string | null): string {
  const q = quote ? `> ${cut(quote.split("\n")[0].trim(), 200)}\n\n` : "";
  return lang === "zh" ? `${q}已在 ${sha} 中修改。\n\n<sub>（Butler 自动回复）</sub>` : `${q}Addressed in ${sha}.\n\n<sub>(automated reply from Butler)</sub>`;
}

type Where = { cwd: string; slug: string | null };

/** 「发给 agent」一键送出的：等你看的和该送还没送的。 */
const SENDABLE: readonly CommentItem["state"][] = ["review", "pending"];

/** 几个 ticket 链接同一个 PR 时，评论项记在 id 最小的那一行上。 */
const primaryRow = (rows: TicketPr[]): TicketPr => rows.reduce((a, b) => (b.id < a.id ? b : a));

export class CommentLoop {
  /** 每个 PR URL 上一次拉 thread 时的样子（review id、PR 评论 id、head sha）：没变就不再拉。 */
  private readonly lastSig = new Map<string, string>();
  private readonly inflight = new Set<string>();
  /** 每个 PR 行最近一次 observe 的 cwd（用户点「再回复一次」时用）。 */
  private readonly whereOf = new Map<number, Where>();
  private readonly compareFailedAt = new Map<string, number>();
  /** 正在回复的项：「再回复一次」连点两下不会发两条。 */
  private readonly replying = new Set<number>();

  constructor(private readonly d: CommentLoopDeps) {
    d.mailbox.on("comments", (m) => this.commentsDelivered(m));
  }

  /** PrWatcher 读完一个 PR：rows 是所有 ticket 对这个 URL 的行（已经更新过）。不抛错。 */
  async observe(rows: TicketPr[], pr: PrStatus, where: Where): Promise<void> {
    const url = rows[0]?.url;
    if (!url || this.inflight.has(url)) return;
    this.inflight.add(url);
    try {
      await this.observeInner(url, rows, pr, where);
    } catch (e) {
      this.d.log(`comment loop: ${url} failed`, e);
    } finally {
      this.inflight.delete(url);
    }
  }

  private async observeInner(url: string, rows: TicketPr[], pr: PrStatus, where: Where): Promise<void> {
    if (pr.state !== "OPEN") {
      let closed = 0;
      for (const r of rows) closed += this.d.items.closePr(r.id, this.d.now());
      this.lastSig.delete(url);
      if (closed > 0) this.d.changed();
      return;
    }
    const policy = this.d.policy(where.slug);
    if (!policy["comments.enabled"]) return;
    for (const r of rows) this.whereOf.set(r.id, where);
    const sig = [pr.headSha, pr.reviews.map((r) => `${r.id}:${r.state}`).sort().join(","), pr.comments.map((c) => c.id).sort().join(",")].join("|");
    const waiting = [primaryRow(rows)].some((r) => this.d.items.byPr(r.id).some((i) => i.state === "pending" || (i.state === "delivered" && i.deliveredSha !== pr.headSha && i.checkedSha !== pr.headSha)));
    if (this.lastSig.get(url) === sig && !waiting) return;
    const threads = await this.d.gh.reviewThreads(where.cwd, pr.number, COMMENT_GH_TIMEOUT_MS, where.slug);
    if (!threads) {
      this.d.log(`comment loop: reading the review threads of ${url} failed`);
      return;
    }
    this.lastSig.set(url, sig);
    const cands = candidates({ author: pr.author, reviews: pr.reviews, comments: pr.comments }, threads);
    // 几个 ticket 链接同一个 PR：评论只记在 id 最小的那一行上（只分类、回复、resolve 一次），送给能送到的那个 session。
    const primary = primaryRow(rows);
    let changed = false;
    if (await this.classifyRow(primary, pr, cands, policy, where)) changed = true;
    if (await this.verifyRow(primary, pr, threads, policy, where)) changed = true;
    if (changed) this.d.changed();
    await this.flush();
  }

  private modeOf(who: string, policy: LoopPolicy): AttributionMode {
    return who === "copilot" ? policy["comments.copilot"] : policy["comments.human"];
  }

  /** 新评论建项、分类、按策略排队。返回有没有变化。 */
  private async classifyRow(row: TicketPr, pr: PrStatus, cands: Candidate[], policy: LoopPolicy, where: Where): Promise<boolean> {
    const now = this.d.now();
    let changed = false;
    const toModel: { item: CommentItem; cand: Candidate }[] = [];
    for (const c of cands) {
      const rule = classifyCommentByRule(c, policy["comments.ignorePatterns"]);
      const existing = this.d.items.byKey(row.id, c.key);
      if (rule?.skip) {
        // 在别处 resolve 了：还没处理完的项收起来。
        if (existing && rule.reason === "resolved" && ["pending", "review", "queued"].includes(existing.state)) {
          this.d.items.update(existing.id, { state: "closed" }, now);
          changed = true;
        }
        continue;
      }
      if (!existing && this.modeOf(c.who, policy) === "off") continue;
      const { item, created } = this.d.items.seen({
        prId: row.id, key: c.key, kind: c.kind, threadId: c.threadId, databaseId: c.databaseId, author: c.author, who: c.who, path: c.path, line: c.line,
        body: c.body, url: c.url, commentedAt: c.commentedAt, seenSha: pr.headSha,
      }, now);
      if (created) changed = true;
      if (item.state !== "pending") continue;
      if (rule) {
        this.route(item, rule.category, "rule", rule.reason, policy, now);
        changed = true;
      } else if (!policy["comments.useModel"]) {
        this.route(item, "human", "rule", "no_model", policy, now);
        changed = true;
      } else {
        toModel.push({ item, cand: c });
      }
    }
    // 还没分类、评论却已经不在了（删掉了）：收起来，不然 observe 会一直当成「有事要做」每轮都拉 thread。
    const keys = new Set(cands.map((c) => c.key));
    for (const i of this.d.items.byPr(row.id)) {
      if (i.state === "pending" && !keys.has(i.key)) {
        this.d.items.update(i.id, { state: "closed", reason: "gone" }, now);
        changed = true;
      }
    }
    if (toModel.length > 0) {
      const batch = toModel.slice(0, COMMENT_MODEL_BATCH);
      const verdicts = await this.d.model(where.cwd, batch.map(({ item, cand }) => ({ id: String(item.id), who: item.who, path: item.path, line: item.line, body: item.body, followUps: cand.followUps })));
      const at = this.d.now();
      for (const { item: before } of batch) {
        // 模型要跑一会儿：这期间你在「评论」标签里改了分类或者忽略了，以你的为准。
        const item = this.d.items.get(before.id);
        if (!item || item.state !== "pending") continue;
        const v = verdicts?.get(String(item.id));
        if (v) this.route(item, v.category, "model", v.reason, policy, at);
        else this.route(item, "human", "model", "model_failed", policy, at);
      }
      changed = true;
      // 超过一批的留着 pending，下一次读到这个 PR 再分（observe 看到有 pending 会再拉）。
    }
    return changed;
  }

  /** 分好类以后去哪：ignore 收起来，fix（和设成 session 的 question）按归属策略 auto 排队、review 等你看，human 一律等你看。 */
  private route(item: CommentItem, category: CommentCategory, source: "rule" | "model", reason: string, policy: LoopPolicy, now: number): void {
    const auto = this.modeOf(item.who, policy) === "auto";
    const sendable = category === "fix" || (category === "question" && policy["comments.questions"] === "session");
    const state = category === "ignore" ? "ignored" : sendable && auto ? "queued" : "review";
    this.d.items.update(item.id, { category, source, reason, state, queuedAt: state === "queued" ? now : null }, now);
  }

  /** push 以后核对已经送进 session 的项。返回有没有变化。 */
  private async verifyRow(row: TicketPr, pr: PrStatus, threads: ReviewThread[], policy: LoopPolicy, where: Where): Promise<boolean> {
    const due = this.d.items.byPr(row.id).filter((i) => i.state === "delivered" && i.deliveredSha !== null && i.deliveredSha !== pr.headSha && i.checkedSha !== pr.headSha);
    if (due.length === 0) return false;
    const byThread = new Map(threads.map((t) => [t.id, t]));
    const compares = new Map<string, { filename: string; patch: string }[] | null>();
    const compare = async (base: string): Promise<{ filename: string; patch: string }[] | null> => {
      if (compares.has(base)) return compares.get(base)!;
      const key = `${where.slug ?? where.cwd}:${base}...${pr.headSha}`;
      const failedAt = this.compareFailedAt.get(key);
      if (failedAt !== undefined && this.d.now() - failedAt < COMPARE_RETRY_MS) return null;
      const files = await this.d.gh.compareFiles(where.cwd, base, pr.headSha, COMMENT_GH_TIMEOUT_MS, where.slug);
      if (!files) this.compareFailedAt.set(key, this.d.now());
      compares.set(base, files);
      return files;
    };
    let changed = false;
    for (const item of due) {
      const now = this.d.now();
      let verified: CommentVerified | null = null;
      if (item.kind !== "inline") {
        verified = "commit";
      } else {
        const t = item.threadId ? byThread.get(item.threadId) : undefined;
        if (t?.isResolved) {
          this.d.items.update(item.id, { state: "closed", checkedSha: pr.headSha }, now);
          changed = true;
          continue;
        }
        if (!t || t.isOutdated) verified = "outdated";
        else {
          const files = await compare(item.deliveredSha!);
          if (!files) continue;
          const f = files.find((x) => x.filename === item.path);
          if (f && touches(f.patch, item.line, t.line)) verified = "patch";
        }
      }
      changed = true;
      if (!verified) {
        const unchanged = item.unchanged + 1;
        if (unchanged >= COMMENT_UNCHANGED_MAX) this.d.items.update(item.id, { state: "review", category: "human", reason: "unchanged_twice", unchanged, checkedSha: pr.headSha }, now);
        else this.d.items.update(item.id, { unchanged, checkedSha: pr.headSha }, now);
        continue;
      }
      this.d.items.update(item.id, { state: "addressed", verified, addressedAt: now, addressedSha: pr.headSha, checkedSha: pr.headSha }, now);
      safeRecord(this.d.recordEvent, "comment_auto_handled", {
        prId: row.id, ticketKey: row.ticketKey, repoSlug: where.slug, sessionId: item.deliveredSession, dedupeKey: `comment:${row.id}:${item.key}`,
        data: { who: item.who, category: item.category, source: item.source, verified },
      }, this.d.log);
      await this.reply(this.d.items.get(item.id)!, row, pr.headSha, policy, where);
    }
    return changed;
  }

  /** 回复（和行内评论的 resolve）。都过对外动作开关；失败只记，不重试。 */
  private async reply(item: CommentItem, row: TicketPr, sha: string, policy: LoopPolicy, where: Where): Promise<void> {
    if (this.replying.has(item.id)) return;
    this.replying.add(item.id);
    try {
      await this.replyInner(item, row, sha, policy, where);
    } finally {
      this.replying.delete(item.id);
    }
  }

  private async replyInner(item: CommentItem, row: TicketPr, sha: string, policy: LoopPolicy, where: Where): Promise<void> {
    const scope = { repoSlug: where.slug ?? undefined, ticketKey: row.ticketKey };
    const place = item.path ? `${item.path}${item.line !== null ? `:${item.line}` : ""}` : item.kind;
    let replied = !policy["comments.reply"];
    if (policy["comments.reply"]) {
      const inline = item.kind === "inline" && item.databaseId !== null;
      const text = replyText(policy["comments.replyLanguage"], short(sha), inline ? null : item.body);
      try {
        const r = await this.d.external.attempt("comment_reply", {
          scope, target: item.url ?? row.url, summary: `reply to the ${item.who} comment on ${row.url} (${place})`.slice(0, 300), payload: text,
        }, async () => {
          const out = inline
            ? await this.d.gh.replyToReviewComment(where.cwd, row.number, item.databaseId!, text, COMMENT_GH_TIMEOUT_MS, where.slug)
            : await this.d.gh.commentOnPr(where.cwd, row.number, text, COMMENT_GH_TIMEOUT_MS, where.slug);
          if (!out.ok) throw new Error(out.error);
          return out;
        });
        if (r.ran) {
          this.d.items.update(item.id, { repliedAt: this.d.now(), replyError: null }, this.d.now());
          replied = true;
        } else {
          // 开关关着：记了 skipped（payload 是本来要发的话），resolve 照样按它自己的开关。
          replied = true;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.d.log(`comment loop: replying to ${item.key} on ${row.url} failed`, e);
        this.d.items.update(item.id, { replyError: msg.slice(0, 300) }, this.d.now());
      }
    }
    if (!replied || item.kind !== "inline" || !item.threadId || !policy["comments.resolve"]) return;
    try {
      const r = await this.d.external.attempt("comment_resolve", {
        scope, target: item.url ?? row.url, summary: `resolve the ${item.who} review thread on ${row.url} (${place})`.slice(0, 300), payload: item.threadId,
      }, async () => {
        const out = await this.d.gh.resolveReviewThread(where.cwd, item.threadId!, COMMENT_GH_TIMEOUT_MS, where.slug);
        if (!out.ok) throw new Error(out.error);
      });
      if (r.ran) this.d.items.update(item.id, { resolvedAt: this.d.now() }, this.d.now());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.d.log(`comment loop: resolving ${item.key} on ${row.url} failed`, e);
      this.d.items.update(item.id, { replyError: msg.slice(0, 300) }, this.d.now());
    }
  }

  /** 把排着队的评论送进 session：每个 PR 一条消息。PrWatcher 每轮结束、session 停下来、分类完都调。 */
  async flush(): Promise<void> {
    const byPr = new Map<number, CommentItem[]>();
    for (const i of this.d.items.withState(["queued"])) (byPr.get(i.prId) ?? byPr.set(i.prId, []).get(i.prId)!).push(i);
    // 信箱里还排着、这边却已经一条都不用送的 PR：撤回。
    for (const ref of this.d.mailbox.queuedRefs("comments")) if (!byPr.has(Number(ref.slice("comments:".length)))) this.d.mailbox.withdraw(ref);
    for (const [prId, items] of byPr) {
      try {
        await this.deliverPr(prId, items);
      } catch (e) {
        this.d.log(`comment loop: delivering the comments of pr ${prId} failed`, e);
      }
    }
  }

  private deliverPr(prId: number, queued: CommentItem[]): Promise<"queued" | string> {
    const ref = `comments:${prId}`;
    const row = this.d.prs.get(prId);
    if (!row || row.state !== "open" || row.repoId === null || row.headBranch === null || row.headSha === null) {
      this.d.mailbox.withdraw(ref);
      return Promise.resolve("not_open");
    }
    const policy = this.d.policy(row.slug);
    if (!policy["comments.enabled"]) return Promise.resolve("disabled");
    // 收件的 session：先找这一行的 ticket，没有就找链接同一个 PR 的其他 ticket。
    let to = this.d.recipient(row.ticketKey, row.repoId, row.headBranch);
    for (const other of this.d.prs.byUrl(row.url)) {
      if (to.ok) break;
      if (other.id === row.id || other.state !== "open" || other.repoId === null || other.headBranch === null) continue;
      const alt = this.d.recipient(other.ticketKey, other.repoId, other.headBranch);
      if (alt.ok) to = alt;
    }
    if (!to.ok) return Promise.resolve(to.reason);
    // 你可能刚忽略了：按库里现在的状态再挑一遍。
    const items = queued.map((i) => this.d.items.get(i.id)).filter((i): i is CommentItem => i !== null && i.state === "queued").slice(0, policy["comments.maxPerDelivery"]);
    if (items.length === 0) {
      this.d.mailbox.withdraw(ref);
      return Promise.resolve("nothing");
    }
    const m = M();
    const lines = items.map((i) => ({
      where: i.path ? `${i.path}${i.line !== null ? `:${i.line}` : ""}` : m.commentWholePr,
      who: i.who === "copilot" ? m.commentWhoCopilot : m.commentWhoHuman,
      body: cut(i.body.trim(), COMMENT_DELIVERY_BODY_CHARS),
      question: i.category === "question",
    }));
    const counts = { copilot: items.filter((i) => i.who === "copilot").length, human: items.filter((i) => i.who !== "copilot").length };
    const note = this.d.stackNote?.(row) ?? null;
    const body = sanitizeTask(m.commentDelivery(m.ciWherePr(row.number), lines, counts) + (note ? `\n\n${note}` : ""));
    const old = this.d.mailbox.queuedByRef(ref);
    // 和排着的那条一样（每轮 PrWatcher 都调）：不动它。
    if (old && old.body === body && this.d.headOf(old.toSession) === this.d.headOf(to.sessionId)) return Promise.resolve("queued");
    this.d.mailbox.send({ kind: "comments", from: null, to: to.sessionId, featureId: null, body, ref, meta: { items: items.map((i) => i.id), sha: row.headSha, via: to.via } });
    return Promise.resolve("queued");
  }

  /** 信箱把一个 PR 的评论送到了：还在排队的那几条记成 delivered（送到时的 head sha、送给了谁）。 */
  private commentsDelivered(msg: SessionMessage): void {
    const meta = msg.meta as { items?: unknown; sha?: unknown; via?: unknown } | null;
    const ids = Array.isArray(meta?.items) ? meta.items.filter((x): x is number => typeof x === "number") : [];
    const sha = typeof meta?.sha === "string" ? meta.sha : null;
    const now = this.d.now();
    let n = 0;
    for (const id of ids) {
      if (this.d.items.get(id)?.state !== "queued") continue;
      this.d.items.update(id, { state: "delivered", deliveredAt: now, deliveredSha: sha, deliveredSession: msg.toSession, unchanged: 0, checkedSha: null }, now);
      n++;
    }
    this.d.log(`comment loop: sent ${n} comment(s) (${msg.ref}) to ${msg.toSession} (${String(meta?.via ?? "")}, ${msg.via})`);
    this.d.changed();
  }

  /** 工作流 K：这个 PR（按记评论项的那一行）还有送进 session、还没核对的评论。K 等它变成 false 再 autosquash。 */
  awaitingCheck(prId: number): boolean {
    const row = this.d.prs.get(prId);
    if (!row) return false;
    const primary = primaryRow(this.d.prs.byUrl(row.url).concat(row));
    return this.d.items.byPr(primary.id).some((i) => i.state === "delivered");
  }

  /** 「送进 session」：把一条改成 queued（act 的 send 和 sendAll 共用）。状态不在 from 里不改，返回 false。 */
  private queueForSend(item: CommentItem, from: readonly CommentItem["state"][], now: number): boolean {
    if (!from.includes(item.state)) return false;
    this.d.items.update(item.id, { state: "queued", queuedAt: now, category: item.category ?? "fix", source: item.category ? item.source : "user" }, now);
    return true;
  }

  /** 记评论项的那一行的 id（几个 ticket 链接同一个 PR 时取 id 最小的，和 list() 一致）；行不在为 null。 */
  private primaryId(prId: number): number | null {
    const row = this.d.prs.get(prId);
    if (!row) return null;
    return primaryRow(this.d.prs.byUrl(row.url).filter((x) => x.state === row.state).concat(row)).id;
  }

  /** UI 重做第 1 层：这个 PR 已经送进 session（head 是 sessionId 的）的评论里，最晚的送达时间；没有为 null。 */
  deliveredAt(prId: number, sessionId: string): number | null {
    const id = this.primaryId(prId);
    if (id === null) return null;
    let best: number | null = null;
    for (const i of this.d.items.byPr(id)) {
      if (i.state !== "delivered" || i.deliveredAt === null || i.deliveredSession === null) continue;
      if (this.d.headOf(i.deliveredSession) !== sessionId) continue;
      if (best === null || i.deliveredAt > best) best = i.deliveredAt;
    }
    return best;
  }

  /** 有没有可以一键送出的评论：state 是 review 或 pending。 */
  sendable(prId: number): boolean {
    const id = this.primaryId(prId);
    return id !== null && this.enabled(id) && this.d.items.byPr(id).some((i) => SENDABLE.includes(i.state));
  }

  /** 这个 PR 的仓库开着 comments.enabled：关着时 deliverPr 什么都不递，一键送出也就不能算数。 */
  private enabled(prId: number): boolean {
    const row = this.d.prs.get(prId);
    return !!row && this.d.policy(row.slug)["comments.enabled"];
  }

  /** 首页「发给 agent」：review / pending 的条目都按 send 的规则改成 queued，再 flush 一次；返回排上的条数。 */
  async sendAll(prId: number): Promise<number> {
    const id = this.primaryId(prId);
    if (id === null || !this.enabled(id)) return 0;
    const now = this.d.now();
    let n = 0;
    for (const i of this.d.items.byPr(id)) if (this.queueForSend(i, SENDABLE, now)) n++;
    if (n === 0) return 0;
    this.d.changed();
    await this.flush();
    return n;
  }

  /** ticket 页「评论」标签。 */
  list(ticketKey: string): PrCommentsView[] {
    return this.d.prs.byTicket(ticketKey).map((r) => {
      const primary = primaryRow(this.d.prs.byUrl(r.url).filter((x) => x.state === r.state).concat(r));
      return { prId: r.id, number: r.number, url: r.url, enabled: this.d.policy(r.slug)["comments.enabled"], items: this.d.items.byPr(primary.id).map(commentView) };
    });
  }

  /** 用户在「评论」标签里点的。返回改过的项；不认识的项、不能做的操作返回 null。 */
  async act(a: CommentAction): Promise<CommentItemView | null> {
    const item = this.d.items.get(a.id);
    if (!item) return null;
    const row = this.d.prs.get(item.prId);
    if (!row) return null;
    const now = this.d.now();
    switch (a.op) {
      case "send":
        if (!this.queueForSend(item, ["review", "ignored", "dismissed", "pending"], now)) return null;
        break;
      case "categorize":
        if (["delivered", "addressed", "closed"].includes(item.state)) return null;
        this.d.items.update(item.id, { category: a.category, source: "user", reason: null, state: a.category === "ignore" ? "ignored" : "review", queuedAt: null }, now);
        break;
      case "dismiss":
        if (["delivered", "addressed", "closed"].includes(item.state)) return null;
        this.d.items.update(item.id, { state: "dismissed", queuedAt: null }, now);
        break;
      case "reply": {
        if (item.state !== "addressed" || item.addressedSha === null || item.repliedAt !== null || this.replying.has(item.id)) return null;
        const where = this.whereOf.get(row.id) ?? (() => {
          const cwd = this.d.cwdOf(row);
          return cwd === null ? null : { cwd, slug: row.slug };
        })();
        if (!where) return null;
        // 用户明确要再回复：按策略的语言，回复开关照样要开。
        await this.reply(item, row, item.addressedSha, { ...this.d.policy(row.slug), "comments.reply": true }, where);
        break;
      }
    }
    this.d.changed();
    // 改了分类或忽略了一条还在排队的：信箱里那条按剩下的重排（一条都不剩就撤回）。
    if (a.op === "send" || item.state === "queued") void this.flush().catch((e: unknown) => this.d.log("comment loop: flush failed", e));
    const after = this.d.items.get(item.id);
    return after ? commentView(after) : null;
  }

  /** 「现在」页：等你看的评论（每个 PR 一条），和该送却超过 30 分钟没送出去的。 */
  waiting(): CommentsWaiting[] {
    const now = this.d.now();
    const out: CommentsWaiting[] = [];
    const group = (items: CommentItem[], reason: CommentsWaiting["reason"], since: (i: CommentItem) => number): void => {
      const by = new Map<number, CommentItem[]>();
      for (const i of items) (by.get(i.prId) ?? by.set(i.prId, []).get(i.prId)!).push(i);
      for (const [prId, list] of by) {
        const row = this.d.prs.get(prId);
        if (!row || row.state !== "open" || !this.d.policy(row.slug)["comments.enabled"]) continue;
        out.push({ reason, ticketKey: row.ticketKey, prId, number: row.number, count: list.length, since: Math.min(...list.map(since)) });
      }
    };
    group(this.d.items.withState(["review"]), "review", (i) => i.updatedAt);
    group(this.d.items.withState(["queued"]).filter((i) => now - (i.queuedAt ?? now) >= COMMENT_UNDELIVERED_MS), "undelivered", (i) => i.queuedAt ?? now);
    return out.sort((a, b) => a.since - b.since);
  }
}
