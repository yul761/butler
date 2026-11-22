// 「发送反馈」（BTL-254）：在浏览器里打开预填好的 GitHub new issue 页，由用户自己提交。
import { BUTLER_REPO } from "./butler-repo";

export const FEEDBACK_KINDS = ["bug", "idea", "first-run"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const isFeedbackKind = (v: unknown): v is FeedbackKind => typeof v === "string" && (FEEDBACK_KINDS as readonly string[]).includes(v);

export const FEEDBACK_REPO_URL = `https://github.com/${BUTLER_REPO}`;
export const FEEDBACK_ISSUE_URL = `${FEEDBACK_REPO_URL}/issues/new`;
export const FEEDBACK_DISCUSSIONS_URL = `${FEEDBACK_REPO_URL}/discussions`;

/** .github/ISSUE_TEMPLATE/ 下的文件名。 */
export const FEEDBACK_TEMPLATES: Record<FeedbackKind, string> = { bug: "bug.yml", idea: "idea.yml", "first-run": "first-run.yml" };

/**
 * 链接最长多少个字符。Windows 上 shell.openExternal 走 ShellExecute，超过 2048 左右就不可靠；
 * 中文百分号编码后一个字变九个字符，所以描述太长时要截。
 */
export const FEEDBACK_URL_MAX = 2000;
export const TITLE_MAX = 200;
/** 渲染进程送来的描述先按这个上限截（主进程校验用），再按链接长度截。 */
export const DESCRIPTION_MAX = 20_000;
export const TRUNCATED_MARK = "\n\n…(truncated)";

export interface FeedbackEnv {
  butler: string;
  /** 例如 "macOS 15.1.0"、"Windows 10.0.22631"。 */
  os: string;
  platform: string;
  arch: string;
  /** 拿不到就是 "unknown"。 */
  claude: string;
}

export interface FeedbackDraft {
  kind: FeedbackKind;
  title: string;
  description: string;
  /** 首次使用向导里哪一步出的问题（first-run 才有）。 */
  step?: string;
  /** 存到下载目录的脱敏诊断文件名，提示用户拖进 issue。 */
  diagnosticsFile?: string | null;
}

export interface FeedbackLink {
  url: string;
  /** 描述或标题因为链接太长被截过。 */
  truncated: boolean;
}

export function envBlock(e: FeedbackEnv): string {
  return [`- Butler: ${e.butler}`, `- OS: ${e.os} (${e.platform})`, `- Architecture: ${e.arch}`, `- Claude Code: ${e.claude}`].join("\n");
}

function build(d: FeedbackDraft, env: FeedbackEnv, title: string, description: string): string {
  const q = new URLSearchParams();
  q.set("template", FEEDBACK_TEMPLATES[d.kind]);
  if (title) q.set("title", title);
  if (description) q.set("description", description);
  if (d.kind === "first-run" && d.step) q.set("step", d.step);
  q.set("environment", envBlock(env));
  if (d.diagnosticsFile) q.set("diagnostics", `Drag ${d.diagnosticsFile} from your Downloads folder into this box.`);
  return `${FEEDBACK_ISSUE_URL}?${q.toString()}`;
}

/** 按码点截到 n 个字（不把一个 emoji 或代理对劈开）。 */
const cut = (s: string, n: number): string => Array.from(s).slice(0, n).join("");

/** 二分找最长的前缀，使 fits(前缀) 成立；一个字都放不下就是 ""。 */
function longestFit(s: string, fits: (part: string) => boolean): string {
  const chars = Array.from(s);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(chars.slice(0, mid).join(""))) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("");
}

/** 拼出 new issue 链接。太长时先截描述，再截标题，截过的加上 …(truncated)。 */
export function feedbackUrl(d: FeedbackDraft, env: FeedbackEnv, max = FEEDBACK_URL_MAX): FeedbackLink {
  const title = cut(d.title.replace(/\s+/g, " ").trim(), TITLE_MAX);
  const description = d.description.trim();
  const full = build(d, env, title, description);
  if (full.length <= max) return { url: full, truncated: false };

  const withDesc = (part: string) => build(d, env, title, part ? `${part}${TRUNCATED_MARK}` : "");
  const desc = description ? longestFit(description, (p) => withDesc(p).length <= max) : "";
  if (withDesc(desc).length <= max) return { url: withDesc(desc), truncated: true };

  const withTitle = (part: string) => build(d, env, part ? `${part}…` : "", "");
  const t = longestFit(title, (p) => withTitle(p).length <= max);
  return { url: withTitle(t), truncated: true };
}
