// shipherd-hook lessons <dir>：Edit / Write / NotebookEdit 之后，把改的文件匹配上、还没送过全文的规矩作为 additionalContext 补送（BTL-274）。
// 只读一份清单和一份已送记录，不调 git，不连网：每次编辑多花几毫秒。
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DRIP_SENT_SUFFIX, DRIP_SUFFIX, dripIntro, dripName, locateInRoots, type DripLesson, type DripManifest } from "../src/shared/lesson-drip";
import { lessonApplies } from "../src/shared/lesson-scope";
import { LESSON_DRIP_LIMIT } from "../src/shared/lessons";
import { envValue } from "../src/shared/legacy-env";

export interface DripDeps {
  read(file: string): string | null;
  append(file: string, text: string): void;
  remove(file: string): void;
  exists(file: string): boolean;
  /** 独占地建锁文件（O_EXCL）；已经有人拿着就返回 false。 */
  lock(file: string): boolean;
  sleep(ms: number): void;
  platform: NodeJS.Platform;
}

/** 锁文件放了这么久还在，就当拿锁的进程已经死了，删掉重拿。 */
export const DRIP_LOCK_STALE_MS = 10_000;
/** 同一个 session 并发的编辑（并行的工具调用）：等前一个送完最多等这么多次、每次这么久，等不到这次就不送（没记成已送，下次编辑再送）。 */
const LOCK_TRIES = 20;
const LOCK_WAIT_MS = 10;

const tryCreate = (f: string): "ok" | "taken" | "error" => {
  try {
    closeSync(openSync(f, "wx"));
    return "ok";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EEXIST" ? "taken" : "error";
  }
};

export const realDripDeps: DripDeps = {
  read: (f) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return null;
    }
  },
  append: (f, t) => appendFileSync(f, t),
  remove: (f) => {
    try {
      unlinkSync(f);
    } catch {
      /* 本来就没有 */
    }
  },
  exists: (f) => existsSync(f),
  lock: (f) => {
    const r = tryCreate(f);
    // 建不了锁（不是被占着，是目录写不了之类）：不锁照送，别因为锁让补送彻底停掉。
    if (r !== "taken") return true;
    try {
      if (Date.now() - statSync(f).mtimeMs <= DRIP_LOCK_STALE_MS) return false;
      unlinkSync(f);
    } catch {
      /* 别人刚好放了锁：再试一次 */
    }
    return tryCreate(f) !== "taken";
  },
  sleep: (ms) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  platform: process.platform,
};

export interface DripRun {
  out: string;
  /** stdout 写完以后调：把这次送的规矩追加到已送记录（只追加还没记过的），然后放锁。 */
  commit(): void;
  /** 不管送没送成都要调（commit 里也会调，重复调没事）：放掉已送记录的锁。 */
  release(): void;
}

const NOTHING: DripRun = { out: "", commit: () => {}, release: () => {} };

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function parseManifest(text: string | null): DripManifest | null {
  if (!text) return null;
  try {
    const m = JSON.parse(text) as DripManifest;
    return m && m.v === 1 && Array.isArray(m.roots) && Array.isArray(m.lessons) ? m : null;
  } catch {
    return null;
  }
}

const sentIds = (text: string | null): Set<number> => new Set((text ?? "").split("\n").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0));

/** 文件属于清单里哪个仓库、相对路径是什么（和 lessons 工具同一份判断）。 */
export const locate = (file: string, m: DripManifest, platform: NodeJS.Platform): { slug: string; rel: string } | null => locateInRoots(file, m.roots, platform);

const block = (l: DripLesson, lang: "zh" | "en"): string =>
  [`- #${l.id} [${l.label}] ${l.text}`, ...(l.why.trim() ? [lang === "zh" ? `  原因：${l.why}` : `  Why: ${l.why}`] : [])].join("\n");

/** 读清单、找匹配的规矩、拼正文。任何一步出错都只是这次不送，不抛。 */
export function runLessonDrip(stdin: string, env: NodeJS.ProcessEnv, root: string, d: DripDeps = realDripDeps): DripRun {
  const sid = envValue(env, "SESSION")?.trim();
  if (!sid || !root) return NOTHING;
  let file: string;
  let agent = "";
  let event = "PostToolUse";
  try {
    const p = JSON.parse(stdin) as { tool_name?: unknown; tool_input?: Record<string, unknown>; agent_id?: unknown; hook_event_name?: unknown };
    if (typeof p.tool_name !== "string" || !EDIT_TOOLS.has(p.tool_name)) return NOTHING;
    const input = p.tool_input ?? {};
    const path = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : "";
    if (!path) return NOTHING;
    file = path;
    // 子 agent 的编辑：additionalContext 进的是子 agent。照样送（改文件的就是它），但单独记，主 session 之后改到时还会收到。
    if (typeof p.agent_id === "string" && p.agent_id) agent = dripName(p.agent_id);
    if (p.hook_event_name === "PreToolUse") event = "PreToolUse";
  } catch {
    return NOTHING;
  }
  const base = join(root, dripName(sid));
  const manifestFile = `${base}${DRIP_SUFFIX}`;
  const m = parseManifest(d.read(manifestFile));
  if (!m) return NOTHING;
  const at = locate(file, m, d.platform);
  if (!at) return NOTHING;
  const sentFile = agent ? `${base}.${agent}${DRIP_SENT_SUFFIX}` : `${base}${DRIP_SENT_SUFFIX}`;
  // 读已送记录、写 stdout、记成已送这一整段拿着锁：并发的两次编辑不会都读到「还没送」、把同一条送两遍。
  const lockFile = `${sentFile}.lock`;
  let locked = d.lock(lockFile);
  for (let i = 1; !locked && i < LOCK_TRIES; i++) {
    d.sleep(LOCK_WAIT_MS);
    locked = d.lock(lockFile);
  }
  if (!locked) return NOTHING;
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    d.remove(lockFile);
  };
  const sent = sentIds(d.read(sentFile));
  const lang = m.lang === "en" ? "en" : "zh";
  const intro = dripIntro(lang, at.rel);
  const picked: DripLesson[] = [];
  let size = intro.length;
  for (const l of m.lessons) {
    if (sent.has(l.id) || !l.slugs.includes(at.slug)) continue;
    // 没限定范围的规矩处处适用：第一次编辑就补送。
    if (!lessonApplies({ scopeGlobs: l.globs, scopeLang: l.lang }, [at.rel])) continue;
    const b = block(l, lang);
    // 放不下的留给下一次编辑（第一条再长也送，不然永远送不出去）。
    if (picked.length > 0 && size + b.length + 1 > LESSON_DRIP_LIMIT) continue;
    picked.push(l);
    size += b.length + 1;
  }
  if (picked.length === 0) {
    release();
    return NOTHING;
  }
  const context = [intro, ...picked.map((l) => block(l, lang))].join("\n");
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
  return {
    out,
    commit: () => {
      try {
        // 锁过期被别人抢了的话，这期间别的进程可能已经记过：重读一遍，只追加没记过的。
        const now = sentIds(d.read(sentFile));
        const fresh = picked.filter((l) => !now.has(l.id));
        if (fresh.length) d.append(sentFile, fresh.map((l) => `${l.id}\n`).join(""));
      } catch {
        /* 记不下就下次再送一遍，不抛 */
      } finally {
        release();
      }
    },
    release,
  };
}

/** shipherd-hook lessons-reset <dir>：SessionStart（startup / clear / compact）时主 session 的已送记录作废，下一次编辑重新补送。 */
export function resetLessonDrip(env: NodeJS.ProcessEnv, root: string, d: DripDeps = realDripDeps): void {
  const sid = envValue(env, "SESSION")?.trim();
  if (!sid || !root) return;
  d.remove(`${join(root, dripName(sid))}${DRIP_SENT_SUFFIX}`);
}
