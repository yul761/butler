import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { checksLayout, dirFromEnv } from "../src/main/paths";
import { renameWithRetrySync } from "../src/main/util/fs-retry";
import { pathKey } from "../src/main/util/env";
import { GIT_SAFE_ARGS, resolveGit } from "../src/main/util/git-path";
import { classifyPush } from "../src/shared/gate-command";
import { inScope, normalizePath } from "../src/shared/glob";
import { parseRemoteSlug } from "../src/shared/repo-slug";
import {
  commentsOf, contentLines, editedLines, evaluateBuiltin, fingerprints, newViolations, patternFlags, reconstructBefore, ticketPatternOf,
  type RegexTest, type Violation,
} from "../src/shared/check-rules";
import {
  CHECKS_SNAPSHOT_VERSION,
  type CheckAbsenceReason, type CheckLogRecord, type CheckSnapshot, type CheckStage, type ResolvedCheck,
} from "../src/shared/checks";
import { runCommand, type CommandResult } from "./check-run";
import { runRegexJobs, type RegexJob, type RegexJobsResult } from "./regex-worker";

/** 文件太大就不跑内置检查（生成的文件、打包产物）。 */
const MAX_CONTENT = 2 * 1024 * 1024;
/** 每条检查每次最多报几处，免得一次改动刷屏。 */
const MAX_REPORTED = 20;
/** 给 agent 看的命令输出末尾。 */
const OUTPUT_TAIL = 3000;
/** 用户正则最多跑这么久（再受编辑预算限制）：剩下的时间留给命令检查。 */
const REGEX_BUDGET_MS = 2000;

type Hit = Extract<CheckLogRecord, { kind: "hit" }>;

/** 每个 session 的防抖状态（addendum 5 第 6 步）：报过的违规指纹、命令失败的输出哈希、仓库根 → slug、报过的「没有检查」。 */
export interface CheckState {
  reported: Record<string, string[]>;
  /** 上次在这个文件里看到的全部违规（报过的和原本就有的）：编辑前内容还原不出来时，见过的不再当新的。 */
  seen: Record<string, string[]>;
  cmd: Record<string, string>;
  slugs: Record<string, string>;
  absent: CheckAbsenceReason | null;
}

export interface CheckHookDeps {
  readText(file: string): string | null;
  /** mkdir + tmp + rename。 */
  writeAtomic(file: string, text: string): void;
  exists(p: string): boolean;
  isFile(p: string): boolean;
  /** owner/name 的来源：git remote get-url origin。none = 确实没有 origin；error = 这次没问出来（超时、git 找不到），不缓存。 */
  remoteUrl(root: string, env: NodeJS.ProcessEnv): RemoteLookup;
  /** push 改动了哪些文件（相对仓库根）；算不出来返回 null（那就全跑）。 */
  pushedFiles(root: string, env: NodeJS.ProcessEnv): string[] | null;
  run(o: { command: string; file: string | null; cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<CommandResult>;
  /** 用户写的正则（限时，见 regex-worker）。 */
  regex(jobs: RegexJob[], timeoutMs: number): Promise<RegexJobsResult>;
  now(): number;
  rand(): string;
  pid: number;
}

export type RemoteLookup = { kind: "url"; url: string } | { kind: "none" } | { kind: "error" };

const emptyState = (): CheckState => ({ reported: {}, seen: {}, cmd: {}, slugs: {}, absent: null });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface Layout {
  snapshot: string;
  hits: string;
  state: string;
}

function layoutOf(env: NodeJS.ProcessEnv): Layout {
  const home = dirFromEnv(env.BUTLER_HOME, homedir()) ?? path.join(homedir(), ".butler");
  const l = checksLayout(home);
  return { snapshot: l.checksSnapshot, hits: l.checksHits, state: l.checksState };
}

const sessionOf = (env: NodeJS.ProcessEnv): string | null => {
  const s = env.BUTLER_SESSION?.trim();
  return s && /^[A-Za-z0-9_.-]{1,200}$/.test(s) ? s : null;
};

const stateFile = (l: Layout, session: string | null) => path.join(l.state, `${session ?? "_none"}.json`);

function loadState(d: CheckHookDeps, file: string): CheckState {
  const v = parseJson(d.readText(file) ?? "");
  if (!isObj(v)) return emptyState();
  const s = emptyState();
  for (const field of ["reported", "seen"] as const) {
    const m = v[field];
    if (isObj(m)) for (const [k, x] of Object.entries(m)) if (Array.isArray(x)) s[field][k] = x.filter((y): y is string => typeof y === "string");
  }
  if (isObj(v.cmd)) for (const [k, x] of Object.entries(v.cmd)) if (typeof x === "string") s.cmd[k] = x;
  if (isObj(v.slugs)) for (const [k, x] of Object.entries(v.slugs)) if (typeof x === "string") s.slugs[k] = x;
  if (typeof v.absent === "string") s.absent = v.absent as CheckAbsenceReason;
  return s;
}

type SnapshotRead = { ok: true; snap: CheckSnapshot } | { ok: false; reason: CheckAbsenceReason };

/** hook 从不打开 SQLite：只读 Butler 写的快照（契约 4.5）。读不懂就放行并记「没有检查」。 */
export function readSnapshot(d: Pick<CheckHookDeps, "readText">, file: string): SnapshotRead {
  const text = d.readText(file);
  if (text === null) return { ok: false, reason: "no_snapshot" };
  const v = parseJson(text);
  if (!isObj(v)) return { ok: false, reason: "no_snapshot" };
  if (v.v !== CHECKS_SNAPSHOT_VERSION) return { ok: false, reason: "snapshot_version" };
  if (!Array.isArray(v.global) || !isObj(v.repos) || !isObj(v.strings)) return { ok: false, reason: "no_snapshot" };
  return { ok: true, snap: v as unknown as CheckSnapshot };
}

/** 从文件往上找含 .git（目录或 worktree 的文件）的目录。 */
export function repoRootOf(d: Pick<CheckHookDeps, "exists">, start: string): string | null {
  let dir = start;
  for (let i = 0; i < 100; i++) {
    if (d.exists(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** 只缓存确定的答案：git 一时没回话（Windows 上冷启动超时之类）下次再问，不让整个 session 的检查都停掉。 */
function slugOf(d: CheckHookDeps, state: CheckState, root: string, env: NodeJS.ProcessEnv): string | null {
  const cached = state.slugs[root];
  if (cached !== undefined) return cached || null;
  const r = d.remoteUrl(root, env);
  if (r.kind === "error") return null;
  const slug = r.kind === "url" ? parseRemoteSlug(r.url) : null;
  state.slugs[root] = slug ?? "";
  return slug;
}

const checksFor = (snap: CheckSnapshot, slug: string): ResolvedCheck[] => (Array.isArray(snap.repos[slug]) ? snap.repos[slug] : snap.global);
const stageOf = (c: ResolvedCheck): CheckStage => (c.type === "run_command" && c.params.stage === "push" ? "push" : "edit");

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
const tail = (s: string, n = OUTPUT_TAIL) => (s.length > n ? `…${s.slice(s.length - n)}` : s);

interface Failure {
  check: ResolvedCheck;
  where: string;
  detail: string;
}

/** 给 agent 看的一段：每条失败一个小节（addendum 第 4 节的格式）。 */
function render(snap: CheckSnapshot, fails: Failure[]): string {
  const blocks: string[] = [];
  const byCheck = new Map<number, Failure[]>();
  for (const f of fails) (byCheck.get(f.check.id) ?? byCheck.set(f.check.id, []).get(f.check.id)!).push(f);
  for (const group of byCheck.values()) {
    const c = group[0].check;
    const tag = c.mode === "shadow" ? snap.strings.shadowTag : c.severity === "warn" ? snap.strings.warnTag : "";
    const lines = group.map((f) => `${fill(snap.strings.failHeader, { name: c.name, where: f.where })}${tag}${f.detail ? `\n  ${f.detail.split("\n").join("\n  ")}` : ""}`);
    blocks.push(`${lines.join("\n")}\n${c.message}`);
  }
  return blocks.join("\n\n");
}

const enforced = (c: ResolvedCheck) => c.mode === "enforce" && c.severity === "block";

const regexKey = (pattern: string, flags: string) => `${flags}\u0000${pattern}`;

/** 这条内置检查要跑的用户正则：禁用写法（非字面）测每一行，注释规则的 ticket 号测每条注释。 */
function regexNeeds(c: ResolvedCheck, contents: string[], ctx: { path: string; ticketPattern: string }): RegexJob | null {
  const p = c.params as Record<string, unknown>;
  if (c.type === "forbidden_pattern" && p.literal !== true && typeof p.pattern === "string") {
    return { pattern: p.pattern, flags: patternFlags({ flags: typeof p.flags === "string" ? p.flags : undefined }), texts: contents.flatMap(contentLines) };
  }
  if (c.type === "comment_policy") {
    const pattern = ticketPatternOf({ ticketPattern: typeof p.ticketPattern === "string" ? p.ticketPattern : undefined }, ctx);
    if (pattern) return { pattern, flags: "", texts: contents.flatMap((t) => commentsOf(t, ctx.path).map((x) => x.text)) };
  }
  return null;
}

/**
 * 先在 worker 里把所有用户正则对要测的文字跑完（同一个正则合并），再给规则一个查表的 test。
 * 超时返回 null：这些检查这次记「超时」放行。
 */
async function precomputeRegexes(d: CheckHookDeps, checks: ResolvedCheck[], contents: string[], ctx: { path: string; ticketPattern: string }, budgetMs: number): Promise<RegexTest | null> {
  const jobs = new Map<string, { pattern: string; flags: string; texts: Set<string> }>();
  for (const c of checks) {
    const need = regexNeeds(c, contents, ctx);
    if (!need) continue;
    const k = regexKey(need.pattern, need.flags);
    const j = jobs.get(k) ?? jobs.set(k, { pattern: need.pattern, flags: need.flags, texts: new Set() }).get(k)!;
    for (const t of need.texts) j.texts.add(t);
  }
  const list = [...jobs.entries()].map(([k, j]) => ({ k, job: { pattern: j.pattern, flags: j.flags, texts: [...j.texts] } }));
  const r = await d.regex(list.map((x) => x.job), budgetMs);
  if (!r.ok) return null;
  const table = new Map(list.map((x, i) => [x.k, new Map(x.job.texts.map((t, n) => [t, r.results[i]?.[n] === true]))]));
  return (pattern, flags, text) => table.get(regexKey(pattern, flags))?.get(text) ?? false;
}

function writeHits(d: CheckHookDeps, l: Layout, recs: CheckLogRecord[]): void {
  if (!recs.length) return;
  const name = `${d.now()}-${d.pid}-${d.rand()}.jsonl`;
  d.writeAtomic(path.join(l.hits, name), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** 写命中日志；写不下来也照常回答 agent。 */
function flushHits(d: CheckHookDeps, l: Layout, recs: CheckLogRecord[]): void {
  try {
    writeHits(d, l, recs);
  } catch {
    // 照常回答。
  }
}

/** 「没有检查」每个 session 只记一次（原因变了再记）。 */
function noteAbsent(d: CheckHookDeps, l: Layout, session: string | null, reason: CheckAbsenceReason): void {
  if (!session) return;
  const file = stateFile(l, session);
  const st = loadState(d, file);
  if (st.absent === reason) return;
  st.absent = reason;
  try {
    writeHits(d, l, [{ kind: "absent", reason, session, at: d.now() }]);
    d.writeAtomic(file, JSON.stringify(st));
  } catch {
    // 记不下来也放行。
  }
}

export interface HookPayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

/** 命令行上的选项：budgetMs 是注册 hook 时的预算（hook 的超时按它留了余量），快照里的预算后来调大了也不超过它。 */
export interface CheckRunOptions {
  budgetMs?: number;
}

/** `--budget-ms N`：认不出就当没给。 */
export function parseCheckArgs(argv: readonly string[]): CheckRunOptions {
  const i = argv.indexOf("--budget-ms");
  const n = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? { budgetMs: n } : {};
}

const budgetOf = (snapMs: number, o: CheckRunOptions) => (o.budgetMs === undefined ? snapMs : Math.min(snapMs, o.budgetMs));

/**
 * PostToolUse Edit|Write|MultiEdit（addendum 第 5 节）。返回要写到 stdout 的 JSON（空串 = 不说话）。
 * 什么情况下都不抛错、不阻止 Claude Code：出错就放行。
 */
export async function runCheck(stdin: string, env: NodeJS.ProcessEnv, d: CheckHookDeps, opts: CheckRunOptions = {}): Promise<string> {
  const started = d.now();
  const p = parseJson(stdin);
  if (!isObj(p)) return "";
  const payload = p as HookPayload;
  const tool = payload.tool_name;
  if (tool !== "Edit" && tool !== "Write" && tool !== "MultiEdit") return "";
  const input = isObj(payload.tool_input) ? payload.tool_input : {};
  const rawFile = typeof input.file_path === "string" ? input.file_path : "";
  if (!rawFile) return "";
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const file = path.resolve(cwd, rawFile);
  const l = layoutOf(env);
  const session = sessionOf(env);
  const sr = readSnapshot(d, l.snapshot);
  if (!sr.ok) {
    noteAbsent(d, l, session, sr.reason);
    return "";
  }
  const snap = sr.snap;
  if (!snap.enabled) return "";
  const budgetMs = budgetOf(snap.editTimeoutMs, opts);
  const sfile = stateFile(l, session);
  const state = loadState(d, sfile);
  const root = repoRootOf(d, path.dirname(file));
  if (!root) return "";
  const slug = slugOf(d, state, root, env);
  const records: CheckLogRecord[] = [];
  const cleared = presentAgain(d, state, session, records);
  const touched = new Set<string>();
  const finishQuiet = () => {
    flushHits(d, l, records);
    safeWrite(d, sfile, state, touched, cleared);
    return "";
  };
  if (!slug) {
    // 没有 remote：放行，不记（源计划「没有 remote 就放行」）。只把 slug 缓存存下来。
    return finishQuiet();
  }
  const rel = normalizePath(path.relative(root, file));
  if (!rel || rel.startsWith("../")) return finishQuiet();
  const checks = checksFor(snap, slug).filter((c) => stageOf(c) === "edit" && inScope(rel, c.globs ?? [], c.excludeGlobs ?? []));
  if (!checks.length) return finishQuiet();
  const after = d.isFile(file) ? d.readText(file) : null;
  if (after === null) return finishQuiet();
  const fails: Failure[] = [];
  const base = { slug, file: rel, stage: "edit" as const, session, at: started };
  const rec = (c: ResolvedCheck, r: Pick<Hit, "line" | "outcome" | "blocked" | "detail">): Hit => ({
    kind: "hit", checkId: c.id, checkKey: c.key, mode: c.mode, severity: c.severity, ...base, ...r, detail: r.detail.slice(0, 2000),
  });
  const before = after.length <= MAX_CONTENT ? reconstructBefore(tool, input, payload.tool_response, after) : null;
  const edited = editedLines(tool, input, after);
  const lines = after.split("\n");
  const base0 = { path: rel, ticketPattern: snap.ticketPattern };
  const builtins = after.length <= MAX_CONTENT ? checks.filter((c) => c.type !== "run_command") : [];
  const regexBudget = Math.min(REGEX_BUDGET_MS, budgetMs - (d.now() - started));
  const test = builtins.length ? await precomputeRegexes(d, builtins, before === null ? [after] : [after, before], base0, regexBudget) : undefined;
  const regexTimedOut = test === null;
  const ctx = { ...base0, test: test ?? undefined };
  for (const c of checks) {
    const sk = `${c.key}\u0000${rel}`;
    touched.add(sk);
    try {
      if (c.type === "run_command") {
        const budget = budgetMs - (d.now() - started);
        const own = typeof c.params.timeoutMs === "number" ? c.params.timeoutMs : budget;
        const r = await d.run({ command: String(c.params.command ?? ""), file: rel, cwd: root, timeoutMs: Math.min(budget, own), env });
        if (r.kind === "pass") {
          if (state.cmd[sk]) {
            records.push(rec(c, { line: null, outcome: "resolved", blocked: false, detail: "" }));
            delete state.cmd[sk];
          }
        } else if (r.kind === "fail") {
          const h = createHash("sha256").update(r.output).digest("hex").slice(0, 16);
          if (state.cmd[sk] === h) continue;
          state.cmd[sk] = h;
          const detail = tail(r.output.trim());
          fails.push({ check: c, where: rel, detail });
          records.push(rec(c, { line: null, outcome: "fail", blocked: enforced(c), detail }));
        } else if (r.kind === "timeout") records.push(rec(c, { line: null, outcome: "timeout", blocked: false, detail: tail(r.output.trim(), 500) }));
        else records.push(rec(c, { line: null, outcome: "unavailable", blocked: false, detail: r.reason }));
        continue;
      }
      if (after.length > MAX_CONTENT) continue;
      if (regexTimedOut && regexNeeds(c, [], base0)) {
        // 正则跑太久（多半是嵌套量词）：这次没检查成，放行，页面上算「没能检查」。
        records.push(rec(c, { line: null, outcome: "timeout", blocked: false, detail: "regex took too long" }));
        continue;
      }
      const now = evaluateBuiltin(c, after, ctx);
      const was = before === null ? null : evaluateBuiltin(c, before, ctx);
      const fresh = newViolations(was, now, before === null ? edited : null);
      const nowFps = fingerprints(now);
      // newViolations 返回的是 now 里的元素本身：按对象认出哪些是这次新增的，指纹用它们在当前文件里的那个。
      const isFresh = new Set(fresh);
      const freshFps = new Set(now.flatMap((v, i) => (isFresh.has(v) ? [nowFps[i]] : [])));
      const reportedBefore = new Set(state.reported[sk] ?? []);
      for (const fpr of reportedBefore) {
        if (!nowFps.includes(fpr)) records.push(rec(c, { line: null, outcome: "resolved", blocked: false, detail: fpr.replace(/#\d+$/, "").slice(0, 500) }));
      }
      const toReport: Violation[] = [];
      const seenBefore = new Set(state.seen[sk] ?? []);
      const freshList = now.filter((v, i) => freshFps.has(nowFps[i]) && !reportedBefore.has(nowFps[i]) && (before !== null || !seenBefore.has(nowFps[i])));
      for (const v of freshList.slice(0, MAX_REPORTED)) toReport.push(v);
      for (const v of toReport) {
        // 给 agent 看原样的那一行；导入边界再标出是哪个导入越界了。
        const lineText = (lines[v.line - 1] ?? v.text).trim().slice(0, 300);
        const detail = c.type === "import_boundary" ? `${lineText}  ← ${v.detail}` : lineText;
        fails.push({ check: c, where: `${rel}:${v.line}`, detail });
        records.push(rec(c, { line: v.line, outcome: "fail", blocked: enforced(c), detail }));
      }
      const reportedNow = new Set(freshList.slice(0, MAX_REPORTED).map((v) => nowFps[now.indexOf(v)]));
      const keep = nowFps.filter((f) => reportedBefore.has(f) || reportedNow.has(f));
      if (keep.length) state.reported[sk] = keep;
      else delete state.reported[sk];
      if (nowFps.length) state.seen[sk] = nowFps.slice(0, 500);
      else delete state.seen[sk];
    } catch (e) {
      records.push(rec(c, { line: null, outcome: "error", blocked: false, detail: e instanceof Error ? e.message : String(e) }));
    }
  }
  flushHits(d, l, records);
  safeWrite(d, sfile, state, touched, cleared);
  if (!fails.length) return "";
  const text = render(snap, fails);
  if (fails.some((f) => enforced(f.check))) {
    return JSON.stringify({ decision: "block", reason: `${text}\n\n${snap.strings.blockFooter}` });
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } });
}

/**
 * 写回防抖状态：先重新读一遍文件，只换上这次动过的那些（检查, 文件）键，slug 缓存取并集。
 * 同一个 session 里并行的几次编辑各自的 hook 同时在跑，整份覆盖会互相丢掉对方记下的东西。
 */
function safeWrite(d: CheckHookDeps, file: string, state: CheckState, touched: ReadonlySet<string> = new Set(), clearAbsent = false): void {
  try {
    const fresh = loadState(d, file);
    for (const k of touched) {
      for (const field of ["reported", "seen"] as const) {
        if (state[field][k]) fresh[field][k] = state[field][k];
        else delete fresh[field][k];
      }
      if (state.cmd[k]) fresh.cmd[k] = state.cmd[k];
      else delete fresh.cmd[k];
    }
    Object.assign(fresh.slugs, state.slugs);
    if (clearAbsent) fresh.absent = null;
    d.writeAtomic(file, JSON.stringify(fresh));
  } catch {
    // 状态写不下来：下次可能重复提醒一次，不影响放行。
  }
}

/** 这个 session 记过「没有检查」，现在又检查上了：记一条 present，Butler 清掉标记。返回要不要在状态里清掉。 */
function presentAgain(d: CheckHookDeps, state: CheckState, session: string | null, records: CheckLogRecord[]): boolean {
  if (!session || state.absent === null) return false;
  records.push({ kind: "present", session, at: d.now() });
  state.absent = null;
  return true;
}

/**
 * PreToolUse Bash 里的 push 前检查（addendum 第 6 节）：只在认出真正的 git push 时跑仓库的 stage=push 命令；
 * 强制 + 拦截的失败 → deny 并给出原因；其余只提示。和合并闸门并行，闸门的行为不变。
 */
export async function runPushCheck(stdin: string, env: NodeJS.ProcessEnv, d: CheckHookDeps, opts: CheckRunOptions = {}): Promise<string> {
  const started = d.now();
  const p = parseJson(stdin);
  if (!isObj(p)) return "";
  const payload = p as HookPayload;
  if (payload.tool_name !== "Bash") return "";
  const input = isObj(payload.tool_input) ? payload.tool_input : {};
  const command = typeof input.command === "string" ? input.command : "";
  const push = classifyPush(command);
  if (!push) return "";
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const dir = push.dir ? path.resolve(cwd, push.dir) : cwd;
  const l = layoutOf(env);
  const session = sessionOf(env);
  const sr = readSnapshot(d, l.snapshot);
  if (!sr.ok) {
    noteAbsent(d, l, session, sr.reason);
    return "";
  }
  const snap = sr.snap;
  if (!snap.enabled) return "";
  const root = repoRootOf(d, dir);
  if (!root) return "";
  const sfile = stateFile(l, session);
  const state = loadState(d, sfile);
  const slug = slugOf(d, state, root, env);
  const records: CheckLogRecord[] = [];
  const cleared = presentAgain(d, state, session, records);
  safeWrite(d, sfile, state, new Set(), cleared);
  if (!slug) {
    flushHits(d, l, records);
    return "";
  }
  let checks = checksFor(snap, slug).filter((c) => stageOf(c) === "push");
  if (!checks.length) {
    flushHits(d, l, records);
    return "";
  }
  const changed = checks.some((c) => (c.globs ?? []).length > 0) ? d.pushedFiles(root, env) : null;
  if (changed) checks = checks.filter((c) => !(c.globs ?? []).length || changed.some((f) => inScope(f, c.globs, c.excludeGlobs ?? [])));
  const fails: Failure[] = [];
  for (const c of checks) {
    const budget = budgetOf(snap.pushTimeoutMs, opts) - (d.now() - started);
    const own = typeof c.params.timeoutMs === "number" ? c.params.timeoutMs : budget;
    const r = await d.run({ command: String(c.params.command ?? ""), file: null, cwd: root, timeoutMs: Math.min(budget, own), env });
    const base = { kind: "hit" as const, checkId: c.id, checkKey: c.key, slug, file: "", line: null, stage: "push" as const, mode: c.mode, severity: c.severity, session, at: started };
    if (r.kind === "pass") continue;
    if (r.kind === "fail") {
      const detail = tail(r.output.trim());
      fails.push({ check: c, where: "git push", detail });
      records.push({ ...base, outcome: "fail", blocked: enforced(c), detail: detail.slice(0, 2000) });
    } else if (r.kind === "timeout") records.push({ ...base, outcome: "timeout", blocked: false, detail: tail(r.output.trim(), 500) });
    else records.push({ ...base, outcome: "unavailable", blocked: false, detail: r.reason.slice(0, 2000) });
  }
  flushHits(d, l, records);
  if (!fails.length) return "";
  const text = render(snap, fails);
  if (fails.some((f) => enforced(f.check))) {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${snap.strings.pushHeader}\n\n${text}` } });
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });
}

/** git 的绝对路径（Windows 上不执行当前目录里的 git.exe）。 */
function git(env: NodeJS.ProcessEnv): string | null {
  return resolveGit(env[pathKey(env)] ?? "", process.platform) ?? (process.platform === "win32" ? null : "git");
}

/** 跑一条 git；git 找不到、起不来、超时返回 null。 */
function gitRun(root: string, env: NodeJS.ProcessEnv, args: string[]): { status: number | null; stdout: string } | null {
  const bin = git(env);
  if (!bin) return null;
  const r = spawnSync(bin, [...GIT_SAFE_ARGS, "-C", root, ...args], { encoding: "utf8", timeout: 3000, windowsHide: true, env: { ...env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.error || r.signal) return null;
  return { status: r.status, stdout: typeof r.stdout === "string" ? r.stdout : "" };
}

function gitOut(root: string, env: NodeJS.ProcessEnv, args: string[]): string | null {
  const r = gitRun(root, env, args);
  return r && r.status === 0 ? r.stdout : null;
}

/** `git remote get-url origin`：退出码 2 是「没有这个 remote」（确定的答案），其余失败都算这次没问出来。 */
export function remoteLookupOf(r: { status: number | null; stdout: string } | null): RemoteLookup {
  if (!r) return { kind: "error" };
  if (r.status === 0) {
    const url = r.stdout.trim();
    return url ? { kind: "url", url } : { kind: "none" };
  }
  return r.status === 2 ? { kind: "none" } : { kind: "error" };
}

export const realCheckDeps: CheckHookDeps = {
  readText(file) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
  writeAtomic(file, text) {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, text, "utf8");
      renameWithRetrySync(tmp, file);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        // 没写出来。
      }
      throw e;
    }
  },
  exists: (p) => existsSync(p),
  isFile(p) {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  remoteUrl: (root, env) => remoteLookupOf(gitRun(root, env, ["remote", "get-url", "origin"])),
  pushedFiles(root, env) {
    for (const range of ["@{upstream}...HEAD", "origin/HEAD...HEAD"]) {
      // quotepath=off：中文等非 ASCII 的路径原样输出，不然带引号和八进制转义，glob 对不上。
      const out = gitOut(root, env, ["-c", "core.quotepath=off", "diff", "--name-only", range]);
      if (out !== null) return out.split("\n").map((s) => s.trim()).filter(Boolean);
    }
    return null;
  },
  run: (o) => runCommand(o),
  regex: (jobs, timeoutMs) => runRegexJobs(jobs, timeoutMs),
  now: () => Date.now(),
  rand: () => randomBytes(4).toString("hex"),
  pid: process.pid,
};
