import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lang } from "../../shared/i18n";
import type { SessionLesson } from "../../shared/lessons";

/**
 * ticket：ticket session 和修复 session；coordinator：feature 总控；shipherd：Shipherd 总控（BTL-190 第 5 点），只看不建。lessons：复盘分析 session（看一次复盘运行），没有 Shipherd 的 MCP 工具，也不会被换新。
 */
export type GuideKind = "ticket" | "coordinator" | "shipherd" | "lessons";

/** 每段一个函数，按语言返回一段文字（返回 null 表示这个 kind 不需要）；后续计划往里加段落。 */
export const GUIDE_SECTIONS: Array<(lang: Lang, kind: GuideKind) => string | null> = [
  // Shipherd 总控和复盘分析 session 不 push，没有自己的 PR。
  (lang, kind) =>
    kind === "shipherd" || kind === "lessons"
      ? null
      : lang === "zh"
      ? "Shipherd 会在后台盯着你的 PR 和 CI。push 之后不要循环查 CI（不要 gh run watch、gh pr checks --watch、sleep 轮询），直接结束这一轮；CI 跑完后 Shipherd 会把结果发给你。"
      : "Shipherd watches your PR and CI in the background. After you push, do not poll CI (no gh run watch, gh pr checks --watch, or sleep loops); just end your turn. Shipherd will send you the result when CI finishes.",
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
  // 提问和汇报（BTL-190 第 2+3 点）：有 shipherd-sessions 的 session 都有 ask_user 和 report；Shipherd 总控的写在它自己那一段里，复盘分析 session 没有这些工具。
  (lang, kind) =>
    kind === "shipherd" || kind === "lessons"
      ? null
      : lang === "zh"
      ? "需要用户回答一个具体的问题、做一个决定时，调用 shipherd-sessions 的 ask_user（问题、可选的几个选项、背景），然后结束这一轮，等回答送进来；" +
        "不要拿它问\"要我继续吗\"\"还有别的吗\"这类话，做完就直接停下。做完一块、或者卡住了，用 report 汇报一句（kind 是 done 或 blocked），管你的总控会收到；中间的进展用 progress。"
      : "When you need the user to answer a specific question or make a decision, call ask_user from shipherd-sessions (question, optional options, context), then end your turn and wait for the answer to arrive. " +
        "Do not use it for \"shall I continue?\" or \"anything else?\"; when you are done, just stop. When you finish a piece of work or get blocked, send one line with report (kind done or blocked) and your coordinator will get it; use progress for updates along the way.",
  // feature 总控：子 session 的问题和汇报 Shipherd 已经处理了。
  (lang, kind) =>
    kind === "ticket" || kind === "shipherd" || kind === "lessons"
      ? null
      : lang === "zh"
        ? "子 session 用 ask_user 提的问题会直接摆在用户面前，不用你再转述一遍；它们 done / blocked 的汇报会在你停下来时自动送到。"
        : "Questions your child sessions raise with ask_user go straight to the user, so do not ask them again; their done and blocked reports are delivered to you automatically when you stop.",
  // feature 总控给子 session 发话（BTL-245）：排进信箱，它在忙也送得到。
  (lang, kind) =>
    kind !== "coordinator"
      ? null
      : lang === "zh"
        ? "要给子 session 改任务、告诉它接口变了，用 shipherd-sessions 的 send_message：消息排进它的信箱，它在忙也会在下一次调用工具时读到，不用等它停下；真要它马上停手才带 interrupt: true。"
        : "To change a child session's task or tell it an interface changed, use send_message from shipherd-sessions: the message goes into its mailbox and a busy session reads it at its next tool call, so you do not wait for it to stop; pass interrupt: true only when it really has to stop now.",
  // 全局总控（内部叫 Shipherd 总控，BTL-190 第 5 点）：看全部，不建不删；跨 epic 协调用 send_message。
  (lang, kind) =>
    kind !== "shipherd"
      ? null
      : lang === "zh"
        ? "你是全局总控：全局只有一个，看得到所有 epic、ticket、PR 和 session（list_epics、list_features、list_tickets、list_prs、list_sessions、session_activity、list_inbox）；要整体进度、每个 PR 轮到谁，先用 progress_overview，一次就够；用户问 Shipherd 的效果（PR 周期、评论、人介入、花费，和 Shipherd 之前比）时用 metrics_overview。" +
          "一个 epic（对应一个 Jira epic）有一个 epic 总控、一个工作区和一份共享记忆；epic 里可以分几个 feature，每个 feature 只是一组 ticket 和一个顺序，没有自己的总控（list_features 看）。" +
          "除了栈（见下）你不能建、删、结束任何东西；要哪个 epic 做什么，用 send_message 发给它的总控（epic 填名字或 id），消息排进它的信箱，它在忙也照样送到（下一次调用工具时读到），终端关着时 Shipherd 会接着它最近的对话打开再发。" +
          "它这一轮做完时的回复会以【回复】自动送回给你，不用轮询。epic 汇总过时（list_epics 的 stale）时用 refresh_epic_summary 在后台重新生成。" +
          "list_inbox 里未决的提问已经摆在用户面前，不要再问一遍；需要用户自己做的事（合 PR、回答问题、处理红了的 CI）用 ask_user 列出来，然后结束这一轮。" +
          "report 只存下来，不会送给任何人。"
        : "You are Shipherd's global control: there is only one, and it sees every epic, ticket, PR and session (list_epics, list_features, list_tickets, list_prs, list_sessions, session_activity, list_inbox); for the overall progress and whose turn each PR is, start with progress_overview, one call is enough; when the user asks how well Shipherd is doing (PR cycle time, comments, human interventions, cost, compared with before Shipherd), use metrics_overview. " +
          "An epic (one Jira epic) has one epic coordinator, one workspace and one shared memory; an epic can be split into features, and each feature is only a set of tickets and an order, with no coordinator of its own (see list_features). " +
          "Apart from stacks (below) you cannot create, delete or end anything; when an epic needs to do something, tell its coordinator with send_message (epic by name or id). The message goes into its mailbox and reaches it even while it is busy (at its next tool call); if its terminal is closed, Shipherd reopens its latest conversation and sends it. " +
          "Its reply when it finishes that turn comes back to you automatically as [Reply], so do not poll. When an epic summary is stale (stale in list_epics), regenerate it in the background with refresh_epic_summary. " +
          "Pending questions in list_inbox are already in front of the user, so do not ask them again; list what the user has to do themselves (merge PRs, answer questions, deal with failing CI) with ask_user, then end your turn. " +
          "report is only stored and is not sent to anyone.",
  // epic 里的 feature（BTL-246，内部叫 block）：只给 epic 总控（内部还叫 feature 总控）。
  (lang, kind) =>
    kind !== "coordinator"
      ? null
      : lang === "zh"
        ? "一个 epic 里可以分几个 feature：每个 feature 是一组 ticket 和一个顺序，没有自己的总控和工作区。list_features 按顺序看每个 feature 的 ticket 和合了几个；" +
          "create_feature 新建，reorder_features 排顺序，set_ticket_feature 把 ticket 放进（或移出）一个 feature，create_ticket 带 feature 直接建在里面；从 Jira 导入的 ticket 要你来归到 feature 里。" +
          "按顺序推进：一次推一个 feature，互不相关的可以并行。几个 ticket 都要遵守的约定（接口、命名、拆分方式）用 shipherd-feature 的 remember 写进 epic 记忆；某个 ticket 自己的进度由它的 session 记在 ticket 记忆（shipherd-memory）里。"
        : "An epic can be split into features: each feature is a set of tickets and an order, with no coordinator or workspace of its own. list_features shows each feature's tickets and how many are merged, in order; " +
          "create_feature makes one, reorder_features sets the order, set_ticket_feature puts a ticket in a feature (or takes it out), and create_ticket with feature creates it there directly; tickets imported from Jira are yours to sort into features. " +
          "Work in order: push one feature forward at a time, and run unrelated ones in parallel. Conventions several tickets must follow (interfaces, naming, how the work is split) go into epic memory with remember on shipherd-feature; a ticket's own progress is kept by its session in ticket memory (shipherd-memory).",
  // 栈式 PR（工作流 K）：feature 总控用 stack_on / stack_define，Shipherd 总控只有 stack_define 这几个。
  (lang, kind) =>
    kind !== "coordinator" && kind !== "shipherd"
      ? null
      : lang === "zh"
        ? (kind === "coordinator"
          ? "几个 ticket 前后依赖（后一个要在前一个的改动上做）时用栈：create_ticket 带 stack_on 把新 ticket 接在上一个之上，或者用 stack_define 把已有的分支定成栈。"
          : "几个 Shipherd 分支前后依赖时可以用 stack_define 把它们定成栈（从下到上）。") +
          "只有栈底的 PR 给人 review；栈底合并或 trunk 更新后 Shipherd 会整栈 rebase、把下一层开成 PR，冲突交给那一层的 session，不用手动 rebase 上面的层。" +
          "list_stacks 看状态，stack_rebase 马上 rebase 一次，上面某层要跑 CI 时用 stack_layer_mode 开成 draft。"
        : (kind === "coordinator"
          ? "When tickets depend on each other (one builds on another's changes), use a stack: create_ticket with stack_on puts the new ticket on top of the previous one, or stack_define turns existing branches into a stack. "
          : "When Shipherd branches depend on each other you can turn them into a stack with stack_define (bottom to top). ") +
          "Only the bottom PR is for human review; when the bottom merges or trunk moves, Shipherd rebases the whole stack, opens the next layer as a PR, and hands conflicts to that layer's session, so nobody rebases the layers above by hand. " +
          "Use list_stacks for the state, stack_rebase to rebase once now, and stack_layer_mode to open a layer above as a draft when it needs CI.",
  // PR 进度：自我 review 的结果用 report 写进时间线（只给 ticket session 和修复 session）。
  (lang, kind) =>
    kind !== "ticket"
      ? null
      : lang === "zh"
        ? "做完自我 review（code-review 这类 skill）以后，用 report（kind 用 progress）一句话说明找到了什么、改了什么；Shipherd 会把它放进这个 PR 的进度时间线。"
        : "After you finish a self-review (a skill like code-review), send one line with report (kind progress) saying what you found and what you changed; Shipherd puts it on this PR's progress timeline.",
  // 换新：复盘分析 session 之外的都可能被换新（它也没有记忆工具）。
  (lang, kind) =>
    kind === "lessons"
      ? null
      : lang === "zh"
      ? "上下文太长时 Shipherd 会替你写 handoff、清空、再让你从记忆里接上，这时按它的话做就行。重要的决定和约定随时用 remember 写进记忆。"
      : "Shipherd may refresh a session whose context grows too long: it writes a handoff for you, clears the session, and has you pick up from memory; just follow what it says. Save important decisions and agreements to memory with remember as you go.",
  // 工作流程（BTL-273）：两级总控能看、能设。epic 总控只能改自己的 epic 和它的 ticket。
  (lang, kind) =>
    kind !== "coordinator" && kind !== "shipherd"
      ? null
      : lang === "zh"
        ? "用户想定 ticket 的做法（写完直接合、要不要预审、要不要 Copilot review、谁来合并）时，用 get_workflow 看现在的流程，list_workflow_presets 看能用的步骤和预设，set_workflow 设好。" +
          "流程按 全局 → 产品/仓库 → epic → ticket 一层层覆盖；Shipherd 会按流程提醒 session 下一步，开 PR、合并的顺序不对会被拦住。" +
          "流程里没有合并这一步时，由用户自己合，你也别合。" +
          (kind === "coordinator" ? "你只能改这个 epic 和它的 ticket；全局、产品、仓库那几层要在 Shipherd 总控里改。" : "")
        : "When the user wants to decide how tickets get done (merge right after writing, whether to pre-review, whether Copilot reviews, who merges), check the current one with get_workflow, see the steps and presets with list_workflow_presets, and set it with set_workflow. " +
          "Workflows layer global → product/repo → epic → ticket, each overriding the one before; Shipherd nudges sessions to the next step and stops a PR or merge that comes out of order. " +
          "When a workflow has no merge step, the user merges; don't merge it yourself." +
          (kind === "coordinator" ? " You can change only this epic and its tickets; the global, product and repo layers are changed from the Shipherd coordinator." : ""),
];

export interface GuideOptions {
  /** 原则的案例文件（有原则行时）。 */
  casesFile?: string;
  /** 有自动预审（G）时才写「开 PR 之前会自动跑一次预审」；没有时不写，否则是假话。 */
  preReview?: boolean;
  /** 仓库相关的几行（WS-M I 的 watcher 规定），放在最后。 */
  extra?: string[];
  /** 仓库档案（工作流 E2）：在规矩后面、extra 前面，只给 ticket session。 */
  profile?: string;
}

/** 仓库档案（工作流 E2，7.8）：只给 ticket session 和修复 session，只有这个 ticket 的仓库；文字已经按字数上限排好。 */
function profileSection(lang: Lang, kind: GuideKind, profile: string): string | null {
  if (kind !== "ticket" || !profile.trim()) return null;
  const head =
    lang === "zh"
      ? "下面是 Shipherd 扫描到的仓库现状：装依赖、跑测试、lint、类型检查时优先用这些仓库自己的命令，不要自己猜。"
      : "Below is what Shipherd found about the repo: when you install, run tests, lint or type check, use the repo's own commands listed here instead of guessing.";
  return `${head}\n\n${profile.trim()}`;
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
  const p = profileSection(lang, kind, opts.profile ?? "");
  if (p) parts.push(p);
  parts.push(...(opts.extra ?? []));
  return parts.join("\n\n") + "\n";
}

/** 原则的案例文件：每个原则一节，下面是它的规矩。 */
export function casesText(lang: Lang, lessons: SessionLesson[]): string {
  const zh = lang === "zh";
  const parts = lessons.filter((l) => l.cases?.length).map((l) => [`## [${l.label}] ${l.text}`, ...l.cases!.map((c) => `- ${c}`)].join("\n"));
  return `# ${zh ? "原则的案例" : "Cases for the principles"}\n\n${parts.join("\n\n")}\n`;
}

/** 内容没变就不重写。touch：会被 pruneSessionGuides 清理的文件把修改时间改成现在，还在用的不会被当成 30 天没用删掉。 */
function writeIfChanged(dir: string, file: string, text: string, touch: boolean): void {
  if (existsSync(file) && readFileSync(file, "utf8") === text) {
    if (!touch) return;
    const now = new Date();
    try {
      utimesSync(file, now, now);
    } catch {
      // 改不了时间不影响这次用
    }
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text);
}

const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/**
 * lessons、extra 和仓库档案都为空：写 <mcpDir>/guide-<kind>-<lang>.md。不然写 guide-<kind>-<lang>-<内容 sha256 前 12 位>.md。内容没变就不重写，返回路径。
 * 有原则行时案例写进旁边的 lessons-cases-<内容 sha256 前 12 位>.md，说明里写它的路径。
 */
export function writeSessionGuide(mcpDir: string, lang: Lang, kind: GuideKind, lessons: SessionLesson[] = [], opts: Omit<GuideOptions, "casesFile"> = {}): string {
  let casesFile: string | undefined;
  if (kind === "ticket" && lessons.some((l) => l.cases?.length)) {
    const cases = casesText(lang, lessons);
    casesFile = join(mcpDir, `lessons-cases-${short(cases)}.md`);
    writeIfChanged(mcpDir, casesFile, cases, true);
  }
  const text = sessionGuide(lang, kind, lessons, { ...opts, casesFile });
  const hash = lessons.length > 0 || (opts.extra?.length ?? 0) > 0 || (kind === "ticket" && !!opts.profile?.trim()) ? `-${short(text)}` : "";
  const file = join(mcpDir, `guide-${kind}-${lang}${hash}.md`);
  writeIfChanged(mcpDir, file, text, hash !== "");
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
