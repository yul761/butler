import type { Lang } from "../../shared/i18n";
import { currentLang } from "../i18n";

/**
 * 栈写到 GitHub 上和送进 session 的文案（设计 4、5、9 节），中英两份；GitHub 上的东西按 Butler 当前的语言写。
 * 单独放一个文件：栈的文案多，放进 main/strings.ts 会和别的工作流天天冲突。
 */

export interface GraphLayer {
  branch: string;
  prNumber: number | null;
  /** branch_only / draft / ready / merged */
  state: string;
  title: string | null;
}

const ZH = {
  draftPrefix: (k: number, n: number) => `[stack ${k}/${n} · 勿 review]`,
  dependsPr: (n: number) => `依赖 #${n}，暂不需要 review`,
  dependsBranch: (b: string) => `依赖分支 \`${b}\`，暂不需要 review`,
  draftIntro: "这是一个栈式 PR 的上层，开成 draft 只是为了跑 CI。下面那层合并后 Butler 会把它 rebase 好并改成可以 review。",
  labelDescription: "Butler 栈式 PR 的上层（draft，暂不需要 review）",
  demoteComment: "Butler：这一层先降级成纯分支（draft 太久没动）。分支还在，轮到它时 Butler 会重新开 PR。",
  bottomIntro: (k: number, n: number) => `这是栈的第 ${k}/${n} 层，也是现在的栈底：可以 review 了。`,
  commits: "提交",
  stack: "栈",
  above: (bs: string[]) => (bs.length ? `上面还有：${bs.map((b) => `\`${b}\``).join(" → ")}（合并这一层后 Butler 会依次处理）。` : "这是最后一层。"),
  stateLabel: { branch_only: "纯分支", draft: "draft", ready: "可以 review", merged: "已合并" } as Record<string, string>,
  reviewNow: "← 现在看这个",
  footer: "_这段由 Butler 维护。_",
  overviewTitle: (name: string) => `[stack] ${name}`,
  overviewIntro: "按 review 顺序列出这个栈的各层。从标出来的那一层开始看；它合并后 Butler 会把下一层 rebase 好并开成可以 review 的 PR。",
  conflict: (p: { branch: string; files: string[]; onto: string; upstream: string; above: string[]; push: boolean }) =>
    `Butler：给栈做 rebase 时，分支 ${p.branch} 有冲突（${p.files.join("、")}）。真分支都没改。请在这个 worktree 里执行：\n\n` +
    `git rebase --onto ${p.onto} ${p.upstream}\n\n` +
    `解决冲突（两边的意图都要保留），git rebase --continue，` +
    (p.push ? "然后 git push --force-with-lease。" : "先不要推（Butler 的「强推」开关关着，推不推由用户决定）。") +
    `rerere 已经打开，你解过的冲突 Butler 下次会自动套用。` +
    (p.above.length ? `上面的层（${p.above.join("、")}）不要自己动，Butler 会接着处理。` : "") +
    `做完以后结束这一轮。`,
  errors: {
    notFound: "没有这个栈",
    layerNotFound: "没有这一层",
    tooFew: "栈至少要两层",
    duplicate: (b: string) => `分支 ${b} 出现了两次`,
    notOwned: (b: string) => `分支 ${b} 不是 Butler 的 ticket 分支，不能放进栈`,
    missing: (b: string) => `仓库里没有分支 ${b}`,
    inOther: (b: string, name: string) => `分支 ${b} 已经在栈「${name}」里`,
    notTop: (b: string) => `${b} 不是栈顶：只能接在栈顶上（栈只能是一条线）`,
    autoRebaseOff: "这个仓库的「允许 Butler 自动 rebase 栈」没开（设置 → 栈）",
    busy: "这个栈正在处理，稍后再试",
    isBottom: "栈底就是要 review 的那层，不用开 draft",
    readyPr: "这一层的 PR 已经可以 review 了，不能改回纯分支",
    merged: "这一层已经合并了",
    nothingToRestore: "没有可以恢复的备份",
    restoreMoved: (b: string) => `${b} 在那次 rebase 之后又变过，不能直接恢复`,
    switchOff: (what: string) => `对外动作「${what}」没开（设置 → 高级 → 对外动作），这一步没做`,
    needRepo: (names: string) => `要给 repo（这几个仓库里的一个）：${names}`,
    noSuchRepo: (wanted: string, names: string) => `没有仓库 ${wanted}。可以用的：${names}`,
    ticketNoRepo: (key: string, repo: string) => `ticket ${key} 没有仓库 ${repo}`,
    notYours: "这个栈不在你管的范围里",
    stackOnNoTicket: (key: string) => `stack_on：这个 epic 下没有 ticket ${key}`,
    stackOnRepo: (key: string, repo: string) => `stack_on：ticket ${key} 没有仓库 ${repo}，新 ticket 的仓库都要是它有的`,
    stackOnFailed: (msg: string) => `ticket 建好了，但没接进栈：${msg}`,
  },
  note: (p: { k: number; n: number; above: string[] }) =>
    `这个 PR 是栈的第 ${p.k}/${p.n} 层` +
    (p.above.length ? `，上面还有 ${p.above.join("、")}` : "") +
    `。改动请用 git commit --fixup=<被改的提交> 提交在这一层，照常 push；不要自己 rebase 上面的层，Butler 会接着做（包括之后把 fixup 合进去）。`,
};

type StackTexts = typeof ZH;

const EN: StackTexts = {
  draftPrefix: (k, n) => `[stack ${k}/${n} · do not review]`,
  dependsPr: (n) => `Depends on #${n}; no review needed yet`,
  dependsBranch: (b) => `Depends on branch \`${b}\`; no review needed yet`,
  draftIntro: "This is an upper layer of a stacked PR, opened as a draft only to run CI. When the layer below merges, Butler rebases it and marks it ready for review.",
  labelDescription: "Upper layer of a Butler stacked PR (draft, no review needed yet)",
  demoteComment: "Butler: turning this layer back into a plain branch (the draft sat for too long). The branch stays; Butler opens a PR again when its turn comes.",
  bottomIntro: (k, n) => `This is layer ${k}/${n} of the stack and now its bottom: ready for review.`,
  commits: "Commits",
  stack: "Stack",
  above: (bs) => (bs.length ? `Still above: ${bs.map((b) => `\`${b}\``).join(" → ")} (Butler handles them in turn after this merges).` : "This is the last layer."),
  stateLabel: { branch_only: "branch", draft: "draft", ready: "ready for review", merged: "merged" },
  reviewNow: "← review this one now",
  footer: "_Maintained by Butler._",
  overviewTitle: (name) => `[stack] ${name}`,
  overviewIntro: "The layers of this stack in review order. Start with the marked one; when it merges, Butler rebases the next layer and opens it for review.",
  conflict: (p) =>
    `Butler: rebasing the stack hit a conflict on branch ${p.branch} (${p.files.join(", ")}). No real branch was changed. In this worktree, run:\n\n` +
    `git rebase --onto ${p.onto} ${p.upstream}\n\n` +
    `Resolve the conflict (keep the intent of both sides) and git rebase --continue` +
    (p.push ? ", then git push --force-with-lease." : ". Don't push (Butler's Force push switch is off; pushing is up to the user).") +
    ` rerere is on, so Butler reuses your resolution next time.` +
    (p.above.length ? ` Leave the layers above (${p.above.join(", ")}) alone; Butler handles them next.` : "") +
    ` End the turn when done.`,
  errors: {
    notFound: "No such stack",
    layerNotFound: "No such layer",
    tooFew: "A stack needs at least two layers",
    duplicate: (b) => `Branch ${b} appears twice`,
    notOwned: (b) => `Branch ${b} is not a Butler ticket branch and can't go into a stack`,
    missing: (b) => `The repository has no branch ${b}`,
    inOther: (b, name) => `Branch ${b} is already in the stack "${name}"`,
    notTop: (b) => `${b} is not the top of its stack: new layers go on top (a stack is a single line)`,
    autoRebaseOff: "\"Let Butler rebase stacks\" is off for this repository (Settings → Stacks)",
    busy: "This stack is being processed; try again shortly",
    isBottom: "The bottom layer is the one to review; it doesn't need a draft",
    readyPr: "This layer's PR is already open for review; it can't go back to a plain branch",
    merged: "This layer is already merged",
    nothingToRestore: "There is no backup to restore",
    restoreMoved: (b) => `${b} changed after that rebase, so it can't be restored directly`,
    switchOff: (what) => `The outward action "${what}" is off (Settings → Advanced → Outward actions), so this step was not done`,
    needRepo: (names) => `Give repo (one of these repositories): ${names}`,
    noSuchRepo: (wanted, names) => `There is no repository ${wanted}. Available: ${names}`,
    ticketNoRepo: (key, repo) => `Ticket ${key} has no repository ${repo}`,
    notYours: "This stack is outside what you manage",
    stackOnNoTicket: (key) => `stack_on: this epic has no ticket ${key}`,
    stackOnRepo: (key, repo) => `stack_on: ticket ${key} has no repository ${repo}; every repository of the new ticket must be one it has`,
    stackOnFailed: (msg) => `The ticket was created but not added to the stack: ${msg}`,
  },
  note: (p) =>
    `This PR is layer ${p.k}/${p.n} of a stack` +
    (p.above.length ? `, with ${p.above.join(", ")} above it` : "") +
    `. Commit changes on this layer with git commit --fixup=<the commit you change> and push as usual; don't rebase the layers above yourself. Butler does that (and folds the fixups in later).`,
};

const TABLES: Record<Lang, StackTexts> = { zh: ZH, en: EN };

export function T(lang: Lang = currentLang()): StackTexts {
  return TABLES[lang];
}

/** 两种语言的前缀都认（切换过语言的栈）。 */
const PREFIX_RE = /^\[stack \d+\/\d+ · [^\]]*\]\s*/;
const DEPENDS_RE = /^(依赖 (#\d+|分支 `[^`]*`)，暂不需要 review|Depends on (#\d+|branch `[^`]*`); no review needed yet)\s*$/;

export function stripPrefix(title: string): string {
  return title.replace(PREFIX_RE, "");
}

export function draftTitle(k: number, n: number, title: string, lang?: Lang): string {
  return `${T(lang).draftPrefix(k, n)} ${stripPrefix(title)}`;
}

export function dependsLine(parent: { prNumber: number | null; branch: string }, lang?: Lang): string {
  return parent.prNumber ? T(lang).dependsPr(parent.prNumber) : T(lang).dependsBranch(parent.branch);
}

/** 正文第一行换成新的「依赖 …」；原来第一行不是这句就加在最前面。其余原样保留（G 的简报标记之类）。 */
export function withDependsLine(body: string, line: string): string {
  const nl = body.indexOf("\n");
  const first = nl === -1 ? body : body.slice(0, nl);
  if (DEPENDS_RE.test(first.trim())) return line + (nl === -1 ? "" : body.slice(nl));
  return body ? `${line}\n\n${body}` : line;
}

/** 去掉第一行的「依赖 …」（提升成栈底时）。 */
export function withoutDependsLine(body: string): string {
  const nl = body.indexOf("\n");
  const first = nl === -1 ? body : body.slice(0, nl);
  return DEPENDS_RE.test(first.trim()) ? (nl === -1 ? "" : body.slice(nl).replace(/^\s+/, "")) : body;
}

export function draftBody(parent: { prNumber: number | null; branch: string }, graph: GraphLayer[], current: number, lang?: Lang): string {
  const t = T(lang);
  return `${dependsLine(parent, lang)}\n\n${t.draftIntro}\n\n### ${t.stack}\n\n${stackGraph(graph, current, lang)}\n\n${t.footer}`;
}

/** 栈图：从栈底到栈顶一行一层，标出现在该 review 的那一层。 */
export function stackGraph(layers: GraphLayer[], current: number | null, lang?: Lang): string {
  const t = T(lang);
  const firstOpen = layers.findIndex((l) => l.state !== "merged");
  return layers
    .map((l, i) => {
      const what = l.prNumber ? `#${l.prNumber}` : `\`${l.branch}\``;
      const title = l.title ? ` ${l.title}` : "";
      const mark = i === firstOpen ? ` ${t.reviewNow}` : "";
      const self = i === current ? "**" : "";
      return `${i + 1}. ${self}${what}${title}${self} · ${t.stateLabel[l.state] ?? l.state}${mark}`;
    })
    .join("\n");
}

export function bottomBody(
  p: { k: number; n: number; brief: string | null; commits: string[]; graph: GraphLayer[]; current: number; above: string[] },
  lang?: Lang,
): string {
  const t = T(lang);
  const parts = [t.bottomIntro(p.k, p.n)];
  if (p.brief) parts.push(p.brief.trim());
  if (p.commits.length) parts.push(`### ${t.commits}\n\n${p.commits.map((c) => `- ${c}`).join("\n")}`);
  parts.push(`### ${t.stack}\n\n${stackGraph(p.graph, p.current, lang)}\n\n${t.above(p.above)}`);
  parts.push(t.footer);
  return parts.join("\n\n");
}

export function overviewBody(graph: GraphLayer[], lang?: Lang): string {
  const t = T(lang);
  return `${t.overviewIntro}\n\n${stackGraph(graph, null, lang)}\n\n${t.footer}`;
}
