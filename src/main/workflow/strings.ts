import type { Lang } from "../../shared/i18n";
import type { MergeBy, ReviewBot, WorkflowProblem, WorkflowStepId } from "../../shared/workflow";
import { currentLang } from "../i18n";

/** 工作流程（BTL-273）给 session、总控、闸门的文案。单独一张表：不和别的 ticket 抢 strings.ts。 */

const ZH_STEPS: Record<WorkflowStepId, string> = {
  implement: "写代码",
  self_review: "自审",
  pre_review: "预审",
  open_pr: "开 PR",
  ci_green: "CI 通过",
  bot_review: "bot review",
  address_comments: "处理评论",
  re_review: "再请 review",
  human_review: "人工 review",
  merge: "合并",
};

const EN_STEPS: Record<WorkflowStepId, string> = {
  implement: "implement",
  self_review: "self-review",
  pre_review: "pre-review",
  open_pr: "open the PR",
  ci_green: "CI green",
  bot_review: "bot review",
  address_comments: "address comments",
  re_review: "review again",
  human_review: "human review",
  merge: "merge",
};

const BOT = { copilot: "Copilot", codex: "Codex" } as const;

const ZH = {
  step: (id: WorkflowStepId) => ZH_STEPS[id],
  list: (ids: WorkflowStepId[]) => ids.map((i) => `「${ZH_STEPS[i]}」`).join("、"),
  bot: (b: ReviewBot) => BOT[b],
  noticeHead: (key: string, step: WorkflowStepId, i: number, n: number) => `${key} 的工作流程：现在是第 ${i}/${n} 步「${ZH_STEPS[step]}」。`,
  noticeNote: (note: string) => `这一步的要求：${note}`,
  doIt: {
    implement: "写完代码后调 workflow_step_done（step: implement）。",
    self_review: "自己 review 一遍改动（比如用 code-review skill），该改的改完，调 workflow_step_done（step: self_review）。",
    pre_review: "提交以后调 submit_evidence 交证据，等预审结果。预审没过之前，gh pr create 会被拦下。",
    open_pr: (draft: boolean): string => (draft ? "可以开 PR 了，先开 draft：gh pr create --draft。" : "可以开 PR 了：gh pr create。"),
    ci_green: "等 CI 跑完；挂了 Shipherd 会把结果发给你，修好再 push。",
    address_comments: "处理 bot 的意见：该改的改、push、回复。都处理完调 workflow_step_done（step: address_comments）。",
    human_review: "等人来 review、批准。有评论 Shipherd 会转给你。",
  },
  botAsked: (bot: ReviewBot) => `Shipherd 已经请了 ${BOT[bot]} review，等结果，意见会转给你。`,
  botAskSession: (bot: ReviewBot, cmds: string[]) => `请你跑一下这条命令请 ${BOT[bot]} review（结果 Shipherd 会转给你）：\n${cmds.join("\n")}`,
  botAskSessionOff: (bot: ReviewBot, cmds: string[]) =>
    `Shipherd 替你请 bot review 的开关没开（设置 › 高级 › 对外动作 › 请 bot review），请你跑一下这条命令请 ${BOT[bot]} review（结果 Shipherd 会转给你）：\n${cmds.join("\n")}`,
  botFailed: (bot: ReviewBot, error: string, cmds: string[]) => `Shipherd 请 ${BOT[bot]} review 没成功（${error}）。请你自己跑一下：\n${cmds.join("\n")}`,
  botWaiting: (bot: ReviewBot) => `等 ${BOT[bot]} 的 review 回来。`,
  reReview: (round: number, max: number) => `改完 push 以后，Shipherd 会再请一次 review（再请的第 ${round} 轮，最多 ${max} 轮）。觉得不用再请了，就调 workflow_step_done（step: re_review）。`,
  reReviewAsked: (bot: ReviewBot, round: number, max: number) => `Shipherd 又请了一次 ${BOT[bot]} review（再请的第 ${round}/${max} 轮），等结果。`,
  mergeWait: (by: MergeBy): string => (by === "coordinator" ? "前面的步骤都做完了，等总控来合；你别自己合，停下就行。" : "前面的步骤都做完了，等用户自己合；你别合，停下就行。"),
  coordinatorMerge: (key: string, prs: string[]) => `${key} 的工作流程走到「合并」了：前面的步骤都做完了，可以合：${prs.join("、")}。合之前再看一眼 CI 是绿的。`,
  // 闸门
  prPending: (ids: WorkflowStepId[]) => `先别开 PR：工作流程里开 PR 之前还有${ZH.list(ids)}没做完。做完再开。`,
  prPreReview: "先别开 PR：这个提交还没通过预审。先调 submit_evidence 交证据，等预审结果出来（没过就按意见改了再交）。",
  openPrNeedsPreReview: "开之前，现在这个提交要通过预审（Shipherd 会核对；push 了新提交要重新交证据）。",
  mergePreReview: (prs: string[]) => `先别合：${prs.join("、")} 现在的提交还没通过预审（push 过新的提交）。等预审过了再合。`,
  prDraft: "这个工作流程要先开 draft：加上 --draft 再开。",
  mergeByUser: "别合并：这个 ticket 的工作流程定了由用户自己合。停下等用户。",
  mergeNotCoordinator: "别合并：这个 ticket 的工作流程由总控来合。做完了就停下，等总控。",
  mergePending: (ids: WorkflowStepId[]) => `还不能合：工作流程里合并之前还有${ZH.list(ids)}没做完。`,
  // 工具
  stepDone: (step: WorkflowStepId, next: WorkflowStepId | null) => (next ? `记下了：「${ZH_STEPS[step]}」做完了。下一步是「${ZH_STEPS[next]}」。` : `记下了：「${ZH_STEPS[step]}」做完了，流程走完了。`),
  stepNotInWorkflow: (step: WorkflowStepId) => `这个 ticket 的工作流程里没有「${ZH_STEPS[step]}」这一步。`,
  stepAuto: (step: WorkflowStepId) => `「${ZH_STEPS[step]}」不用你标：Shipherd 会按实际情况（预审、PR、CI、review、合并）自己判断。`,
  stepTooEarly: (step: WorkflowStepId, before: WorkflowStepId) => `现在还不能标「${ZH_STEPS[step]}」：前面的「${ZH_STEPS[before]}」还没做完。`,
  stepNoteTooLong: (max: number) => `说明太长了（最多 ${max} 字），请写短一点再标。`,
  noWorkflow: "这个 ticket 没有设工作流程，不用标步骤。",
  problem: (p: WorkflowProblem): string => {
    switch (p.code) {
      case "empty":
        return "流程里至少要有一步";
      case "unknown_step":
        return `不认识的步骤：${p.step}（能用的：${Object.keys(ZH_STEPS).join("、")}）`;
      case "duplicate":
        return `「${ZH_STEPS[p.step]}」出现了两次`;
      case "needs_pr":
        return `「${ZH_STEPS[p.step]}」要排在「开 PR」后面（流程里也要有开 PR 这一步）`;
      case "before_pr":
        return `「${ZH_STEPS[p.step]}」要排在「开 PR」前面`;
      case "merge_last":
        return "「合并」要放在最后一步";
      case "re_review_needs_bot":
        return "「再请 review」前面要有「bot review」";
      case "bad_option":
        return `「${ZH_STEPS[p.step]}」不能带 ${p.option} 这个选项（或者值不对）`;
      case "too_long":
        return p.step ? `「${ZH_STEPS[p.step]}」的要求太长了（最多 2000 字）` : "流程说明太长了（最多 4000 字）";
    }
  },
  guideHead: (source: string) => `这个 ticket 按工作流程走（来自${source}）。Shipherd 会按顺序提醒你下一步，也会拦下不按顺序的开 PR 和合并：`,
  guideStep: (i: number, step: WorkflowStepId, extra: string) => `${i}. ${ZH_STEPS[step]}${extra}`,
  guideDraft: "（先开 draft）",
  guideBot: (bot: ReviewBot) => `（${BOT[bot]}）`,
  guideRounds: (bot: ReviewBot, n: number) => `（${BOT[bot]}，最多再请 ${n} 轮；没有新意见就停）`,
  guideMergeBy: (by: MergeBy): string => (by === "coordinator" ? "（总控来合）" : "（用户自己合）"),
  guideNote: (note: string) => `：${note}`,
  guideNotes: (notes: string) => `补充说明：${notes}`,
  guideCurrent: (step: WorkflowStepId | null) => (step ? `现在是「${ZH_STEPS[step]}」。` : "流程已经走完了。"),
  guideTool: "写代码、自审、处理评论、再请 review 这几步做完后调 workflow_step_done（step 写步骤名）；别的步骤 Shipherd 自己会判断。",
  noMergeStep: "没有合并这一步：由用户自己合，session 和总控都别合。",
  // 总控工具
  ctlOff: "工作流程没开（Shipherd 版本太旧）。",
  ctlBadScope: (ref: string) => `认不出 ${ref}：scope 写 global、product:<名字>、repo:<owner/repo>、epic:<名字> 或 ticket:<号>。`,
  ctlNoProduct: (ref: string, names: string) => `没有叫 ${ref} 的产品。现有的：${names || "（没有）"}`,
  ctlNoEpic: (ref: string) => `没有叫 ${ref} 的 epic。用 list_epics 看看名字。`,
  ctlNoTicket: (ref: string) => `没有 ${ref} 这个 ticket。`,
  ctlNotYours: "epic 总控只能改自己这个 epic 和它的 ticket 的流程；全局、产品、仓库的流程找全局总控改。",
  ctlNotYourSession: "只有这个 ticket 自己的 session 能标步骤。",
  ctlSet: (scope: string) => `${scope} 的工作流程设好了，这个范围里进行中的 ticket 会按新流程走。`,
  ctlCleared: (scope: string) => `${scope} 的工作流程清掉了，改用上一层的（都没有就照旧）。`,
  ctlUnchanged: "和现在的一样，没改。",
  uiBadScope: "认不出这一层。",
  ctlPresetsNote: "steps 可以直接用这里的 id，也可以写成 { id, note, draft, bot, maxRounds, mergeBy }。merge 不写 mergeBy 是总控来合；流程里没有 merge 就是用户自己合。",
  stepHelp: {
    implement: "写代码（session 标）",
    self_review: "自审（用了 review 类 skill 自动算，或 session 标）",
    pre_review: "预审通过（Shipherd 预审 clean 才算；没过拦 gh pr create）",
    open_pr: "开 PR（可以 draft: true）",
    ci_green: "CI 通过",
    bot_review: "请 bot review 并等结果（bot: copilot / codex）",
    address_comments: "处理评论（session 标；第一轮没有意见自动算）",
    re_review: "改完再请 review（maxRounds 1–5，默认 2；没新意见就停）",
    human_review: "人工 review 批准",
    merge: "合并（mergeBy: coordinator / user），要放在最后",
  } as Record<WorkflowStepId, string>,
  source: {
    global: "全局设置",
    product: (name: string) => `产品「${name}」`,
    repo: (slug: string) => `仓库 ${slug}`,
    feature: (name: string) => `epic「${name}」`,
    ticket: (key: string) => `${key} 自己的设置`,
  },
};

type WorkflowStrings = typeof ZH;

const EN: WorkflowStrings = {
  step: (id) => EN_STEPS[id],
  list: (ids) => ids.map((i) => `"${EN_STEPS[i]}"`).join(", "),
  bot: (b) => BOT[b],
  noticeHead: (key, step, i, n) => `${key} workflow: step ${i}/${n} is "${EN_STEPS[step]}".`,
  noticeNote: (note) => `What this step needs: ${note}`,
  doIt: {
    implement: "When the code is written, call workflow_step_done (step: implement).",
    self_review: "Review your own changes (for example with the code-review skill), fix what needs fixing, then call workflow_step_done (step: self_review).",
    pre_review: "After committing, call submit_evidence and wait for the pre-review. Until it passes, gh pr create is blocked.",
    open_pr: (draft) => (draft ? "You can open the PR now, as a draft: gh pr create --draft." : "You can open the PR now: gh pr create."),
    ci_green: "Wait for CI. If it fails, Shipherd sends you the result; fix it and push.",
    address_comments: "Work through the bot's comments: change what needs changing, push, reply. When all are handled, call workflow_step_done (step: address_comments).",
    human_review: "Wait for a person to review and approve. Shipherd forwards any comments.",
  },
  botAsked: (bot) => `Shipherd asked ${BOT[bot]} for a review. Wait for it; Shipherd forwards the comments.`,
  botAskSession: (bot, cmds) => `Please run this to ask ${BOT[bot]} for a review (Shipherd forwards the result):\n${cmds.join("\n")}`,
  botAskSessionOff: (bot, cmds) =>
    `Shipherd asking a bot to review is off (Settings › Advanced › External actions › Ask a bot to review). Please run this to ask ${BOT[bot]} for a review (Shipherd forwards the result):\n${cmds.join("\n")}`,
  botFailed: (bot, error, cmds) => `Shipherd couldn't ask ${BOT[bot]} for a review (${error}). Please run this yourself:\n${cmds.join("\n")}`,
  botWaiting: (bot) => `Waiting for the ${BOT[bot]} review.`,
  reReview: (round, max) => `After you push your fixes, Shipherd asks for another review (extra round ${round}, at most ${max}). If no more review is needed, call workflow_step_done (step: re_review).`,
  reReviewAsked: (bot, round, max) => `Shipherd asked ${BOT[bot]} for another review (extra round ${round}/${max}). Wait for it.`,
  mergeWait: (by) => (by === "coordinator" ? "Everything before the merge is done. The coordinator merges; don't merge yourself, just stop." : "Everything before the merge is done. The user merges; don't merge, just stop."),
  coordinatorMerge: (key, prs) => `${key} reached "merge" in its workflow: every earlier step is done, so you can merge ${prs.join(", ")}. Check once more that CI is green first.`,
  prPending: (ids) => `Don't open the PR yet: the workflow still has ${EN.list(ids)} to do first.`,
  prPreReview: "Don't open the PR yet: this commit hasn't passed pre-review. Call submit_evidence and wait for the result (if it fails, fix it and submit again).",
  openPrNeedsPreReview: "Before you open it, the current commit has to pass pre-review (Shipherd checks; after a new push, submit evidence again).",
  mergePreReview: (prs) => `Don't merge yet: the current commit of ${prs.join(", ")} hasn't passed pre-review (new commits were pushed). Merge once it passes.`,
  prDraft: "This workflow opens a draft first: add --draft.",
  mergeByUser: "Don't merge: this ticket's workflow leaves the merge to the user. Stop and wait.",
  mergeNotCoordinator: "Don't merge: in this ticket's workflow the coordinator merges. Stop when you're done and wait.",
  mergePending: (ids) => `Can't merge yet: the workflow still has ${EN.list(ids)} before the merge.`,
  stepDone: (step, next) => (next ? `Noted: "${EN_STEPS[step]}" is done. Next is "${EN_STEPS[next]}".` : `Noted: "${EN_STEPS[step]}" is done, and the workflow is complete.`),
  stepNotInWorkflow: (step) => `This ticket's workflow has no "${EN_STEPS[step]}" step.`,
  stepAuto: (step) => `You don't mark "${EN_STEPS[step]}": Shipherd tells from the facts (pre-review, PR, CI, reviews, merge).`,
  stepTooEarly: (step, before) => `You can't mark "${EN_STEPS[step]}" yet: "${EN_STEPS[before]}" before it isn't done.`,
  stepNoteTooLong: (max) => `The note is too long (${max} characters at most). Shorten it and mark again.`,
  noWorkflow: "This ticket has no workflow, so there are no steps to mark.",
  problem: (p) => {
    switch (p.code) {
      case "empty":
        return "A workflow needs at least one step";
      case "unknown_step":
        return `Unknown step: ${p.step} (available: ${Object.keys(EN_STEPS).join(", ")})`;
      case "duplicate":
        return `"${EN_STEPS[p.step]}" appears twice`;
      case "needs_pr":
        return `"${EN_STEPS[p.step]}" must come after "open the PR" (and the workflow needs that step)`;
      case "before_pr":
        return `"${EN_STEPS[p.step]}" must come before "open the PR"`;
      case "merge_last":
        return `"merge" must be the last step`;
      case "re_review_needs_bot":
        return `"review again" needs a "bot review" before it`;
      case "bad_option":
        return `"${EN_STEPS[p.step]}" can't take the option ${p.option} (or the value is wrong)`;
      case "too_long":
        return p.step ? `The note for "${EN_STEPS[p.step]}" is too long (at most 2000 characters)` : "The workflow notes are too long (at most 4000 characters)";
    }
  },
  guideHead: (source) => `This ticket follows a workflow (from ${source}). Shipherd reminds you of the next step and blocks opening the PR or merging out of order:`,
  guideStep: (i, step, extra) => `${i}. ${EN_STEPS[step]}${extra}`,
  guideDraft: " (draft first)",
  guideBot: (bot) => ` (${BOT[bot]})`,
  guideRounds: (bot, n) => ` (${BOT[bot]}, at most ${n} extra rounds; stop when there are no new comments)`,
  guideMergeBy: (by) => (by === "coordinator" ? " (the coordinator merges)" : " (the user merges)"),
  guideNote: (note) => `: ${note}`,
  guideNotes: (notes) => `Notes: ${notes}`,
  guideCurrent: (step) => (step ? `The current step is "${EN_STEPS[step]}".` : "The workflow is complete."),
  guideTool: "After implement, self-review, address comments or review again, call workflow_step_done (step is the step name); Shipherd tells the other steps from the facts.",
  noMergeStep: "There's no merge step: the user merges. Neither the session nor the coordinator merges.",
  ctlOff: "Workflows aren't available (this Shipherd is too old).",
  ctlBadScope: (ref) => `Can't read ${ref}: scope is global, product:<name>, repo:<owner/repo>, epic:<name> or ticket:<key>.`,
  ctlNoProduct: (ref, names) => `No product named ${ref}. Products: ${names || "(none)"}`,
  ctlNoEpic: (ref) => `No epic named ${ref}. Check list_epics for the names.`,
  ctlNoTicket: (ref) => `No ticket ${ref}.`,
  ctlNotYours: "An epic coordinator can only change the workflow of its own epic and its tickets; ask the global coordinator for global, product or repo workflows.",
  ctlNotYourSession: "Only this ticket's own session can mark steps.",
  ctlSet: (scope) => `The workflow for ${scope} is set; tickets in progress there follow it from now on.`,
  ctlCleared: (scope) => `The workflow for ${scope} is cleared; the layer above applies (or the old behavior if none is set).`,
  ctlUnchanged: "Same as now; nothing changed.",
  uiBadScope: "That layer isn't recognized.",
  ctlPresetsNote: "steps can use these ids directly, or objects { id, note, draft, bot, maxRounds, mergeBy }. A merge without mergeBy is done by the coordinator; a workflow without merge leaves it to the user.",
  stepHelp: {
    implement: "write the code (the session marks it)",
    self_review: "self-review (counts when a review skill runs, or the session marks it)",
    pre_review: "pass pre-review (only a clean Shipherd pre-review counts; gh pr create is blocked until then)",
    open_pr: "open the PR (draft: true allowed)",
    ci_green: "CI passes",
    bot_review: "ask a bot for a review and wait (bot: copilot / codex)",
    address_comments: "address the comments (the session marks it; skipped when round one has none)",
    re_review: "ask again after the fixes (maxRounds 1–5, default 2; stops when there are no new comments)",
    human_review: "a person approves",
    merge: "merge (mergeBy: coordinator / user), must be last",
  },
  source: {
    global: "the global setting",
    product: (name) => `product "${name}"`,
    repo: (slug) => `repo ${slug}`,
    feature: (name) => `epic "${name}"`,
    ticket: (key) => `${key}'s own setting`,
  },
};

export const WORKFLOW_STRINGS: Record<Lang, WorkflowStrings> = { zh: ZH, en: EN };

export function WF(): WorkflowStrings {
  return WORKFLOW_STRINGS[currentLang()];
}
