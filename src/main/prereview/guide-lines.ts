// 预审打开时 ticket session 说明文件里的「完成前交证据」一段（设计 §3.2）。不依赖规矩段：没有规矩的仓库也要交证据、也会预审。
// 要哪些检查按仓库档案：每个仓库一行，列出档案里有的测试、lint、类型检查、构建命令；没有档案时写通用的一句。规矩本身不进这里。
import type { RepoProfile } from "../../shared/baselines";
import type { Lang } from "./model";

export interface GuideRepo {
  /** 给人看的仓库名（worktree 目录名）。 */
  name: string;
  profile: RepoProfile | null;
}

const CMD_CHARS = 200;
const code = (s: string): string => `\`${(s.length > CMD_CHARS ? `${s.slice(0, CMD_CHARS)}…` : s).replace(/`/g, "'")}\``;

/** 一个仓库要跑的命令（档案里有的，按项目目录；只有一个项目且在根目录时不写目录）。 */
function repoLine(r: GuideRepo, lang: Lang): string {
  const zh = lang === "zh";
  const projects = r.profile?.projects ?? [];
  const parts = projects.flatMap((p) => {
    const cmds = [
      p.testAll ? `${zh ? "测试" : "test"} ${code(p.testAll)}` : p.testOne ? `${zh ? "测试" : "test"} ${code(p.testOne)}` : null,
      p.lint ? `lint ${code(p.lint)}` : null,
      p.typecheck ? `${zh ? "类型检查" : "typecheck"} ${code(p.typecheck)}` : null,
      p.build ? `${zh ? "构建" : "build"} ${code(p.build)}` : null,
    ].filter((x): x is string => x !== null);
    if (cmds.length === 0) return [];
    const dir = p.dir && p.dir !== "." && !(projects.length === 1 && p.dir === "") ? `${p.dir}: ` : "";
    return [`${dir}${cmds.join(zh ? "，" : ", ")}`];
  });
  if (parts.length === 0) return zh ? `- ${r.name}：测试、lint、类型检查（档案里没有命令，用仓库自己的）` : `- ${r.name}: tests, lint, typecheck (no commands in the profile; use the repo's own)`;
  return `- ${r.name}${zh ? "：" : ": "}${parts.join(zh ? "；" : "; ")}`;
}

export function evidenceGuideLines(lang: Lang, repos: readonly GuideRepo[]): string[] {
  const zh = lang === "zh";
  const head = zh
    ? [
        "## 完成前交证据",
        "",
        "Butler 会在后台预审你的改动（对照这个仓库的规矩和检查结果），预审要你交的完成证据。做完、提交以后、开 PR 之前调 `submit_evidence`：",
        "- checks：跑了哪些检查，写实际的命令、pass 或 fail、输出的关键部分（比如通过 / 失败的数量）；",
        "- acceptance：每条验收条件怎么满足的；",
        "- ui：改了界面时附截图路径（有条件时）；",
        "- notRun：该跑但没跑的检查，写原因。",
        "",
        "要跑的检查：",
      ]
    : [
        "## Hand in evidence before you finish",
        "",
        "Butler pre-reviews your change in the background (against this repo's rules and check results) and needs your completion evidence. When the work is done and committed, before opening a PR, call `submit_evidence` with:",
        "- checks: what you ran, with the actual command, pass or fail, and the key part of the output (such as pass / fail counts);",
        "- acceptance: how each acceptance criterion is met;",
        "- ui: screenshot paths when you changed the UI (when you can);",
        "- notRun: checks that should have run but did not, and why.",
        "",
        "Checks to run:",
      ];
  const lines = repos.length ? repos.map((r) => repoLine(r, lang)) : [zh ? "- 测试、lint、类型检查" : "- tests, lint, typecheck"];
  const tail = zh
    ? "交完结束这一轮，等预审结果送进来（没收到就调 `pre_review_result`）；在那之前不要改 worktree。Butler 会自己复跑档案里的命令核对你的输出。"
    : "After submitting, end your turn and wait for the pre-review result (call `pre_review_result` if it does not arrive); do not change the worktree until then. Butler reruns the profile's commands itself to check your output.";
  return [[...head, ...lines, "", tail].join("\n")];
}
