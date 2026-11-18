import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lang } from "../../shared/i18n";
import type { SessionLesson } from "../../shared/lessons";

/**
 * ticket：ticket session 和修复 session；coordinator：ticket 总控、feature 总控；epic：epic session（BTL-190 第 4 点起单独一种，它开的是 feature 总控）；
 * butler：Butler 总控（BTL-190 第 5 点），只看不建。lessons：复盘分析 session（看一次复盘运行），没有 Butler 的 MCP 工具，也不会被换新。
 */
export type GuideKind = "ticket" | "coordinator" | "epic" | "butler" | "lessons";

/** 每段一个函数，按语言返回一段文字（返回 null 表示这个 kind 不需要）；后续计划往里加段落。 */
export const GUIDE_SECTIONS: Array<(lang: Lang, kind: GuideKind) => string | null> = [
  // Butler 总控和复盘分析 session 不 push，没有自己的 PR。
  (lang, kind) =>
    kind === "butler" || kind === "lessons"
      ? null
      : lang === "zh"
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
  // 「待你决定」和汇报（BTL-190 第 2+3 点）：有 butler-sessions 的 session 都有 ask_user 和 report；Butler 总控的写在它自己那一段里，复盘分析 session 没有这些工具。
  (lang, kind) =>
    kind === "butler" || kind === "lessons"
      ? null
      : lang === "zh"
      ? "需要用户回答一个具体的问题、做一个决定时，调用 butler-sessions 的 ask_user（问题、可选的几个选项、背景），然后结束这一轮，等回答送进来；" +
        "不要拿它问\"要我继续吗\"\"还有别的吗\"这类话，做完就直接停下。做完一块、或者卡住了，用 report 汇报一句（kind 是 done 或 blocked），管你的总控会收到；中间的进展用 progress。"
      : "When you need the user to answer a specific question or make a decision, call ask_user from butler-sessions (question, optional options, context), then end your turn and wait for the answer to arrive. " +
        "Do not use it for \"shall I continue?\" or \"anything else?\"; when you are done, just stop. When you finish a piece of work or get blocked, send one line with report (kind done or blocked) and your coordinator will get it; use progress for updates along the way.",
  // 总控和 epic session：子 session 的问题和汇报 Butler 已经处理了。
  (lang, kind) =>
    kind === "ticket" || kind === "butler" || kind === "lessons"
      ? null
      : lang === "zh"
        ? "子 session 用 ask_user 提的问题会直接摆在用户面前，不用你再转述一遍；它们 done / blocked 的汇报会在你停下来时自动送到。"
        : "Questions your child sessions raise with ask_user go straight to the user, so do not ask them again; their done and blocked reports are delivered to you automatically when you stop.",
  // epic session 用 start_feature 让 feature 开工（BTL-190 第 4 点）。
  (lang, kind) =>
    kind !== "epic"
      ? null
      : lang === "zh"
        ? "规划定下来、用户同意开工后，用 start_feature 打开 feature 的总控，它会收到规划并直接建 ticket、开子 session；建 feature 时带 start: true 等于建完马上 start_feature。" +
          "用户还没同意开工时不要调用。按规划的先后顺序开；能同时开几个只看这台电脑的内存，内存不够时 start_feature 会说还剩多少、要多少，等前面的做完再开。总控已经在跑时不会再开一个，要补充说明就带上 instructions。"
        : "Once the plan is settled and the user agrees to start, open a feature's coordinator with start_feature: it gets the plan and goes on to create tickets and start child sessions. Passing start: true to create_feature is the same as calling start_feature right after creating. " +
          "Do not call it before the user agrees to start. Open them in the order the plan sets; how many run at once depends only on this computer's memory, and when memory runs short start_feature says how much is left and how much is needed, so wait for earlier ones to finish. A coordinator that is already running is not opened again, and you can pass instructions to add to what it is doing.",
  // Butler 总控（BTL-190 第 5 点）：看全部，不建不删；跨 epic 协调用 send_message。
  (lang, kind) =>
    kind !== "butler"
      ? null
      : lang === "zh"
        ? "你是 Butler 总控：全局只有一个，看得到所有 epic、feature、ticket、PR 和 session（list_epics、list_features、list_tickets、list_prs、list_sessions、session_activity、list_inbox）；要整体进度、每个 PR 卡在谁手上，先用 progress_overview，一次就够；用户问 Butler 的效果（PR 周期、评论、人介入、花费，和 Butler 之前比）时用 metrics_overview。" +
          "你不能建、删、结束任何东西；要哪个 epic、feature 做什么，用 send_message 发给它（feature 或 epic 填名字或 id），它的终端关着时 Butler 会接着它最近的对话打开再发，它正忙时稍后再试。" +
          "它这一轮做完时的回复会以【回复】自动送回给你，不用轮询。feature 汇总过时（list_features 的 stale）时用 refresh_feature_summary 在后台重新生成。" +
          "各 epic session done / blocked 的汇报会在你停下来时自动送到。list_inbox 里的「待你决定」已经摆在用户面前，不要再问一遍；需要用户自己做的事（合 PR、回答问题、处理红了的 CI）用 ask_user 列出来，然后结束这一轮。" +
          "report 只存下来，不会送给任何人。"
        : "You are Butler control: there is only one, and it sees every epic, feature, ticket, PR and session (list_epics, list_features, list_tickets, list_prs, list_sessions, session_activity, list_inbox); for the overall progress and who each PR waits on, start with progress_overview, one call is enough; when the user asks how well Butler is doing (PR cycle time, comments, human interventions, cost, compared with before Butler), use metrics_overview. " +
          "You cannot create, delete or end anything; when an epic or feature needs to do something, tell it with send_message (feature or epic by name or id). If its terminal is closed, Butler reopens its latest conversation and sends it; if it is busy, try again later. " +
          "Its reply when it finishes that turn comes back to you automatically as [Reply], so do not poll. When a feature summary is stale (stale in list_features), regenerate it in the background with refresh_feature_summary. " +
          "Done and blocked reports from the epic sessions are delivered to you automatically when you stop. Pending decisions in list_inbox are already in front of the user, so do not ask them again; list what the user has to do themselves (merge PRs, answer questions, deal with failing CI) with ask_user, then end your turn. " +
          "report is only stored and is not sent to anyone.",
  // PR 进度：自我 review 的结果用 report 写进时间线（只给 ticket session 和修复 session）。
  (lang, kind) =>
    kind !== "ticket"
      ? null
      : lang === "zh"
        ? "做完自我 review（code-review 这类 skill）以后，用 report（kind 用 progress）一句话说明找到了什么、改了什么；Butler 会把它放进这个 PR 的进度时间线。"
        : "After you finish a self-review (a skill like code-review), send one line with report (kind progress) saying what you found and what you changed; Butler puts it on this PR's progress timeline.",
  // 换新：复盘分析 session 之外的都可能被换新（它也没有记忆工具）。
  (lang, kind) =>
    kind === "lessons"
      ? null
      : lang === "zh"
      ? "上下文太长时 Butler 会替你写 handoff、清空、再让你从记忆里接上，这时按它的话做就行。重要的决定和约定随时用 remember 写进记忆。"
      : "Butler may refresh a session whose context grows too long: it writes a handoff for you, clears the session, and has you pick up from memory; just follow what it says. Save important decisions and agreements to memory with remember as you go.",
];

export interface GuideOptions {
  /** 原则的案例文件（有原则行时）。 */
  casesFile?: string;
  /** 有自动预审（G）时才写「开 PR 之前会自动跑一次预审」；没有时不写，否则是假话。 */
  preReview?: boolean;
  /** 仓库相关的几行（WS-M I 的 watcher 规定），放在最后。 */
  extra?: string[];
}

/** 用户确认过的规矩，只给 ticket session 和修复 session。 */
function lessonsSection(lang: Lang, kind: GuideKind, lessons: SessionLesson[], opts: GuideOptions): string | null {
  if (kind !== "ticket" || lessons.length === 0) return null;
  const zh = lang === "zh";
  const head = zh
    ? "下面是从这个仓库以前的 review 里总结出来、用户确认过的规矩。写代码时就照着做；做自我 review 时逐条对照，在 report 里写明对照的结果（哪几条相关、有没有违反、改了什么）。"
    : "Below are rules distilled from this repo's earlier reviews and confirmed by the user. Follow them when you write code; in your self-review, check against them one by one, and say in your report what you found (which ones apply, whether any was violated, what you changed).";
  const lines = lessons.map((l) => (l.cases?.length ? `- [${l.label}] ${l.text} ${zh ? `（${l.cases.length} 个案例）` : `(${l.cases.length} cases)`}` : `- [${l.label}] ${l.text}`));
  const out = [head, ...lines];
  if (opts.casesFile && lessons.some((l) => l.cases?.length))
    out.push(
      zh
        ? `带案例数的是原则：和你在做的事相关时，读 ${opts.casesFile} 里它的案例（这个仓库以前被指出过的具体规矩）。`
        : `Lines with a case count are principles: when one is relevant to what you are doing, read its cases (the specific rules this repo was given in earlier reviews) in ${opts.casesFile}.`,
    );
  if (opts.preReview) out.push(zh ? "开 PR 之前会自动跑一次预审，对照的就是这些规矩。" : "A pre-review runs automatically before a PR is opened, against these same rules.");
  return out.join("\n");
}

export function sessionGuide(lang: Lang, kind: GuideKind, lessons: SessionLesson[] = [], opts: GuideOptions = {}): string {
  const parts = GUIDE_SECTIONS.map((s) => s(lang, kind)).filter((s): s is string => !!s);
  const l = lessonsSection(lang, kind, lessons, opts);
  if (l) parts.push(l);
  parts.push(...(opts.extra ?? []));
  return parts.join("\n\n") + "\n";
}

/** 原则的案例文件：每个原则一节，下面是它的规矩。 */
export function casesText(lang: Lang, lessons: SessionLesson[]): string {
  const zh = lang === "zh";
  const parts = lessons.filter((l) => l.cases?.length).map((l) => [`## [${l.label}] ${l.text}`, ...l.cases!.map((c) => `- ${c}`)].join("\n"));
  return `# ${zh ? "原则的案例" : "Cases for the principles"}\n\n${parts.join("\n\n")}\n`;
}

function writeIfChanged(dir: string, file: string, text: string): void {
  if (existsSync(file) && readFileSync(file, "utf8") === text) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text);
}

const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/**
 * lessons 和 extra 都为空：写 <mcpDir>/guide-<kind>-<lang>.md。不然写 guide-<kind>-<lang>-<内容 sha256 前 12 位>.md。内容没变就不重写，返回路径。
 * 有原则行时案例写进旁边的 lessons-cases-<内容 sha256 前 12 位>.md，说明里写它的路径。
 */
export function writeSessionGuide(mcpDir: string, lang: Lang, kind: GuideKind, lessons: SessionLesson[] = [], opts: Omit<GuideOptions, "casesFile"> = {}): string {
  let casesFile: string | undefined;
  if (kind === "ticket" && lessons.some((l) => l.cases?.length)) {
    const cases = casesText(lang, lessons);
    casesFile = join(mcpDir, `lessons-cases-${short(cases)}.md`);
    writeIfChanged(mcpDir, casesFile, cases);
  }
  const text = sessionGuide(lang, kind, lessons, { ...opts, casesFile });
  const hash = lessons.length > 0 || (opts.extra?.length ?? 0) > 0 ? `-${short(text)}` : "";
  const file = join(mcpDir, `guide-${kind}-${lang}${hash}.md`);
  writeIfChanged(mcpDir, file, text);
  return file;
}

const GUIDE_MAX_AGE_MS = 30 * 24 * 3600_000;

/** 删掉 mcpDir 里 30 天没改过的 guide-<kind>-<lang>-<12 位 hex>.md（不碰没有 hash 的那几份）；返回删了几个。启动时调一次。 */
export function pruneSessionGuides(mcpDir: string, now: number): number {
  let names: string[];
  try {
    names = readdirSync(mcpDir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (!/^guide-[a-z]+-[a-z]+-[0-9a-f]{12}\.md$/.test(name) && !/^lessons-cases-[0-9a-f]{12}\.md$/.test(name)) continue;
    try {
      const file = join(mcpDir, name);
      if (now - statSync(file).mtimeMs <= GUIDE_MAX_AGE_MS) continue;
      unlinkSync(file);
      n++;
    } catch {
      /* 单个文件出错不影响其他的 */
    }
  }
  return n;
}
