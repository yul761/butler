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
import { editedLines, evaluateBuiltin, fingerprints, newViolations, reconstructBefore, type Violation } from "../src/shared/check-rules";
import {
  CHECKS_SNAPSHOT_VERSION,
  type CheckAbsenceReason, type CheckLogRecord, type CheckSnapshot, type CheckStage, type ResolvedCheck,
} from "../src/shared/checks";
import { runCommand, type CommandResult } from "./check-run";

/** 文件太大就不跑内置检查（生成的文件、打包产物）。 */
const MAX_CONTENT = 2 * 1024 * 1024;
/** 每条检查每次最多报几处，免得一次改动刷屏。 */
const MAX_REPORTED = 20;
/** 给 agent 看的命令输出末尾。 */
const OUTPUT_TAIL = 3000;

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
  /** owner/name 的来源：git remote get-url origin；没有 origin 返回 null。 */
  remoteUrl(root: string, env: NodeJS.ProcessEnv): string | null;
  /** push 改动了哪些文件（相对仓库根）；算不出来返回 null（那就全跑）。 */
  pushedFiles(root: string, env: NodeJS.ProcessEnv): string[] | null;
  run(o: { command: string; file: string | null; cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<CommandResult>;
  now(): number;
  rand(): string;
  pid: number;
}

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

function slugOf(d: CheckHookDeps, state: CheckState, root: string, env: NodeJS.ProcessEnv): string | null {
  const cached = state.slugs[root];
  if (cached !== undefined) return cached || null;
  const url = d.remoteUrl(root, env);
  const slug = url ? parseRemoteSlug(url) : null;
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

function writeHits(d: CheckHookDeps, l: Layout, recs: CheckLogRecord[]): void {
  if (!recs.length) return;
  const name = `${d.now()}-${d.pid}-${d.rand()}.jsonl`;
  d.writeAtomic(path.join(l.hits, name), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
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

/**
 * PostToolUse Edit|Write|MultiEdit（addendum 第 5 节）。返回要写到 stdout 的 JSON（空串 = 不说话）。
 * 什么情况下都不抛错、不阻止 Claude Code：出错就放行。
 */
export async function runCheck(stdin: string, env: NodeJS.ProcessEnv, d: CheckHookDeps): Promise<string> {
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
  const sfile = stateFile(l, session);
  const state = loadState(d, sfile);
  const root = repoRootOf(d, path.dirname(file));
  if (!root) return "";
  const slug = slugOf(d, state, root, env);
  if (!slug) {
    // 没有 remote：放行，不记（源计划「没有 remote 就放行」）。只把 slug 缓存存下来。
    safeWrite(d, sfile, state);
    return "";
  }
  const rel = normalizePath(path.relative(root, file));
  if (!rel || rel.startsWith("../")) return "";
  const checks = checksFor(snap, slug).filter((c) => stageOf(c) === "edit" && inScope(rel, c.globs ?? [], c.excludeGlobs ?? []));
  if (!checks.length) {
    safeWrite(d, sfile, state);
    return "";
  }
  const after = d.isFile(file) ? d.readText(file) : null;
  if (after === null) return "";
  const records: CheckLogRecord[] = [];
  const fails: Failure[] = [];
  const base = { slug, file: rel, stage: "edit" as const, session, at: started };
  const rec = (c: ResolvedCheck, r: Pick<Hit, "line" | "outcome" | "blocked" | "detail">): Hit => ({
    kind: "hit", checkId: c.id, checkKey: c.key, mode: c.mode, severity: c.severity, ...base, ...r, detail: r.detail.slice(0, 2000),
  });
  const ctx = { path: rel, ticketPattern: snap.ticketPattern };
  const before = after.length <= MAX_CONTENT ? reconstructBefore(tool, input, payload.tool_response, after) : null;
  const edited = editedLines(tool, input, after);
  const lines = after.split("\n");
  for (const c of checks) {
    const sk = `${c.key}\u0000${rel}`;
    try {
      if (c.type === "run_command") {
        const budget = snap.editTimeoutMs - (d.now() - started);
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
  try {
    writeHits(d, l, records);
  } catch {
    // 日志写不下来也照常回答 agent。
  }
  safeWrite(d, sfile, state);
  if (!fails.length) return "";
  const text = render(snap, fails);
  if (fails.some((f) => enforced(f.check))) {
    return JSON.stringify({ decision: "block", reason: `${text}\n\n${snap.strings.blockFooter}` });
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } });
}

function safeWrite(d: CheckHookDeps, file: string, state: CheckState): void {
  try {
    d.writeAtomic(file, JSON.stringify(state));
  } catch {
    // 状态写不下来：下次可能重复提醒一次，不影响放行。
  }
}

/**
 * PreToolUse Bash 里的 push 前检查（addendum 第 6 节）：只在认出真正的 git push 时跑仓库的 stage=push 命令；
 * 强制 + 拦截的失败 → deny 并给出原因；其余只提示。和合并闸门并行，闸门的行为不变。
 */
export async function runPushCheck(stdin: string, env: NodeJS.ProcessEnv, d: CheckHookDeps): Promise<string> {
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
  safeWrite(d, sfile, state);
  if (!slug) return "";
  let checks = checksFor(snap, slug).filter((c) => stageOf(c) === "push");
  if (!checks.length) return "";
  const changed = checks.some((c) => (c.globs ?? []).length > 0) ? d.pushedFiles(root, env) : null;
  if (changed) checks = checks.filter((c) => !(c.globs ?? []).length || changed.some((f) => inScope(f, c.globs, c.excludeGlobs ?? [])));
  const records: CheckLogRecord[] = [];
  const fails: Failure[] = [];
  for (const c of checks) {
    const budget = snap.pushTimeoutMs - (d.now() - started);
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
  try {
    writeHits(d, l, records);
  } catch {
    // 照常回答。
  }
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

function gitOut(root: string, env: NodeJS.ProcessEnv, args: string[]): string | null {
  const bin = git(env);
  if (!bin) return null;
  const r = spawnSync(bin, [...GIT_SAFE_ARGS, "-C", root, ...args], { encoding: "utf8", timeout: 3000, windowsHide: true, env: { ...env, GIT_TERMINAL_PROMPT: "0" } });
  return r.status === 0 && typeof r.stdout === "string" ? r.stdout : null;
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
  remoteUrl: (root, env) => gitOut(root, env, ["remote", "get-url", "origin"])?.trim() || null,
  pushedFiles(root, env) {
    for (const range of ["@{upstream}...HEAD", "origin/HEAD...HEAD"]) {
      const out = gitOut(root, env, ["diff", "--name-only", range]);
      if (out !== null) return out.split("\n").map((s) => s.trim()).filter(Boolean);
    }
    return null;
  },
  run: (o) => runCommand(o),
  now: () => Date.now(),
  rand: () => randomBytes(4).toString("hex"),
  pid: process.pid,
};
