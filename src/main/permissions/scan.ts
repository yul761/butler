import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { ruleForTool, scanRuleForCommand } from "./classify";

/**
 * 权限档案的候选（ws-j 设计 2.1）：从 Claude Code 的历史 transcript（<config>/projects/<dir>/<session>.jsonl）里数
 * 每个仓库真正跑过、没被拒绝的只读命令。只在本机读，结果只给界面看；不调模型。
 */

export interface ScanOptions {
  projectsDir: string;
  /** cwd → 仓库 slug（owner/name）；认不出返回 null（这条就不算）。 */
  slugOf(cwd: string): string | null | Promise<string | null>;
  now: number;
  days?: number;
  maxFiles?: number;
  maxBytes?: number;
  minRuns?: number;
  minSessions?: number;
}

export interface ScanCandidate {
  slug: string;
  rule: string;
  /** 跑过几次、在几个 session 里。 */
  runs: number;
  sessions: number;
  /** 一个例子（最长 200 字符，只在本机界面上显示）。 */
  example: string;
}

export const SCAN_DEFAULTS = { days: 30, maxFiles: 400, maxBytes: 20 * 1024 * 1024, minRuns: 3, minSessions: 2 } as const;

/** 用户拒绝了这次工具调用时 tool_result 里的话。 */
const REJECTED = "doesn't want to proceed";

interface Use {
  slug: string;
  rule: string;
  session: string;
  example: string;
}

interface Tally {
  runs: number;
  sessions: Set<string>;
  example: string;
}

type Block = { type?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; is_error?: unknown; content?: unknown };

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("\n") : "";

function ruleOf(name: string, input: unknown): { rule: string; example: string } | null {
  if (name === "Bash") {
    const cmd = input && typeof input === "object" ? (input as { command?: unknown }).command : null;
    if (typeof cmd !== "string") return null;
    const rule = scanRuleForCommand(cmd.trim());
    return rule ? { rule, example: cmd.trim().slice(0, 200) } : null;
  }
  const rule = ruleForTool(name);
  return rule ? { rule, example: name } : null;
}

/** 最近改过的 transcript，新的在前，最多 maxFiles 个。 */
async function recentFiles(dir: string, since: number, maxFiles: number, maxBytes: number): Promise<string[]> {
  let projects: string[];
  try {
    projects = await readdir(dir);
  } catch {
    return [];
  }
  const files: { path: string; mtime: number }[] = [];
  for (const p of projects) {
    let names: string[];
    try {
      names = await readdir(join(dir, p));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const path = join(dir, p, n);
      try {
        const s = await stat(path);
        if (s.isFile() && s.mtimeMs >= since && s.size <= maxBytes) files.push({ path, mtime: s.mtimeMs });
      } catch {
        // 读的时候被删了：跳过。
      }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, maxFiles).map((f) => f.path);
}

/** 扫一遍，给出达到门槛的候选（按仓库、次数排序）。 */
export async function scanTranscripts(o: ScanOptions): Promise<ScanCandidate[]> {
  const days = o.days ?? SCAN_DEFAULTS.days;
  const since = o.now - days * 86_400_000;
  const files = await recentFiles(o.projectsDir, since, o.maxFiles ?? SCAN_DEFAULTS.maxFiles, o.maxBytes ?? SCAN_DEFAULTS.maxBytes);
  const slugCache = new Map<string, string | null>();
  const slugFor = async (cwd: string): Promise<string | null> => {
    if (!slugCache.has(cwd)) {
      let s: string | null;
      try {
        s = await o.slugOf(cwd);
      } catch {
        s = null;
      }
      slugCache.set(cwd, s);
    }
    return slugCache.get(cwd) ?? null;
  };
  const tallies = new Map<string, Tally>();
  const rejected = new Set<string>();
  const keyOf = (u: Pick<Use, "slug" | "rule">) => `${u.slug}\n${u.rule}`;

  for (const file of files) {
    const pending = new Map<string, Use>();
    const fallbackSession = basename(file, ".jsonl");
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes("tool_use") && !line.includes("tool_result")) continue;
        let e: { cwd?: unknown; sessionId?: unknown; message?: { content?: unknown } };
        try {
          e = JSON.parse(line) as typeof e;
        } catch {
          continue;
        }
        const content = e?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const b of content as Block[]) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string" && typeof e.cwd === "string") {
            const r = ruleOf(b.name, b.input);
            if (!r) continue;
            const slug = await slugFor(e.cwd);
            if (!slug) continue;
            pending.set(b.id, { slug, rule: r.rule, example: r.example, session: typeof e.sessionId === "string" ? e.sessionId : fallbackSession });
          } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
            const u = pending.get(b.tool_use_id);
            if (!u) continue;
            pending.delete(b.tool_use_id);
            if (b.is_error === true) {
              if (textOf(b.content).includes(REJECTED)) rejected.add(keyOf(u));
              continue;
            }
            const k = keyOf(u);
            const t = tallies.get(k) ?? { runs: 0, sessions: new Set<string>(), example: u.example };
            t.runs++;
            t.sessions.add(u.session);
            tallies.set(k, t);
          }
        }
      }
    } catch {
      // 读到一半出错（文件被截断、编码问题）：已经读到的照算。
    } finally {
      lines.close();
    }
  }

  const minRuns = o.minRuns ?? SCAN_DEFAULTS.minRuns;
  const minSessions = o.minSessions ?? SCAN_DEFAULTS.minSessions;
  const out: ScanCandidate[] = [];
  for (const [k, t] of tallies) {
    if (rejected.has(k) || t.runs < minRuns || t.sessions.size < minSessions) continue;
    const [slug, rule] = k.split("\n") as [string, string];
    out.push({ slug, rule, runs: t.runs, sessions: t.sessions.size, example: t.example });
  }
  return out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : b.runs - a.runs || (a.rule < b.rule ? -1 : 1)));
}
