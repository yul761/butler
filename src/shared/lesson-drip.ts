// 编辑时补送规矩（BTL-274）：主进程开 session 时写一份清单，hook 在 Edit / Write / NotebookEdit 之后按改的文件补送匹配的规矩全文。
// 纯数据和命令拼装：hook 打包时也带上它。

/**
 * 清单：<dir>/<session id>.json。settings 里的命令只看它在不在：没有要补送的 session 开销只是一次 test。
 * 主 session 全送完了也留着：子 agent 各有自己的上下文和已送记录，它们改到匹配的文件时还要送。
 */
export const DRIP_SUFFIX = ".json";
/** 已经送过全文的规矩 id，一行一个：<dir>/<session id>.sent；子 agent 各有一份 <session id>.<agent>.sent。 */
export const DRIP_SENT_SUFFIX = ".sent";

/** 清单里的一个仓库：它的 slug 和 session 里能碰到它的目录（worktree、仓库本身、解析软链接以后的路径）。 */
export interface DripRoot {
  slug: string;
  dirs: string[];
}

/** 清单里一条没写全文的规矩。slugs：它适用的仓库（仓库规矩是它自己；产品规矩是这个 session 里属于这个产品的仓库）。 */
export interface DripLesson {
  id: number;
  label: string;
  text: string;
  why: string;
  globs: string[];
  lang: string | null;
  slugs: string[];
}

export interface DripManifest {
  v: 1;
  lang: "zh" | "en";
  roots: DripRoot[];
  lessons: DripLesson[];
}

/** session id 里只留文件名安全的字符（Claude Code 的 session id 本来就是 uuid）。 */
export const dripName = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_");

const dq = (s: string): string => s.replace(/[\\"$`]/g, (c) => `\\${c}`);

/**
 * PostToolUse（Edit|Write|MultiEdit|NotebookEdit）的补送命令：清单不在就只是一次 test，退出 0；在才 exec shipherd-hook。
 * 和信箱一样，macOS 的 sh、Windows 的 Git Bash 都能跑；没有 SHIPHERD_SESSION 的（外部终端）看的是 `_`，不存在。
 */
export function lessonsHookCommand(hook: string, dir: string, platform: NodeJS.Platform): string {
  const d = dq(platform === "win32" ? dir.replace(/\\/g, "/") : dir);
  return `[ ! -f "${d}/\${SHIPHERD_SESSION:-_}${DRIP_SUFFIX}" ] || exec ${hook} lessons "${d}"`;
}

/** SessionStart（clear|compact|startup）：上下文清掉了，已送记录作废，下一次编辑重新补送。 */
export function lessonsResetCommand(hook: string, dir: string, platform: NodeJS.Platform): string {
  const d = dq(platform === "win32" ? dir.replace(/\\/g, "/") : dir);
  return `[ -z "\${SHIPHERD_SESSION:-}" ] || exec ${hook} lessons-reset "${d}"`;
}

/** 补送的那段话的开头。 */
export const dripIntro = (lang: "zh" | "en", file: string): string =>
  lang === "zh"
    ? `你刚改的 ${file} 在下面这些规矩的适用范围里（Shipherd 补送全文，session 说明里只列了标题或者原则）。接着改之前先对照：`
    : `The file you just changed, ${file}, is in scope for these rules (Shipherd sends the full text; the session guide only listed their titles or principles). Check against them before you go on:`;
