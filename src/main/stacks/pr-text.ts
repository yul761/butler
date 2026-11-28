import type { Lang } from "../../shared/i18n";
import { currentLang } from "../i18n";

/**
 * 栈写到 GitHub 上和送进 session 的文案（设计 4、5、9 节），中英两份；GitHub 上的东西按 Shipherd 当前的语言写。
 * 单独放一个文件：栈的文案多，放进 main/strings.ts 会和别的工作流天天冲突。
 */

export interface GraphLayer {
  branch: string;
  prNumber: number | null;
  /** branch_only / draft / ready / merged */
  state: string;
  title: string | null;
}

export interface ConflictText {
  branch: string;
  files: string[];
  onto: string;
  upstream: string;
  above: string[];
  push: boolean;
  /** 推到哪个 remote。 */
  remote: string;
  /** 交出去时远端这个分支的完整 sha（force-with-lease 锁它）；远端还没有这个分支时是 null。 */
  remoteSha: string | null;
  /** 远端有本地分支没有的提交（比如 reviewer 推的）：不给推送命令，强推会冲掉它们（BTL-278）。 */
  remoteAhead?: boolean;
  /** 认不出该推到哪个 remote（fork 工作流里分支只在别的 remote 上之类）：不给推送命令（BTL-278）。 */
  noRemote?: boolean;
}

/**
 * 自动改写以后请那一层的 session 核对（BTL-278）。没推（pushed false）的原因：off = 「强推」开关关着（默认）；
 * blocked = 推之前查出冲突标记、或者推失败了；local = 远端还没有这个分支，或者认不出该推到哪个 remote。
 */
export interface VerifyText { branch: string; onto: string; tip: string; pushed: boolean; unpushed?: "off" | "blocked" | "local"; }

/**
 * 给 session 的强推命令：lease 锁定交出去时远端的完整 sha（远端没有就锁「不存在」）（BTL-278）。
 * 只在远端是本地分支的祖先时才给（调用方核对过）：带了具体 sha 的 lease 只比 sha，--force-if-includes 不再起作用。
 */

export const pushLine = (p: { branch: string; remote: string; remoteSha: string | null }): string =>
  `git push --force-with-lease=refs/heads/${p.branch}:${p.remoteSha ?? ""} --force-if-includes ${p.remote} HEAD:refs/heads/${p.branch}`;

const ZH = {
  draftPrefix: (k: number, n: number) => `[stack ${k}/${n} · 勿 review]`,
  dependsPr: (n: number) => `依赖 #${n}，暂不需要 review`,
  dependsBranch: (b: string) => `依赖分支 \`${b}\`，暂不需要 review`,
  draftIntro: "这是一个栈式 PR 的上层，开成 draft 只是为了跑 CI。下面那层合并后 Shipherd 会把它 rebase 好并改成可以 review。",
  labelDescription: "Shipherd 栈式 PR 的上层（draft，暂不需要 review）",
  demoteComment: "Shipherd：这一层先降级成纯分支（draft 太久没动）。分支还在，轮到它时 Shipherd 会重新开 PR。",
  bottomIntro: (k: number, n: number) => `这是栈的第 ${k}/${n} 层，也是现在的栈底：可以 review 了。`,
  commits: "提交",
  stack: "栈",
  above: (bs: string[]) => (bs.length ? `上面还有：${bs.map((b) => `\`${b}\``).join(" → ")}（合并这一层后 Shipherd 会依次处理）。` : "这是最后一层。"),
  stateLabel: { branch_only: "纯分支", draft: "draft", ready: "可以 review", merged: "已合并" } as Record<string, string>,
  reviewNow: "← 现在看这个",
  footer: "_这段由 Shipherd 维护。_",
  overviewTitle: (name: string) => `[stack] ${name}`,
  overviewIntro: "按 review 顺序列出这个栈的各层。从标出来的那一层开始看；它合并后 Shipherd 会把下一层 rebase 好并开成可以 review 的 PR。",
  conflict: (p: ConflictText) =>
    `Shipherd：给栈做 rebase 时，分支 ${p.branch} 有冲突（${p.files.join("、")}）。真分支都没改。请在这个 worktree 里执行：\n\n` +
    `git -c rerere.enabled=false rebase --onto ${p.onto} ${p.upstream}\n\n` +
    `解决冲突（两边的意图都要保留），再用 git -c rerere.enabled=false rebase --continue 接着走（要跳过某个提交也一样带上：git -c rerere.enabled=false rebase --skip）。-c 只管这一条命令，后面每一步都要带。` +
    `看到「Resolved '…' using previous resolution」不要信，那是以前记下的解法：git checkout -m 那个文件，重新解。` +
    `推之前：确认没有冲突标记（git grep -nE '^(<<<<<<<|>>>>>>>)( |$)' 没有输出），构建、跑相关的测试，核对迁移号没有和 ${p.onto.slice(0, 7)} 里已有的撞。` +
    (p.remoteAhead
      ? `先不要推：远端的 ${p.branch}（${(p.remoteSha ?? "").slice(0, 7)}）有这个分支没有的提交，可能是 reviewer 推的，强推会把它们冲掉。解完冲突以后用 report（kind 用 blocked）说明，由用户决定怎么把它们合进来。`
      : p.push
      ? `然后只用这一条推：\n\n${pushLine(p)}\n\n推不上去（stale info、远端变了）就停下，用 report（kind 用 blocked）说明，不要重新 fetch 再推：可能是 reviewer 在 GitHub 上推了提交。`
      : p.noRemote
      ? "先不要推：Shipherd 认不出这个分支该推到哪个 remote（它的 PR 在哪个仓库上），推错了会在别的仓库里新建一个分支。推不推、推到哪里由用户决定。"
      : "先不要推（Shipherd 的「强推」开关关着，推不推由用户决定）。") +
    `你不 rebase，Shipherd 也不会替你改这个分支；决定不 rebase 就说一声原因。` +
    (p.above.length ? `上面的层（${p.above.join("、")}）不要自己动，Shipherd 会接着处理。` : "") +
    `做完以后结束这一轮。`,
  verify: (p: VerifyText) =>
    `Shipherd：刚把这个分支 ${p.branch} 自动 rebase 到了新的 ${p.onto.slice(0, 7)} 上（现在的顶端是 ${p.tip.slice(0, 7)}）` +
    (p.pushed ? "，也已经强推到远端。" : "，还没推到远端。") +
    `Shipherd 只是让 git 把提交合了过去，没有编译、没有跑测试。请在这个 worktree 里：先 git status 看工作区，HEAD 不在 ${p.tip.slice(0, 7)} 就停下，用 report（kind 用 blocked）说明；` +
    `然后构建、跑和这个分支相关的测试，核对迁移号没有和 trunk 新进来的撞。有问题就修好、提交（用 git commit --fixup 也行），` +
    (p.pushed
      ? "照常 git push（不用 force）；"
      : p.unpushed === "blocked"
      ? "先不要推（改写还没推出去：Shipherd 推之前查出了问题，比如冲突标记，推不推由用户决定）；"
      : p.unpushed === "local"
      ? "先不要推（Shipherd 没推：远端还没有这个分支，或者认不出它该推到哪个 remote，推不推由用户决定）；"
      : "先不要推（改写还没推出去，Shipherd 的「强推」开关关着，推不推由用户决定）；") +
    `都没问题不用回复。不要自己 rebase 别的层。做完以后结束这一轮。`,
  errors: {
    notFound: "没有这个栈",
    layerNotFound: "没有这一层",
    tooFew: "栈至少要两层",
    duplicate: (b: string) => `分支 ${b} 出现了两次`,
    notOwned: (b: string) => `分支 ${b} 不是 Shipherd 的 ticket 分支，不能放进栈`,
    missing: (b: string) => `仓库里没有分支 ${b}`,
    inOther: (b: string, name: string) => `分支 ${b} 已经在栈「${name}」里`,
    notTop: (b: string) => `${b} 不是栈顶：只能接在栈顶上（栈只能是一条线）`,
    autoRebaseOff: "这个仓库的「允许 Shipherd 自动 rebase 栈」没开（设置 → 栈）",
    busy: "这个栈正在处理，稍后再试",
    isBottom: "栈底就是要 review 的那层，不用开 draft",
    pushRemoteAmbiguous: (b: string) => `认不出 ${b} 该推到哪个 remote（它在别的 remote 上，配置里也没写推到哪），改写了也推不出去，这次没 rebase。在终端跑 git config branch.${b}.pushRemote <remote> 指定以后再点「马上 rebase」`,
    noPushRemote: (b: string) => `认不出 ${b} 该推到哪个 remote（它只在别的 remote 上，或者哪个 remote 上都还没有它），没推。先把它推到它的 PR 该在的仓库上再试`,
    markers: (b: string, files: string) => `${b} 还没推过，可是 ${files} 里有冲突标记（<<<<<<<）。推上去就把标记交给了 reviewer，没推、没开 draft：去掉标记、提交以后再试`,
    markersUnchecked: (b: string) => `${b} 还没推过，可是查不了里面有没有冲突标记，没推、没开 draft。过一会儿再试；一直这样就看一下 Shipherd 的日志`,
    notLive: (b: string) => `${b} 的 ticket 已经关掉或归档了，或者这个分支已经不属于它：Shipherd 不再改写、推送它，也不给它开 PR，这次什么都没做。让那个 ticket 的 session 或总控用 stack_define 把它移出栈（或者在栈区块点「不再管这个栈」），或者重新打开 ticket，再试`,
    restoreSkipped: (bs: string) => `${bs} 已经不在栈里了，没恢复`,
    heldBelow: (b: string, below: string) => `${b} 叠在 ${below} 上，${below} 带着冲突标记、还没推出去：推 ${b} 就把那些标记一起推上去了，没推、没开 draft。先把 ${below} 的标记去掉、提交以后再试`,
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
    `。改动请用 git commit --fixup=<被改的提交> 提交在这一层，照常 push；不要自己 rebase 上面的层，Shipherd 会接着做（包括之后把 fixup 合进去）。`,
};

type StackTexts = typeof ZH;

const EN: StackTexts = {
  draftPrefix: (k, n) => `[stack ${k}/${n} · do not review]`,
  dependsPr: (n) => `Depends on #${n}; no review needed yet`,
  dependsBranch: (b) => `Depends on branch \`${b}\`; no review needed yet`,
  draftIntro: "This is an upper layer of a stacked PR, opened as a draft only to run CI. When the layer below merges, Shipherd rebases it and marks it ready for review.",
  labelDescription: "Upper layer of a Shipherd stacked PR (draft, no review needed yet)",
  demoteComment: "Shipherd: turning this layer back into a plain branch (the draft sat for too long). The branch stays; Shipherd opens a PR again when its turn comes.",
  bottomIntro: (k, n) => `This is layer ${k}/${n} of the stack and now its bottom: ready for review.`,
  commits: "Commits",
  stack: "Stack",
  above: (bs) => (bs.length ? `Still above: ${bs.map((b) => `\`${b}\``).join(" → ")} (Shipherd handles them in turn after this merges).` : "This is the last layer."),
  stateLabel: { branch_only: "branch", draft: "draft", ready: "ready for review", merged: "merged" },
  reviewNow: "← review this one now",
  footer: "_Maintained by Shipherd._",
  overviewTitle: (name) => `[stack] ${name}`,
  overviewIntro: "The layers of this stack in review order. Start with the marked one; when it merges, Shipherd rebases the next layer and opens it for review.",
  conflict: (p) =>
    `Shipherd: rebasing the stack hit a conflict on branch ${p.branch} (${p.files.join(", ")}). No real branch was changed. In this worktree, run:\n\n` +
    `git -c rerere.enabled=false rebase --onto ${p.onto} ${p.upstream}\n\n` +
    `Resolve the conflict (keep the intent of both sides), then go on with git -c rerere.enabled=false rebase --continue (the same for skipping a commit: git -c rerere.enabled=false rebase --skip). The -c only covers that one command, so add it at every step. ` +
    `If you see "Resolved '…' using previous resolution", don't trust it; that is an old recorded resolution: git checkout -m that file and resolve it again. ` +
    `Before pushing: make sure no conflict markers are left (git grep -nE '^(<<<<<<<|>>>>>>>)( |$)' prints nothing), build, run the related tests, and check your migration numbers don't clash with the ones already in ${p.onto.slice(0, 7)}.` +
    (p.remoteAhead
      ? ` Don't push: the remote ${p.branch} (${(p.remoteSha ?? "").slice(0, 7)}) has commits this branch doesn't, maybe pushed by a reviewer, and a force push would drop them. Once the conflict is solved, say so with report (kind blocked); the user decides how to bring them in.`
      : p.push
      ? ` Then push with exactly this:\n\n${pushLine(p)}\n\nIf the push is rejected (stale info, the remote moved), stop and say so with report (kind blocked); don't fetch again and push: a reviewer may have pushed commits on GitHub.`
      : p.noRemote
      ? " Don't push: Shipherd can't tell which remote this branch goes to (which repository its PR is on), and pushing to the wrong one would create a new branch there. Whether and where to push is up to the user."
      : " Don't push (Shipherd's Force push switch is off; pushing is up to the user).") +
    ` Until you rebase, Shipherd won't touch this branch. If you decide not to rebase, say why.` +
    (p.above.length ? ` Leave the layers above (${p.above.join(", ")}) alone; Shipherd handles them next.` : "") +
    ` End the turn when done.`,
  verify: (p) =>
    `Shipherd: just rebased this branch ${p.branch} onto the new ${p.onto.slice(0, 7)} on its own (its tip is now ${p.tip.slice(0, 7)})` +
    (p.pushed ? " and force-pushed it." : "; it isn't pushed yet.") +
    ` Shipherd only had git carry the commits over; it didn't build or run any tests. In this worktree: first git status; if HEAD isn't at ${p.tip.slice(0, 7)}, stop and say so with report (kind blocked).` +
    ` Then build, run the tests related to this branch, and check your migration numbers don't clash with the ones that just came in from trunk. Fix and commit anything that broke (git commit --fixup is fine)` +
    (p.pushed
      ? " and git push as usual (no force)"
      : p.unpushed === "blocked"
      ? " but don't push (the rewrite isn't pushed yet: Shipherd found a problem before pushing, such as conflict markers, so pushing is up to the user)"
      : p.unpushed === "local"
      ? " but don't push (Shipherd didn't: the remote doesn't have this branch yet, or Shipherd can't tell which remote it goes to, so pushing is up to the user)"
      : " but don't push (the rewrite isn't pushed yet: Shipherd's Force push switch is off, so pushing is up to the user)") +
    `; if all is well, no reply is needed. Don't rebase other layers yourself. End the turn when done.`,
  errors: {
    notFound: "No such stack",
    layerNotFound: "No such layer",
    tooFew: "A stack needs at least two layers",
    duplicate: (b) => `Branch ${b} appears twice`,
    notOwned: (b) => `Branch ${b} is not a Shipherd ticket branch and can't go into a stack`,
    missing: (b) => `The repository has no branch ${b}`,
    inOther: (b, name) => `Branch ${b} is already in the stack "${name}"`,
    notTop: (b) => `${b} is not the top of its stack: new layers go on top (a stack is a single line)`,
    autoRebaseOff: "\"Let Shipherd rebase stacks\" is off for this repository (Settings → Stacks)",
    busy: "This stack is being processed; try again shortly",
    isBottom: "The bottom layer is the one to review; it doesn't need a draft",
    pushRemoteAmbiguous: (b) => `Can't tell which remote ${b} goes to (it's on another remote, and no config says where it goes), so a rewrite couldn't be pushed and the stack wasn't rebased. Say which with git config branch.${b}.pushRemote <remote> in a terminal, then click "Rebase now" again`,
    noPushRemote: (b) => `Can't tell which remote ${b} goes to (it's only on another remote, or on none yet), so it wasn't pushed. Push it to the repository its PR belongs on first, then try again`,
    markers: (b, files) => `${b} hasn't been pushed yet, and ${files} has conflict markers (<<<<<<<). Pushing would hand them to reviewers, so it wasn't pushed and no draft was opened: remove them, commit, then try again`,
    markersUnchecked: (b) => `${b} hasn't been pushed yet, and Shipherd couldn't check it for conflict markers, so it wasn't pushed and no draft was opened. Try again in a while; if this keeps up, look at Shipherd's log`,
    notLive: (b) => `The ticket for ${b} is closed or archived, or the branch isn't its any more: Shipherd doesn't rewrite or push it any more, or open a PR for it, so nothing was done. Have that ticket's session or coordinator take it out of the stack with stack_define (or click "Stop managing this stack"), or reopen the ticket, then try again`,
    restoreSkipped: (bs) => `${bs} ${bs.includes(",") ? "aren't" : "isn't"} in the stack any more, so ${bs.includes(",") ? "they weren't" : "it wasn't"} restored`,
    heldBelow: (b, below) => `${b} sits on ${below}, which has conflict markers and hasn't been pushed: pushing ${b} would push those markers too, so it wasn't pushed and no draft was opened. Remove the markers in ${below}, commit, then try again`,
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
    `. Commit changes on this layer with git commit --fixup=<the commit you change> and push as usual; don't rebase the layers above yourself. Shipherd does that (and folds the fixups in later).`,
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
