import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lang } from "../../shared/i18n";

/** ticket：ticket session 和修复 session；coordinator：ticket 总控、feature 总控、epic session。 */
export type GuideKind = "ticket" | "coordinator";

/** 每段一个函数，按语言返回一段文字（返回 null 表示这个 kind 不需要）；后续计划往里加段落。 */
export const GUIDE_SECTIONS: Array<(lang: Lang, kind: GuideKind) => string | null> = [
  (lang) =>
    lang === "zh"
      ? "Butler 会在后台盯着你的 PR 和 CI。push 之后不要循环查 CI（不要 gh run watch、gh pr checks --watch、sleep 轮询），直接结束这一轮；CI 跑完后 Butler 会把结果发给你。"
      : "Butler watches your PR and CI in the background. After you push, do not poll CI (no gh run watch, gh pr checks --watch, or sleep loops); just end your turn. Butler will send you the result when CI finishes.",
  // 子代理的模型：所有 session 都有。
  (lang) =>
    lang === "zh"
      ? '子代理默认用 Sonnet。派子代理做代码审查、查原因不明的问题、做架构判断时，调用 Agent 工具要传 model: "opus"；读代码、搜索、跑命令这类活用默认就行。'
      : 'Subagents use Sonnet by default. When you send a subagent to review code, chase a problem with an unknown cause, or make an architecture call, pass model: "opus" to the Agent tool; for reading code, searching, or running commands the default is fine.',
  // 只有总控会用 start_session 开子 session。
  (lang, kind) =>
    kind !== "coordinator"
      ? null
      : lang === "zh"
        ? "用 start_session 开子 session 时按任务选 model：范围小、目标明确的用 sonnet，需要判断的用 opus，拿不准就用 opus。"
        : "When you open a child session with start_session, pick the model by task: sonnet for small, well-defined work, opus for work that needs judgment, and opus when unsure.",
  // 「待你决定」和汇报（BTL-190 第 2+3 点）：所有 session 都有 ask_user 和 report。
  (lang) =>
    lang === "zh"
      ? "需要用户回答一个具体的问题、做一个决定时，调用 butler-sessions 的 ask_user（问题、可选的几个选项、背景），然后结束这一轮，等回答送进来；" +
        "不要拿它问\"要我继续吗\"\"还有别的吗\"这类话，做完就直接停下。做完一块、或者卡住了，用 report 汇报一句（kind 是 done 或 blocked），管你的总控会收到；中间的进展用 progress。"
      : "When you need the user to answer a specific question or make a decision, call ask_user from butler-sessions (question, optional options, context), then end your turn and wait for the answer to arrive. " +
        "Do not use it for \"shall I continue?\" or \"anything else?\"; when you are done, just stop. When you finish a piece of work or get blocked, send one line with report (kind done or blocked) and your coordinator will get it; use progress for updates along the way.",
  // 总控：子 session 的问题和汇报 Butler 已经处理了。
  (lang, kind) =>
    kind !== "coordinator"
      ? null
      : lang === "zh"
        ? "子 session 用 ask_user 提的问题会直接摆在用户面前，不用你再转述一遍；它们 done / blocked 的汇报会在你停下来时自动送到。"
        : "Questions your child sessions raise with ask_user go straight to the user, so do not ask them again; their done and blocked reports are delivered to you automatically when you stop.",
  // 换新：所有 session 都可能被换新。
  (lang) =>
    lang === "zh"
      ? "上下文太长时 Butler 会替你写 handoff、清空、再让你从记忆里接上，这时按它的话做就行。重要的决定和约定随时用 remember 写进记忆。"
      : "Butler may refresh a session whose context grows too long: it writes a handoff for you, clears the session, and has you pick up from memory; just follow what it says. Save important decisions and agreements to memory with remember as you go.",
];

export function sessionGuide(lang: Lang, kind: GuideKind): string {
  return GUIDE_SECTIONS.map((s) => s(lang, kind)).filter((s): s is string => !!s).join("\n\n") + "\n";
}

/** 写到 <mcpDir>/guide-<kind>-<lang>.md；内容没变就不重写，返回路径。 */
export function writeSessionGuide(mcpDir: string, lang: Lang, kind: GuideKind): string {
  const file = join(mcpDir, `guide-${kind}-${lang}.md`);
  const text = sessionGuide(lang, kind);
  if (existsSync(file) && readFileSync(file, "utf8") === text) return file;
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(file, text);
  return file;
}
