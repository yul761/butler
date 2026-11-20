import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LimitHit } from "../../shared/availability";
import type { ConvMessage } from "../../shared/conversation";
import { FORK_QUESTION_MAX, ForkError, type DevSendResult, type ForkErrorCode, type ForkMode, type ForkView, type RememberResult } from "../../shared/fork";
import { featureScope, ticketScope } from "../../shared/memory";
import type { RegistryModel } from "../../shared/model-routing";
import type { Session } from "../../shared/types";
import { HEADLESS_TIMEOUT_MS, type HeadlessOutcome, type HeadlessRun } from "../claude/headless";
import { AUTO_COMPACT_WINDOW_DEFAULT, SUBAGENT_MODEL_DEFAULT, bypassProxyForLoopback, headlessEnv } from "../claude/spawn";
import type { ForkDiscussionsRepo, ForkRow } from "../db/fork-discussions-repo";
import type { UsageReport } from "../handoff/headless-exec";
import { MAIN_STRINGS, M } from "../strings";
import { continueArgs, devForkArgs, forkSettings, strictForkArgs, type DevLaunch } from "./fork-args";
import type { FullForkPlan } from "./fork-cache";
import { LIGHT_QA_CHARS, LIGHT_RECALL_CHARS, chooseMode, fullBlock, runStart, turnCost } from "./fork-mode";

/** 用量和限额里的 job 名（成本统计、效果页按它汇总）。 */
export const FORK_JOB = "fork discussion";

export interface ForkDeps {
  repo: ForkDiscussionsRepo;
  conv: { append(m: Omit<ConvMessage, "id">): ConvMessage; byFork(forkId: number): ConvMessage[] };
  recentQa: (rootSessionId: string, maxChars: number) => string;
  sessions: { rootOf(id: string): string | null; head(id: string): Session | null };
  devLaunchOf: (sessionId: string) => DevLaunch | null;
  transcriptExists: (sessionId: string) => boolean;
  /** 这个 head 开着终端在跑（休眠的、终端退出了的都不算）。不在跑的开发 session 不会和分叉抢，跟停在输入框一样算空着。 */
  devRunning: (headId: string) => boolean;
  lastTurnAt: (sessionId: string) => number | null;
  recall: (scope: string, maxChars: number) => Promise<string>;
  /** 写分叉 settings / MCP 配置到 paths.mcp；hook 没装（readonly 不可用）时 settings 返回 null → 不起跑，报 no_claude。 */
  files: { settings(devSettingsPath: string | null): string | null; mcp(dev: DevLaunch, forkRunId: string): string | null };
  /** 只读 hook 现在可用（装好、是当前版本）。接着问、要结论用的是行里存的 settings，不再经过 files.settings，每一轮都要看它。 */
  hookReady: () => boolean;
  run: HeadlessRun;
  claude: () => { path: string | null; pathValue: string };
  baseEnv: NodeJS.ProcessEnv;
  recordHeadless: (sessionId: string, cwd: string, at: number) => void;
  onUsage: (r: UsageReport) => void;
  onLimit: (hit: LimitHit, job: string) => void;
  registry: () => readonly RegistryModel[];
  /** 发给开发 session（DevSender.send）。 */
  send: (anyId: string, text: string) => Promise<DevSendResult>;
  /** 写进记忆（MemoryService.rememberText）。 */
  remember: (scope: string, text: string) => Promise<Exclude<RememberResult, "busy" | "no_conclusion">>;
  /** 记忆功能整体开着（关着时 remember 直接 disabled，不为它花一轮要结论）。 */
  memoryEnabled: () => boolean;
  /** 推 fork:changed。 */
  changed: (rootSessionId: string) => void;
  /** FULL_FORK。 */
  plan: FullForkPlan;
  now: () => number;
  newRunId: () => string;
  signal?: AbortSignal;
  log: (msg: string, err?: unknown) => void;
}

/**
 * 分叉 claude 的环境变量：headlessEnv（BUTLER_SESSION 带 headless: 前缀，hook 上报会被忽略），再补上跟交互 session（sessionEnv）一样的默认值。
 * 完整分叉要读到开发 session 的缓存，CLAUDE_EFFORT 之类的 CLAUDE_* 必须跟它一样：都从同一个 baseEnv 原样带过来。
 * 共享 MCP 的地址是本机回环，设了代理时同样要绕开（开发 session 那份 MCP 配置照样用）。
 */
export function forkEnv(base: NodeJS.ProcessEnv, x: { pathValue: string; runId: string }): Record<string, string> {
  const env = headlessEnv(base, x);
  env.CLAUDE_CODE_SUBAGENT_MODEL ??= SUBAGENT_MODEL_DEFAULT;
  env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ??= AUTO_COMPACT_WINDOW_DEFAULT;
  bypassProxyForLoopback(env);
  return env;
}

/**
 * files.settings 的实现：开发那份 settings（读不到、不是对象当 null）经 forkSettings 换成只读的一份，写到 dir/fork-<sha1>.json。
 * guardCommand 是 gate hook 用的同一个 butler-hook 命令（hookCommand 的输出），forkSettings 在后面加 readonly；
 * hook 不可用（没装、旧版本）时传 null，返回 null。内容一样就是同一个文件，已经有了不重写（可能有分叉正在读它）。
 */
export function writeForkSettings(o: { dir: string; devSettingsPath: string | null; guardCommand: string | null }): string | null {
  if (!o.guardCommand) return null;
  let dev: Record<string, unknown> | null = null;
  if (o.devSettingsPath) {
    try {
      const v: unknown = JSON.parse(readFileSync(o.devSettingsPath, "utf8"));
      if (v && typeof v === "object" && !Array.isArray(v)) dev = v as Record<string, unknown>;
    } catch {
      // 读不到就当开发 session 没有 settings。
    }
  }
  const body = `${JSON.stringify(forkSettings(dev, o.guardCommand), null, 2)}\n`;
  const file = join(o.dir, `fork-${createHash("sha1").update(body).digest("hex").slice(0, 16)}.json`);
  if (existsSync(file)) return file;
  mkdirSync(o.dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
  return file;
}

type Answer = { ok: true; text: string } | { ok: false };

interface TurnOpts {
  row: ForkRow;
  /** 对话存储里这一轮记在哪个 session 名下（链上现在的 head）。 */
  sessionId: string;
  args: string[];
  prompt: () => Promise<string> | string;
  runId: string;
  claudePath: string;
  pathValue: string;
  /** 回答存成这个分叉的结论（conclusion 要的那一轮）。 */
  conclude?: boolean;
}

const failure = (code: ForkErrorCode, resetAt: number | null = null) => ({ code, resetAt });

/** 带 --fork-session 的参数里 --resume 后面的那个（被分叉的开发 session）；返回的 session id 等于它时绝不能记成 headless。 */
function forkedFrom(args: readonly string[]): string | null {
  if (!args.includes("--fork-session")) return null;
  const at = args.indexOf("--resume");
  return at >= 0 ? (args[at + 1] ?? null) : null;
}

/** 没有结果的一轮：起不来（spawn_failed）、被限额挡在门外（rate_limited）、模型不可用（model_unavailable）没花 token；别的（超时、中途退出）可能花了，记成一部分不知道。 */
const NO_SPEND: ReadonlySet<string> = new Set(["spawn_failed", "rate_limited", "model_unavailable"]);
function noResultCost(out: HeadlessOutcome): { usd: null; partial: boolean } {
  return { usd: null, partial: out.ok ? false : !NO_SPEND.has(out.reason) };
}

/** 各种语言的「要结论」那句：重问时不算用户的问题。 */
const CONCLUSION_ASKS: ReadonlySet<string> = new Set(Object.values(MAIN_STRINGS).map((s) => s.fork.conclusionAsk));

/**
 * 对话 tab 的分叉讨论（UI 重做第 5 层）：从开发 session 分叉出一个只读讨论，可以接着问、用完整上下文重问、要结论。
 * 直接调 HeadlessRun：不走 execHeadlessJson（路由会换模型、破缓存），也不过成本闸门（分叉是用户点的，跟交互 session 一样），费用照实记。
 * 连点靠两层挡：内存里的在途标记（按分叉、按「根 + 问题」、按重问的原分叉），加上 repo.start 的原子判断。
 */
export class ForkService {
  /** 分叉 id → 这一轮跑完。 */
  private readonly running = new Map<number, Promise<void>>();
  /** 「根 + 问题」→ 正在起跑的新分叉。 */
  private readonly asking = new Map<string, number>();
  /** 原分叉 id → 正在跑的完整重问。 */
  private readonly reasking = new Map<number, number>();

  /** 正在发给开发 session 的分叉。 */
  private readonly sending = new Set<number>();
  /** 正在写进记忆的分叉。 */
  private readonly remembering = new Set<number>();

  constructor(private readonly d: ForkDeps) {}

  /** 立刻写入用户的问题、返回 forkId，回答异步写进对话存储。anyId 可以是链上任意 id。 */
  ask(anyId: string, forkId: number | null, question: string): { forkId: number } {
    const q = question.trim();
    if (!q || [...q].length > FORK_QUESTION_MAX) throw new ForkError("bad_question");
    return forkId === null ? this.askNew(anyId, q) : this.askMore(anyId, forkId, q);
  }

  /** 用完整上下文把这个分叉问过的问题重问一遍（新开一个分叉，reask_of 指向原来的）。开发 session 在跑 → dev_busy；没有 transcript → no_transcript。 */
  reaskFull(forkId: number): { forkId: number } {
    const row = this.d.repo.get(forkId);
    if (!row) throw new ForkError("not_found");
    const pending = this.reasking.get(forkId);
    if (pending !== undefined) return { forkId: pending };
    const existing = this.d.repo.runningReaskOf(forkId);
    if (existing) return { forkId: existing.id };
    const head = this.d.sessions.head(row.rootSessionId);
    if (!head) throw new ForkError("not_found");
    const block = fullBlock({ transcriptExists: this.d.transcriptExists(head.id), devIdle: this.devIdle(head) });
    if (block) throw new ForkError(block);
    const questions = this.d.conv.byFork(forkId).filter((m) => m.role === "user" && !CONCLUSION_ASKS.has(m.text)).map((m) => m.text);
    if (questions.length === 0) throw new ForkError("bad_question");
    const id = this.open(row.rootSessionId, head, this.d.devLaunchOf(head.id), "full", questions.join("\n\n"), () => M().fork.fullPrompt(M().fork.reaskPrompt(questions)), forkId, () =>
      this.reasking.delete(forkId),
    );
    this.reasking.set(forkId, id);
    return { forkId: id };
  }

  list(anyId: string): ForkView[] {
    return this.d.repo.listByRoot(this.rootOf(anyId)).map((r) => this.view(r));
  }

  /** 有新鲜的结论（conclusion_at ≥ 最后一条消息）就用它，否则在分叉里再问一句要结论。 */
  async conclusion(forkId: number): Promise<{ ok: true; text: string } | { ok: false; reason: "fork_busy" | "no_conclusion" | "not_found" }> {
    const row = this.d.repo.get(forkId);
    if (!row) return { ok: false, reason: "not_found" };
    if (this.running.has(forkId) || row.status === "running") return { ok: false, reason: "fork_busy" };
    const last = Math.max(0, ...this.d.conv.byFork(forkId).map((m) => m.at));
    if (row.conclusion !== null && row.conclusionAt !== null && row.conclusionAt >= last) return { ok: true, text: row.conclusion };
    if (!row.forkSessionId) return { ok: false, reason: "no_conclusion" };
    const { path, pathValue } = this.d.claude();
    if (!path) {
      this.d.log(`fork ${forkId}: no conclusion, claude was not found`);
      return { ok: false, reason: "no_conclusion" };
    }
    if (!this.d.hookReady()) {
      this.d.log(`fork ${forkId}: no conclusion, the readonly hook is not ready`);
      return { ok: false, reason: "no_conclusion" };
    }
    const ask = M().fork.conclusionAsk;
    const answer = this.continueTurn(row, ask, path, pathValue, true);
    if (!answer) return { ok: false, reason: "fork_busy" };
    const r = await answer;
    return r.ok ? { ok: true, text: r.text } : { ok: false, reason: "no_conclusion" };
  }

  /** 把结论（没有就先要）发给开发 session；成功才记发送时间。没递出去的结论留着，下次不再重新要。 */
  async sendConclusion(forkId: number): Promise<DevSendResult> {
    if (this.sending.has(forkId)) return { ok: false, reason: "in_flight" };
    this.sending.add(forkId);
    try {
      const row = this.d.repo.get(forkId);
      if (!row) return { ok: false, reason: "not_found" };
      let c: Awaited<ReturnType<ForkService["conclusion"]>>;
      try {
        c = await this.conclusion(forkId);
      } catch (e) {
        this.d.log(`fork ${forkId}: getting the conclusion threw`, e);
        return { ok: false, reason: "no_conclusion" };
      }
      if (!c.ok) return { ok: false, reason: c.reason };
      const r = await this.d.send(row.rootSessionId, M().fork.conclusionForDev(c.text));
      if (r.ok) {
        // 文字已经贴进去了：记不下发送时间也要返回成功，不然用户再点一次会发两遍。
        try {
          this.d.repo.markSent(forkId, r.at);
        } catch (e) {
          this.d.log(`fork ${forkId}: markSent failed`, e);
        }
        this.hook("changed", () => this.d.changed(row.rootSessionId));
      }
      return r;
    } finally {
      this.sending.delete(forkId);
    }
  }

  /** 把结论（没有就先要）记进这个 ticket / feature 的记忆。都没有就不记（disabled）。 */
  async remember(forkId: number): Promise<RememberResult> {
    if (this.remembering.has(forkId)) return "busy";
    if (!this.d.memoryEnabled()) return "disabled";
    this.remembering.add(forkId);
    try {
      const row = this.d.repo.get(forkId);
      if (!row) return "failed";
      const scope = row.ticketKey ? ticketScope(row.ticketKey) : row.featureId !== null ? featureScope(row.featureId) : null;
      if (!scope) return "disabled";
      const c = await this.conclusion(forkId);
      if (!c.ok) return c.reason === "fork_busy" ? "busy" : c.reason === "not_found" ? "failed" : "no_conclusion";
      return await this.d.remember(scope, c.text);
    } catch (e) {
      this.d.log(`fork ${forkId}: remember failed`, e);
      return "failed";
    } finally {
      this.remembering.delete(forkId);
    }
  }

  /** 启动时调用：上次没跑完的标成 interrupted。 */
  recover(): void {
    const n = this.d.repo.failRunning("interrupted", this.d.now());
    if (n > 0) this.d.log(`fork: ${n} discussion(s) interrupted by the last quit`);
  }

  /** 测试用：等所有在途的跑完。 */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()]);
  }

  /** 开发 session 空着：停在输入框，或者根本没在终端里跑（终端退出时 handleExit 会清掉 waitingForInput）。 */
  private devIdle(head: Session): boolean {
    return head.waitingForInput || !this.d.devRunning(head.id);
  }

  private rootOf(anyId: string): string {
    return this.d.sessions.rootOf(anyId) ?? anyId;
  }

  private askNew(anyId: string, q: string): { forkId: number } {
    const root = this.rootOf(anyId);
    const head = this.d.sessions.head(root);
    if (!head) throw new ForkError("not_found");
    const key = `${root}\u0000${q}`;
    const pending = this.asking.get(key);
    if (pending !== undefined) return { forkId: pending };
    // 都按 head 查：用量行、transcript、启动参数都是 head 的（/clear 之后的 head 没有启动参数 → 精简）。
    const launch = this.d.devLaunchOf(head.id);
    const mode = chooseMode({
      cacheOk: this.d.plan.cacheOk, launchKnown: launch !== null, transcriptExists: this.d.transcriptExists(head.id), devIdle: this.devIdle(head),
      lastTurnAt: this.d.lastTurnAt(head.id), now: this.d.now(),
    });
    const id = this.open(root, head, launch, mode, q, mode === "full" ? () => M().fork.fullPrompt(q) : (row) => this.lightPrompt(row, q), null, () => this.asking.delete(key));
    this.asking.set(key, id);
    return { forkId: id };
  }

  private askMore(anyId: string, forkId: number, q: string): { forkId: number } {
    const row = this.d.repo.get(forkId);
    if (!row || row.rootSessionId !== this.rootOf(anyId)) throw new ForkError("not_found");
    if (this.running.has(forkId)) throw new ForkError("fork_busy");
    if (row.forkSessionId === null) {
      // 第一轮按原参数重跑：CLI 上次没分叉出来（not_forked）就不再盲目重跑；完整的要跟开分叉时一样，开发 session 得空着、有 transcript。
      if (row.status === "failed" && row.errorCode === "not_forked") throw new ForkError("not_forked");
      if (row.mode === "full") {
        const head = this.d.sessions.head(row.rootSessionId);
        if (!head) throw new ForkError("not_found");
        const block = fullBlock({ transcriptExists: this.d.transcriptExists(head.id), devIdle: this.devIdle(head) });
        if (block) throw new ForkError(block);
      }
    }
    const { path, pathValue } = this.d.claude();
    // 只读 hook 不可用时不跑：参数里那份 settings 的 readonly hook 会失效。
    if (!path || !this.d.hookReady()) throw new ForkError("no_claude");
    if (!this.continueTurn(row, q, path, pathValue, false)) throw new ForkError("fork_busy");
    return { forkId };
  }

  /**
   * 在已有的分叉里跑一轮：有分叉 session 就 continueArgs 续它；第一轮就失败了（还没有）就按第一轮的参数原样重跑，提示词照第一轮的样子拼。
   * cwd、参数都用行里存的，不看开发 session 现在的样子。库里已经是 running 时返回 null（连点）。
   */
  private continueTurn(row: ForkRow, q: string, claudePath: string, pathValue: string, conclude: boolean): Promise<Answer> | null {
    if (!this.d.repo.start(row.id, this.d.now())) return null;
    const sessionId = this.d.sessions.head(row.rootSessionId)?.id ?? row.rootSessionId;
    this.appendUser(row, sessionId, q);
    this.hook("changed", () => this.d.changed(row.rootSessionId));
    const fresh = row.forkSessionId === null;
    const args = fresh ? row.launchArgs : continueArgs(row.launchArgs, row.forkSessionId!);
    // 第一轮（第一轮失败后重跑）才带开头那段说明：精简的带上下文，完整的带只读说明；续上的分叉里已经有了，要结论那句也不加。
    const prompt = !fresh || conclude ? () => q : row.mode === "light" ? () => this.lightPrompt(row, q) : () => M().fork.fullPrompt(q);
    return this.track(row.id, { row, sessionId, args, prompt, runId: this.d.newRunId(), claudePath, pathValue, conclude });
  }

  /** 新开一个分叉：建行、写入问题、起跑。claude 找不到、只读 hook 不可用、只读 settings 写不出来时报 no_claude，什么都不建。 */
  private open(
    root: string, head: Session, launch: DevLaunch | null, mode: ForkMode, userText: string, prompt: (row: ForkRow) => Promise<string> | string,
    reaskOf: number | null, settled: () => void,
  ): number {
    const { path, pathValue } = this.d.claude();
    if (!path || !this.d.hookReady()) throw new ForkError("no_claude");
    const settingsPath = this.d.files.settings(launch?.settingsPath ?? null);
    if (!settingsPath) throw new ForkError("no_claude");
    const runId = this.d.newRunId();
    const args = mode === "full" ? this.fullArgs(head, launch, settingsPath, runId) : strictForkArgs({ model: head.model, addDirs: launch?.addDirs ?? [], forkSettingsPath: settingsPath });
    const at = this.d.now();
    const row = this.d.repo.create({ rootSessionId: root, mode, ticketKey: head.ticketKey, featureId: head.featureId, cwd: launch?.cwd ?? head.cwd, launchArgs: args, at, reaskOf });
    this.appendUser(row, head.id, userText);
    this.hook("changed", () => this.d.changed(root));
    void this.track(row.id, { row, sessionId: head.id, args, prompt: () => prompt(row), runId, claudePath: path, pathValue }).finally(settled);
    return row.id;
  }

  /** 完整上下文：缓存可用、知道开发参数时照抄（devForkArgs）；否则用严格参数续开发 session（读不到缓存，但上下文是完整的）。 */
  private fullArgs(head: Session, launch: DevLaunch | null, forkSettingsPath: string, runId: string): string[] {
    const plan = this.d.plan;
    if (plan.cacheOk && launch) {
      return devForkArgs(launch, { forkSettingsPath, forkMcpConfigPath: plan.ownMcpConfig ? this.d.files.mcp(launch, runId) : null, plan });
    }
    return strictForkArgs({ resumeSessionId: head.id, model: head.model, addDirs: launch?.addDirs ?? [], forkSettingsPath });
  }

  private async lightPrompt(row: ForkRow, question: string): Promise<string> {
    const scope = row.ticketKey ? ticketScope(row.ticketKey) : row.featureId !== null ? featureScope(row.featureId) : null;
    const recall = scope ? await this.d.recall(scope, LIGHT_RECALL_CHARS) : "";
    return M().fork.lightPrompt({ recall, qa: this.d.recentQa(row.rootSessionId, LIGHT_QA_CHARS), question });
  }

  private appendUser(row: ForkRow, sessionId: string, text: string): void {
    try {
      this.d.conv.append({ rootSessionId: row.rootSessionId, sessionId, role: "user", text, at: this.d.now(), forkId: row.id, qa: false, turnId: 0 });
    } catch (e) {
      // 问题没存下来就不跑：行标成失败，别让它一直挂在 running。
      this.d.repo.finish(row.id, { at: this.d.now(), addCost: null, partial: false, error: failure("spawn_failed") });
      throw e;
    }
  }

  private track(forkId: number, o: TurnOpts): Promise<Answer> {
    const answer = this.turn(o);
    const done = answer.then(() => undefined).finally(() => this.running.delete(forkId));
    this.running.set(forkId, done);
    return answer;
  }

  private hook(name: string, f: () => void): void {
    try {
      f();
    } catch (e) {
      this.d.log(`fork: ${name} threw`, e);
    }
  }

  /** 跑一轮，写回答、费用、状态。永不 reject。 */
  private async turn(o: TurnOpts): Promise<Answer> {
    const { row } = o;
    let out: HeadlessOutcome;
    try {
      const prompt = await o.prompt();
      out = await this.d.run({
        claudePath: o.claudePath, args: o.args, prompt, cwd: row.cwd, env: forkEnv(this.d.baseEnv, { pathValue: o.pathValue, runId: o.runId }),
        timeoutMs: HEADLESS_TIMEOUT_MS, signal: this.d.signal,
      });
    } catch (e) {
      this.d.log(`fork ${row.id}: run threw`, e);
      out = { ok: false, reason: "spawn_failed", message: e instanceof Error ? e.message : String(e), limit: null, stderr: "", result: null };
    }
    // app 正在退出：什么都不写（数据库可能已经关了），行留着 running，下次启动由 recover 标成 interrupted。
    if (!out.ok && out.reason === "aborted" && this.d.signal?.aborted) {
      this.d.log(`fork ${row.id}: aborted by quit`);
      return { ok: false };
    }
    // 失败的那一轮也照记已经算出的费用（记答案出错时也不丢）；什么都没算出来就当一部分不知道。
    // CLI 的 total_cost_usd 是累计的：按这一轮怎么起的、上次见到的累计算出这一轮自己的（turnCost）。
    let cost: { usd: number | null; partial: boolean; cli: number | null; seenTotal: number | null } = { usd: null, partial: true, cli: null, seenTotal: null };
    try {
      const at = this.d.now();
      const r = out.result;
      const seen = this.d.repo.get(row.id)?.costSeenTotal ?? null;
      cost = r ? turnCost(r, runStart(o.args), seen, this.d.registry()) : { ...noResultCost(out), cli: null, seenTotal: seen };
      const sid = r?.sessionId ?? null;
      // 返回的就是 --resume 的那个开发 session：CLI 没分叉出来，这一轮写进了开发 session 自己的对话。不记成 headless、不存成分叉 id
      // （否则接着问会直接续上正在用的开发 session）。跑成功的这一轮记 not_forked；本来就失败的保留真正的原因（限额的 resetAt 也在）。
      // 它的用量也在开发 session 的 transcript 里、由用量扫描记在开发 session 名下：不再记一行 headless 用量（否则记两遍），费用标成不全。
      const unforked = sid !== null && sid === forkedFrom(o.args);
      // 那个累计是开发 session 的，也不记成这个分叉见过的。
      if (unforked) cost = { ...cost, partial: true, seenTotal: seen };
      if (r?.usage && !unforked) {
        const usage = r.usage;
        // 用量行记这一轮自己的金额；估出来的不带（null），由用量统计按价格表估。
        const costUsd = cost.cli;
        this.hook("onUsage", () => this.d.onUsage({ runId: o.runId, label: FORK_JOB, at, model: r.model, usage, costUsd, ticketKey: row.ticketKey }));
      }
      if (!out.ok && out.limit) {
        const hit = out.limit;
        this.hook("onLimit", () => this.d.onLimit(hit, FORK_JOB));
      }
      if (unforked && out.ok) this.d.log(`fork ${row.id}: the CLI resumed the dev session ${sid} instead of forking it`);
      if (sid && !unforked) this.hook("recordHeadless", () => this.d.recordHeadless(sid, row.cwd, at));
      const text = out.ok && !unforked ? out.result.resultText.trim() : "";
      if (text) {
        this.d.conv.append({ rootSessionId: row.rootSessionId, sessionId: o.sessionId, role: "assistant", text, at, forkId: row.id, qa: false, turnId: 0 });
        if (o.conclude) this.d.repo.setConclusion(row.id, text, at);
      }
      const error = !out.ok ? failure(out.reason, out.limit?.resetsAt ?? null) : unforked ? failure("not_forked") : text ? null : failure("no_answer");
      if (!out.ok) this.d.log(`fork ${row.id}: ${out.reason}: ${out.message.slice(0, 500)}`);
      this.d.repo.finish(row.id, { at, ...(out.ok && sid && !unforked ? { forkSessionId: sid } : {}), addCost: cost.usd, partial: cost.partial, seenTotal: cost.seenTotal, error });
      this.hook("changed", () => this.d.changed(row.rootSessionId));
      return text ? { ok: true, text } : { ok: false };
    } catch (e) {
      this.d.log(`fork ${row.id}: recording the answer failed`, e);
      try {
        this.d.repo.finish(row.id, { at: this.d.now(), addCost: cost.usd, partial: cost.partial, seenTotal: cost.seenTotal, error: failure("bad_output") });
        this.hook("changed", () => this.d.changed(row.rootSessionId));
      } catch (e2) {
        this.d.log(`fork ${row.id}: marking it failed failed too`, e2);
      }
      return { ok: false };
    }
  }

  private view(r: ForkRow): ForkView {
    return {
      id: r.id, rootSessionId: r.rootSessionId, mode: r.mode, status: r.status, costUsd: r.costUsd, costPartial: r.costPartial, startedAt: r.startedAt, lastAt: r.lastAt,
      summarySentAt: r.summarySentAt, conclusion: r.conclusion, reaskOf: r.reaskOf,
      error: r.status === "failed" && r.errorCode ? { code: r.errorCode, resetAt: r.errorResetAt } : null,
      messages: this.d.conv.byFork(r.id),
    };
  }
}
