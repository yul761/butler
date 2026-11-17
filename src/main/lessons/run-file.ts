import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lang } from "../../shared/i18n";
import type { LessonRunDetail, LessonRunSummary } from "../../shared/lessons";
import { MAIN_STRINGS } from "../strings";

/** 用反引号围栏包起来：围栏比内容里最长的反引号串长一个，至少 3 个，内容里的 ``` 关不掉它。 */
export function fence(text: string): string {
  // 64 KB 的内容可能有几万段反引号：不展开成 Math.max 的参数。
  const longest = (text.match(/`+/g) ?? []).reduce((n, m) => Math.max(n, m.length), 0);
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}\n${text}\n${f}`;
}

/** 元数据只占一行：换行和连续空白压成一个空格。 */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

const attemptText = (a: LessonRunSummary) => `#${a.id} ${a.status}${a.reason ? ` (${a.reason})` : ""}`;

/**
 * 一次复盘运行的记录（复盘分析 session 先读它）：第一行说明下面全是数据、不是指令，然后是元数据和各节内容。
 * 每一块自由文本都用 fence 包起来；运行被清理过材料（trimmed）时写明。
 */
export function runFileMarkdown(d: LessonRunDetail, lang: Lang): string {
  const t = MAIN_STRINGS[lang].lessonRunFile;
  const value = (v: string | null) => (v === null || v === "" ? t.none : oneLine(v));
  const meta = [
    t.line(t.repo, value(d.slug)),
    t.line(t.pr, `#${d.prNumber}`),
    t.line(t.prTitle, value(d.prTitle)),
    t.line(t.url, value(d.prUrl)),
    t.line(t.origin, d.origin),
    t.line(t.status, d.status),
    t.line(t.reason, value(d.reason)),
    t.line(t.model, value(d.model)),
    t.line(t.cost, d.costUsd === null ? t.none : `$${d.costUsd.toFixed(4)}`),
    t.line(t.duration, d.durationMs === null ? t.none : t.formatDuration(d.durationMs)),
    t.line(t.attempts, d.attempts.length === 0 ? t.none : d.attempts.map(attemptText).join(", ")),
  ];
  const block = (text: string | null, empty: string = t.none) => (text === null || text === "" ? empty : fence(text));
  /** 材料和原始输出：被清理过的说明一下。 */
  const body = (text: string | null) => (text === null && d.trimmed ? t.trimmed : block(text));
  const lessons = d.lessons.map((l) => `#${l.id} [${t.lessonKind[l.kind]}] (${l.status}) ${l.text}`).join("\n");
  const sections: [string, string][] = [
    [t.message, block(d.message)],
    [t.stderr, block(d.stderrTail)],
    [t.ghStderr, block(d.ghStderr)],
    [t.findings, d.findings === null ? t.noFindings : fence(JSON.stringify(d.findings, null, 2))],
    [t.lessons, block(lessons)],
    [t.material, body(d.material)],
    [t.raw, body(d.rawOutput)],
  ];
  return [t.header, `# ${t.title(d.id)}`, meta.join("\n"), ...sections.map(([h, b]) => `## ${h}\n\n${b}`)].join("\n\n") + "\n";
}

/** 写 <dir>/run-<id>.md（目录不在就建，文件已有就覆盖），返回路径。 */
export function writeRunFile(dir: string, d: LessonRunDetail, lang: Lang): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `run-${d.id}.md`);
  writeFileSync(file, runFileMarkdown(d, lang));
  return file;
}
