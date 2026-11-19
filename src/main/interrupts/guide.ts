import type { Lang } from "../../shared/i18n";
import type { GuideKind } from "../claude/session-guide";

/**
 * 指南里和打断有关的段落（ws-j 设计 3、4）：只给 ticket session（含修复 session）和总控，开关打开时才写。
 * choiceRule：有推荐项又没有特别情况就自己选、用 report(kind: "choice") 记一笔；selfServe：问用户要信息之前先自己查。
 */
export function interruptGuideLines(lang: Lang, kind: GuideKind, o: { choiceRule: boolean; selfServe: boolean }): string[] {
  if (kind !== "ticket" && kind !== "coordinator") return [];
  const zh = lang === "zh";
  const out: string[] = [];
  if (o.choiceRule)
    out.push(
      zh
        ? "要在几个选项里选一个、而且有一个明显该推荐的时候，不要用 ask_user 等用户：直接选推荐的那个，接着做，再用 report（kind: \"choice\"）记一笔：问题、选项、选了哪个、为什么。" +
            "以下情况例外，照常用 ask_user：不可撤销或别人看得到的动作（删除、推送到别人的分支、发消息、改线上东西）、要花钱、超出这个 ticket 的范围、和用户说过的偏好有关。" +
            "真的要问时，ask_user 里给出 recommended（推荐第几个选项）。"
        : "When you have to pick between options and one is clearly the one to recommend, do not wait for the user with ask_user: pick it, carry on, and record it with report (kind: \"choice\"): the question, the options, what you picked and why. " +
            "The exceptions, where you still use ask_user: irreversible or outward-visible actions (deleting, pushing to someone else's branch, sending messages, changing anything live), spending money, going beyond this ticket, or anything touching a preference the user stated. " +
            "When you do ask, give recommended (the index of the option you recommend) in ask_user.",
    );
  if (o.selfServe) {
    const steps = zh
      ? ["通过 tracker 的 MCP 看 ticket 本身（描述、评论、关联的 ticket）", "代码、文档和 git 历史", "用 recall 查记忆"]
      : ["the ticket itself through the tracker MCP (description, comments, linked tickets)", "the code, docs and git history", "memory, with recall"];
    if (kind === "ticket") steps.push(zh ? "有管你的总控时，用 report（kind: \"blocked\"）问总控" : "if a coordinator manages you, ask it with report (kind: \"blocked\")");
    out.push(
      zh
        ? `要问用户要某个信息之前，按顺序先自己找：${steps.map((s, i) => `${i + 1}. ${s}`).join("；")}。都找不到再用 ask_user，并在 context 里写明已经查过哪些。`
        : `Before asking the user for a piece of information, look for it yourself, in this order: ${steps.map((s, i) => `${i + 1}. ${s}`).join("; ")}. Only when none of these has it, use ask_user, and say in context what you already checked.`,
    );
  }
  return out;
}
